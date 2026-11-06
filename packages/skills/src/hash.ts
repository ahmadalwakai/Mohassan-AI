import { createHash } from 'node:crypto';
import type { SkillContract } from '@mohassan/contracts';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
const payload = (contract: SkillContract, files: readonly { path: string; content: string }[]) => ({
  contract,
  files: [...files].sort((a, b) => a.path.localeCompare(b.path, 'en')).map(({ path, content }) => ({ path, hash: sha256(content) })),
});

/** The hash covers the contract and every file, so any change is a different version. */
export function skillContentHash(contract: SkillContract, files: readonly { path: string; content: string }[]): string {
  return sha256(JSON.stringify(canonical(payload(contract, files))));
}

/** Read compatibility only: existing valid hashes, inspection records and grants stay immutable. */
export function skillContentMatches(contract: SkillContract, files: readonly { path: string; content: string }[], storedHash: string): boolean {
  return storedHash === skillContentHash(contract, files) || storedHash === sha256(JSON.stringify(payload(contract, files)));
}
