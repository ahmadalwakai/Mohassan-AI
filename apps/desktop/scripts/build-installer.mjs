// Builds the Windows installers from a clean staging folder outside the repository.
//
// Why not run electron-builder inside apps/desktop directly?
//  - In this npm workspace electron-builder walks the hoisted root node_modules and packs the whole
//    web stack's dependencies into app.asar (311 MB measured on 2026-11-22) although the shell only
//    uses Electron and Node built-ins. The staging folder has no node_modules, so the asar stays small.
//  - Repository file watchers (dev servers of other sessions, indexers) locked `release\win-unpacked.tmp`
//    and failed two builds with EPERM/EBUSY. Staging and output live under %LOCALAPPDATA%\Mohassan\build.
// The finished installers are copied back to apps/desktop/release (git-ignored).
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
const buildRoot = process.env.MOHASSAN_DESKTOP_BUILD_DIR || join(localAppData, 'Mohassan', 'build');
const stage = join(buildRoot, 'stage');
const output = join(buildRoot, 'release');
const releaseDir = join(appDir, 'release');

if (!existsSync(join(appDir, 'dist', 'main.js'))) {
  console.error('dist/main.js is missing: run `npm run build --workspace @mohassan/desktop-shell` first.');
  process.exit(1);
}

const started = Date.now();
rmSync(stage, { recursive: true, force: true });
// A stale installer left in the output folder would otherwise be copied back as if it were fresh.
rmSync(output, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(appDir, 'dist'), join(stage, 'dist'), { recursive: true });
cpSync(join(appDir, 'assets'), join(stage, 'assets'), { recursive: true });

// A package.json without the workspace: electron-builder needs the name, version, entry point, author and the Electron version.
writeFileSync(join(stage, 'package.json'), JSON.stringify({
  name: pkg.name,
  productName: 'Mohassan',
  version: pkg.version,
  description: pkg.description,
  author: pkg.author,
  license: pkg.license,
  main: pkg.main,
  devDependencies: { electron: pkg.devDependencies.electron },
}, null, 2));

const config = JSON.parse(readFileSync(join(appDir, 'electron-builder.json'), 'utf8'));
config.directories = { ...config.directories, output, buildResources: 'assets' };
const configPath = join(stage, 'electron-builder.json');
writeFileSync(configPath, JSON.stringify(config, null, 2));

const quote = (value) => `"${value}"`;
const command = ['npx', 'electron-builder', '--win', '--project', quote(stage), '--config', quote(configPath), ...process.argv.slice(2)].join(' ');
console.log(`> ${command}`);
const result = spawnSync(command, { cwd: appDir, stdio: 'inherit', shell: true });
if (result.status !== 0) {
  console.error(`electron-builder exited with ${result.status ?? result.signal}`);
  process.exit(result.status ?? 1);
}

mkdirSync(releaseDir, { recursive: true });
const copied = [];
for (const name of readdirSync(output)) {
  if (!/\.(exe|blockmap)$/i.test(name)) continue;
  copyFileSync(join(output, name), join(releaseDir, name));
  copied.push(`${name}  ${(statSync(join(releaseDir, name)).size / 1024 / 1024).toFixed(1)} MB`);
}
console.log(`\nInstallers (${((Date.now() - started) / 1000).toFixed(0)} s) in ${releaseDir}:\n  ${copied.join('\n  ')}`);
