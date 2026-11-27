import { headers } from 'next/headers';
import { forbidden, unauthorized } from 'next/navigation';
import { ActivationConsole } from './activation-console';

type OwnerAccess = 'owner' | 'error' | 'signin' | 'forbidden';

export default async function ActivationConsolePage() {
  const cookie = (await headers()).get('cookie');
  if (!cookie) unauthorized();

  const secret = process.env.INTERNAL_API_SECRET;
  const access = secret ? await ownerAccess(secret, cookie) : 'error';
  if (access === 'signin') unauthorized();
  if (access === 'forbidden') forbidden();
  return <ActivationConsole initialState={{ kind: access === 'owner' ? 'loading' : 'error' }} />;
}

async function ownerAccess(secret: string, cookie: string): Promise<OwnerAccess> {
  try {
    const url = new URL('/api/access', process.env.MOHASSAN_SERVER_URL || 'http://127.0.0.1:4000');
    const response = await fetch(url, {
      cache: 'no-store', redirect: 'error',
      headers: { cookie, 'x-mohassan-internal': secret },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) return 'signin';
    if (response.status === 403) return 'forbidden';
    if (!response.ok) return 'error';
    const access: unknown = await response.json();
    if (!access || typeof access !== 'object' || !('role' in access) || typeof access.role !== 'string') return 'error';
    return access.role === 'owner' ? 'owner' : 'forbidden';
  } catch {
    return 'error';
  }
}
