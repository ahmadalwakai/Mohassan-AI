import { createHash } from 'node:crypto';
import type { Attribution, CodeBlock, Corpus, Passage, SourceCard } from '../types.js';
import { htmlSection, markdownSections, pythonSections } from './snippets.js';

// Source versions and licenses are pinned to the primary URLs in definitions below.
const mdnCommit = '72813e874d34cf328f39ab025448d9e06d921254';
const typescriptCommit = 'cf57c7ec6762f3cae3a9ebc973e63851d88cb2a8';
const pythonVersion = '3.13.9';
const nodeVersion = '22.21.1';
const pythonBase = 'https://docs.python.org/release/' + pythonVersion + '/';
const nodeBase = 'https://nodejs.org/download/release/v' + nodeVersion + '/docs/api/';
const githubRaw = 'https://raw.githubusercontent.com/';

export const officialSources = ['mdn', 'python', 'node', 'typescript'] as const;
export type OfficialSource = typeof officialSources[number];

interface Page {
  path: string;
  symbol?: string;
}

const javascriptRef = 'web/javascript/reference/';
const mdnBuiltins = 'files/en-us/' + javascriptRef + 'global_objects/';
const mdnGlobals: Page[] = [
  ...[
    ['promise', 'Promise'], ['promise/all', 'Promise.all'], ['promise/allsettled', 'Promise.allSettled'],
    ['promise/any', 'Promise.any'], ['promise/race', 'Promise.race'], ['promise/catch', 'Promise.prototype.catch'],
    ['promise/then', 'Promise.prototype.then'], ['promise/finally', 'Promise.prototype.finally'],
    ['array/from', 'Array.from'], ['array/includes', 'Array.prototype.includes'],
    ['array/find', 'Array.prototype.find'], ['array/findindex', 'Array.prototype.findIndex'],
    ['array/flat', 'Array.prototype.flat'], ['array/flatmap', 'Array.prototype.flatMap'],
    ['array/tosorted', 'Array.prototype.toSorted'], ['array/at', 'Array.prototype.at'],
    ['object/assign', 'Object.assign'], ['object/entries', 'Object.entries'], ['object/fromentries', 'Object.fromEntries'],
    ['object/groupby', 'Object.groupBy'], ['object/hasown', 'Object.hasOwn'],
    ['string/includes', 'String.prototype.includes'], ['string/replaceall', 'String.prototype.replaceAll'],
    ['map', 'Map'], ['set', 'Set'],
  ].map(([slug, symbol]) => ({ path: mdnBuiltins + slug + '/index.md', symbol })),
  ...[
    ['array', 'Array'], ['array/map', 'Array.prototype.map'], ['array/filter', 'Array.prototype.filter'],
    ['array/foreach', 'Array.prototype.forEach'], ['array/reduce', 'Array.prototype.reduce'],
    ['array/sort', 'Array.prototype.sort'], ['array/splice', 'Array.prototype.splice'],
    ['array/slice', 'Array.prototype.slice'], ['array/isarray', 'Array.isArray'], ['array/indexof', 'Array.prototype.indexOf'],
    ['object/keys', 'Object.keys'], ['object/create', 'Object.create'], ['object/values', 'Object.values'],
    ['string/replace', 'String.prototype.replace'], ['string/split', 'String.prototype.split'],
    ['json/parse', 'JSON.parse'], ['json/stringify', 'JSON.stringify'],
    ['regexp', 'RegExp'], ['typeerror', 'TypeError'], ['referenceerror', 'ReferenceError'],
    ['syntaxerror', 'SyntaxError'], ['error/stack', 'Error.stack'], ['error/cause', 'Error.cause'],
  ].map(([slug, symbol]) => ({ path: mdnBuiltins + slug + '/index.md', symbol })),
];

const mdnPages: readonly Page[] = [
  ...mdnGlobals,
  ...[
    'operators/await', 'operators/optional_chaining', 'operators/nullish_coalescing',
    'operators/spread_syntax', 'operators/destructuring', 'statements/async_function',
    'statements/import', 'statements/export', 'statements/const', 'errors/not_a_function', 'errors/not_defined',
    'errors/no_properties', 'errors/json_bad_parse', 'errors/invalid_const_assignment',
  ].map(slug => ({ path: 'files/en-us/' + javascriptRef + slug + '/index.md' })),
  ...['closures', 'using_promises', 'modules', 'working_with_objects', 'iterators_and_generators']
    .map(slug => ({ path: 'files/en-us/web/javascript/guide/' + slug + '/index.md' })),
  ...[
    ['window/structuredclone', 'structuredClone'], ['window/fetch', 'fetch'], ['fetch_api/using_fetch', 'Fetch'],
    ['urlsearchparams', 'URLSearchParams'], ['url', 'URL'], ['abortcontroller', 'AbortController'],
    ['abortsignal', 'AbortSignal'], ['response/json', 'Response.json'],
  ].map(([slug, symbol]) => ({ path: 'files/en-us/web/api/' + slug + '/index.md', symbol })),
];

const pythonPages: readonly Page[] = [
  'faq/programming', 'faq/design', 'faq/library', 'howto/regex', 'howto/sorting', 'howto/functional',
  'tutorial/datastructures', 'tutorial/errors', 'tutorial/controlflow', 'tutorial/modules',
  'tutorial/classes', 'tutorial/inputoutput', 'library/pathlib', 'library/os', 'library/os.path',
  'library/functions', 'library/stdtypes', 'library/exceptions', 'library/json', 'library/datetime',
  'library/collections', 'library/itertools', 'library/functools', 'library/re', 'library/csv',
  'library/subprocess', 'library/asyncio-task', 'library/argparse', 'library/typing', 'library/venv',
  'library/contextlib', 'library/sqlite3', 'library/tempfile', 'library/io', 'library/logging',
  'library/copy', 'library/unittest',
].map(path => ({ path: path + '.html' }));

const nodePages: readonly Page[] = [
  'assert', 'async_context', 'buffer', 'child_process', 'crypto', 'dns', 'errors', 'esm', 'events', 'fs',
  'globals', 'http', 'module', 'modules', 'net', 'os', 'path', 'process', 'readline', 'stream', 'timers', 'url',
  'util', 'worker_threads', 'test',
].map(path => ({ path: path + '.json' }));

const handbook = 'packages/documentation/copy/en/handbook-v2/';
const typescriptPages: readonly Page[] = [
  ...['Basics', 'Everyday Types', 'Narrowing', 'More on Functions', 'Object Types', 'Classes', 'Modules']
    .map(path => ({ path: handbook + path + '.md' })),
  ...['Generics', 'Keyof Type Operator', 'Typeof Type Operator', 'Indexed Access Types', 'Conditional Types', 'Mapped Types', 'Template Literal Types']
    .map(path => ({ path: handbook + 'Type Manipulation/' + path + '.md' })),
  ...['Utility Types', 'Type Compatibility', 'Type Inference', 'Enums', 'Declaration Merging', 'JSX']
    .map(path => ({ path: 'packages/documentation/copy/en/reference/' + path + '.md' })),
];

type CardInfo = Omit<SourceCard, 'fingerprint'>;
interface Definition {
  card: CardInfo;
  base: string;
  pages: readonly Page[];
  licenses: readonly { url: string; contains: string }[];
}

const definitions: Record<OfficialSource, Definition> = {
  mdn: {
    card: {
      id: 'mdn', title: 'MDN Web Docs', kind: 'documentation',
      url: 'https://github.com/mdn/content/tree/' + mdnCommit,
      license: 'CC-BY-SA-2.5', licenseUrl: 'https://github.com/mdn/content/blob/' + mdnCommit + '/LICENSE.md',
      version: 'MDN content ' + mdnCommit,
    },
    base: githubRaw + 'mdn/content/' + mdnCommit + '/',
    pages: mdnPages,
    licenses: [{ url: githubRaw + 'mdn/content/' + mdnCommit + '/LICENSE.md', contains: 'CC-BY-SA 2.5' }],
  },
  python: {
    card: {
      id: 'python', title: 'Python documentation', kind: 'documentation',
      url: pythonBase, license: 'PSF-2.0', licenseUrl: pythonBase + 'license.html#psf-license', version: pythonVersion,
    },
    base: pythonBase,
    pages: pythonPages,
    licenses: [{ url: pythonBase + 'license.html', contains: 'Python Software Foundation License Version 2' }],
  },
  node: {
    card: {
      id: 'node', title: 'Node.js documentation', kind: 'documentation',
      url: nodeBase, license: 'MIT',
      licenseUrl: 'https://github.com/nodejs/node/blob/v' + nodeVersion + '/LICENSE', version: 'v' + nodeVersion,
    },
    base: nodeBase,
    pages: nodePages,
    licenses: [{ url: githubRaw + 'nodejs/node/v' + nodeVersion + '/LICENSE', contains: 'Copyright Node.js contributors.' }],
  },
  typescript: {
    card: {
      id: 'typescript', title: 'TypeScript Handbook and reference', kind: 'documentation',
      url: 'https://github.com/microsoft/TypeScript-Website/tree/' + typescriptCommit,
      license: 'CC-BY-4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      version: 'TypeScript Website Handbook v2 snapshot ' + typescriptCommit,
    },
    base: githubRaw + 'microsoft/TypeScript-Website/' + typescriptCommit + '/',
    pages: typescriptPages,
    licenses: [
      { url: githubRaw + 'microsoft/TypeScript-Website/' + typescriptCommit + '/LICENSE', contains: 'Attribution 4.0 International' },
      { url: githubRaw + 'microsoft/TypeScript-Website/' + typescriptCommit + '/LICENSE-CODE', contains: 'The MIT License' },
    ],
  },
};

function pythonLicense(licenseHtml: string, anchor: 'psf-license' | 'bsd0'): string {
  const html = licenseHtml.split('<span id="' + anchor + '"></span>')[1]?.split('</section>')[0];
  const notice = html && htmlSection(html).code[0]?.text.trim();
  if (!notice) throw new Error('Python documentation lost the ' + anchor + ' license notice');
  return notice;
}

function codeLicense(source: OfficialSource, licensedFiles: readonly string[]): Pick<CodeBlock, 'license' | 'licenseUrl' | 'copyrightNotice'> {
  if (source === 'python') return {
    license: '0BSD', licenseUrl: pythonBase + 'license.html#bsd0',
    copyrightNotice: pythonLicense(licensedFiles[0], 'bsd0'),
  };
  if (source === 'typescript') return {
    license: 'MIT', licenseUrl: 'https://github.com/microsoft/TypeScript-Website/blob/' + typescriptCommit + '/LICENSE-CODE',
    copyrightNotice: licensedFiles[1].trim(),
  };
  return {};
}

function copyrightNotice(source: OfficialSource, licensedFiles: readonly string[]): string | undefined {
  if (source === 'node') {
    const notices = [...licensedFiles[0].matchAll(/"""\r?\n([\s\S]*?)\r?\n"""/g)].slice(0, 2).map(match => match[1]);
    if (!notices[0]?.startsWith('Copyright Node.js contributors.')
      || !notices[1]?.startsWith('Copyright Joyent, Inc. and other Node contributors.')) {
      throw new Error('Node.js documentation lost its MIT license notices');
    }
    return notices.join('\n\n');
  }
  if (source === 'python') return pythonLicense(licensedFiles[0], 'psf-license');
  return undefined;
}

function fragment(url: string, anchor?: string): string {
  return anchor ? url + '#' + encodeURIComponent(anchor) : url;
}

function parseMarkdown(source: 'mdn' | 'typescript', page: Page, raw: string, license: ReturnType<typeof codeLicense>): Passage[] {
  const { frontmatter, sections } = markdownSections(raw, block => {
    if (source === 'typescript') {
      const role = /^\s*\/\/\s*@errors:\s+\d/m.test(block.text) ? 'failure' : block.role;
      return { ...block, ...license, role };
    }
    // The MDN migration obscures the snippet dates needed to establish MIT or CC0.
    // https://developer.mozilla.org/en-US/docs/MDN/Writing_guidelines/Attrib_copyright_license (retrieved 2026-11-27)
    return undefined;
  });
  const path = source === 'mdn' ? frontmatter.slug : frontmatter.permalink;
  if (!path || (source === 'mdn' ? !path.startsWith('Web/') : !path.startsWith('/docs/'))) {
    throw new Error('Missing expected documentation path for ' + page.path);
  }
  const url = source === 'mdn' ? 'https://developer.mozilla.org/en-US/docs/' + path : 'https://www.typescriptlang.org' + path;
  const attribution: Attribution[] = source === 'mdn'
    ? [{ name: 'Mozilla Contributors', url: url + '/contributors.txt' }]
    : [{ name: 'Microsoft and TypeScript contributors', url: definitions.typescript.card.url }];
  const tags = source === 'mdn' ? (path.startsWith('Web/API/') ? ['javascript', 'web-api'] : ['javascript']) : ['typescript'];
  return sections.flatMap((section, index) => {
    if ((!section.text && !section.code.length) || /^(see-also|specifications|browser-compatibility)$/.test(section.anchor ?? '')) return [];
    const anchor = source === 'mdn' && section.anchor
      ? /^[a-z\d ._-]+$/i.test(section.title) ? section.title.toLowerCase().replace(/\s+/g, '_') : undefined
      : section.anchor;
    return [{
      id: source + ':' + path + ':' + index, sourceId: source, url: fragment(url, anchor),
      title: section.title === frontmatter.title ? section.title : frontmatter.title + ' – ' + section.title,
      text: section.text, code: section.code, tags,
      symbols: page.symbol ? [page.symbol] : [], attribution,
    }];
  });
}

function parsePython(page: Page, raw: string, license: ReturnType<typeof codeLicense>): Passage[] {
  return pythonSections(raw, license).map((section, index) => ({
    id: 'python:' + page.path + ':' + index,
    sourceId: 'python',
    url: fragment(pythonBase + page.path, section.anchor),
    title: section.title,
    text: section.text, code: section.code, tags: ['python'],
    symbols: section.anchor && (section.anchor.includes('.') || section.title === section.anchor) ? [section.anchor] : [],
    attribution: [{ name: 'Python Software Foundation', url: pythonBase + 'copyright.html' }],
  }));
}

const nodeCollections = ['modules', 'methods', 'classes', 'properties', 'events', 'miscs', 'ctors', 'globals'] as const;

function parseNode(page: Page, raw: string): Passage[] {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed.type !== 'module') throw new Error('Unexpected Node.js API JSON for ' + page.path);
  const passages: Passage[] = [];
  const name = page.path.replace(/\.json$/, '');
  const url = nodeBase + name + '.html';
  const queue: unknown[] = [parsed];
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index] as Record<string, unknown>;
    for (const collection of nodeCollections) {
      const children = item[collection];
      if (Array.isArray(children)) queue.push(...children);
    }
    if (typeof item.desc !== 'string') continue;
    const heading = typeof item.textRaw === 'string' ? item.textRaw.replace(/[`#]/g, '').trim() : '';
    const title = heading || (typeof item.name === 'string' ? item.name : name);
    const symbol = heading.match(/^(?:Class:\s*)?([A-Za-z_$][\w$.]*(?::[\w$.]+)?)(?:\(|$)/)?.[1];
    const body = htmlSection(item.desc, 'javascript');
    if (!body.text && !body.code.length) continue;
    const anchor = /^[A-Z][A-Z_\d]+$/.test(title) && name === 'errors' ? title.toLowerCase() : undefined;
    passages.push({
      id: 'node:' + page.path + ':' + index, sourceId: 'node', title, url: fragment(url, anchor),
      text: body.text, code: body.code, tags: ['node.js', 'javascript'],
      symbols: symbol ? [symbol] : [],
      attribution: [{ name: 'Node.js contributors', url: definitions.node.card.licenseUrl }],
    });
  }
  return passages;
}

export async function downloadText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
  return Buffer.from(await response.arrayBuffer()).toString('utf8');
}

export async function importOfficial(
  source: OfficialSource,
  getText: (url: string) => Promise<string> = downloadText,
  options: { selectPage?: (path: string) => boolean; retrievedOn?: string } = {},
): Promise<Corpus> {
  const { card, base, pages, licenses } = definitions[source];
  const selectPage = options.selectPage;
  const selected = selectPage ? pages.filter(({ path }) => selectPage(path)) : pages;
  if (!selected.length) throw new Error('No selected pages for ' + source);
  const licenseText = await Promise.all(licenses.map(async license => {
    const text = await getText(license.url);
    if (!text.includes(license.contains)) throw new Error('License check failed for ' + license.url);
    return text;
  }));
  const notice = copyrightNotice(source, licenseText);
  const snippetLicense = codeLicense(source, licenseText);
  const fingerprint = createHash('sha256');
  const addDigest = (path: string, body: string) => fingerprint.update(JSON.stringify([path, createHash('sha256').update(body).digest('hex')]) + '\n');
  licenses.forEach(({ url }, index) => addDigest(url, licenseText[index]));
  const passages: Passage[] = [];
  for (let start = 0; start < selected.length; start += 6) {
    const batch = await Promise.all(selected.slice(start, start + 6).map(async page => {
      const url = base + encodeURI(page.path);
      const raw = await getText(url);
      const parsed = source === 'node' ? parseNode(page, raw)
        : source === 'python' ? parsePython(page, raw, snippetLicense)
          : parseMarkdown(source, page, raw, snippetLicense);
      if (!parsed.length) throw new Error('No usable passages in ' + url);
      return { parsed, raw, url };
    }));
    for (const { parsed, raw, url } of batch) {
      addDigest(url, raw);
      passages.push(...parsed);
    }
  }
  return {
    sources: [{
      ...card,
      retrievedOn: options.retrievedOn ?? new Date().toISOString().slice(0, 10),
      ...(notice ? { copyrightNotice: notice } : {}),
      fingerprint: 'sha256:' + fingerprint.digest('hex'),
    }],
    passages,
  };
}
