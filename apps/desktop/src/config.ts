import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

interface Config {
  repoRoot: string;
  mode: 'dev' | 'lab' | 'production';
  webUrl: string;
  serverUrl: string;
  /** Lab mode only: the lab folder (database and profiles), relative to the repository. */
  labDir: string;
  autostartStack: boolean;
  closeToTray: boolean;
  startHidden: boolean;
}

// Existing repository discovery and defaults from https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/desktop/src/main.ts#L36-L54 (retrieved 2026-11-27).
function defaultConfig(envRepoRoot?: string): Config {
  const appRepoRoot = resolve(__dirname, '..', '..', '..');
  const candidates = [envRepoRoot, appRepoRoot, 'C:\\Mohassan AI'];
  const repoRoot = candidates.find(candidate => candidate && existsSync(join(candidate, 'scripts', 'dev.mjs')));
  return {
    repoRoot: repoRoot ? resolve(repoRoot) : appRepoRoot,
    mode: 'dev',
    webUrl: 'http://127.0.0.1:3000',
    serverUrl: 'http://127.0.0.1:4000',
    labDir: '.data/local-lab',
    autostartStack: true,
    closeToTray: true,
    startHidden: false,
  };
}

function readSavedConfig(configPath: string): Partial<Config> {
  try {
    const saved: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) return saved as Partial<Config>;
  } catch { /* Use defaults if the profile cannot be read. */ }
  return {};
}

export function loadConfig(configPath: string, args: readonly string[], envRepoRoot?: string): Config {
  const defaults = defaultConfig(envRepoRoot);
  const saved = readSavedConfig(configPath);
  const repoIndex = args.indexOf('--repo');
  const repoOption = repoIndex >= 0 ? args[repoIndex + 1] : undefined;
  const savedRepoRoot = typeof saved.repoRoot === 'string' && saved.repoRoot && existsSync(join(saved.repoRoot, 'scripts', 'dev.mjs'))
    ? saved.repoRoot
    : defaults.repoRoot;
  return {
    repoRoot: repoOption ? resolve(repoOption) : savedRepoRoot,
    mode: args.includes('--lab') ? 'lab' : args.includes('--production') ? 'production' : saved.mode ?? defaults.mode,
    webUrl: saved.webUrl ?? defaults.webUrl,
    serverUrl: saved.serverUrl ?? defaults.serverUrl,
    labDir: saved.labDir ?? defaults.labDir,
    autostartStack: saved.autostartStack ?? defaults.autostartStack,
    closeToTray: saved.closeToTray ?? defaults.closeToTray,
    startHidden: args.includes('--hidden') || (saved.startHidden ?? defaults.startHidden),
  };
}

/** Seeds the editable settings file when the user opens it for the first time. */
export function ensureConfigFile(configPath: string, envRepoRoot?: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
  try {
    const contents = `${JSON.stringify(defaultConfig(envRepoRoot), null, 2)}\n`;
    writeFileSync(configPath, contents, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
