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

/** Deploys a static site as its own Vercel project through the REST API (POST /v13/deployments with inline files). */
export function createVercelPublisher(options: VercelPublisherOptions): SitePublisher {
  const call = options.fetch ?? fetch;
  const prefix = options.projectPrefix ?? 'mohassan-site';
  const query = (extra: Record<string, string> = {}) => { const params = new URLSearchParams({ ...(options.teamId ? { teamId: options.teamId } : {}), ...extra }); const text = params.toString(); return text ? `?${text}` : ''; };
  const headers = () => ({ Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' });
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
      const created = await call(`https://api.vercel.com/v13/deployments${query({ skipAutoDetectionConfirmation: '1', forceNew: '1' })}`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal });
      const payload = await created.json().catch(() => null) as { id?: string; url?: string; readyState?: string; alias?: string[]; error?: { code?: string; message?: string } } | null;
      if (!created.ok || !payload?.id) throw new PublishError('PUBLISH_REJECTED', `رفض Vercel النشر${payload?.error?.message ? `: ${payload.error.message}` : ''}.`, created.status === 401 || created.status === 403 ? 403 : 424);
      const deadline = Date.now() + (options.timeoutMs ?? 120_000);
      let state = payload.readyState ?? 'QUEUED', url = payload.url ?? '', alias = payload.alias ?? [];
      while (!['READY', 'ERROR', 'CANCELED'].includes(state)) {
        if (Date.now() > deadline) throw new PublishError('PUBLISH_TIMEOUT', 'لم يكتمل النشر على Vercel في الوقت المحدد؛ تحقق من لوحة Vercel.', 424);
        await new Promise(resolvePromise => setTimeout(resolvePromise, options.pollMs ?? 2000));
        signal?.throwIfAborted();
        const check = await call(`https://api.vercel.com/v13/deployments/${payload.id}${query()}`, { headers: headers(), signal });
        const status = await check.json().catch(() => null) as { readyState?: string; url?: string; alias?: string[]; error?: { message?: string } } | null;
        if (!check.ok || !status) throw new PublishError('PUBLISH_STATUS_FAILED', 'تعذر قراءة حالة النشر من Vercel.', 424);
        state = status.readyState ?? state; url = status.url ?? url; alias = status.alias ?? alias;
      }
      if (state !== 'READY') throw new PublishError('PUBLISH_FAILED', 'فشل بناء الموقع على Vercel.', 424);
      const publicUrl = alias.find(item => item.endsWith('.vercel.app')) ?? `${project}.vercel.app`;
      return { url: `https://${publicUrl}`, reference: payload.id, provider: 'vercel' };
    },
  };
}

/** No publishing configured: the site stays a preview and a ZIP. */
export const noPublisher: SitePublisher = { kind: 'none', available: () => false, publish: async () => { throw new PublishError('PUBLISH_NOT_CONFIGURED', 'النشر غير مهيأ على هذا الخادم؛ حمّل الموقع كملف ZIP أو اطلب من المالك تفعيل النشر.', 409); } };
