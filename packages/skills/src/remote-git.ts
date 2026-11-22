import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { blobBatch, blobBytes, createMirror, hasCommit, remoteFetch, remoteHead, treeChildren, treeEntries, treeEntriesBySkill, type RemoteSkillListing, type RemoteTreeEntry } from '@mohassan/coding/git-remote';
import { CodingError, assertNoLinks, containsPath, sha256 } from '@mohassan/coding/security';
import type { SkillRemoteConfig } from '@mohassan/contracts';
import type { SkillRemoteEntry, SkillRemoteTransport } from './remote.ts';

/** The real transport: a bare depth-1 mirror of one public repository under `dataDir`, read with the restricted Git runner.
 * A skills repository is small, so a mirror that misses the wanted commit is deleted and fetched fresh: no gc, no stale objects.
 * One listing of the whole skills folder serves every skill of a commit; a folder too large for it is listed one skill at a time. */
export function createGitSkillTransport(dataDir: string, config: Pick<SkillRemoteConfig, 'repo' | 'ref' | 'path'>): SkillRemoteTransport {
  const mirror = join(dataDir, `${sha256(config.repo).slice(0, 16)}.git`);
  const strip = (prefix: string) => (entry: RemoteTreeEntry): SkillRemoteEntry => ({ mode: entry.mode, type: entry.type, objectId: entry.objectId, size: entry.size, path: entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path });
  // The listing of the last commit read; `null` means that folder is too large for one listing.
  let listing: { commit: string; result: RemoteSkillListing | null } | null = null;
  async function grouped(commit: string, signal: AbortSignal): Promise<RemoteSkillListing | null> {
    if (listing?.commit !== commit) {
      try { listing = { commit, result: await treeEntriesBySkill(mirror, commit, config.path, signal) }; }
      catch (error) { if (!(error instanceof CodingError && error.code === 'GIT_REMOTE_TOO_LARGE')) throw error; listing = { commit, result: null }; }
    }
    return listing.result;
  }
  async function ready(): Promise<void> {
    await assertNoLinks(dataDir);
    await mkdir(dataDir, { recursive: true });
  }
  async function present(): Promise<boolean> {
    try { return (await stat(mirror)).isDirectory(); } catch { return false; }
  }
  async function refresh(signal: AbortSignal): Promise<string> {
    await ready();
    await assertNoLinks(mirror);
    if (!containsPath(dataDir, mirror)) throw new CodingError('GIT_REMOTE_REJECTED', 'مجلد المرآة خارج مجلد البيانات.');
    await rm(mirror, { recursive: true, force: true });
    await mkdir(mirror, { recursive: true });
    await createMirror(mirror, signal);
    return remoteFetch(mirror, config.repo, config.ref, signal);
  }
  return {
    async head(signal) { await ready(); return remoteHead(dataDir, config.repo, config.ref, signal); },
    async ensure(commit, signal) {
      if (await present() && await hasCommit(mirror, commit, signal)) return commit;
      return refresh(signal);
    },
    async children(commit, signal) { return (await treeChildren(mirror, commit, config.path, signal)).map(strip(`${config.path}/`)); },
    async entries(commit, slug, signal) {
      const all = await grouped(commit, signal);
      if (!all) return (await treeEntries(mirror, commit, `${config.path}/${slug}`, signal)).map(strip(`${config.path}/${slug}/`));
      if (all.unreadable.has(slug)) throw new CodingError('GIT_REMOTE_REJECTED', 'اسم ملف في المستودع ليس UTF-8 صالحاً.');
      return all.skills.get(slug) ?? [];
    },
    blob: (objectId, maxBytes, signal) => blobBytes(mirror, objectId, maxBytes, signal),
    readBlobs: (requests, signal) => blobBatch(mirror, requests, signal),
  };
}
