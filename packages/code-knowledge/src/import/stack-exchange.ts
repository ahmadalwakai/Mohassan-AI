import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { Attribution, Corpus, Passage } from '../types.js';
import { decodeEntities, htmlSection } from './snippets.js';

export const stackSites = {
  stackoverflow: { host: 'stackoverflow.com', title: 'Stack Overflow' },
  unix: { host: 'unix.stackexchange.com', title: 'Unix & Linux Stack Exchange' },
  dba: { host: 'dba.stackexchange.com', title: 'Database Administrators Stack Exchange' },
  devops: { host: 'devops.stackexchange.com', title: 'DevOps Stack Exchange' },
} as const;
export type StackSite = keyof typeof stackSites;

export const stackTags = [
  'javascript', 'typescript', 'node.js', 'reactjs', 'next.js', 'fastify', 'kysely', 'zod', 'chakra-ui',
  'electron', 'playwright', 'vitest', 'html', 'css', 'webextensions', 'google-chrome-extension',
  'kotlin', 'java', 'c#', '.net', 'win32', 'android', 'android-jetpack-compose', 'powershell', 'docker', 'docker-compose',
  'python', 'python-3.x', 'postgresql', 'sql', 'sqlite', 'shell', 'bash', 'sh', 'posix', 'zsh',
];

type XmlStream = () => Readable;
type Row = Record<string, string>;
type PostLicense = { license: string; licenseUrl: string };
type PostOwner = { userId?: number; displayName?: string };
interface Question {
  id: number;
  tags: string[];
  accepted: number;
  owner: PostOwner;
  title: string;
  license?: PostLicense;
  editorId?: number;
  edited: boolean;
}
interface Candidate {
  id: number;
  questionId: number;
  weight: number;
  owner: PostOwner;
  editorId?: number;
  edited: boolean;
  body: string;
  license: PostLicense;
}

export interface StackImportOptions {
  site: StackSite;
  version: string;
  posts: XmlStream;
  users: XmlStream;
  sourceUrl?: string;
  maxAnswers?: number;
  minScore?: number;
  since?: string;
}

export function openXmlFile(path: string): XmlStream {
  return () => createReadStream(path);
}

function parseLine(line: string, root: 'posts' | 'users', markers: { opened: boolean; closed: boolean }): Row | undefined {
  if (!line.trim() || /^\uFEFF?<\?xml\s.*\?>\s*$/.test(line)) return;
  if (line.trim() === '<' + root + '>') {
    if (markers.opened) throw new Error('Duplicate Stack Exchange XML root');
    markers.opened = true;
    return;
  }
  if (line.trim() === '</' + root + '>') {
    if (!markers.opened || markers.closed) throw new Error('Invalid Stack Exchange XML root');
    markers.closed = true;
    return;
  }
  const attributes = line.match(/^\s*<row\s+(.+)\s*\/\s*>\s*$/s)?.[1];
  if (!attributes || !markers.opened || markers.closed) throw new Error('Unexpected Stack Exchange ' + root + ' XML row');
  return Object.fromEntries([...attributes.matchAll(/([A-Za-z][A-Za-z\d]*)="([^"]*)"/g)].map(match => [match[1], match[2]]));
}

async function* xmlRows(open: XmlStream, root: 'posts' | 'users', hash?: Hash): AsyncGenerator<Row> {
  const decoder = new StringDecoder('utf8');
  const markers = { opened: false, closed: false };
  let pending = '';
  let multilineRow = '';
  const parse = (line: string) => {
    if (multilineRow || /^\s*<row\b/.test(line)) {
      const row = multilineRow + line;
      if (!/"\s*\/>\s*$/.test(line)) {
        if (row.length > 16_000_000) throw new Error('Stack Exchange XML row exceeds the supported size');
        multilineRow = row + '\n';
        return undefined;
      }
      multilineRow = '';
      return parseLine(row, root, markers);
    }
    return parseLine(line, root, markers);
  };
  for await (const chunk of open()) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    hash?.update(bytes);
    const lines = (pending + decoder.write(bytes)).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const row = parse(line);
      if (row) yield row;
    }
  }
  const last = parse(pending + decoder.end());
  if (last) yield last;
  if (multilineRow || !markers.closed) throw new Error('Incomplete Stack Exchange ' + root + ' XML');
}

const allowedTags = new Set(stackTags);
function selectTags(value: string): string[] {
  return decodeEntities(value).split(/[|<>]/).filter(tag => allowedTags.has(tag));
}

function postLicense(value?: string): PostLicense | undefined {
  const version = value?.match(/^CC\s+BY-SA\s+(2\.5|3\.0|4\.0)$/)?.[1];
  if (version) return { license: 'CC-BY-SA-' + version, licenseUrl: 'https://creativecommons.org/licenses/by-sa/' + version + '/' };
  return undefined;
}

function postOwner(row: Row): PostOwner {
  return { userId: Number(row.OwnerUserId) || undefined, displayName: row.OwnerDisplayName && decodeEntities(row.OwnerDisplayName).trim() };
}

// Heap root is the least preferred selected answer. The buffer never holds more than the limit.
const compare = (a: Candidate, b: Candidate) => a.weight - b.weight || b.id - a.id;
function keepCandidate(heap: Candidate[], candidate: Candidate, limit: number) {
  if (heap.length < limit) {
    let index = heap.length;
    heap.push(candidate);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compare(heap[parent], candidate) <= 0) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = candidate;
    return;
  }
  if (compare(candidate, heap[0]) <= 0) return;
  let index = 0;
  while (index * 2 + 1 < heap.length) {
    const left = index * 2 + 1;
    const right = left + 1;
    const child = right < heap.length && compare(heap[right], heap[left]) < 0 ? right : left;
    if (compare(heap[child], candidate) >= 0) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = candidate;
}

function attributionFor(author: PostOwner, users: Map<number, string>, site: string): Attribution | undefined {
  const name = author.userId ? users.get(author.userId) ?? author.displayName : author.displayName;
  if (!name) return undefined;
  return { name, ...(author.userId && author.userId > 0 ? { url: site + '/users/' + author.userId } : {}) };
}

export async function importStackExchange(options: StackImportOptions): Promise<Corpus> {
  const { site, version, posts, users } = options;
  const metadata = stackSites[site];
  const maxAnswers = options.maxAnswers ?? 25_000;
  const minScore = options.minScore ?? 10;
  if (!version.trim() || !Number.isSafeInteger(maxAnswers) || maxAnswers < 1 || !Number.isSafeInteger(minScore) || minScore < 5) {
    throw new Error('Stack Exchange requires a version, a positive answer limit and a high-score threshold of at least 5');
  }
  if (options.since && !/^\d{4}-\d{2}-\d{2}$/.test(options.since)) throw new Error('Stack Exchange start date must be YYYY-MM-DD');
  const base = 'https://' + metadata.host;
  const sourceId = 'stack-exchange:' + site;
  const postsHash = createHash('sha256');
  const usersHash = createHash('sha256');
  const questions = new Map<number, Question>();
  for await (const row of xmlRows(posts, 'posts', postsHash)) {
    if (row.PostTypeId !== '1' || (options.since && row.CreationDate < options.since)) continue;
    const tags = selectTags(row.Tags ?? '');
    const id = Number(row.Id);
    if (!tags.length || !Number.isSafeInteger(id) || id < 1) continue;
    questions.set(id, {
      id, tags, accepted: Number(row.AcceptedAnswerId),
      owner: postOwner(row), title: decodeEntities(row.Title ?? '').trim(),
      license: postLicense(row.ContentLicense), editorId: Number(row.LastEditorUserId) || undefined, edited: Boolean(row.LastEditDate),
    });
  }

  const selected: Candidate[] = [];
  const secondPostsHash = createHash('sha256');
  for await (const row of xmlRows(posts, 'posts', secondPostsHash)) {
    if (row.PostTypeId !== '2') continue;
    const question = questions.get(Number(row.ParentId));
    const id = Number(row.Id);
    const score = Number(row.Score);
    if (!question || !Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(score)) continue;
    const accepted = question.accepted === id;
    if (!accepted && score < minScore) continue;
    const license = postLicense(row.ContentLicense);
    const owner = postOwner(row);
    if (!license || !row.Body || (!owner.userId && !owner.displayName)) continue;
    keepCandidate(selected, {
      id, questionId: question.id, weight: score + (accepted ? 5 : 0), owner,
      editorId: Number(row.LastEditorUserId) || undefined,
      edited: Boolean(row.LastEditDate), body: row.Body, license,
    }, maxAnswers);
  }
  const postsDigest = postsHash.digest('hex');
  if (secondPostsHash.digest('hex') !== postsDigest) throw new Error('Stack Exchange Posts.xml changed during import');

  const neededUsers = new Set<number>();
  for (const answer of selected) {
    const question = questions.get(answer.questionId);
    for (const id of [answer.owner.userId, answer.editorId, question?.owner.userId, question?.editorId]) {
      if (id) neededUsers.add(id);
    }
  }
  const names = new Map<number, string>();
  for await (const row of xmlRows(users, 'users', usersHash)) {
    const id = Number(row.Id);
    if (neededUsers.has(id) && row.DisplayName) names.set(id, decodeEntities(row.DisplayName).trim());
  }
  const passages: Passage[] = [];
  for (const answer of selected.sort((a, b) => a.id - b.id)) {
    const author = attributionFor(answer.owner, names, base);
    if (!author) continue;
    const question = questions.get(answer.questionId)!;
    const questionAuthor = attributionFor(question.owner, names, base);
    const quoteTitle = Boolean(question.title && question.license?.license === answer.license.license && questionAuthor);
    const questionUrl = base + '/questions/' + question.id;
    const attribution: Attribution[] = [author];
    if (answer.editorId && answer.editorId !== answer.owner.userId) {
      const editor = attributionFor({ userId: answer.editorId }, names, base);
      if (editor) attribution.push(editor);
    }
    if (answer.edited) attribution.push({ name: 'Answer revision history', url: base + '/posts/' + answer.id + '/revisions' });
    if (quoteTitle && questionAuthor) {
      attribution.push(questionAuthor);
      if (question.editorId && question.editorId !== question.owner.userId) {
        const editor = attributionFor({ userId: question.editorId }, names, base);
        if (editor) attribution.push(editor);
      }
      if (question.edited) attribution.push({ name: 'Question revision history', url: base + '/posts/' + question.id + '/revisions' });
    }
    const content = htmlSection(decodeEntities(answer.body));
    if (!content.text && !content.code.length) continue;
    passages.push({
      id: sourceId + ':' + answer.id, sourceId, title: quoteTitle ? question.title : metadata.title + ' answer #' + answer.id,
      url: base + '/a/' + answer.id, questionUrl, tags: question.tags, attribution, ...answer.license,
      text: content.text, code: content.code,
    });
  }
  const fingerprint = createHash('sha256').update('Posts.xml:' + postsDigest + '\nUsers.xml:' + usersHash.digest('hex') + '\n').digest('hex');
  return {
    sources: [{
      id: sourceId, title: metadata.title, kind: 'qa', url: options.sourceUrl ?? base + '/help/data-dumps',
      license: 'CC BY-SA (post-specific)', licenseUrl: base + '/help/licensing', version, fingerprint: 'sha256:' + fingerprint,
    }],
    passages,
  };
}
