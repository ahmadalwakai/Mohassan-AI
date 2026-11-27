import type { ChatConversationSummary } from '@mohassan/contracts';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { z } from 'zod';

// Legacy page size and chat input bound, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/command-chat.ts#L1148
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/packages/contracts/src/command-chat.ts#L261
const pageSize = 60;
const querySchema = z.object({
  cursor: z.base64url().min(1).max(256).optional(),
  limit: z.string().regex(/^\d+$/u).transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
  q: z.string().trim().max(4000).regex(/^[^\0]*$/u).optional(),
});

const positionSchema = z.tuple([z.iso.datetime({ precision: 6 }).refine(at => !at.startsWith('0000')), z.uuid()]);

function readPosition(cursor: string) {
  let position: unknown;
  try {
    position = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    position = null;
  }
  return positionSchema.parse(position);
}

// Unicode 17.0.0, retrieved 2026-11-27. Mark ranges are the intersection of General_Category=M
// and Arabic in Script or Script_Extensions. NFKD decomposes seated hamzas into a letter and a mark.
// https://www.unicode.org/Public/17.0.0/ucd/UnicodeData.txt
// https://www.unicode.org/Public/17.0.0/ucd/Scripts.txt
// https://www.unicode.org/Public/17.0.0/ucd/ScriptExtensions.txt
const arabicMarks = '[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc\u06df-\u06e4\u06e7-\u06e8\u06ea-\u06ed'
  + '\u0897-\u089f\u08ca-\u08e1\u08e3-\u08ff\u{102e0}\u{10efa}-\u{10eff}]';

function normalizedTitle(text: string | RawBuilder<string>) {
  return sql<string>`translate(regexp_replace(lower(normalize(${text}, NFKD)) COLLATE "C", ${arabicMarks}, '', 'g'),
    'ٱٲٳةىـءٴ', 'اااهي')`;
}

interface ConversationRow {
  id: string;
  title: string;
  status: ChatConversationSummary['status'];
  updated_at: Date | string;
  browser_account: string | null;
}

export async function listConversationRows(db: Kysely<any>, ownerId: string, rawQuery: unknown = {}): Promise<{
  rows: ConversationRow[];
  nextCursor?: string | null;
}> {
  const { cursor, limit, q } = querySchema.parse(rawQuery);
  const owned = db.selectFrom('chat_conversations').select(['id', 'title', 'status', 'updated_at', 'browser_account'])
    .where('owner_id', '=', ownerId).orderBy('updated_at', 'desc');
  if (cursor === undefined && limit === undefined && q === undefined) return { rows: await owned.limit(pageSize).execute() };

  // Preserve the six fractional digits of timestamptz. PostgreSQL formatting reference, retrieved 2026-11-27.
  // https://www.postgresql.org/docs/18/functions-formatting.html
  let page = owned.orderBy('id', 'desc').select(sql<string>`to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('cursor_at'));
  if (cursor !== undefined) {
    const [updatedAt, id] = readPosition(cursor);
    page = page.where(sql<boolean>`(updated_at, id) < (${updatedAt}::timestamptz, ${id})`);
  }
  if (q) page = page.where(sql<boolean>`strpos(${normalizedTitle(sql.ref('title'))}, nullif(${normalizedTitle(q)}, '')) > 0`);

  const size = limit ?? pageSize;
  const rows = await page.limit(size + 1).execute();
  const visible = rows.slice(0, size);
  const last = visible.at(-1);
  const nextCursor = rows.length > size && last ? Buffer.from(JSON.stringify([last.cursor_at, last.id])).toString('base64url') : null;
  return { rows: visible, nextCursor };
}
