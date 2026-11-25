import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentBrowser } from '@mohassan/browser';

interface ManagedContext { context: { close(): Promise<void> } }
type KeyMap = Pick<Map<string, unknown>, 'keys' | 'delete'>;
type ProfileHash = (value: string) => string;

const defaultKey = (ownerId: string) => `default:${ownerId}`;
const accountKey = (ownerId: string, accountId: string) => `account:${JSON.stringify([ownerId, accountId])}`;
const profileName = (key: string, hash: ProfileHash) =>
  key.startsWith('default:') ? hash(key.slice('default:'.length)) : `account-${hash(key)}`;
const indexDir = (root: string, ownerId: string, hash: ProfileHash) => join(root, '.member-profiles', hash(ownerId));

async function rememberProfile(root: string, ownerId: string, name: string, hash: ProfileHash) {
  const index = indexDir(root, ownerId, hash);
  await mkdir(index, { recursive: true });
  await writeFile(join(index, name), '', { flag: 'a' });
}

/** The last conversation for a legacy named profile may be its only remaining ownership record. */
async function rememberExistingAgentBrowserProfile(root: string, ownerId: string, accountId: string | null, hash: ProfileHash) {
  if (!accountId) return;
  const name = profileName(accountKey(ownerId, accountId), hash);
  try {
    await access(join(root, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await rememberProfile(root, ownerId, name, hash);
}

function belongsToOwner(key: string, ownerId: string) {
  return (JSON.parse(key) as [string])[0] === ownerId;
}

export async function purgeAgentBrowserProfiles<T extends ManagedContext>(
  root: string,
  ownerId: string,
  accountIds: readonly string[],
  owners: Map<string, Promise<T>>,
  accounts: KeyMap,
  recoveryBindings: KeyMap,
  hash: ProfileHash,
) {
  const keys = new Set([defaultKey(ownerId), ...accountIds.map(id => accountKey(ownerId, id))]);
  for (const key of owners.keys()) {
    if (key.startsWith('account:') && belongsToOwner(key.slice('account:'.length), ownerId)) keys.add(key);
  }
  for (const key of keys) {
    const owner = await owners.get(key)?.catch(() => null);
    if (owner) await owner.context.close();
    owners.delete(key);
  }
  for (const map of [accounts, recoveryBindings]) {
    for (const key of map.keys()) if (belongsToOwner(key, ownerId)) map.delete(key);
  }

  const index = indexDir(root, ownerId, hash);
  const knownProfiles = await readdir(index).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const names = new Set([...keys].map(key => profileName(key, hash)));
  for (const name of knownProfiles) if (/^account-[a-f0-9]{24}$/u.test(name)) names.add(name);
  for (const name of names) await rm(join(root, name), { recursive: true, force: true });
  await rm(index, { recursive: true, force: true });
}

const rememberAccountProfile = Symbol('rememberAccountProfile');

/** The server records ownership before a named profile can be used by the browser. */
export function memberAgentBrowserClass(Base: typeof AgentBrowser) {
  return class MemberAgentBrowser extends Base {
    override async bindAccount(ownerId: string, conversationId: string, accountId: string | null): Promise<void> {
      const { root, accounts, hash } = this.memberProfileState();
      if (accountId !== null && accounts.get(JSON.stringify([ownerId, conversationId])) !== accountId) {
        await rememberProfile(root, ownerId, profileName(accountKey(ownerId, accountId), hash), hash);
      }
      await super.bindAccount(ownerId, conversationId, accountId);
    }

    [rememberAccountProfile](ownerId: string, accountId: string | null) {
      const { root, hash } = this.memberProfileState();
      return rememberExistingAgentBrowserProfile(root, ownerId, accountId, hash);
    }

    purgeAccount(ownerId: string, accounts: readonly string[]) {
      const { root, owners, accounts: bindings, recoveryBindings, hash } = this.memberProfileState();
      return purgeAgentBrowserProfiles(root, ownerId, accounts, owners, bindings, recoveryBindings, hash);
    }
  };
}

export const MemberAgentBrowser = memberAgentBrowserClass(AgentBrowser);

export async function rememberRemovedConversationProfile(browser: AgentBrowser, ownerId: string, accountId: string | null) {
  if (rememberAccountProfile in browser && typeof browser[rememberAccountProfile] === 'function') {
    await browser[rememberAccountProfile](ownerId, accountId);
  }
}
