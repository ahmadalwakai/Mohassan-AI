import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { ActivationConsole } from './activation-console';

export default async function ActivationConsolePage() {
  const cookie = (await headers()).get('cookie');
  const secret = process.env.INTERNAL_API_SECRET;
  if (!cookie || !secret) notFound();

  const url = new URL('/api/access', process.env.MOHASSAN_SERVER_URL || 'http://127.0.0.1:4000');
  const response = await fetch(url, {
    cache: 'no-store',
    redirect: 'error',
    headers: { cookie, 'x-mohassan-internal': secret },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response?.ok) notFound();

  const access = await response.json().catch(() => null);
  if (access?.role !== 'owner') notFound();
  return <ActivationConsole />;
}
