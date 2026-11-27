import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { readLocalDump } from './dump.ts';

export type WikipediaLanguage = 'ar' | 'en';

export interface WikipediaInput {
  inputPath: string;
  language: WikipediaLanguage;
  source: string;
  dumpDate: string;
}

interface XmlTag {
  name: string;
  attributes: Record<string, string>;
}

interface XmlParser {
  onopentag: (tag: XmlTag) => void;
  onclosetag: (tag: string) => void;
  ontext: (text: string) => void;
  oncdata: (text: string) => void;
  ondoctype: () => never;
  onerror: (error: Error) => never;
  write(text: string): XmlParser;
  close(): XmlParser;
}

const sax: { parser(strict: boolean): XmlParser } = createRequire(import.meta.url)('sax');
type Field = 'title' | 'ns' | 'pageId' | 'revisionId' | 'revisionDate' | 'wikitext';

interface WikipediaPage {
  title: string;
  pageId: string;
  revisionId: string;
  revisionDate: string;
  wikitext: string;
}

const articleFields: Record<string, Field | undefined> = {
  'mediawiki/page/title': 'title',
  'mediawiki/page/ns': 'ns',
  'mediawiki/page/id': 'pageId',
  'mediawiki/page/revision/id': 'revisionId',
  'mediawiki/page/revision/timestamp': 'revisionDate',
  'mediawiki/page/revision/text': 'wikitext',
};

const maxTextSize = 4 * 1024 * 1024;
const maxMetadataSize = 1024;

interface Page {
  fields: Partial<Record<Field, string>>;
  redirect: boolean;
  revision: boolean;
  oversized: boolean;
}

interface TextCapture {
  field: Field | 'dbname';
  text: string[];
  size: number;
}

const positiveId = /^[1-9][0-9]*$/u;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

function parserFor(language: WikipediaLanguage, onPage: (page: WikipediaPage) => void) {
  const parser = sax.parser(true);
  const path: string[] = [];
  let page: Page | undefined;
  let capture: TextCapture | undefined;
  let rootSeen = false;
  let pages = 0;
  let skippedOversizedPages = 0;

  parser.onopentag = tag => {
    if (capture) throw new Error('Unexpected nested element in a Wikipedia XML text field');
    path.push(tag.name);
    if (path.length > 32) throw new Error('Wikipedia XML element nesting limit exceeded');
    const here = path.join('/');
    if (path.length === 1) {
      if (tag.name !== 'mediawiki' || rootSeen) throw new Error('Expected one MediaWiki XML root');
      rootSeen = true;
      if (tag.attributes['xml:lang'] && tag.attributes['xml:lang'] !== language) {
        throw new Error('Wikipedia XML language differs from the requested edition');
      }
    }
    if (here === 'mediawiki/page') page = { fields: {}, redirect: false, revision: false, oversized: false };
    if (page && here === 'mediawiki/page/redirect') page.redirect = true;
    if (page && here === 'mediawiki/page/revision') {
      if (page.revision) throw new Error('Expected a current-revision pages-articles dump');
      page.revision = true;
    }
    const field = here === 'mediawiki/siteinfo/dbname' ? 'dbname' : page && articleFields[here];
    if (field) capture = { field, text: [], size: 0 };
  };

  parser.ontext = parser.oncdata = value => {
    if (!capture) return;
    const limit = capture.field === 'wikitext' ? maxTextSize : maxMetadataSize;
    capture.size += value.length;
    if (capture.size <= limit) capture.text.push(value);
    else if (capture.field === 'wikitext' && page) {
      capture.text.length = 0;
      page.oversized = true;
    } else {
      throw new Error('Wikipedia XML metadata field exceeds its size limit');
    }
  };

  parser.onclosetag = () => {
    if (capture) {
      const value = capture.text.join('');
      if (capture.field === 'dbname') {
        if (value.trim() !== `${language}wiki`) throw new Error('Wikipedia XML database name differs from the requested edition');
      } else if (page) {
        page.fields[capture.field] = value;
      }
      capture = undefined;
    }

    if (page && path.length === 2 && path[1] === 'page') {
      pages++;
      const { ns, title, pageId, revisionId, revisionDate, wikitext } = page.fields;
      if (ns?.trim() === '0' && !page.redirect) {
        if (page.oversized) {
          skippedOversizedPages++;
        } else if (wikitext) {
          if (!title?.trim() || !pageId || !positiveId.test(pageId) || !revisionId || !positiveId.test(revisionId)
            || !revisionDate || !timestamp.test(revisionDate) || !Number.isFinite(Date.parse(revisionDate))) {
            throw new Error('Wikipedia article has incomplete citation metadata');
          }
          onPage({ title: title.trim(), pageId, revisionId, revisionDate, wikitext });
        }
      }
      page = undefined;
    }
    path.pop();
  };

  parser.ondoctype = () => { throw new Error('Wikipedia XML doctype is unsupported'); };
  parser.onerror = error => { throw error; };
  return {
    parser,
    finish() {
      parser.close();
      if (!rootSeen || path.length) throw new Error('Incomplete MediaWiki XML document');
      return { pages, skippedOversizedPages };
    },
  };
}

async function* xmlChunks(inputPath: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
  if (!inputPath.toLowerCase().endsWith('.bz2')) {
    yield* readLocalDump(inputPath, signal);
    return;
  }

  // Pass the file as stdin so its name is never interpreted as an argument.
  const input = createReadStream(inputPath, { signal });
  const decoder = spawn('bzip2', ['-dc'], { stdio: ['pipe', 'pipe', 'ignore'], signal });
  const status = once(decoder, 'close').then(([code]) => ({ code }), error => ({ error }));
  const inputStatus = pipeline(input, decoder.stdin, { signal }).then(() => ({}), error => ({ error }));
  try {
    for await (const chunk of decoder.stdout) yield chunk;
    const outcome = await status;
    if ('error' in outcome) throw outcome.error;
    const copied = await inputStatus;
    if (outcome.code !== 0) throw new Error(`bzip2 failed to decode Wikipedia XML (exit ${outcome.code})`);
    if ('error' in copied) throw copied.error;
  } finally {
    input.destroy();
    if (decoder.exitCode === null) decoder.kill();
    await status;
    await inputStatus;
  }
}

export async function readWikipediaXml(input: WikipediaInput, onPage: (page: WikipediaPage) => void, signal?: AbortSignal) {
  const reader = parserFor(input.language, onPage);
  const sha256 = createHash('sha256');
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  let inputBytes = 0;
  for await (const chunk of xmlChunks(input.inputPath, signal)) {
    signal?.throwIfAborted();
    sha256.update(chunk);
    inputBytes += chunk.length;
    reader.parser.write(utf8.decode(chunk, { stream: true }));
  }
  reader.parser.write(utf8.decode());
  return { ...reader.finish(), inputBytes, fingerprint: `sha256:${sha256.digest('hex')}` };
}
