import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Kysely } from 'kysely';
import { PDFDocument } from 'pdf-lib';
import { memberDocumentLocation } from '../../apps/server/src/member-data-document-path.ts';
import { MEMBER_EXPORT_MAX_BYTES } from '../../apps/server/src/member-data-export.ts';

export async function addOversizedMemberDocument(db: Kysely<any>, documentsDir: string, accountId: string) {
  const id = randomUUID();
  const name = 'oversized member export.pdf';
  const path = memberDocumentLocation(documentsDir, accountId, id)!;
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const byteCount = MEMBER_EXPORT_MAX_BYTES + 1;
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, 'wx');
  try {
    await file.writeFile(await pdf.save());
    await file.truncate(byteCount);
  } finally {
    await file.close();
  }
  const checksum = createHash('sha256');
  for await (const chunk of createReadStream(path)) checksum.update(chunk);
  const hash = checksum.digest('hex');

  // Seed the stored PDF so the test only exercises the independent archive limit.
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/documents.ts#L44 (retrieved 2026-11-27).
  await db.insertInto('pdf_documents').values({ id, owner_id: accountId, name, path,
    source: 'uploaded', pages: pdf.getPageCount(), byte_count: byteCount, content_hash: hash }).execute();
  return { id, name, byteCount, hash };
}
