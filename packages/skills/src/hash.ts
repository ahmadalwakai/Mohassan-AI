import { createHash } from 'node:crypto';
import type { SkillContract } from '@mohassan/contracts';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** The hash covers the contract and every file, so any change is a different version. */
export function skillContentHash(contract: SkillContract, files: readonly { path: string; content: string }[]): string {
  const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path, 'en')).map(({ path, content }) => ({ path, hash: sha256(content) }));
  return sha256(JSON.stringify({ contract, files: ordered }));
}
