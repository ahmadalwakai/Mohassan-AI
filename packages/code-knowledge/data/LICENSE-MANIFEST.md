# Offline programming knowledge sources

The bundled `corpus.json` contains 1,183 passages from 69 primary documentation pages retrieved on 2026-11-27. Each passage identifies its original page, source version and credits. The SHA-256 of the serialized corpus is `9c703e67922706c9395af5e3068d9da0a2bdb4ce058dfca29609555e14139724`.

| Documentation and pinned version | Redistribution and attribution | Pages / passages |
| --- | --- | ---: |
| MDN Web Docs at `72813e874d34cf328f39ab025448d9e06d921254`. [Snapshot](https://github.com/mdn/content/tree/72813e874d34cf328f39ab025448d9e06d921254) | Prose excerpts remain under CC BY-SA 2.5. Each passage credits Mozilla Contributors and links to the page and its contributor list. MDN fenced examples are omitted because their licensing depends on a date the migration obscured. [Pinned license](https://github.com/mdn/content/blob/72813e874d34cf328f39ab025448d9e06d921254/LICENSE.md) · [Attribution guidance](https://developer.mozilla.org/en-US/docs/MDN/Writing_guidelines/Attrib_copyright_license) | 37 / 397 |
| Python documentation `3.13.9`. [Versioned pages](https://docs.python.org/release/3.13.9/) | Prose uses PSF License Version 2. Examples use the 0BSD option of their dual license. The corpus contains the complete PSF agreement with its copyright notice and the complete 0BSD text. [PSF agreement](https://docs.python.org/release/3.13.9/license.html#psf-license) · [0BSD](https://docs.python.org/release/3.13.9/license.html#bsd0) · [Copyright](https://docs.python.org/release/3.13.9/copyright.html) | 11 / 210 |
| Node.js documentation `v22.21.1`. [Versioned pages](https://nodejs.org/download/release/v22.21.1/docs/api/) | Node.js documentation and examples use MIT. The corpus includes both the Node.js contributors and Joyent MIT notices. [Pinned license](https://github.com/nodejs/node/blob/v22.21.1/LICENSE) | 9 / 403 |
| TypeScript Handbook v2 and reference at `cf57c7ec6762f3cae3a9ebc973e63851d88cb2a8`. [Snapshot](https://github.com/microsoft/TypeScript-Website/tree/cf57c7ec6762f3cae3a9ebc973e63851d88cb2a8) | Prose uses CC BY 4.0 with Microsoft and TypeScript contributors credited. Code uses MIT with its copyright and permission notice included on every retained example. [Pinned legal notice](https://github.com/microsoft/TypeScript-Website/blob/cf57c7ec6762f3cae3a9ebc973e63851d88cb2a8/README.md#legal-notices) · [Prose license](https://github.com/microsoft/TypeScript-Website/blob/cf57c7ec6762f3cae3a9ebc973e63851d88cb2a8/LICENSE) · [Code license](https://github.com/microsoft/TypeScript-Website/blob/cf57c7ec6762f3cae3a9ebc973e63851d88cb2a8/LICENSE-CODE) | 12 / 173 |

The section importer removes navigation and markup, decodes entities and normalizes whitespace. The bundle keeps selected sections, up to two early paragraphs and one bounded source example per section. The answerer quotes selected sentences and may omit a snippet. These are the extraction changes to the licensed upstream documentation. The build and answer paths do not use a model. The project did not independently verify writing tools used by individual upstream contributors.

The production corpus contains only the four documentation sources in the table. The opt-in historical Stack Exchange importer and PR #45 evaluation fixtures are separate from the bundle. Stack Exchange records license and attribution per post revision. [Stack Exchange licensing](https://stackoverflow.com/help/licensing) · [Archive access](https://stackoverflow.com/help/data-dumps)

## Arabic query terminology

The following sources, checked on 2026-11-27, supply lookup terms in [glossary.ts](../src/glossary.ts).

- Arabeyes Technical Computing Dictionary v3.0.20160902 under the FreeBSD Documentation License. The terms are selected and some English senses shortened. The full notice and source fingerprint are in the file. [Dictionary and license](https://www.arabeyes.org/techdict/archive/arabdict-20160902.pdf)
- Wikidata language labels and aliases under CC0. [JavaScript revision](https://www.wikidata.org/wiki/Special:PermanentLink/2566877768) · [Python revision](https://www.wikidata.org/wiki/Special:PermanentLink/2566877611) · [TypeScript revision](https://www.wikidata.org/wiki/Special:PermanentLink/2573905279) · [License](https://www.wikidata.org/wiki/Wikidata:Licensing)
- Selected terminology from `Rendering Lists` by the Arabic React documentation contributors under CC BY 4.0. [Pinned page](https://github.com/reactjs/ar.react.dev/blob/2da48d6c96d6e5ae6aa6618e074504efc2717d30/src/content/learn/rendering-lists.md) · [Pinned license](https://github.com/reactjs/ar.react.dev/blob/2da48d6c96d6e5ae6aa6618e074504efc2717d30/LICENSE-DOCS.md)

## Reproduction

The generator declares every input page. Its output includes a per-source fingerprint computed from the input URL and SHA-256 of each license and page, in importer order. From the repository root with dependencies installed, rerun the networked build and compare its output with the checked-in file. The explicit date reproduces the recorded retrieval date when all source fingerprints match.

```bash
NODE_USE_ENV_PROXY=1 node_modules/.bin/tsx scripts/code-knowledge/bundle.ts \
  --retrieved-on 2026-11-27 --output /tmp/code-knowledge-corpus.json
cmp packages/code-knowledge/data/corpus.json /tmp/code-knowledge-corpus.json
```
