import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { writeCorpus } from '../../packages/code-knowledge/src/corpus.js';
import { importOfficial, officialSources, type OfficialSource } from '../../packages/code-knowledge/src/import/official.js';
import { downloadStackArchive } from '../../packages/code-knowledge/src/import/stack-archives.js';
import { importStackExchange, openXmlFile, stackSites, type StackSite } from '../../packages/code-knowledge/src/import/stack-exchange.js';
import type { Corpus } from '../../packages/code-knowledge/src/types.js';

const usage = `Usage: npx tsx scripts/code-knowledge/import.ts --output <corpus.json> [options]
  --docs mdn,python,node,typescript  Official sources, or "none" (default: all four)
  --stack-site stackoverflow|unix|dba|devops
                                     Include a Stack Exchange archive (repeatable)
  --stack-cache <directory>          Retain checked archives for later imports
  --seven-zip <executable>           7-Zip command for archive imports (default: 7zz)
  --stack-posts <Posts.xml> --stack-users <Users.xml> --stack-version <version>
                                     Use a local paired XML dump with a single --stack-site
  --stack-limit <count>              Keep at most this many answers per site (default: 25000)
  --stack-min-score <score>           Minimum score if the answer is not accepted (default: 10)
  --stack-since <YYYY-MM-DD>           Oldest question creation date to include
  --help`;

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    docs: { type: 'string' },
    'stack-site': { type: 'string', multiple: true },
    'stack-cache': { type: 'string' },
    'seven-zip': { type: 'string' },
    'stack-posts': { type: 'string' },
    'stack-users': { type: 'string' },
    'stack-version': { type: 'string' },
    'stack-limit': { type: 'string' },
    'stack-min-score': { type: 'string' },
    'stack-since': { type: 'string' },
    help: { type: 'boolean' },
  },
});

async function main() {
  if (values.help) {
    console.log(usage);
    return;
  }
  if (!values.output) throw new Error('--output is required. See --help');
  const docs = values.docs === 'none' ? [] : (values.docs?.split(',') ?? [...officialSources]);
  for (const id of docs) if (!officialSources.includes(id as OfficialSource)) throw new Error('Unknown official source ' + id);
  const sites = [...new Set(values['stack-site'] ?? [])];
  for (const site of sites) if (!Object.hasOwn(stackSites, site)) throw new Error('Unknown Stack Exchange site ' + site);
  if (!docs.length && !sites.length) throw new Error('Choose at least one source');
  const posts = values['stack-posts'];
  const users = values['stack-users'];
  const version = values['stack-version'];
  if ((posts || users || version) && (!posts || !users || !version || sites.length !== 1)) {
    throw new Error('Local Stack Exchange XML requires --stack-posts, --stack-users, --stack-version and a single --stack-site');
  }
  const stackImport = {
    maxAnswers: values['stack-limit'] === undefined ? undefined : Number(values['stack-limit']),
    minScore: values['stack-min-score'] === undefined ? undefined : Number(values['stack-min-score']),
    since: values['stack-since'],
  };

  const results: Corpus[] = await Promise.all([...new Set(docs)].map(id => importOfficial(id as OfficialSource)));
  if (sites.length) {
    const persistentCache = values['stack-cache'];
    const needsArchive = !(posts && users && version);
    const cache = needsArchive
      ? persistentCache ? resolve(persistentCache) : await mkdtemp(join(tmpdir(), 'mohassan-code-knowledge-'))
      : undefined;
    if (needsArchive && persistentCache && cache) await mkdir(cache, { recursive: true });
    try {
      for (const id of sites) {
        const site = id as StackSite;
        const source = posts && users && version
          ? { site, version, posts: openXmlFile(posts), users: openXmlFile(users) }
          : await downloadStackArchive(site, cache!, values['seven-zip']);
        const result = await importStackExchange({ ...source, ...stackImport });
        if (!result.passages.length) throw new Error('No qualifying attributed answers for ' + site);
        results.push(result);
      }
    } finally {
      if (cache && !persistentCache) await rm(cache, { recursive: true, force: true });
    }
  }
  const corpus = { sources: results.flatMap(result => result.sources), passages: results.flatMap(result => result.passages) };
  const output = resolve(values.output);
  await mkdir(dirname(output), { recursive: true });
  await writeCorpus(output, corpus);
  for (const result of results) {
    console.log(result.sources[0].id + ' ' + result.passages.length + ' passages ' + result.sources[0].fingerprint);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Code knowledge import failed');
  process.exitCode = 1;
});
