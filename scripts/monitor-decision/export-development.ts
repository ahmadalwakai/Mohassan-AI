import { createHash } from 'node:crypto';
import { stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createDatabase, type DatabaseHandle } from '@mohassan/database';
import { sql } from 'kysely';
import { z } from 'zod';
import { MONITOR_EXCLUSION_SHA256 } from '../../apps/server/src/monitors/decision/exclusion.js';
import { MonitorDecisionSnapshotSchema } from '../../apps/server/src/monitors/decision/features.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const Decision = z.enum(['approved', 'declined', 'stopped_early', 'alert_helpful', 'alert_unhelpful']);

export function parseDevelopmentExportWindow(from: string, until: string) {
  const start = new Date(from);
  const end = new Date(until);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())
      || start.toISOString() !== from || end.toISOString() !== until || start >= end) {
    throw new Error('Use an increasing UTC window with ISO 8601 millisecond timestamps.');
  }
  return { start: from, end: until };
}

async function readDevelopmentWindow(
  db: DatabaseHandle['db'], ownerId: string, from: string, until: string,
) {
  const owner = await db.selectFrom('workspace_owner').select('id').where('id', '=', 1)
    .where('owner_id', '=', ownerId).executeTakeFirst();
  if (!owner) throw new Error('A primary owner account is required.');

  return sql<{
    decision: string; decision_at: Date; proposed_at: Date; conversation_id: string; monitor_id: string; features: unknown;
  }>`
    WITH outcomes AS (
      SELECT user_id, monitor_id, event_key, decision, happened_at
      FROM smart_monitor_decisions
      WHERE event_key <> 'proposal' AND happened_at >= ${from} AND happened_at < ${until}
      UNION ALL
      SELECT feedback.user_id, notice.monitor_id, 'alert:' || feedback.alert_id,
             CASE feedback.rating WHEN 'helpful' THEN 'alert_helpful' ELSE 'alert_unhelpful' END,
             feedback.updated_at
      FROM monitor_alert_feedback AS feedback
      JOIN chat_notifications AS notice ON notice.task_id = feedback.alert_id AND notice.user_id = feedback.user_id
      WHERE notice.monitor_id IS NOT NULL AND notice.background_outcome = 'completed'
        AND feedback.updated_at >= ${from} AND feedback.updated_at < ${until}
    )
    SELECT event.decision, event.happened_at AS decision_at, proposal.happened_at AS proposed_at,
           monitor.conversation_id, event.monitor_id, proposal.features
    FROM outcomes AS event
    JOIN smart_monitor_decisions AS proposal ON proposal.monitor_id = event.monitor_id
      AND proposal.user_id = event.user_id AND proposal.event_key = 'proposal'
      AND proposal.happened_at >= ${from} AND proposal.happened_at < ${until}
    JOIN smart_monitors AS monitor ON monitor.id = proposal.monitor_id AND monitor.user_id = proposal.user_id
    LEFT JOIN workspace_members AS member ON member.user_id = event.user_id
    LEFT JOIN smart_monitor_v2_preferences AS prefs ON prefs.user_id = event.user_id
    WHERE (event.user_id = ${ownerId}
      OR (member.role = 'member' AND member.disabled_at IS NULL AND prefs.decision_recording))
      AND NOT EXISTS (SELECT 1 FROM member_deletion_requests AS deletion WHERE deletion.user_id = event.user_id)
    ORDER BY event.happened_at, event.monitor_id, event.event_key`.execute(db);
}

export async function writeDevelopmentDecisionExport(
  database: Pick<DatabaseHandle, 'db' | 'mode'>, ownerId: string, output: string, from: string, until: string,
) {
  const trialWindow = parseDevelopmentExportWindow(from, until);
  const { db, mode } = database;
  const { rows } = mode === 'postgres'
    ? await db.transaction().setAccessMode('read only').execute(tx => readDevelopmentWindow(tx, ownerId, from, until))
    : await readDevelopmentWindow(db, ownerId, from, until);
  const content = rows.map(row => JSON.stringify({
    ...MonitorDecisionSnapshotSchema.parse(row.features),
    decision: Decision.parse(row.decision), decisionAt: new Date(row.decision_at).toISOString(),
    proposedAt: new Date(row.proposed_at).toISOString(),
    conversationKey: sha256(`monitor-conversation:${row.conversation_id}`), monitorKey: sha256(`monitor:${row.monitor_id}`),
  }) + '\n').join('');
  const manifest = {
    version: 1, source: 'human', rows: rows.length, sha256: sha256(content),
    v2ExclusionSha256: MONITOR_EXCLUSION_SHA256, trialWindow,
  };
  await writeFile(output, content, { flag: 'wx', mode: 0o600 });
  try {
    await writeFile(`${output}.manifest.json`, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await unlink(output);
    throw error;
  }
  return manifest;
}

export function parseDevelopmentExportArgs(args: string[]) {
  const { values } = parseArgs({ args, options: {
    'database-dir': { type: 'string' }, 'database-url': { type: 'string' }, 'owner-id': { type: 'string' },
    out: { type: 'string' }, from: { type: 'string' }, until: { type: 'string' },
  } });
  const { 'database-dir': directory, 'database-url': connectionString, 'owner-id': owner, out, from, until } = values;
  if ((directory === undefined) === (connectionString === undefined) || directory === '') {
    throw new Error('Provide exactly one of --database-dir and --database-url.');
  }
  if (!owner || !out || !from || !until) {
    throw new Error('--owner-id, --out, --from, and --until are required.');
  }
  parseDevelopmentExportWindow(from, until);
  if (directory !== undefined) return { databaseOptions: { dataDir: resolve(directory) }, owner, out, from, until };

  const target = URL.parse(connectionString ?? '');
  if (!target || !['postgres:', 'postgresql:'].includes(target.protocol) || !target.hostname || target.pathname.length < 2) {
    throw new Error('Provide a PostgreSQL URL with a host and database name.');
  }
  return { databaseOptions: { connectionString }, owner, out, from, until };
}

async function main() {
  const { databaseOptions, owner, out, from, until } = parseDevelopmentExportArgs(process.argv.slice(2));
  if (databaseOptions.dataDir && !(await stat(databaseOptions.dataDir)).isDirectory()) {
    throw new Error('Use an existing local PGlite snapshot directory.');
  }
  const database = await createDatabase(databaseOptions);
  try {
    console.log(JSON.stringify(await writeDevelopmentDecisionExport(database, owner, resolve(out), from, until)));
  } finally {
    await database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  catch {
    console.error('Development export failed. Provide exactly one explicit connection via --database-url or --database-dir. Check the primary owner, UTC window and fresh output path.');
    process.exitCode = 1;
  }
}
