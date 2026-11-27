import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { writeCorpus } from '../../packages/code-knowledge/src/corpus.js';
import { importOfficial, officialSources, type OfficialSource } from '../../packages/code-knowledge/src/import/official.js';
import type { Passage } from '../../packages/code-knowledge/src/types.js';

// These paths refer to the primary sources pinned in import/official.ts.
// Initial retrieval: 2026-11-27. See the bundle's LICENSE-MANIFEST.md.
const mdnReference = 'files/en-us/web/javascript/reference/';
const mdnGuide = 'files/en-us/web/javascript/guide/';
const typescriptHandbook = 'packages/documentation/copy/en/handbook-v2/';
const typescriptReference = 'packages/documentation/copy/en/reference/';

const pages: Record<OfficialSource, readonly string[]> = {
  mdn: [
    ...[
      'array', 'array/from', 'array/map', 'array/filter', 'array/reduce', 'array/foreach',
      'array/find', 'array/flatmap', 'array/includes', 'array/sort', 'array/tosorted',
      'map', 'set', 'json/parse', 'json/stringify', 'object/entries', 'object/fromentries',
      'object/keys', 'promise', 'promise/all', 'promise/allsettled', 'promise/any', 'promise/race',
      'string/includes', 'string/split',
    ].map(path => mdnReference + 'global_objects/' + path + '/index.md'),
    ...[
      'operators/await', 'operators/destructuring', 'operators/nullish_coalescing',
      'operators/optional_chaining', 'operators/spread_syntax', 'statements/async_function',
      'errors/not_a_function', 'errors/not_defined', 'errors/json_bad_parse',
    ].map(path => mdnReference + path + '/index.md'),
    ...['closures', 'modules', 'using_promises'].map(path => mdnGuide + path + '/index.md'),
  ],
  python: [
    'faq/programming', 'howto/sorting', 'tutorial/datastructures', 'tutorial/errors',
    'tutorial/inputoutput', 'library/collections', 'library/functions', 'library/json',
    'library/pathlib', 'library/re', 'library/stdtypes',
  ].map(path => path + '.html'),
  node: [
    'assert', 'errors', 'esm', 'events', 'fs', 'modules', 'path', 'process', 'test',
  ].map(path => path + '.json'),
  typescript: [
    ...['Basics', 'Everyday Types', 'Narrowing', 'More on Functions', 'Object Types', 'Modules',
      'Type Manipulation/Generics', 'Type Manipulation/Conditional Types',
      'Type Manipulation/Mapped Types'].map(path => typescriptHandbook + path + '.md'),
    ...['Utility Types', 'Type Compatibility', 'Type Inference'].map(path => typescriptReference + path + '.md'),
  ],
};

// The long reference pages have hundreds of unrelated entries. Keep their
// overview and the common APIs documented on the pinned primary pages above.
const sections: Readonly<Record<string, RegExp>> = {
  '/library/collections.html': /^(?:collections —|(?:ChainMap|Counter) objects|collections\.(?:ChainMap|Counter|deque|defaultdict|namedtuple)(?:\.(?:append|appendleft|most_common|pop|popleft|update))?$)/u,
  '/library/functions.html': /^(?:Built-in Functions|all|any|enumerate|filter|isinstance|len|map|max|min|open|print|sorted|sum|zip)$/u,
  '/library/pathlib.html': /^(?:pathlib —|Basic use|pathlib\.(?:Path|PurePath)(?:\.(?:exists|glob|is_file|mkdir|open|read_text|resolve|write_text))?$)/u,
  '/library/re.html': /^(?:re —|Regular Expression Syntax|re\.(?:compile|findall|finditer|fullmatch|match|search|split|sub)$)/u,
  '/library/stdtypes.html': /^(?:Built-in Types|Truth Value Testing|Boolean Operations|Comparisons|Common Sequence Operations|Sequence Types|Text Sequence Type|Mapping Types|Set Types|Lists|list(?:\.sort)?$|dict(?:\.(?:get|items|keys|setdefault|update|values))?$|str\.(?:join|replace|split|strip)$)/u,
  '/docs/api/errors.html': /^(?:Errors|Common system errors|Class: (?:Assertion|Range|Reference|Syntax|System|Type)?Error|Error\.captureStackTrace|ERR_(?:ASSERTION|INVALID_ARG_TYPE|MODULE_NOT_FOUND|REQUIRE_ESM)|EADDRINUSE|ECONNREFUSED|EEXIST|ENOENT|ETIMEDOUT)\b/u,
  '/docs/api/fs.html': /^(?:File system|(?:Promise|Callback|Synchronous) example|(?:Promises|Callback|Synchronous) API|(?:fsPromises|fs)\.(?:access|appendFile|mkdir|readFile|readdir|rename|rm|stat|unlink|writeFile)(?:Sync)?\()/u,
  '/docs/api/process.html': /^(?:Process|Process events|Exit codes|process\.(?:argv|cwd|env|exit|exitCode|nextTick|stderr|stdin|stdout|version))\b/u,
};

function excerpt(passage: Passage): Passage[] {
  const selection = Object.entries(sections).find(([path]) => new URL(passage.url).pathname.endsWith(path))?.[1];
  if (selection && !selection.test(passage.title)) return [];
  const paragraphs = passage.text.split('\n\n').filter(Boolean);
  const text = paragraphs.slice(0, 2).filter(paragraph => paragraph.length <= 1_000).join('\n\n');
  if (!text) return [];
  const code = passage.code.filter(block => block.role !== 'failure' && block.text.length <= 1_200).slice(0, 1);
  return [{ ...passage, text, code }];
}

async function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' }, 'retrieved-on': { type: 'string' } } });
  const output = values.output ?? fileURLToPath(new URL('../../packages/code-knowledge/data/corpus.json', import.meta.url));
  const corpora = [];
  for (const source of officialSources) {
    const remaining = new Set(pages[source]);
    const corpus = await importOfficial(source, undefined, {
      selectPage: path => remaining.delete(path),
      retrievedOn: values['retrieved-on'],
    });
    if (remaining.size) throw new Error(`Missing ${source} bundle pages: ${[...remaining].join(', ')}`);
    corpora.push(corpus);
  }
  const corpus = {
    sources: corpora.flatMap(result => result.sources),
    passages: corpora.flatMap(result => result.passages.flatMap(excerpt)),
  };
  await writeCorpus(output, corpus);
  for (const source of corpus.sources) {
    const count = corpus.passages.filter(passage => passage.sourceId === source.id).length;
    console.log(`${source.id} ${count} passages ${source.fingerprint}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Code knowledge bundle failed');
  process.exitCode = 1;
});
