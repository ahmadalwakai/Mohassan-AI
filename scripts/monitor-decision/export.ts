import { createHash } from 'node:crypto';
import { access, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createDatabase } from '@mohassan/database';
import dotenv from 'dotenv';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { MONITOR_EXCLUSION_SHA256 } from '../../apps/server/src/monitors/decision/exclusion.js';
import { MonitorDecisionSnapshotSchema } from '../../apps/server/src/monitors/decision/features.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const Decision = z.enum(['approved', 'declined', 'stopped_early', 'alert_helpful', 'alert_unhelpful']);

export async function writeMonitorDecisionExport(db: Kysely<any>, ownerId: string, output: string, source: 'human' | 'pipeline-check') {
  const owner = await db.selectFrom('workspace_owner').select('id').where('id', '=', 1).where('owner_id', '=', ownerId).executeTakeFirst();
  if (!owner) throw new Error('A primary owner account is required.');

  const { rows } = await sql<{
    decision: string; decision_at: Date; proposed_at: Date; conversation_id: string; monitor_id: string; features: unknown;
  }>`
    WITH outcomes AS (
      SELECT user_id, monitor_id, event_key, decision, happened_at
      FROM smart_monitor_decisions WHERE event_key <> 'proposal'
      UNION ALL
      SELECT feedback.user_id, notice.monitor_id, 'alert:' || feedback.alert_id,
             CASE feedback.rating WHEN 'helpful' THEN 'alert_helpful' ELSE 'alert_unhelpful' END,
             feedback.updated_at
      FROM monitor_alert_feedback AS feedback
      JOIN chat_notifications AS notice ON notice.task_id = feedback.alert_id AND notice.user_id = feedback.user_id
      WHERE notice.monitor_id IS NOT NULL AND notice.background_outcome = 'completed'
    )
    SELECT event.decision, event.happened_at AS decision_at, proposal.happened_at AS proposed_at,
           monitor.conversation_id, event.monitor_id, proposal.features
    FROM outcomes AS event
    JOIN smart_monitor_decisions AS proposal ON proposal.monitor_id = event.monitor_id
      AND proposal.user_id = event.user_id AND proposal.event_key = 'proposal'
    JOIN smart_monitors AS monitor ON monitor.id = proposal.monitor_id AND monitor.user_id = proposal.user_id
    LEFT JOIN workspace_members AS member ON member.user_id = event.user_id
    LEFT JOIN smart_monitor_v2_preferences AS prefs ON prefs.user_id = event.user_id
    WHERE (event.user_id = ${ownerId}
      OR (member.role = 'member' AND member.disabled_at IS NULL AND prefs.decision_recording))
      AND NOT EXISTS (SELECT 1 FROM member_deletion_requests AS deletion WHERE deletion.user_id = event.user_id)
    ORDER BY event.happened_at, event.monitor_id, event.event_key`.execute(db);

  const content = rows.map(row => JSON.stringify({
    ...MonitorDecisionSnapshotSchema.parse(row.features),
    decision: Decision.parse(row.decision), decisionAt: new Date(row.decision_at).toISOString(),
    proposedAt: new Date(row.proposed_at).toISOString(),
    conversationKey: sha256(`monitor-conversation:${row.conversation_id}`), monitorKey: sha256(`monitor:${row.monitor_id}`),
  }) + '\n').join('');
  const manifest = { version: 1, source, rows: rows.length, sha256: sha256(content), v2ExclusionSha256: MONITOR_EXCLUSION_SHA256 };
  await writeFile(output, content, { flag: 'wx', mode: 0o600 });
  try {
    await writeFile(`${output}.manifest.json`, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await unlink(output);
    throw error;
  }
  return manifest;
}

async function main() {
  const { values } = parseArgs({ options: { 'owner-id': { type: 'string' }, out: { type: 'string' }, 'database-dir': { type: 'string' } } });
  if (!values['owner-id'] || !values.out) throw new Error('Both --owner-id and --out are required.');
  dotenv.config({ quiet: true });
  const connectionString = values['database-dir'] || process.env.MOHASSAN_LOCAL_LAB === '1' ? undefined : process.env.DATABASE_URL;
  const dataDir = connectionString ? undefined : resolve(values['database-dir'] ?? process.env.DATA_DIR ?? '.data/postgres');
  if (dataDir) await access(dataDir);
  const database = await createDatabase({ connectionString, dataDir });
  try {
    console.log(JSON.stringify(await writeMonitorDecisionExport(database.db, values['owner-id'], resolve(values.out), 'human')));
  } finally {
    await database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  catch {
    console.error('Monitor decision export failed. Check the owner ID, database configuration, migration, and fresh output path.');
    process.exitCode = 1;
  }
}
