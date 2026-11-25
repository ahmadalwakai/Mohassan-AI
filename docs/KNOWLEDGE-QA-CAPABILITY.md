# Offline knowledge QA in the capability benchmark

This diagnostic uses the factual area from PR #22 at `a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f`. The upstream loader verifies the development and sealed fixture hashes before the runner selects all 24 factual cases. The benchmark's own harness produces today's answer using fixture replay with model calls disabled. The shadow adapter logs today's answer and the offline result together. The upstream fixtures are agent-authored and serve only as this requested capability diagnostic. [Capability benchmark fixture provenance](https://github.com/ahmadalwakai/Mohassan-AI/blob/a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f/tests/fixtures/agent-capability-bench/README.md)

## Scoring

`Current full` uses the upstream check of understanding, routing, tools, content and verification. `Current content` and `Shadow content` apply the same upstream required and forbidden text matchers to each path's answer. The shadow matcher uses the answer line before source details. `Shadow dated matches` are content passes with a stored Wikidata statement, a revision or item URL, the original references array and a snapshot date for every fact. The index source card identifies the captured projection. A statement can have zero original references. Every shadow content pass requires an answered result. Requests containing an explicit URL are included in the total and reported as a group.

## Results

The current controller scored 4/24 on the full check and 5/24 on answer content. The public index produced 1 exact dated match out of 24, and the geography index produced 3. The geography index supplied one exact match where current answer content failed, for the Swiss franc. Both runs abstained on all 13 explicit-URL requests. The shadow comparison ran in the isolated benchmark harness.

| Index and group | Cases | Current full | Current content | Shadow dated matches | Shadow answered | Abstained | Choice |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Public, all | 24 | 4 | 5 | 1 | 2 | 21 | 1 |
| Public, development | 18 | 4 | 4 | 1 | 2 | 15 | 1 |
| Public, sealed | 6 | 0 | 1 | 0 | 0 | 6 | 0 |
| Public, Arabic | 12 | 2 | 2 | 1 | 2 | 10 | 0 |
| Public, English | 12 | 2 | 3 | 0 | 0 | 11 | 1 |
| Public, no explicit URL | 11 | 4 | 5 | 1 | 2 | 8 | 1 |
| Geography, all | 24 | 4 | 5 | 3 | 4 | 20 | 0 |
| Geography, development | 18 | 4 | 4 | 3 | 4 | 14 | 0 |
| Geography, sealed | 6 | 0 | 1 | 0 | 0 | 6 | 0 |
| Geography, Arabic | 12 | 2 | 2 | 1 | 2 | 10 | 0 |
| Geography, English | 12 | 2 | 3 | 2 | 2 | 10 | 0 |
| Geography, no explicit URL | 11 | 4 | 5 | 3 | 4 | 7 | 0 |

Every issued shadow answer carried dated evidence. Each run recorded zero shadow errors. Both runs recorded one answered case that failed the exact content matcher, `dev-factual-020`. The answer «ين ياباني» denotes the requested Japanese yen (Q8146). The benchmark accepts the literal «الين». The table keeps the original failure, and manual review found zero factual errors among these answered cases. [Wikidata Japanese yen item](https://www.wikidata.org/wiki/Q8146)

## Data

The primary run uses the public QA evaluation index, built from question entities in the human-authored evaluation and their bounded Wikidata expansion. The geography run independently initializes the same builder with all 193 sovereign-state items with an unended, non-deprecated UN membership claim when queried. The selected member-state QIDs and their Wikidata graph expansion form the entire geography slice. [Public QA evaluation](KNOWLEDGE-QA-EVALUATION-2026-11-25.md) [Wikidata Query Service](https://query.wikidata.org/) [Wikidata CC0 terms](https://www.wikidata.org/wiki/Wikidata:Data_access)

The geography selector produced a sorted newline list with SHA-256 `a10c3dab8e957e6bc006d6d74aa1f391576f95d7d5a5fbac22b29cc7aa887689`. The revision lock records the individual Wikidata revision IDs needed to reconstruct the captured projection following membership changes. Both slices contain CC0 Wikidata structured data captured on 2026-11-25 from the entity API. [SPARQL selector](../scripts/knowledge-base/qa/current-un-members.rq) [Revision lock](../scripts/knowledge-base/qa/un-members-lock.json)

| Slice | Scanned entities | Indexed entities | Indexed claims | Projection SHA-256 |
| --- | ---: | ---: | ---: | --- |
| Public | 6,904 | 2,359 | 58,723 | `6b7644c40f747e60e019eca64bf32e9c10676a45d791997b56eef1e05bed15c0` |
| Geography | 5,865 | 2,155 | 61,810 | `b78c799f839b9b56f1e1d1655403eb506b4810f6ba8045eb267f9d81eb17c0fd` |

## Reproducing the run

Fetch PR #22, then merge it into a detached worktree of the QA branch and stop before committing the merge. The runner checks the detached HEAD and `MERGE_HEAD` before loading the benchmark. It records both revisions, the QA source and lockfile hashes, the exact fixture hashes, the Wikidata data card and one side-by-side log per case in a new JSON file. The measured scratch checkout used detached base `9bdec96ef5f194646e19c9e1cb33642365dac9f2` with the QA source overlaid from the feature branch. Both reports record the same QA source digest `e684d854d430bc88cd6f7b276cdca5ba471588250ed7d1c7453b2b015547f3cd`.

```sh
git fetch origin feat/agent-capability-bench
git worktree add --detach /workspace/work/knowledge-qa-capability feat/knowledge-qa
cd /workspace/work/knowledge-qa-capability
git merge --no-commit --no-ff a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f
npm ci --cache /workspace/work/qa-npm-cache --no-audit --no-fund

# Build the public QA index using the linked evaluation instructions.
python3 scripts/knowledge-base/qa/prepare-slice.py /workspace/work/knowledge-qa-un \
  --lock scripts/knowledge-base/qa/un-members-lock.json
npx tsx scripts/knowledge-base/build.ts wikidata \
  --input /workspace/work/knowledge-qa-un/wikidata-slice.json \
  --output /workspace/work/knowledge-qa-un/wikidata.sqlite \
  --source https://www.wikidata.org/wiki/Special:EntityData --dump-date 2026-11-25

node --import tsx scripts/knowledge-base/capability-shadow.mjs \
  --index /workspace/scratch/knowledge-qa-data/wikidata.sqlite \
  --output /workspace/work/knowledge-qa-capability-public-results.json
node --import tsx scripts/knowledge-base/capability-shadow.mjs \
  --index /workspace/work/knowledge-qa-un/wikidata.sqlite \
  --output /workspace/work/knowledge-qa-capability-geography-results.json
```

The scratch checks used Node `v24.22.3`. The bridge passed `node --check scripts/knowledge-base/capability-shadow.mjs`. Both `node --import tsx` commands above exited 0 and reproduced 4 of 24 full passes for the current answer. `npm test -- tests/agent-capability-corpus.test.ts tests/agent-capability-observe.test.ts tests/agent-capability-score.test.ts` passed 22 of 22 tests across three files. Running `node scripts/knowledge-base/capability-shadow.mjs --index /tmp/unused.sqlite --output /tmp/unused-shadow-report.json` in the regular feature checkout exited 1 at the scratch merge guard.
