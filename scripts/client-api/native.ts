import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ClientCall } from './types.js';

const androidRoot = 'apps/android/app/src/main/java';
const iosRoot = 'apps/ios/Wasla';
const iosRef = 'origin/feat/iphone-store-name';
const waslaCompanionSource = 'https://github.com/ahmadalwakai/Mohassan-AI/blob/80f1f09537c7d2e95caf9d71b022891cac567671/apps/wasla-service/wasla/server.py';

type Source = { file: string; lines: string[] };

function source(file: string, text: string): Source {
  return { file, lines: text.split(/\r?\n/) };
}

function androidSources(root: string, directory = androidRoot): Source[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const file = directory + '/' + entry.name;
    if (entry.isDirectory()) return androidSources(root, file);
    return entry.name.endsWith('.kt') ? [source(file, readFileSync(join(root, file), 'utf8'))] : [];
  });
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

function iosSources(root: string) {
  let ref: string;
  try {
    ref = git(root, 'rev-parse', '--verify', iosRef + '^{commit}');
  } catch (cause) {
    throw new Error('Fetch origin/feat/iphone-store-name before checking the iOS client inventory.', { cause });
  }
  const files = git(root, 'ls-tree', '-r', '--name-only', ref, '--', iosRoot).split('\n');
  return { ref, sources: files.filter(file => file.endsWith('.swift')).map(file => source(file, git(root, 'show', ref + ':' + file))) };
}

const httpMethods = { get: 'GET', post: 'POST', delete: 'DELETE' } as const;
type Helper = keyof typeof httpMethods | 'data' | 'send';

function methodOf(helper: Helper, argumentsAfterPath: string, client: 'Android' | 'iOS') {
  if (helper === 'data' || helper === 'send') {
    if (client === 'Android' && helper === 'send') return 'POST';
    const argument = client === 'iOS' ? /\bmethod:\s*"([A-Z]+)"/ : /^,\s*"([A-Z]+)"/;
    return argument.exec(argumentsAfterPath)?.[1] ?? 'GET';
  }
  return httpMethods[helper];
}

function androidPath(path: string) {
  return path.replace(/\$\{?(\w+)\}?/g, (_, name: string) => {
    if (path.startsWith('/v1/images/')) return ':request_id';
    return name === 'existing' ? ':id' : ':' + name;
  });
}

function iosPath(path: string) {
  return path.replace(/\\\(([^)]+)\)/g, (_, expression: string) => {
    if (path.startsWith('/api/chat/images/')) return ':imageId';
    if (expression === 'conversation' || expression === 'device.id') return ':id';
    return ':' + expression;
  });
}

type AndroidWire = { request?: string; response?: string; finding?: string };
const androidWire: Readonly<Record<string, AndroidWire>> = {
  'POST /v1/pair': { request: 'PairRequest', response: 'PairResponse' },
  'GET /v1/status': { response: 'ServerStatus' },
  'DELETE /v1/session': { response: 'acknowledgement' },
  'POST /v1/chat': {
    request: 'ChatRequest', response: 'ChatResponse',
    finding: 'The reference Wasla companion returns 410 legacy_chat_removed. [server.py:219](' + waslaCompanionSource + '#L219) (retrieved 2026-11-27).',
  },
  'POST /v1/images/prepare': { request: 'ImagePreparation', response: 'PreparedImage' },
  'POST /v1/images': { request: 'ImageRequest', response: 'ImageJob' },
  'GET /v1/images/:request_id': { response: 'ImageJob' },
  'GET /v1/images/:request_id/content': { response: 'PNG bytes' },
  'POST /v1/search': { request: 'SearchRequest', response: 'SearchResponse' },
  'POST /v1/desktop/session': { request: 'EmptyBody', response: 'DesktopSession' },
  'DELETE /v1/desktop/session': { request: 'X-Wasla-Session header', response: 'acknowledgement' },
  'GET /v1/desktop/frame': { request: 'X-Wasla-Session header', response: 'frame bytes' },
  'POST /v1/desktop/input': { request: 'DesktopCommand and X-Wasla-Session header', response: 'acknowledgement' },
  'GET /v1/mohassan/status': { response: 'MohassanLink' },
  'GET /v1/mohassan/conversations': { response: 'MohassanList' },
  'POST /v1/mohassan/conversations': { request: 'MohassanCreate', response: 'MohassanCreated' },
  'GET /v1/mohassan/conversations/:id': { response: 'MohassanConversation' },
  'DELETE /v1/mohassan/conversations/:id': { response: 'acknowledgement' },
  'POST /v1/mohassan/conversations/:id/messages': { request: 'MohassanSend', response: 'acknowledgement' },
  'POST /v1/mohassan/conversations/:id/respond': {
    request: 'MohassanRespond', response: 'acknowledgement',
    finding: 'The reference Wasla companion rejects a typed legacy answer because it requires optionId and forbids text. [server.py:380](' + waslaCompanionSource + '#L380) (retrieved 2026-11-27).',
  },
  'POST /v1/mohassan/conversations/:id/approve': { request: 'MohassanApprove', response: 'acknowledgement' },
  'POST /v1/mohassan/conversations/:id/cancel': { request: 'EmptyBody', response: 'acknowledgement' },
};

function androidNote(method: string, path: string) {
  const wire = androidWire[method + ' ' + path];
  return [
    'Paired Wasla computer API, absent from production Fastify.',
    androidAuth(method, path) === 'anonymous' ? 'The companion checks a pairing code.' : 'The companion checks a paired-device bearer, separate from workspace roles.',
    wire && 'Android wire types (Models.kt): ' + (wire.request ?? 'no body') + ' → ' + (wire.response ?? 'no decoded body') + '.',
    wire?.finding,
  ].filter(Boolean).join(' ');
}

function androidAuth(method: string, path: string): ClientCall['auth'] {
  return method === 'POST' && path === '/v1/pair' ? 'anonymous' : 'owner';
}

function androidActionSites(sources: Source[]) {
  return sources.flatMap(({ file, lines }) => lines.flatMap((line, index) => {
    const action = /\bactOnMohassan\([^,]+,\s*"(\w+)"\s*,/.exec(line)?.[1];
    return action ? [{ action, file, line: index + 1 }] : [];
  }));
}

function androidCalls(sources: Source[]): ClientCall[] {
  const actions = androidActionSites(sources);
  return sources.flatMap(({ file, lines }) => lines.flatMap((line, index): ClientCall[] => {
    if (line.trimStart().startsWith('//')) return [];
    const calls = line.matchAll(/\b\w+\.(get|post|delete|data|send)\s*\(\s*"([^"]+)"([^\n]*)/g);
    return [...calls].flatMap(([, helper, literal, rest]) => {
      if (!literal.startsWith('/v1/')) return [];
      const method = methodOf(helper as Helper, rest, 'Android');
      const path = androidPath(literal);
      if (path.endsWith('/:action')) {
        if (!actions.length) throw new Error(file + ': no callers resolved for the Mohassan action request.');
        return actions.map(site => {
          const concrete = path.replace(/:action$/, site.action);
          return {
            client: 'Android', method, path: concrete, transport: 'external', auth: androidAuth(method, concrete),
            file: site.file, line: site.line, note: androidNote(method, concrete),
          };
        });
      }
      return [{
        client: 'Android', method, path, file, line: index + 1, transport: 'external',
        auth: androidAuth(method, path), note: androidNote(method, path),
      }];
    });
  }));
}

function findIosSource(sources: Source[], name: string) {
  const file = sources.find(file => file.file === iosRoot + '/' + name);
  if (!file) throw new Error('Missing iOS route source ' + name);
  return file;
}

function pendingPaths(sources: Source[]) {
  const { lines } = findIosSource(sources, 'Models.swift');
  const models = lines.join('\n');
  const resolver = /var path: String \{\s*let conversation = "([^"]+)" \+ \(conversationId \?\? ""\)\s*switch kind \{([^}]+)\}/.exec(models);
  if (!resolver) throw new Error('iOS pending chat path resolver changed.');
  return [...resolver[2].matchAll(/\breturn (conversation \+ )?"([^"]+)"/g)]
    .map(([, useConversation, path]) => useConversation ? resolver[1] + ':id' + path : path);
}

function screenPath(sources: Source[]) {
  const models = findIosSource(sources, 'Models.swift').lines.join('\n');
  const check = /func screen\(conversation: String\)[^\{]+\{[^}]*?parts\.path == "([^"]+)"/.exec(models);
  if (!check) throw new Error('iOS browser screen route could not be resolved.');
  return iosPath(check[1]);
}

function monitorPaths(sources: Source[]) {
  const store = findIosSource(sources, 'WaslaStore.swift').lines.join('\n');
  const base = /let base = "([^"]+)"\s*let path = action == \.(\w+) \? base : "\\\(base\)\/\\\(card\.id\)\/\\\(action\.rawValue\)"/.exec(store);
  const cases = /enum MonitorAction: String \{\s*case ([^\n]+)/.exec(findIosSource(sources, 'MonitorModels.swift').lines.join('\n'));
  if (!base || !cases) throw new Error('iOS monitor paths could not be resolved.');
  return cases[1].trim().split(/,\s*/).map(action => action === base[2] ? base[1] : base[1] + '/:id/' + action);
}

function iosVisibility(method: string, path: string): Pick<ClientCall, 'memberVisible' | 'note'> {
  if (path.startsWith('/api/auth/')) return {};
  if (path === '/api/windows') {
    return { memberVisible: true, note: 'Requested at sign-in and from the unguarded remote-control sheet (iOS WaslaStore.swift:91,117 and Mohassan.swift:585).' };
  }
  if (path.startsWith('/api/windows/')) {
    return { note: 'Remote-control actions depend on the owner-only Windows overview (iOS Views.swift:1085–1091).' };
  }
  if (path === '/api/chat/images' && method === 'GET') {
    return { memberVisible: true, note: 'The signed-in app probes images for every account (iOS WaslaStore.swift:92,118). A refusal hides the attachment button (iOS Mohassan.swift:42,632).' };
  }
  if (path === '/api/chat/images') {
    return { note: 'The upload control depends on the owner-only image availability probe (iOS Mohassan.swift:632).' };
  }
  if (path.startsWith('/api/chat/images/')) {
    return { memberVisible: true, note: 'Attachment rendering fetches bytes from the signed-in conversation (iOS Mohassan.swift:459,1243).' };
  }
  if (path.endsWith('/feedback')) {
    return { memberVisible: true, note: 'Signed-in assistant replies show ratings without an owner check (iOS Views.swift:330,528–530).' };
  }
  return { memberVisible: true };
}

function iosCalls(sources: Source[], ref: string): ClientCall[] {
  return sources.flatMap(({ file, lines }) => lines.flatMap((line, index): ClientCall[] => {
    if (line.trimStart().startsWith('//')) return [];
    const calls = file.endsWith('/Security.swift')
      ? line.matchAll(/\bsend\s*\(\s*("(?:\\.|[^"\\])*")([^\n]*)/g)
      : line.matchAll(/\bclient\.(get|post|delete|send)\s*\(\s*("(?:\\.|[^"\\])*"|[\w.]+)([^\n]*)/g);
    return [...calls].flatMap(call => {
      const [, helper, expression, rest] = file.endsWith('/Security.swift') ? [call[0], 'send', call[1], call[2]] : call;
      const method = methodOf(helper as Helper, rest, 'iOS');
      let paths: string[];
      if (expression.startsWith('"/api/')) paths = [iosPath(expression.slice(1, -1))];
      else if (expression === 'current.path') paths = pendingPaths(sources);
      else if (expression === 'screen.path') paths = [screenPath(sources)];
      else if (expression === 'path' && file.endsWith('/WaslaStore.swift')) paths = monitorPaths(sources);
      else throw new Error(file + ':' + (index + 1) + ': unresolved iOS request path ' + expression);
      return paths.map(path => ({ client: 'iOS', method, path, file, line: index + 1, ref, ...iosVisibility(method, path) }));
    });
  }));
}

export function nativeCalls(root: string): ClientCall[] {
  const ios = iosSources(root);
  return [...androidCalls(androidSources(root)), ...iosCalls(ios.sources, ios.ref)];
}
