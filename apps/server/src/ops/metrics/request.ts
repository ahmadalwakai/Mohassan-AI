import { performance } from 'node:perf_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { conversationSharePaths } from '../../conversation-share-paths.js';
import type { WorkspaceRole } from '../../members.js';

export const METRICS_PATH = '/api/ops/metrics';
export const METRICS_CSV_PATH = '/api/ops/metrics.csv';

type RequestPattern = { method: string; routeOptions: { url?: string } };
type CachedRole<Request = FastifyRequest> = (request: Request) => Promise<WorkspaceRole | null> | undefined;
type RecordRequest = (role: WorkspaceRole, route: string, status: number, durationMs: number) => void;

export function createRequestMetricsHooks<Request extends RequestPattern>(roleFor: CachedRole<Request>, record: RecordRequest) {
  const starts = new WeakMap<Request, number>();

  function start(request: Request) {
    try {
      starts.set(request, performance.now());
    } catch {
      // A collector failure must never change the response.
    }
  }

  async function finish(request: Request, status: number) {
    try {
      const started = starts.get(request);
      if (started === undefined) return;
      // Fastify supplies the registered pattern, including its parameter names.
      // https://fastify.dev/docs/latest/Reference/Request/#routeoptions (retrieved 2026-11-25)
      const pattern = request.routeOptions.url;
      if (!pattern || pattern === METRICS_PATH || pattern === METRICS_CSV_PATH) return;
      // Viewing a public share uses its bearer link even when the viewer has a workspace session.
      if (pattern === conversationSharePaths.public) return;
      const cachedRole = roleFor(request);
      if (!cachedRole) return;
      const durationMs = performance.now() - started;
      const role = await cachedRole;
      if (role === 'owner' || role === 'member') record(role, `${request.method} ${pattern}`, status, durationMs);
    } catch {
      // Keep authorization and collector failures out of the response path.
    }
  }
  return { start, finish };
}

export function registerRequestMetrics(app: FastifyInstance, roleFor: CachedRole, record: RecordRequest) {
  const hooks = createRequestMetricsHooks(roleFor, record);
  app.addHook('onRequest', (request, _reply, done) => { hooks.start(request); done(); });
  app.addHook('onResponse', (request, reply) => hooks.finish(request, reply.statusCode));
}
