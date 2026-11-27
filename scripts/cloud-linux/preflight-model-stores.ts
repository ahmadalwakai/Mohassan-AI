import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { modelRegistry, modelRoots, resolveModelInRoots, type ModelEntry } from '../../packages/model-relations/src/registry.js';
import { loadOcrModel, MAX_OCR_MANIFEST_BYTES, MAX_OCR_WEIGHT_BYTES } from '../../packages/vision/src/ocr-model.js';

// S_ISVTX from https://man7.org/linux/man-pages/man7/inode.7.html (retrieved 2026-11-27).
const stickyBit = 0o1000;

function serviceCanWrite(path: string) {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch (error) {
    if (['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

function protectedModelStore(path: string | undefined, appRoot: string) {
  if (!path || !isAbsolute(path) || path !== path.trim()) return false;
  const local = realpathSync(path);
  if (local !== resolve(path)) return false;
  const fromApp = relative(realpathSync(appRoot), local);
  if (fromApp !== '..' && !fromApp.startsWith(`..${sep}`)) return false;
  accessSync(local, constants.R_OK | constants.X_OK);
  for (let dir = local; ; dir = dirname(dir)) {
    const file = statSync(dir);
    if (!file.isDirectory() || file.uid === process.getuid?.()) return false;
    // A sticky ancestor such as /tmp cannot be used to replace an entry the service does not own.
    if (serviceCanWrite(dir) && (dir === local || !(file.mode & stickyBit))) return false;
    if (dir === dirname(dir)) return true;
  }
}

export async function modelStatus(entry: ModelEntry, roots: readonly string[], env: NodeJS.ProcessEnv) {
  const model = await resolveModelInRoots(entry, roots, env);
  if (model.state === 'absent') return 'absent';
  const badPin = model.artifacts.some(artifact => artifact.present && (artifact.matchesPin === false ||
    (!artifact.expectedSha256 && entry.artifacts.some(spec => spec.role === artifact.role && spec.pin))));
  return badPin ? 'hash mismatch' : 'present';
}

async function ocrLoaderAccepts(directory: string) {
  for (const [name, maxBytes] of [['manifest.json', MAX_OCR_MANIFEST_BYTES], ['weights.bin', MAX_OCR_WEIGHT_BYTES]] as const) {
    const path = join(directory, name);
    const file = lstatSync(path);
    if (!file.isFile() || file.size > maxBytes || file.uid === process.getuid?.() || serviceCanWrite(path)) return false;
  }
  await loadOcrModel(directory);
  return true;
}

export async function checkModelStores(appRoot: string, env: NodeJS.ProcessEnv, ownerCouncil: boolean, ocrDirectory: string | undefined,
  check: (label: string, predicate: () => boolean) => boolean) {
  const modelRoot = env.MOHASSAN_MODELS_ROOT;

  let ocrStatus;
  if (ocrDirectory !== undefined && check('MOHASSAN_OCR_MODEL_DIR is an absolute, readable, service-read-only directory outside the app',
    () => protectedModelStore(ocrDirectory, appRoot))) {
    const entry = modelRegistry.find(entry => entry.id === 'ocr')!;
    ocrStatus = await modelStatus(entry, [appRoot], env);
    if (ocrStatus === 'present') {
      const valid = await ocrLoaderAccepts(ocrDirectory).catch(() => false);
      check('OCR manifest and weights are service-read-only files accepted by the server loader', () => valid);
    }
  }

  if (ownerCouncil && check('MOHASSAN_MODELS_ROOT is an absolute, readable, service-read-only directory outside the app',
    () => protectedModelStore(modelRoot, appRoot))) {
    const roots = modelRoots(appRoot, env);
    for (const entry of modelRegistry) {
      if (entry.id === 'ocr' && ocrDirectory !== undefined) continue;
      const status = await modelStatus(entry, roots, env);
      check(`model ${entry.id}: ${status}`, () => status !== 'hash mismatch');
    }
  }

  if (ocrStatus) check(`model ocr: ${ocrStatus}`, () => ocrStatus === 'present');
}
