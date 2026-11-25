import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync } from 'node:fs';
import { lstat, mkdtemp, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const database = 'mohassan';
const daily = '/var/backups/mohassan/daily';
const status = '/var/lib/mohassan-backup-status';
const pgBin = '/usr/lib/postgresql/18/bin';
const connection = ['--host=/var/run/postgresql', '--port=5432', '--username=postgres', '--no-password'];
const dailyPattern = /^mohassan-[0-9]{4}-[0-9]{2}-[0-9]{2}\.dump$/;
const reportPattern = /^restore-drill-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}\.[0-9]{3}Z\.json$/;

// The first query establishes the repeatable-read snapshot. Keep this session
// open until pg_dump finishes importing and using it.
// https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION (retrieved 2026-11-25)
// https://www.postgresql.org/docs/18/app-pgdump.html (retrieved 2026-11-25)
const beginSnapshot = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;';
const exportSnapshot = `SELECT json_build_object('snapshot', pg_export_snapshot(), 'snapshotAt', to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'serverVersion', current_setting('server_version'));`;

// Migration ledgers at the pinned deployment baseline (retrieved 2026-11-25).
// https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff7/packages/database/src/index.ts#L186-L190
// https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff7/apps/server/src/auth.ts#L4-L8
// Count ordinary and partitioned tables by quoted schema-qualified name. Foreign
// tables, views and system catalogs contain no table rows in the default dump.
const inspectSql = String.raw`
SELECT coalesce(
  'SELECT json_object_agg(name, versions) FROM (' ||
  string_agg(format(
    'SELECT %L::text AS name, coalesce(json_agg(version ORDER BY version COLLATE "C"), ''[]''::json) AS versions FROM %s',
    name, name), ' UNION ALL ') || ') AS migrations',
  $empty$SELECT '{}'::json$empty$)
FROM (VALUES ('public.schema_migrations'), ('public.auth_schema_migrations')) AS ledgers(name)
WHERE to_regclass(name) IS NOT NULL
\gexec
SELECT coalesce(
  'SELECT json_object_agg(name, rows) FROM (' ||
  string_agg(format(
    'SELECT %L::text AS name, count(*)::text AS rows FROM %I.%I',
    format('%I.%I', n.nspname, c.relname), n.nspname, c.relname), ' UNION ALL ') || ') AS counts',
  $empty$SELECT '{}'::json$empty$)
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
\gexec
`;

// Foreign keys at the pinned deployment baseline (retrieved 2026-11-25).
// https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff7/apps/server/src/members.ts#L69-L77
// https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff7/apps/server/src/auth.ts#L10-L25
// https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff7/apps/server/src/command-chat.ts#L365-L371
const integritySql = `
SELECT json_build_object(
  'memberOrphans', (SELECT count(*)::text FROM public.workspace_members AS m
    WHERE NOT EXISTS (SELECT 1 FROM public."user" AS u WHERE u.id = m.user_id)),
  'sessionOrphans', (SELECT count(*)::text FROM public.session AS s
    WHERE NOT EXISTS (SELECT 1 FROM public."user" AS u WHERE u.id = s."userId")),
  'accountOrphans', (SELECT count(*)::text FROM public.account AS a
    WHERE NOT EXISTS (SELECT 1 FROM public."user" AS u WHERE u.id = a."userId")),
  'messageOrphans', (SELECT count(*)::text FROM public.chat_messages AS m
    WHERE NOT EXISTS (SELECT 1 FROM public.chat_conversations AS c WHERE c.id = m.conversation_id))
);
`;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
const isTimestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validMetadata = value =>
  isRecord(value) && isRecord(value.tables) && Object.values(value.tables).every(isCount) &&
  isRecord(value.migrations) && Object.values(value.migrations).every(versions =>
    Array.isArray(versions) && versions.every(version => typeof version === 'string') &&
    new Set(versions).size === versions.length);

function compareEntries(expected, restored, matches) {
  const names = Object.keys(expected);
  const restoredNames = Object.keys(restored);
  return {
    expected: names.length,
    restored: restoredNames.length,
    missing: names.filter(name => !Object.hasOwn(restored, name)).length,
    unexpected: restoredNames.filter(name => !Object.hasOwn(expected, name)).length,
    changed: names.filter(name => Object.hasOwn(restored, name) && !matches(expected[name], restored[name])).length,
  };
}

export function compareMetadata(expected, restored) {
  if (!validMetadata(expected) || !validMetadata(restored)) throw new Error('Invalid backup metadata.');
  const tables = compareEntries(expected.tables, restored.tables, (left, right) => left === right);
  const migrations = compareEntries(expected.migrations, restored.migrations, (left, right) =>
    left.length === right.length && left.every(version => right.includes(version)));
  const passed = [tables, migrations].every(counts => !counts.missing && !counts.unexpected && !counts.changed);
  return { verdict: passed ? 'passed' : 'failed', tables, migrations };
}

export function isDrillDatabaseName(name) {
  const parts = /^mohassan_restore_drill_([0-9]{4})([0-9]{2})([0-9]{2})$/.exec(name);
  if (parts?.[0] !== name) return false;
  const day = `${parts[1]}-${parts[2]}-${parts[3]}`;
  const timestamp = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(timestamp.valueOf()) && timestamp.toISOString().slice(0, 10) === day;
}

function startCommand(program, args, stdio, signal) {
  const child = spawn(program, args, { stdio, signal });
  let failed = false;
  child.on('error', () => { failed = true; });
  child.stdin?.on('error', () => { failed = true; });
  const done = new Promise(resolve => child.once('close', code => resolve(!failed && code === 0)));
  return { child, done };
}

async function runCommand(program, args, { input = 'ignore', sql, output = 'pipe', signal, label = basename(program) } = {}) {
  const { child, done } = startCommand(program, args, [sql === undefined ? input : 'pipe', output, 'ignore'], signal);
  if (sql !== undefined) child.stdin.end(sql);
  let stdout = '';
  child.stdout?.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  if (!(await done)) throw new Error(`${label} failed.`);
  return stdout.trim();
}

function localPgArgs(program, args) {
  return ['-u', 'postgres', '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'PGAPPNAME=mohassan_backup_ops',
    join(pgBin, program), ...connection, ...args];
}

function runPg(program, args, options) {
  return runCommand('/usr/sbin/runuser', localPgArgs(program, args), { label: program, ...options });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON in backup metadata.');
  }
}

async function readJsonLine(lines) {
  const line = await lines.next();
  if (line.done) throw new Error('PostgreSQL did not return backup metadata.');
  return parseJson(line.value);
}

async function createDump(path, startedAt) {
  const { child, done } = startCommand('/usr/sbin/runuser', localPgArgs('psql', [
    '--dbname=' + database, '-XqAt', '-v', 'ON_ERROR_STOP=1',
  ]), ['pipe', 'pipe', 'ignore']);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const rows = lines[Symbol.asyncIterator]();
  try {
    child.stdin.write(`${beginSnapshot}\n${exportSnapshot}\n${inspectSql}\n`);
    const { snapshot, snapshotAt, serverVersion } = await readJsonLine(rows);
    if (typeof snapshot !== 'string' || !isTimestamp(snapshotAt) || typeof serverVersion !== 'string') {
      throw new Error('PostgreSQL did not return a valid backup snapshot.');
    }
    const migrations = await readJsonLine(rows);
    const tables = await readJsonLine(rows);
    if (!validMetadata({ migrations, tables })) throw new Error('Invalid backup metadata.');

    const file = await open(path, 'wx', 0o600);
    try {
      await runPg('pg_dump', [
        '--dbname=' + database, '--format=custom', '--no-owner', '--no-acl', '--snapshot=' + snapshot,
      ], { output: file.fd });
      await file.sync();
    } finally {
      await file.close();
    }

    child.stdin.end('COMMIT;\n');
    if (!(await done)) throw new Error('Snapshot transaction failed.');
    await runCommand(join(pgBin, 'pg_restore'), ['--list', path], { output: 'ignore' });
    const pgDumpVersion = await runCommand(join(pgBin, 'pg_dump'), ['--version']);
    return { ...await dumpDigest(path), pgDumpVersion, serverVersion, startedAt, snapshotAt,
      finishedAt: new Date().toISOString(), migrations, tables };
  } finally {
    lines.close();
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await done;
  }
}

async function safeFile(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`Refusing a nonregular backup file: ${basename(path)}.`);
    return info;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function openDump(path) {
  if (!(await safeFile(path))) throw new Error('Archive is missing.');
  return open(path, 'r');
}

async function digestDump(file, signal) {
  const { size } = await file.stat();
  if (!size) throw new Error('Archive is empty.');
  const hash = createHash('sha256');
  // Positional reads preserve the descriptor's offset for pg_restore's stdin.
  for await (const bytes of file.createReadStream({ start: 0, autoClose: false, signal })) hash.update(bytes);
  return { sha256: hash.digest('hex'), sizeBytes: size };
}

async function dumpDigest(path) {
  const file = await openDump(path);
  try {
    return await digestDump(file);
  } finally {
    await file.close();
  }
}

async function readManifest(path) {
  if (!(await safeFile(path))) throw new Error('Backup manifest is missing.');
  const manifest = parseJson(await readFile(path, 'utf8'));
  if (!validMetadata(manifest) || !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '') ||
      !Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes < 1 ||
      !isTimestamp(manifest.snapshotAt) || !isTimestamp(manifest.finishedAt)) {
    throw new Error('Invalid backup manifest.');
  }
  return manifest;
}

async function checkArchive(dump, manifestPath) {
  const manifest = await readManifest(manifestPath);
  requireMatchingDigest(manifest, await dumpDigest(dump));
  return manifest;
}

function requireMatchingDigest(manifest, { sha256, sizeBytes }) {
  if (sizeBytes !== manifest.sizeBytes || sha256 !== manifest.sha256) throw new Error('Backup archive integrity check failed.');
}

async function syncDirectory(path) {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeJson(path, value, group) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    if (group !== undefined) {
      await file.chown(0, group);
      await file.chmod(0o640);
    }
    await file.sync();
  } finally {
    await file.close();
  }
}

async function statusGroup() {
  for (const path of ['/var', '/var/lib', status]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022)) {
      throw new Error('The backup status directory and its ancestors must be real, root-owned directories.');
    }
    if (path === status) return info.gid;
  }
}

async function publishStatus(name, value, group) {
  const destination = join(status, name);
  await safeFile(destination);
  const temporary = await mkdtemp(join(status, '.backup-'));
  try {
    const source = join(temporary, name);
    await writeJson(source, value, group);
    await rename(source, destination);
    await syncDirectory(status);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function retainedNames(directory, pattern) {
  return (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && pattern.exec(entry.name)?.[0] === entry.name)
    .map(entry => entry.name)
    .sort();
}

async function backup() {
  const group = await statusGroup();
  const startedAt = new Date().toISOString();
  const stem = 'mohassan-' + startedAt.slice(0, 10);
  const dump = join(daily, stem + '.dump');
  const manifestPath = join(daily, stem + '.json');
  await safeFile(dump);
  let manifest;
  if (await safeFile(manifestPath)) {
    manifest = await checkArchive(dump, manifestPath);
  } else {
    const temporary = await mkdtemp(join(daily, '.backup-'));
    try {
      const dumpTemporary = join(temporary, stem + '.dump');
      const manifestTemporary = join(temporary, stem + '.json');
      manifest = await createDump(dumpTemporary, startedAt);
      await writeJson(manifestTemporary, manifest);
      await rename(dumpTemporary, dump);
      await syncDirectory(daily);
      await rename(manifestTemporary, manifestPath);
      await syncDirectory(daily);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  const { snapshotAt, finishedAt, sizeBytes } = manifest;
  await publishStatus('backup.json', { snapshotAt, finishedAt }, group);

  // Only exact daily archive names and their corresponding manifests are retained.
  const names = await retainedNames(daily, dailyPattern);
  for (const old of names.slice(0, -7)) {
    const oldManifest = join(daily, old.replace(/\.dump$/, '.json'));
    const info = await lstat(oldManifest).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (info?.isFile()) await unlink(oldManifest);
    await unlink(join(daily, old));
  }
  console.log(`Backup complete: ${dump} (${sizeBytes} bytes)`);
  await runCommand('/usr/local/sbin/mohassan-backup-publish', [dump, manifestPath], { label: 'Off-server backup publication' });
}

async function verifyRestored(name, manifest, signal) {
  const args = ['--dbname=' + name, '-XqAt', '-v', 'ON_ERROR_STOP=1'];
  const output = await runPg('psql', args, { sql: `${beginSnapshot}\n${inspectSql}\nCOMMIT;\n`, signal });
  const [migrations, tables] = output.split('\n').map(parseJson);
  const comparison = compareMetadata(manifest, { migrations, tables });
  let integrity = null;
  try {
    integrity = parseJson(await runPg('psql', args, { sql: integritySql, signal }));
  } catch {
    // Preserve comparison counts if the integrity query itself fails.
  }
  const passed = comparison.verdict === 'passed' && isRecord(integrity) &&
    Object.values(integrity).every(count => count === '0');
  return { ...comparison, integrity, verdict: passed ? 'passed' : 'failed' };
}

async function drill(requestedName, argCount) {
  const startedAt = new Date().toISOString();
  const name = requestedName ?? 'mohassan_restore_drill_' + startedAt.slice(0, 10).replaceAll('-', '');
  if (argCount > 2 || !isDrillDatabaseName(name)) {
    throw new Error('Restore drill database must be named mohassan_restore_drill_YYYYMMDD with a valid UTC date.');
  }
  const group = await statusGroup();
  // restore-drill.sh holds the daily lock on this descriptor while we open the pair.
  const dailyLock = await lstat(join(daily, '.backup.lock'));
  const inheritedLock = fstatSync(9);
  if (!dailyLock.isFile() || dailyLock.dev !== inheritedLock.dev || dailyLock.ino !== inheritedLock.ino) {
    throw new Error('Run the restore drill through restore-drill.sh.');
  }
  const report = {
    startedAt, finishedAt: null, verdict: 'failed', stage: 'archive', snapshotAt: null,
    recoveryPointAgeSeconds: null, restoreDurationMs: null, verification: null, databaseDropped: null,
  };
  const interruption = new AbortController();
  const terminate = () => interruption.abort();
  process.on('SIGINT', terminate);
  process.on('SIGTERM', terminate);
  const { signal } = interruption;
  let created = false;
  let file;
  try {
    let manifest;
    try {
      const dumpName = (await retainedNames(daily, dailyPattern)).at(-1);
      if (!dumpName) throw new Error('No daily backup was found.');
      const dump = join(daily, dumpName);
      file = await openDump(dump);
      manifest = await readManifest(dump.replace(/\.dump$/, '.json'));
    } finally {
      // Retention may now unlink the original path. The open descriptor still pins its bytes.
      closeSync(9);
    }
    requireMatchingDigest(manifest, await digestDump(file, signal));
    report.snapshotAt = manifest.snapshotAt;
    report.recoveryPointAgeSeconds = Math.max(0, Math.floor((Date.parse(startedAt) - Date.parse(manifest.snapshotAt)) / 1000));
    report.stage = 'create';
    const exists = await runPg('psql', [
      '--dbname=postgres', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-v', 'drill_database=' + name,
    ], { sql: "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = :'drill_database');\n", signal });
    if (exists !== 'f') throw new Error('The restore drill database already exists or could not be checked.');

    signal.throwIfAborted();
    // createdb also fails if another process creates the name after the existence check.
    // Finish the create operation before honoring a stop so cleanup knows if we own it.
    await runPg('createdb', ['--maintenance-db=postgres', '--template=template0', '--', name]);
    created = true;
    report.stage = 'restore';
    const restoreStarted = performance.now();
    try {
      await runPg('pg_restore', [
        '--dbname=' + name, '--single-transaction', '--exit-on-error', '--no-owner', '--no-acl',
      ], { input: file.fd, output: 'ignore', signal });
    } finally {
      report.restoreDurationMs = Math.round(performance.now() - restoreStarted);
    }
    report.stage = 'verify';
    report.verification = await verifyRestored(name, manifest, signal);
    if (report.verification.verdict === 'passed') {
      report.verdict = 'passed';
      report.stage = 'complete';
    }
  } catch (error) {
    console.error(`Restore drill failed during ${report.stage}: ${error.message}`);
  } finally {
    if (created) {
      try {
        await runPg('dropdb', ['--maintenance-db=postgres', '--force', '--', name]);
        report.databaseDropped = true;
      } catch {
        report.verdict = 'failed';
        report.stage = 'drop';
        report.databaseDropped = false;
      }
    }
    await file?.close();
    if (signal.aborted && report.verdict === 'passed') {
      report.verdict = 'failed';
      report.stage = 'interrupted';
    }
    process.off('SIGINT', terminate);
    process.off('SIGTERM', terminate);
  }
  report.finishedAt = new Date().toISOString();
  const nameTime = report.finishedAt.replaceAll(':', '');
  const reportName = 'restore-drill-' + nameTime + '.json';
  await publishStatus(reportName, report, group);
  const names = await retainedNames(status, reportPattern);
  for (const old of names.slice(0, -12)) await unlink(join(status, old));
  console.log(`Restore drill ${report.verdict}: ${reportName} (pg_restore duration: ${report.restoreDurationMs ?? 'unavailable'}${report.restoreDurationMs === null ? '' : ' ms'}).`);
  if (report.verdict !== 'passed') process.exitCode = 1;
}

async function main(args) {
  const [command, first, second] = args;
  if (command === 'backup' && args.length === 1) {
    await backup();
  } else if (command === 'check-archive' && args.length === 3) {
    const { sizeBytes, snapshotAt } = await checkArchive(first, second);
    console.log(JSON.stringify({ verdict: 'passed', sizeBytes, snapshotAt }));
  } else if (command === 'drill') {
    await drill(first, args.length);
  } else if (command === 'verify-production-restore' && args.length === 2) {
    const verification = await verifyRestored(database, await readManifest(first));
    console.log(JSON.stringify(verification));
    if (verification.verdict !== 'passed') process.exitCode = 1;
  } else {
    throw new Error('Invalid backup operations command or arguments.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
