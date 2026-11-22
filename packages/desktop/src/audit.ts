import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AuditEntry {
  at: string;
  kind: string;
  detail: Record<string, unknown>;
  ok: boolean;
}

/** Every desktop action lands in one JSON-lines file; the panel shows the latest entries. */
export class DesktopAudit {
  constructor(private readonly file: string) {}

  async record(kind: string, detail: Record<string, unknown>, ok = true): Promise<AuditEntry> {
    const entry: AuditEntry = { at: new Date().toISOString(), kind, detail, ok };
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  }

  async recent(limit = 50): Promise<AuditEntry[]> {
    let text: string;
    try { text = await readFile(this.file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const lines = text.split(/\r?\n/u).filter(Boolean).slice(-Math.max(1, Math.min(limit, 500)));
    const entries: AuditEntry[] = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line) as AuditEntry); } catch { /* a torn line at the end of the file */ }
    }
    return entries.reverse();
  }
}
