import { lstatSync } from 'node:fs';
import { link, mkdtemp, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeLookupKey } from './normalize.ts';
import { readWikipediaXml, type WikipediaInput, type WikipediaLanguage } from './wikipedia-xml.ts';
import { parseWikipediaLead, type WikipediaField } from './wikipedia-wikitext.ts';

export type { WikipediaInput, WikipediaLanguage } from './wikipedia-xml.ts';
export { parseWikipediaLead, type WikipediaField } from './wikipedia-wikitext.ts';

const license = 'CC-BY-SA-4.0';
const licenseUrl = 'https://creativecommons.org/licenses/by-sa/4.0/';
const applicationId = 0x4d4f5749; // MOWI
const version = 1;
const batchSize = 250;

interface WikipediaSource {
  language: WikipediaLanguage;
  source: string;
  dumpDate: string;
  inputBytes: number;
  fingerprint: string;
  pages: number;
  articles: number;
  leads: number;
  facts: number;
  skippedOversizedPages: number;
}

interface WikipediaCard {
  formatVersion: typeof version;
  source: 'Wikipedia';
  license: typeof license;
  licenseUrl: typeof licenseUrl;
  fingerprintOf: 'decompressed XML bytes';
  sources: WikipediaSource[];
}

export interface WikipediaDataCard extends WikipediaCard {
  storeBytes: number;
}

export interface WikipediaAttribution {
  source: 'Wikipedia';
  dumpSource: string;
  dumpDate: string;
  language: WikipediaLanguage;
  title: string;
  pageId: string;
  revisionId: string;
  revisionDate: string;
  revisionUrl: string;
  author: 'Wikipedia contributors';
  historyUrl: string;
  license: typeof license;
  licenseUrl: typeof licenseUrl;
  changes: string;
}

export interface WikipediaLeadHit {
  lead: string;
  /** SQLite FTS5 BM25, ordered from lowest (best) to highest. */
  bm25: number;
  attribution: WikipediaAttribution;
}

export interface WikipediaInfoboxFact extends WikipediaField {
  attribution: WikipediaAttribution;
}

interface ArticleRow {
  language: WikipediaLanguage;
  pageId: string;
  title: string;
  revisionId: string;
  revisionDate: string;
  lead: string;
  fields: string;
}

export interface WikipediaBuildOptions {
  databasePath: string;
  inputs: readonly WikipediaInput[];
  signal?: AbortSignal;
}

function initialize(db: DatabaseSync) {
  db.exec(`
    PRAGMA application_id = ${applicationId};
    PRAGMA user_version = ${version};
    CREATE TABLE article (
      id INTEGER PRIMARY KEY,
      language TEXT NOT NULL,
      pageId TEXT NOT NULL,
      title TEXT NOT NULL,
      revisionId TEXT NOT NULL,
      revisionDate TEXT NOT NULL,
      lead TEXT NOT NULL,
      fields TEXT NOT NULL,
      UNIQUE (language, pageId)
    ) STRICT;
    CREATE VIRTUAL TABLE article_fts USING fts5(title, lead, content='', tokenize='unicode61 remove_diacritics 0');
    CREATE TABLE data_card (card TEXT NOT NULL) STRICT;
  `);
}

function validateInputs(inputs: readonly WikipediaInput[]) {
  if (!inputs.length) throw new Error('At least one Wikipedia XML input is required');
  const languages = new Set<WikipediaLanguage>();
  for (const input of inputs) {
    if (input.language !== 'en' && input.language !== 'ar') throw new Error('Wikipedia edition must be en or ar');
    if (languages.has(input.language)) throw new Error('Provide one complete Wikipedia XML input per edition');
    languages.add(input.language);
    const date = new Date(`${input.dumpDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.dumpDate) || !Number.isFinite(+date) || date.toISOString().slice(0, 10) !== input.dumpDate) {
      throw new Error('Wikipedia dump date must be YYYY-MM-DD');
    }
    if (!input.source.trim()) throw new Error('Wikipedia dump source is required');
  }
}

async function build(db: DatabaseSync, inputs: readonly WikipediaInput[], signal?: AbortSignal): Promise<WikipediaCard> {
  initialize(db);
  const insert = db.prepare('INSERT INTO article(language, pageId, title, revisionId, revisionDate, lead, fields) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const index = db.prepare('INSERT INTO article_fts(rowid, title, lead) VALUES (?, ?, ?)');
  const sources: WikipediaSource[] = [];
  for (const { inputPath, language, source, dumpDate } of inputs) {
    let articles = 0;
    let leads = 0;
    let facts = 0;
    db.exec('BEGIN');
    const receipt = await readWikipediaXml({ inputPath, language, source, dumpDate }, page => {
      const { lead, fields } = parseWikipediaLead(page.wikitext);
      if (!lead && !fields.length) return;
      const row = insert.run(language, page.pageId, page.title, page.revisionId, page.revisionDate, lead, JSON.stringify(fields));
      if (lead) {
        index.run(row.lastInsertRowid, normalizeLookupKey(page.title), normalizeLookupKey(lead));
        leads++;
      }
      facts += fields.length;
      articles++;
      if (articles % batchSize === 0) db.exec('COMMIT; BEGIN');
    }, signal);
    db.exec('COMMIT');
    sources.push({ language, source, dumpDate, ...receipt, articles, leads, facts });
  }
  const card: WikipediaCard = { formatVersion: version, source: 'Wikipedia', license, licenseUrl, fingerprintOf: 'decompressed XML bytes', sources };
  db.prepare('INSERT INTO data_card VALUES (?)').run(JSON.stringify(card));
  return card;
}

/** Build a fresh index, publishing the SQLite file only after every input completes. */
export async function importWikipedia(options: WikipediaBuildOptions): Promise<WikipediaDataCard> {
  validateInputs(options.inputs);
  options.signal?.throwIfAborted();
  const existing = lstatSync(options.databasePath, { throwIfNoEntry: false });
  if (existing) throw new Error('Wikipedia index already exists; choose a fresh output path');
  const directory = await mkdtemp(join(dirname(options.databasePath), '.offline-wikipedia-'));
  const path = join(directory, 'index.sqlite');
  try {
    const db = new DatabaseSync(path);
    let card: WikipediaCard;
    try {
      card = await build(db, options.inputs, options.signal);
    } finally {
      db.close();
    }
    const { size } = await stat(path);
    options.signal?.throwIfAborted();
    // An exclusive publication avoids replacing an existing snapshot accidentally.
    await link(path, options.databasePath);
    return { ...card, storeBytes: size };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function attribution(row: ArticleRow, sources: readonly WikipediaSource[], changes: string): WikipediaAttribution {
  const edition = sources.find(source => source.language === row.language);
  if (!edition) throw new Error('Wikipedia edition has no data-card entry');
  const document = `https://${row.language}.wikipedia.org/w/index.php`;
  const title = encodeURIComponent(row.title.replaceAll(' ', '_'));
  return {
    source: 'Wikipedia', dumpSource: edition.source, dumpDate: edition.dumpDate,
    language: row.language, title: row.title, pageId: row.pageId,
    revisionId: row.revisionId, revisionDate: row.revisionDate,
    revisionUrl: `${document}?oldid=${row.revisionId}`,
    author: 'Wikipedia contributors', historyUrl: `${document}?title=${title}&action=history`,
    license, licenseUrl, changes,
  };
}

function readCard(db: DatabaseSync): WikipediaDataCard {
  if (db.prepare('PRAGMA application_id').get()?.application_id !== applicationId
    || db.prepare('PRAGMA user_version').get()?.user_version !== version) {
    throw new Error('Unsupported Wikipedia index format');
  }
  const json = db.prepare('SELECT card FROM data_card').get()?.card;
  if (typeof json !== 'string') throw new Error('Wikipedia index is missing its data card');
  const card = JSON.parse(json) as WikipediaCard;
  const pages = Number(db.prepare('PRAGMA page_count').get()?.page_count);
  const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size);
  return { ...card, storeBytes: pages * pageSize };
}

export function openWikipediaIndex(databasePath: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const card = readCard(db);
    const search = db.prepare(`
      SELECT a.language, a.pageId, a.title, a.revisionId, a.revisionDate, a.lead, bm25(article_fts, 3.0, 1.0) AS bm25
      FROM article_fts JOIN article a ON a.id = article_fts.rowid
      WHERE article_fts MATCH ? AND (? IS NULL OR a.language = ?)
      ORDER BY bm25, a.id LIMIT ?
    `);
    const find = db.prepare('SELECT * FROM article WHERE language = ? AND pageId = ?');
    return {
      card,
      searchLeads(query: string, options: { language?: WikipediaLanguage; limit?: number } = {}): WikipediaLeadHit[] {
        const tokens = [...new Set(normalizeLookupKey(query.slice(0, 2048)).match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu))].slice(0, 24);
        if (!tokens.length) return [];
        const match = tokens.map(term => `"${term}"`).join(' OR ');
        const language = options.language ?? null;
        const limit = options.limit !== undefined && Number.isFinite(options.limit)
          ? Math.max(0, Math.min(100, Math.trunc(options.limit))) : 10;
        const rows = search.all(match, language, language, limit) as unknown as (ArticleRow & { bm25: number })[];
        return rows.map(row => ({
          lead: row.lead, bm25: row.bm25,
          attribution: attribution(row, card.sources, 'Lead extracted, wikitext simplified and length limited.'),
        }));
      },
      infobox(language: WikipediaLanguage, pageId: string): WikipediaInfoboxFact[] {
        const row = find.get(language, pageId) as unknown as ArticleRow | undefined;
        if (!row) return [];
        const fields = JSON.parse(row.fields) as WikipediaField[];
        return fields.map(field => ({
          ...field, attribution: attribution(row, card.sources, 'Named parameter extracted and outer whitespace trimmed. Wikitext is unexpanded.'),
        }));
      },
      close() { db.close(); },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
