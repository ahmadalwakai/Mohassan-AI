import { sessionIpPrefix } from './member-sessions.js';

type AuthResponse = { token?: string; session?: { token?: string; ipAddress?: string | null } };

export async function memberAuthResponseBody(response: Response, path: string | undefined) {
  if (!response.ok || (path !== '/api/auth/get-session' && path !== '/api/auth/sign-in/email')) return response.text();

  const result = await response.json() as AuthResponse | null;
  if (result) delete result.token;
  if (result?.session) {
    delete result.session.token;
    if ('ipAddress' in result.session) result.session.ipAddress = sessionIpPrefix(result.session.ipAddress ?? null);
  }
  return JSON.stringify(result);
}
