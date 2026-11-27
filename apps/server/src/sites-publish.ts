import { setTimeout as delay } from 'node:timers/promises';
import type { SiteFile } from '@mohassan/sites';

/**
 * Publishing adapters for generated sites. The owner chose Vercel (2026-11-22): a hosting API with the
 * owner's own token, not a model. Everything a publisher needs is the slug and the files.
 */
export interface PublishResult { url: string; reference: string; provider: string }
export interface SitePublisher {
  readonly kind: string;
  available(): boolean;
  publish(input: { slug: string; files: SiteFile[] }, signal?: AbortSignal): Promise<PublishResult>;
}
/** 4xx codes on purpose: the API maps 5xx to a generic message, and these messages tell the user what to do. */
export class PublishError extends Error { constructor(public readonly code: string, message: string, public readonly statusCode = 424) { super(message); this.name = 'PublishError'; } }

export interface VercelPublisherOptions { token?: string; teamId?: string; fetch?: typeof fetch; projectPrefix?: string; pollMs?: number; timeoutMs?: number }

interface DeploymentPayload {
  id?: string;
  readyState?: string;
  alias?: string[];
  error?: { message?: string };
}

function publishTimeout() {
  return new PublishError('PUBLISH_TIMEOUT', 'لم يكتمل النشر على Vercel في الوقت المحدد؛ تحقق من لوحة Vercel.');
}

/** Deploys a static site as its own Vercel project through the REST API (POST /v13/deployments with inline files). */
export function createVercelPublisher(options: VercelPublisherOptions): SitePublisher {
  const call = options.fetch ?? fetch;
  const prefix = options.projectPrefix ?? 'mohassan-site';
  const timeoutMs = options.timeoutMs ?? 120_000;
  // Leave at least half of the deployment budget after the initial request for status polling.
  const requestTimeoutMs = Math.floor(timeoutMs / 2);
  const query = (extra: Record<string, string> = {}) => { const params = new URLSearchParams({ ...(options.teamId ? { teamId: options.teamId } : {}), ...extra }); const text = params.toString(); return text ? `?${text}` : ''; };
  const headers = () => ({ Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' });

  async function requestDeployment(url: string, init: RequestInit, deploymentSignal: AbortSignal) {
    deploymentSignal.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(publishTimeout()), requestTimeoutMs);
    const signal = AbortSignal.any([deploymentSignal, timeout.signal]);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const exchange = async () => {
      const response = await call(url, { ...init, signal });
      signal.throwIfAborted();
      const payload = await response.json().catch(() => null) as DeploymentPayload | null;
      signal.throwIfAborted();
      return { response, payload };
    };
    try {
      return await Promise.race([aborted, exchange()]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  return {
    kind: 'vercel',
    available: () => Boolean(options.token),
    async publish({ slug, files }, signal) {
      if (!options.token) throw new PublishError('PUBLISH_NOT_CONFIGURED', 'النشر على Vercel غير مهيأ: أضف VERCEL_TOKEN إلى إعدادات الخادم.', 409);
      const project = `${prefix}-${slug}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 90).replace(/-$/, '');
      const body = {
        name: project,
        project,
        target: 'production',
        projectSettings: { framework: null },
        files: files.map(file => ({ file: file.path, data: (typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : Buffer.from(file.content)).toString('base64'), encoding: 'base64' })),
      };
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(publishTimeout()), timeoutMs);
      const deploymentSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      try {
        const { response: created, payload } = await requestDeployment(`https://api.vercel.com/v13/deployments${query({ skipAutoDetectionConfirmation: '1', forceNew: '1' })}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) }, deploymentSignal);
        if (!created.ok || !payload?.id) throw new PublishError('PUBLISH_REJECTED', `رفض Vercel النشر${payload?.error?.message ? `: ${payload.error.message}` : ''}.`, created.status === 401 || created.status === 403 ? 403 : 424);
        let state = payload.readyState ?? 'QUEUED', alias = payload.alias ?? [];
        while (!['READY', 'ERROR', 'CANCELED'].includes(state)) {
          await delay(options.pollMs ?? 2000, undefined, { signal: deploymentSignal });
          const { response: check, payload: status } = await requestDeployment(`https://api.vercel.com/v13/deployments/${payload.id}${query()}`, { headers: headers() }, deploymentSignal);
          if (!check.ok || !status) throw new PublishError('PUBLISH_STATUS_FAILED', 'تعذر قراءة حالة النشر من Vercel.');
          state = status.readyState ?? state;
          alias = status.alias ?? alias;
        }
        if (state !== 'READY') throw new PublishError('PUBLISH_FAILED', 'فشل بناء الموقع على Vercel.');
        const publicUrl = alias.find(item => item.endsWith('.vercel.app')) ?? `${project}.vercel.app`;
        return { url: `https://${publicUrl}`, reference: payload.id, provider: 'vercel' };
      } catch (error) {
        if (signal?.aborted) throw new PublishError('PUBLISH_ABORTED', 'انقطع الاتصال قبل اكتمال النشر.', 499);
        deadline.signal.throwIfAborted();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** No publishing configured: the site stays a preview and a ZIP. */
export const noPublisher: SitePublisher = { kind: 'none', available: () => false, publish: async () => { throw new PublishError('PUBLISH_NOT_CONFIGURED', 'النشر غير مهيأ على هذا الخادم؛ حمّل الموقع كملف ZIP أو اطلب من المالك تفعيل النشر.', 409); } };
