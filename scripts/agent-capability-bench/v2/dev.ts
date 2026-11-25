import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { CapabilityCorpusError } from '../corpus.js';
import {
  capabilityV2DevelopmentManifestSchema, capabilityV2PayloadFile, parseV2BundleJson, readV2BundleBytes, readV2BundleCases,
} from './sealed.js';

const manifestFile = 'manifest.json';

export async function loadDevelopmentCapabilityCorpus(directory: string) {
  const manifestPath = join(directory, manifestFile);
  if (!(await lstat(directory).catch(() => undefined))?.isDirectory()
    || !(await lstat(manifestPath).catch(() => undefined))?.isFile()) {
    throw new CapabilityCorpusError('Capability v2 development requires a regular bundle directory and manifest.json.');
  }
  const manifestBytes = await readV2BundleBytes(manifestPath, 'manifest');
  const manifest = parseV2BundleJson(manifestBytes, capabilityV2DevelopmentManifestSchema, 'manifest');
  const cases = await readV2BundleCases(join(directory, capabilityV2PayloadFile), manifest, manifest.development, manifestFile);
  return { manifest, cases, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex') };
}
