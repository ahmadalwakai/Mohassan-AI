/**
 * Phase 0: write and read time of the embedded database the lab uses (docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §5.1).
 *
 * Usage: npx tsx scripts/perf/db-write.ts [--out artifacts/perf/2026-11-22/db-write]
 *
 * A fresh PGlite folder in the temp directory (the same engine and version as `.data/local-lab/postgres`),
 * the chat tables' shape, then 300 single-row write transactions like a chat step event, and 300 reads
 * shaped like the conversation detail. Production (Neon over the network) is not measured here.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { stats } from './fixture.js';

const argument = (name: string, fallback: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback; };
const out = path.resolve(argument('out', path.join('artifacts', 'perf', '2026-11-22', 'db-write')));
await mkdir(out, { recursive: true });
const directory = await mkdtemp(path.join(tmpdir(), 'mohassan-perf-pglite-'));
const opened = performance.now();
const db = new PGlite(directory);
await db.waitReady;
const openMs = performance.now() - opened;
await db.exec(`CREATE TABLE chat_conversations(id text PRIMARY KEY,owner_id text NOT NULL,title text NOT NULL,status text NOT NULL DEFAULT 'idle',progress text,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE chat_messages(id text PRIMARY KEY,conversation_id text NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,role text NOT NULL,text text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE chat_events(id text PRIMARY KEY,conversation_id text NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,run_id text,kind text NOT NULL,message text NOT NULL,data jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX chat_events_conversation_idx ON chat_events(conversation_id,created_at DESC);`);
const conversation = randomUUID(), run = randomUUID();
await db.query('INSERT INTO chat_conversations(id,owner_id,title) VALUES ($1,$2,$3)', [conversation, 'owner', 'قياس']);
for (let i = 0; i < 20; i++) await db.query('INSERT INTO chat_messages(id,conversation_id,role,text) VALUES ($1,$2,$3,$4)', [randomUUID(), conversation, i % 2 ? 'assistant' : 'user', 'نص رسالة للقياس '.repeat(8)]);
const write: number[] = [], progress: number[] = [], read: number[] = [];
for (let i = 0; i < 300; i++) {
  let started = performance.now();
  await db.transaction(async tx => { await tx.query('INSERT INTO chat_events(id,conversation_id,run_id,kind,message) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), conversation, run, 'step', `خطوة ${i}: يقرأ الصفحة…`]); });
  write.push(performance.now() - started);
  started = performance.now();
  await db.transaction(async tx => { await tx.query('UPDATE chat_conversations SET progress=$1,updated_at=now() WHERE id=$2', [`يقرأ ${i}…`, conversation]); });
  progress.push(performance.now() - started);
  started = performance.now();
  await db.query('SELECT * FROM chat_conversations WHERE id=$1', [conversation]);
  await db.query('SELECT * FROM chat_messages WHERE conversation_id=$1 ORDER BY created_at ASC, id ASC LIMIT 300', [conversation]);
  await db.query("SELECT id,message,created_at FROM chat_events WHERE run_id=$1 AND kind='step' ORDER BY created_at DESC LIMIT 40", [run]);
  read.push(performance.now() - started);
}
await db.close();
await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
const result = { at: new Date().toISOString(), engine: 'PGlite (embedded, file-backed in temp)', openMs: Math.round(openMs),
  insertStepTransactionMs: stats(write.slice(20)), updateProgressTransactionMs: stats(progress.slice(20)), detailReadMs: stats(read.slice(20)),
  note: 'first 20 of 300 dropped as warm-up' };
await writeFile(path.join(out, 'db-write.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 1));
