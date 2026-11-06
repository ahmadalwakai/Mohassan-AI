/**
 * Credentials the owner gives during a task. They live only in this process's
 * memory, only for one exact origin. Reusable values are removed after sign-in;
 * redaction-only copies expire after ten minutes or when the run finishes.
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
  // Consumed values cannot be reused for authentication; retain them briefly
  // only to redact a site's echo until the run finishes or the entry expires.
  private redactions = new Map<string, { values: Set<string>; expiresAt: number }>();

  put(conversationId: string, site: string, values: Pick<VaultEntry, 'username' | 'password' | 'code'>): void {
    const existing = this.read(conversationId);
    const previous = existing?.site === site ? existing : undefined;
    this.entries.set(conversationId, { ...previous, ...values, site, expiresAt: Date.now() + LIFETIME_MS });
    const redactions = this.redactions.get(conversationId)?.values ?? new Set<string>();
    for (const value of [values.password, values.code]) if (value) redactions.add(value);
    this.redactions.set(conversationId, { values: redactions, expiresAt: Date.now() + LIFETIME_MS });
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
    this.redactions.clear();
  }

  forget(conversationId: string): void { this.clear(conversationId); this.redactions.delete(conversationId); }
  hasRedactions(conversationId: string): boolean { const value = this.redactions.get(conversationId); return Boolean(value && value.expiresAt > Date.now() && value.values.size); }

  scrubValue<T>(conversationId:string,value:T):T {
    if(typeof value==='string')return this.scrub(conversationId,value) as T;
    if(Array.isArray(value))return value.map(item=>this.scrubValue(conversationId,item)) as T;
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,this.scrubValue(conversationId,item)])) as T;
    return value;
  }

  /** A site can echo a typed value back; it must not reach the model. */
  scrub(conversationId: string, text: string): string {
    const entry = this.read(conversationId);
    const remembered = this.redactions.get(conversationId);
    if (remembered && remembered.expiresAt <= Date.now()) this.redactions.delete(conversationId);
    let result = text;
    for (const secret of [entry?.password, entry?.code, ...(remembered && remembered.expiresAt > Date.now() ? remembered.values : [])]) {
      if (secret && secret.length >= MINIMUM_SCRUB_LENGTH) result = result.split(secret).join('[محجوب]');
    }
    return result;
  }
}
