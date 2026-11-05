/**
 * Credentials the owner gives during a task. They live only in this process's
 * memory, only for one site, and are wiped as soon as the sign-in finishes.
 */
export interface VaultEntry {
  site: string;
  username?: string;
  password?: string;
  code?: string;
  expiresAt: number;
}

const LIFETIME_MS = 10 * 60000;
const MINIMUM_SCRUB_LENGTH = 4;

export class CredentialVault {
  private entries = new Map<string, VaultEntry>();

  put(conversationId: string, site: string, values: Pick<VaultEntry, 'username' | 'password' | 'code'>): void {
    const existing = this.read(conversationId);
    const previous = existing?.site === site ? existing : undefined;
    this.entries.set(conversationId, { ...previous, ...values, site, expiresAt: Date.now() + LIFETIME_MS });
  }

  private read(conversationId: string): VaultEntry | undefined {
    const entry = this.entries.get(conversationId);
    if (entry && entry.expiresAt <= Date.now()) {
      this.entries.delete(conversationId);
      return undefined;
    }
    return entry;
  }

  /** Returns credentials only for the exact site they were entered for. */
  forSite(conversationId: string, site: string): VaultEntry | undefined {
    const entry = this.read(conversationId);
    return entry?.site === site ? entry : undefined;
  }

  takeCode(conversationId: string, site: string): string | undefined {
    const entry = this.forSite(conversationId, site);
    const code = entry?.code;
    if (entry) delete entry.code;
    return code;
  }

  clear(conversationId: string): void {
    this.entries.delete(conversationId);
  }

  clearAll(): void {
    this.entries.clear();
  }

  /** A site can echo a typed value back; it must not reach the model. */
  scrub(conversationId: string, text: string): string {
    const entry = this.entries.get(conversationId);
    let result = text;
    for (const secret of [entry?.password, entry?.code]) {
      if (secret && secret.length >= MINIMUM_SCRUB_LENGTH) result = result.split(secret).join('[محجوب]');
    }
    return result;
  }
}
