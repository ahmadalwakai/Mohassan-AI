import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, posix, relative, resolve, sep, toNamespacedPath } from 'node:path';
import { modelArtifactLocations, modelRegistry, readModelMetadata, type ModelEntry } from '../../packages/model-relations/src/registry.js';

export type Area = 'models' | 'ocr';
export type PinStatus = 'match' | 'mismatch' | 'no pin';
export type StoreStatus = 'present' | 'absent' | 'hash mismatch' | 'unpinned';

export interface StoreRoots {
  root: string;
  ocrDir?: string;
  workerConfig?: string;
}

export interface ArtifactRecord {
  modelId: string;
  version: string;
  role: string;
  required: boolean;
  expectedSha256: string | null;
  pinStatus: PinStatus;
}

export interface BundleFile {
  area: Area;
  path: string;
  sizeBytes: number;
  sha256: string;
  artifacts: ArtifactRecord[];
}

export interface ModelStatus {
  id: string;
  version: string;
  status: StoreStatus;
  reason?: string;
  artifacts: { role: string; required: boolean; area?: Area; path?: string; status: StoreStatus; reason?: string }[];
}

export interface StoreManifest {
  schemaVersion: 1;
  totalBytes: number;
  files: BundleFile[];
  models: ModelStatus[];
}

interface Location {
  area: Area;
  path: string;
  source: string;
  size: number | null;
  identity: BigIntStats | null;
  content?: Buffer;
}

interface ArtifactPlan {
  role: string;
  required: boolean;
  location: Location | null;
  expectedSha256: string | null;
  missingPin: boolean;
}

// Windows filename restrictions: https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file (retrieved 2026-11-27).
const windowsDevice = /^(?:con|prn|aux|nul|(?:com|lpt)[1-9¹²³])(?:\.|$)/iu;
const forbiddenPathCharacter = /[\\/:*?"<>|\x00-\x1f\x7f]/u;
export function portablePath(path: string): string {
  if (path.split('/').some(part => !part || part.endsWith('.') || part.endsWith(' ')
    || windowsDevice.test(part) || forbiddenPathCharacter.test(part))) throw new Error(`Unsafe registry artifact path: ${JSON.stringify(path)}`);
  return path;
}

function within(root: string, path: string): string {
  const local = relative(root, path);
  if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) {
    throw new Error(`Registry artifact is outside its source root: ${path}`);
  }
  return portablePath(local.split(sep).join('/'));
}

async function directory(path: string): Promise<string> {
  // The installer passes already-open directory handles to pin its staging roots.
  if (process.platform === 'linux' && /^\/proc\/self\/fd\/\d+$/u.test(path)) return path;
  const actual = await realpath(toNamespacedPath(path));
  return process.platform === 'win32' ? actual.replace(/^\\\\\?\\UNC\\/iu, '\\\\').replace(/^\\\\\?\\/u, '') : actual;
}

// Check each component before opening. In particular, never read through a junction, symlink, or device.
async function regularInfo(base: string, local: string): Promise<BigIntStats | null> {
  let cursor = base;
  const parts = local.split('/');
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    const info = await lstat(toNamespacedPath(cursor), { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return null;
    if (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()) {
      throw new Error(`Expected a regular registry artifact with no symlink components: ${cursor}`);
    }
    if (index === parts.length - 1) return info;
  }
  throw new Error(`Empty artifact path: ${local}`);
}

export async function openArtifact(path: string, expected?: BigIntStats | null) {
  const handle = await open(toNamespacedPath(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const actual = await handle.stat({ bigint: true });
    if (!actual.isFile() || (expected && (actual.dev !== expected.dev || actual.ino !== expected.ino))) {
      throw new Error(`Registry artifact was replaced: ${path}`);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function fingerprint(location: Location): Promise<{ sizeBytes: number; sha256: string }> {
  const handle = await openArtifact(location.source, location.identity);
  try {
    let sizeBytes = 0;
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      sizeBytes += chunk.length;
    }
    return { sizeBytes, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

export async function planStore(roots: StoreRoots, registry: readonly ModelEntry[] = modelRegistry, packing = false) {
  const root = await directory(roots.root).catch((error: NodeJS.ErrnoException) => {
    if (!packing && error.code === 'ENOENT') return resolve(roots.root);
    throw error;
  });
  // The VM may have no OCR directory yet. Keep the configured location for reporting absent files.
  const ocrDir = roots.ocrDir && await directory(roots.ocrDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return resolve(roots.ocrDir!);
    throw error;
  });
  const workerConfig = roots.workerConfig && resolve(roots.workerConfig);
  if (workerConfig) within(root, workerConfig);
  const locations = new Map<string, Promise<Location>>();
  const locate = (candidate: string, ocr: boolean, destination?: string) => {
    const base = ocr && ocrDir ? ocrDir : root;
    const local = within(base, candidate);
    const area = ocr ? 'ocr' : 'models';
    const path = destination ? portablePath(destination) : ocr ? basename(local) : local;
    const key = `${area}/${path}`;
    const cached = locations.get(key);
    if (cached) return cached.then(location => {
      if (location.source !== candidate) throw new Error(`Multiple source files for ${key}`);
      return location;
    });
    const found = regularInfo(base, local).then(identity => ({ area, path, source: candidate, identity,
      size: identity ? Number(identity.size) : null } as Location));
    locations.set(key, found);
    return found;
  };
  const metadata = new Map<string, Promise<unknown>>();
  const groups: { entry: ModelEntry; artifacts: ArtifactPlan[] }[] = [];
  for (const entry of registry) {
    const env: NodeJS.ProcessEnv = {};
    if (ocrDir) env.MOHASSAN_OCR_MODEL_DIR = ocrDir;
    if (workerConfig) env.MOHASSAN_MODEL_WORKER_CONFIG = workerConfig;
    // Validate literal registry paths before resolution normalizes any traversal.
    for (const item of entry.artifacts) {
      if (!item.workerConfigField) portablePath(item.path);
      if (item.pin && !entry.artifacts.some(reference => reference.role === item.pin!.reference)) portablePath(item.pin.reference);
    }
    const ocrPaths = new Set(entry.artifacts.filter(item => item.env === 'MOHASSAN_OCR_MODEL_DIR')
      .map(item => ocrDir ? resolve(ocrDir, basename(item.path)) : resolve(root, item.path)));
    const workerItem = entry.artifacts.find(item => item.envFile && item.env === 'MOHASSAN_MODEL_WORKER_CONFIG');
    const locateCandidate = (candidate: string, destination?: string) => locate(candidate, ocrPaths.has(candidate),
      destination ?? (workerConfig === candidate ? workerItem?.path : undefined));
    const readJson = (path: string) => {
      const cached = metadata.get(path);
      if (cached) return cached;
      const data = (async () => {
        const { identity } = await locateCandidate(path);
        if (!identity) return undefined;
        return readModelMetadata(path, file => openArtifact(file, identity));
      })();
      metadata.set(path, data);
      return data;
    };
    const artifacts: ArtifactPlan[] = [];
    const supporting = new Set<string>();
    const workerPaths: { field: 'checkpoint' | 'tokenizer'; path: string }[] = [];
    for (const { item, path, expectedSha256, supportPath } of await modelArtifactLocations(entry, root, env, readJson)) {
      const destination = packing && path && workerItem && item.workerConfigField
        ? posix.join(posix.dirname(workerItem.path), 'model-worker-files', item.workerConfigField, basename(path)) : undefined;
      const location = path === null ? null : await locateCandidate(path, destination);
      if (item.workerConfigField && location) workerPaths.push({ field: item.workerConfigField, path: location.path });
      artifacts.push({ role: item.role, required: !item.optional, location, expectedSha256,
        missingPin: Boolean(item.pin && !expectedSha256) });
      if (supportPath && !supporting.has(supportPath)) {
        supporting.add(supportPath);
        artifacts.push({ role: 'pin-reference', required: false, location: await locateCandidate(supportPath),
          expectedSha256: null, missingPin: false });
      }
    }
    const config = artifacts.find(item => item.role === workerItem?.role)?.location;
    if (packing && config && workerPaths.length) {
      // Keep the pinned model bytes intact and make the worker config portable across hosts.
      const parsed = structuredClone(await readJson(config.source)) as { model: Record<string, { path: string }> };
      let changed = false;
      for (const worker of workerPaths) {
        const path = posix.relative(posix.dirname(config.path), worker.path);
        const record = parsed.model[worker.field];
        changed ||= record.path !== path;
        record.path = path;
      }
      if (changed) {
        config.content = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`);
        config.size = config.content.length;
      }
    }
    groups.push({ entry, artifacts });
  }
  return groups;
}

export type StorePlan = Awaited<ReturnType<typeof planStore>>;
export function presentFiles(plan: StorePlan): Map<string, Location & { size: number }> {
  const files = new Map<string, Location & { size: number }>();
  for (const { artifacts } of plan) {
    for (const { location } of artifacts) {
      if (location && location.size !== null) files.set(`${location.area}/${location.path}`, { ...location, size: location.size });
    }
  }
  return files;
}

export async function inspectStore(plan: StorePlan, readFingerprint = (location: Location) => location.content
  ? { sizeBytes: location.content.length, sha256: createHash('sha256').update(location.content).digest('hex') }
  : fingerprint(location)) {
  const files = new Map<string, BundleFile>();
  const models: ModelStatus[] = [];
  for (const { entry, artifacts } of plan) {
    const records: ModelStatus['artifacts'] = [];
    for (const { role, required, location, expectedSha256, missingPin } of artifacts) {
      if (!location || location.size === null) {
        records.push({ role, required, area: location?.area, path: location?.path, status: 'absent',
          reason: location ? 'File missing' : 'No matching worker configuration' });
        continue;
      }
      const { area, path } = location;
      const key = `${area}/${path}`;
      let file = files.get(key);
      if (!file) {
        file = { area, path, ...await readFingerprint(location), artifacts: [] };
        files.set(key, file);
      }
      const pinStatus = missingPin || (expectedSha256 && expectedSha256 !== file.sha256) ? 'mismatch'
        : expectedSha256 ? 'match' : 'no pin';
      file.artifacts.push({ modelId: entry.id, version: entry.version, role, required, expectedSha256, pinStatus });
      records.push({ role, required, area, path, status: pinStatus === 'match' ? 'present' : pinStatus === 'mismatch' ? 'hash mismatch' : 'unpinned',
        reason: missingPin ? 'Registry pin metadata missing or invalid' : undefined });
    }
    const mismatch = records.some(item => item.status === 'hash mismatch');
    const absent = !records.length || records.some(item => item.required && item.status === 'absent');
    const unpinned = records.some(item => item.required && item.status === 'unpinned');
    models.push({ id: entry.id, version: entry.version, status: mismatch ? 'hash mismatch' : absent ? 'absent' : unpinned ? 'unpinned' : 'present',
      reason: !records.length ? 'No trained artifact declared in the registry' : undefined, artifacts: records });
  }
  return { models, files: [...files.values()], schemaVersion: 1, totalBytes: [...files.values()].reduce((sum, file) => sum + file.sizeBytes, 0) } satisfies StoreManifest;
}
