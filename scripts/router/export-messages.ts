/**
 * Read-only export of the owner's own chat messages for the router model (approved by the owner 2026-11-20).
 * Writes .data/router/messages.jsonl (git-ignored): one user message per line with the previous user message in that conversation.
 * Usage: npx tsx scripts/router/export-messages.ts
 */
import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
const { rows } = await client.query<{ conversation_id: string; role: string; text: string; created_at: Date }>(
  `SELECT m.conversation_id, m.role, m.text, m.created_at FROM chat_messages m
   JOIN chat_conversations c ON c.id = m.conversation_id
   WHERE m.role = 'user' ORDER BY m.conversation_id, m.created_at, m.id`);
await client.end();
const lines: string[] = [];
let conversation = '', previous: string | null = null;
for (const row of rows) {
  if (row.conversation_id !== conversation) { conversation = row.conversation_id; previous = null; }
  const text = row.text.trim();
  if (text) lines.push(JSON.stringify({ text, previous, at: row.created_at.toISOString() }));
  previous = text;
}
await writeFile('.data/router/messages.jsonl', `${lines.join('\n')}\n`);
console.log(`exported ${lines.length} user messages from ${new Set(rows.map(row => row.conversation_id)).size} conversations`);
