import { spawn } from 'node:child_process';
import {
  LOCAL_MODEL_PROTOCOL, ModelTransportError, parseReady, parseResponse, validateConfig,
  type LocalModelLaunchSpec, type LocalModelProcessConfig, type ModelCandidateResponse, type ModelCapabilities,
  type ModelTaskSubmission, type ModelTransport,
} from './transport.js';

/**
 * EXPERIMENTAL, NOT CONTAINED. Deliberately NOT exported from index.ts.
 *
 * Speaks the same `mohassan.execution.local.v1` frames, parsed by the same
 * `parseReady`/`parseResponse` as `LocalProcessModelTransport`, but launches the
 * worker as an ordinary child process. No OS containment evidence exists for this
 * process, so it can never satisfy `LocalModelContainmentAdapter` and must never be
 * wired into runtime routing. It exists only for bounded local demonstrations of an
 * inference-only worker whose output is untrusted data. Generated code still runs
 * only in the AppContainer sandbox, never in this process.
 */
export interface ExperimentalWorkerAcknowledgement {
  readonly mode: 'uncontained-local-demonstration';
  readonly reason: string;
}

export class ExperimentalUncontainedWorkerTransport implements ModelTransport {
  private readonly spec: LocalModelLaunchSpec;
  private readonly used = new Set<string>();

  constructor(config: LocalModelProcessConfig, acknowledgement: ExperimentalWorkerAcknowledgement) {
    if (acknowledgement?.mode !== 'uncontained-local-demonstration' || !acknowledgement.reason?.trim()) {
      throw new ModelTransportError('isolation_unavailable');
    }
    this.spec = validateConfig(config);
  }

  discover(signal: AbortSignal): Promise<ModelCapabilities> {
    return this.run(undefined, signal) as Promise<ModelCapabilities>;
  }

  submit(request: ModelTaskSubmission, signal: AbortSignal): Promise<ModelCandidateResponse> {
    if (this.used.has(request.requestId)) return Promise.reject(new ModelTransportError('duplicate_request'));
    this.used.add(request.requestId);
    return this.run(request, signal) as Promise<ModelCandidateResponse>;
  }

  private run(request: ModelTaskSubmission | undefined, signal: AbortSignal): Promise<ModelCapabilities | ModelCandidateResponse> {
    if (signal.aborted) return Promise.reject(new ModelTransportError('cancelled'));
    const spec = this.spec;
    return new Promise((resolve, reject) => {
      const child = spawn(spec.executable, [...spec.args], {
        cwd: spec.cwd, env: { ...spec.environment }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let pending = '';
      let stdoutBytes = 0;
      let ready: ModelCapabilities | undefined;
      let settled = false;
      const finish = (error: ModelTransportError | undefined, value?: ModelCapabilities | ModelCandidateResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(startup);
        clearTimeout(requestTimer);
        signal.removeEventListener('abort', onAbort);
        if (child.exitCode === null) child.kill();
        if (error) reject(error); else resolve(value!);
      };
      const onAbort = () => finish(new ModelTransportError('cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      const startup = setTimeout(() => finish(new ModelTransportError('timeout')), spec.limits.startupTimeoutMs);
      let requestTimer: ReturnType<typeof setTimeout> | undefined;
      child.on('error', () => finish(new ModelTransportError('model_process_failure')));
      child.on('close', () => finish(new ModelTransportError('model_process_failure')));
      child.stderr.on('data', () => undefined); // drained, never retained or logged
      child.stdout.on('data', (chunk: Buffer) => {
        try {
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > spec.limits.maxOutputBytes) throw new ModelTransportError('resource_exhaustion');
          pending += chunk.toString('utf8');
          for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (line.length > spec.limits.maxMessageBytes) throw new ModelTransportError('invalid_model_output');
            const raw = JSON.parse(line) as unknown;
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ModelTransportError('invalid_model_output');
            if (!ready) {
              ready = parseReady(raw as Record<string, unknown>, spec);
              clearTimeout(startup);
              if (!request) { child.stdin.end(); return finish(undefined, ready); }
              if (!ready.capabilities.includes(request.capability)) throw new ModelTransportError('unsupported_capability');
              requestTimer = setTimeout(() => finish(new ModelTransportError('timeout')), spec.limits.requestTimeoutMs);
              // Exactly one write; never re-sent.
              child.stdin.end(JSON.stringify({ protocol: LOCAL_MODEL_PROTOCOL, kind: 'generate', identity: spec.identity, ...request }) + '\n');
            } else {
              if (!request) throw new ModelTransportError('invalid_model_output');
              return finish(undefined, parseResponse(raw as Record<string, unknown>, request, spec));
            }
          }
        } catch (error) {
          finish(error instanceof ModelTransportError ? error : new ModelTransportError('invalid_model_output'));
        }
      });
    });
  }
}
