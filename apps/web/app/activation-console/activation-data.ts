import { ActivationConsoleSnapshotSchema, type ActivationConsoleSnapshot } from '@mohassan/contracts';

export const activationPath = '/api/activation-console';

export type ActivationState =
  | { kind: 'loading' | 'error' | 'signin' | 'forbidden' }
  | { kind: 'ready'; snapshot: ActivationConsoleSnapshot };

export async function requestActivationConsole(path: string | URL, options: RequestInit = {}): Promise<ActivationState> {
  try {
    const response = await fetch(path, { ...options, cache: 'no-store', redirect: 'error' });
    if (response.status === 401) return { kind: 'signin' };
    if (response.status === 403) return { kind: 'forbidden' };
    if (!response.ok) return { kind: 'error' };
    const snapshot = ActivationConsoleSnapshotSchema.safeParse(await response.json());
    return snapshot.success ? { kind: 'ready', snapshot: snapshot.data } : { kind: 'error' };
  } catch {
    return { kind: 'error' };
  }
}
