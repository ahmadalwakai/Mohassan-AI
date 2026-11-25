import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';

/** Matches the account partition and file names written by documents.ts. */
export function memberDocumentDirectory(documentsDir: string, accountId: string): string {
  const segment = createHash('sha256').update(accountId, 'utf8').digest('hex').slice(0, 32);
  return resolve(documentsDir, segment);
}

export function memberDocumentLocation(documentsDir: string, accountId: string, id: string): string | null {
  if (!z.uuid().safeParse(id).success) return null;
  return resolve(memberDocumentDirectory(documentsDir, accountId), `${id}.pdf`);
}
