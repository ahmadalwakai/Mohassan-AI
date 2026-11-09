const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash, randomBytes } = require('node:crypto');

const directory = '/var/backups/mohassan/freellmapi';
const databasePath = '/var/lib/freellmapi/freeapi.db';
const secretPaths = ['/etc/freellmapi/server.env', '/etc/freellmapi/admin.json'];
const completedName = /^freellmapi-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{8}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function regularFile(filename) {
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid source file.');
}

async function backup() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Root on Linux is required.');
  process.umask(0o077);
  for (const ancestor of ['/var', '/var/backups', '/var/backups/mohassan', directory]) {
    const info = await fs.lstat(ancestor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid backup directory.');
  }
  if (await fs.realpath(directory) !== directory) throw new Error('Unexpected backup directory.');
  await fs.chmod(directory, 0o700);
  await regularFile(databasePath);
  const secrets = [];
  for (const filename of secretPaths) {
    await regularFile(filename);
    secrets.push({ filename, bytes: await fs.readFile(filename) });
  }
  const stamp = new Date().toISOString().replace(/:/g, '-');
  const name = `freellmapi-${stamp}-${randomBytes(4).toString('hex')}`;
  const staging = await fs.mkdtemp(path.join(directory, '.pending-'));
  let committed = false;
  let source;
  let check;
  try {
    const Database = createRequire('/opt/freellmapi/app/server/package.json')('better-sqlite3');
    source = new Database(databasePath, { readonly: true, fileMustExist: true });
    await source.backup(path.join(staging, 'freeapi.db'));
    source.close(); source = undefined;
    // Only the new backup copy is writable: normalize it to a self-contained file.
    check = new Database(path.join(staging, 'freeapi.db'), { fileMustExist: true });
    if (check.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') throw new Error('Backup journal mode failed.');
    if (check.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('SQLite integrity check failed.');
    check.close(); check = undefined;
    for (const secret of secrets) {
      await regularFile(secret.filename);
      if (!secret.bytes.equals(await fs.readFile(secret.filename))) throw new Error('Credentials changed during backup.');
      await fs.writeFile(path.join(staging, path.basename(secret.filename)), secret.bytes, { flag: 'wx', mode: 0o600 });
    }
    const files = [];
    for (const filename of ['freeapi.db', 'server.env', 'admin.json']) {
      const fullPath = path.join(staging, filename);
      await fs.chmod(fullPath, 0o600);
      const bytes = await fs.readFile(fullPath);
      files.push({ name: filename, bytes: bytes.length, sha256: sha256(bytes) });
    }
    await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), sqliteIntegrity: 'ok', files }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(staging, path.join(directory, name));
    committed = true;

    // Keep the newest complete backup for each of the latest seven UTC dates.
    // Only our exact directory names inside this dedicated folder are eligible.
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && completedName.test(entry.name))
      .map(entry => entry.name).sort().reverse();
    const days = new Set();
    for (const entry of entries) {
      const day = entry.slice('freellmapi-'.length, 'freellmapi-'.length + 10);
      if (!days.has(day) && days.size < 7) { days.add(day); continue; }
      const target = path.join(directory, entry);
      if (path.dirname(target) !== directory || !completedName.test(path.basename(target))) throw new Error('Invalid retention target.');
      await fs.rm(target, { recursive: true, force: false });
    }
    console.log(JSON.stringify({ ok: true, directory: path.join(directory, name), files: files.length + 1, payloadBytes: files.reduce((total, file) => total + file.bytes, 0), sqliteIntegrity: 'ok' }));
  } finally {
    check?.close();
    source?.close();
    if (!committed && path.dirname(staging) === directory && path.basename(staging).startsWith('.pending-')) await fs.rm(staging, { recursive: true, force: true });
  }
}

// The systemd unit serializes invocations with flock. Never log data, secrets or driver errors.
backup().catch(() => { console.error('FreeLLMAPI backup failed; inspect its protected backup directory.'); process.exitCode = 1; });
