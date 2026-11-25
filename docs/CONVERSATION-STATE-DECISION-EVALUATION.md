# Conversation-state decision evaluation

The offline runner uses human-written dialogue for development and evaluation. It downloads nothing and calls no models. The datasets remain outside Mohassan and are reserved for evaluation here. The checked-in Claude-authored development fixture was excluded. The two user-specified regressions are exercised separately in focused tests.

## Rollout

Leave `MOHASSAN_CONVERSATION_SHADOW` unset for legacy routing with paired diagnostics in development. Set it to `decide` to use the new decision. The existing `0` setting disables diagnostics. Normal committed worker tasks capture bounded transcript history and log paired legacy and v2 decisions in development. Logs include the legacy route and candidate query, the v2 type, confidence, reason codes, reference source, and agreement when both sides have a standalone query. The worker captures history before deferred logging. Direct card, approval and secure responses and image-only sends lack the dedicated paired observer in this patch. The comparison omits assistant-derived v2 text.

The resolver replays a bounded transcript. An assistant name can enter a public query only when the visible answer and its originating public read support it. Each inserted reference is checked against that boundary. The original request still supplies execution permissions and any restrictions on search. The judge uses the existing lookup lane. Standalone question handoff to the judge remains unverified.

## Sources and coverage

| Source | Revision | Coverage |
| --- | --- | --- |
| [COD](https://github.com/cambridgeltl/COD) | `38ccafdbf0a7e8dccaab3e1f363de16ced2100b9` | 194 Arabic and 194 English dialogues with at least two user turns. Native speakers wrote the Arabic dialogue from outlines. Crowdworkers wrote the English SGD dialogue. The language versions share scenario IDs and several IDs recur across upstream splits. [Collection methodology, §3 and §3.1](https://aclanthology.org/2023.tacl-1.9/) |
| [Arabic-TOD](https://github.com/En-J-A/Arabic-TOD) | `489e621a27ec2abf7f8dfad3273c0bb6ac7b75cf` | 260 test dialogues with at least two user turns and at least one user turn combining Arabic with a multiword Latin-script entity. Bilingual speakers translated the dialogues and retained embedded names and addresses. [Collection methodology, §3.2](https://doi.org/10.3390/app12041881) |
| [CANARD](https://github.com/aagohary/canard) | `da8639cee97a50b3c62dc4d7e800c93675731186` | 489 English test dialogues with at least one scoreable contextual question. QuAC questions and answers and CANARD rewrites came from crowdworkers. [CANARD collection methodology](https://aclanthology.org/D19-1605/) |
| [Multi3WOZ](https://github.com/cambridgeltl/multi3woz) | `c65e80fe120704125255de5cf582a51ebaa285cd` | 12 Arabic dialogues with at least two user turns and a user utterance containing a regional lexical marker. Human localizers culturally adapted the dialogue. [Collection methodology, §3](https://aclanthology.org/2023.tacl-1.79/) |

The original whole-source evaluation scored 1,149 multi-turn dialogue instances. Mixed Arabic-TOD turns primarily mix scripts through names and addresses. The Multi3WOZ subset matches a fixed list of Egyptian (8 dialogues), Levantine (2) and Gulf (5) lexical markers. Some dialogues contain markers from more than one group. These labels indicate wording in the user turns rather than dialect metadata for the entire dialogue. That subset draws on the published upstream training split for local evaluation only. Graded reference and rewrite accuracy in regional dialects remains unverified.

## Frozen dialogue split

The same human sources used for the original rollout are now partitioned by source dialogue group, so this is a retrospective holdout. The earlier report included aggregate results across the full sources. This round used only development rows for failure inspection and tuning.

[The freeze manifest](../scripts/conversation-state/decision-eval-freeze.json) pins the seven raw file hashes and both partitions for each source. The runner ranks source groups by SHA-256 of the freeze seed, source name and group ID. It assigns the first 30% per source, rounded down, to held-out. COD pairs and repeated IDs across upstream splits stay together. CANARD groups all questions and dialogue sections sharing a source article title. Arabic-TOD and Multi3WOZ group by dialogue ID. Each partition digest covers the ranked group IDs and all original rows in each group, before scoring filters. The manifest contains only settings, hashes and counts.

The freeze manifest was committed as `eea4c15` before resolver edits. The scorer verifies every raw file and partition against the manifest before it loads a resolver. It allows row-level diagnostic output on development only. Held-out scoring requires a checked-out candidate commit and a clean, separately checked-out baseline at `fb8e452`. Each resolver receives only the current user text, prior visible turns and the metadata for an open question when there is one. Gold annotations and rewrites are used in scoring.

## Scoring

“Before” uses the published seven-way resolver at `fb8e452`. “After” uses the follow-up resolver changes. Both process the same turns from each frozen partition. The runner still emits the restricted legacy v2 fields as context for the comparisons with `c2a0ff7`. This is a parser comparison. It measures neither search results nor the downstream answer.

- **Turn type.** For COD, Arabic-TOD and Multi3WOZ, score source dialogue acts that map directly to five of the seven types. Examples are the initial intent, a user slot supplying the prior system's requested slot, an affirmation after an explicit confirmation, and a question after an offer or information. Unmapped and mixed-intent acts are excluded. Corrections and refinements have no reliable act mapping in these sources. In the selected CANARD rows, the crowdworker rewrite introduces a single literal name that already appeared in the dialogue, which marks a contextual follow-up.
- **Reference resolution.** CANARD expects the single added proper name that appeared in a prior utterance. This conservative extraction is a deterministic proxy for antecedent annotation. Arabic-TOD expects the previous agent's single named offer when the user's next turn asks for a different property and the subsequent agent response records the same offered item. The reference must match the full name.
- **Standalone rewrite.** CANARD uses exact match to the writer's reference rewrite after case, whitespace, apostrophe and terminal punctuation normalization. Equivalent alternate wording can fail exact match. The Arabic sources supply no human standalone rewrites.

## Development failures at the published baseline

| Reference failure | CANARD English | Arabic-TOD mixed |
| --- | ---: | ---: |
| Exact expected name absent from the stack | 379 | 31 |
| Exact expected name present but no candidate selected | 340 | 61 |
| Exact expected name present but a different candidate selected | 89 | 1 |

Of the CANARD reference misses, 516 match an English pronoun pattern and 98 match an English possessive pattern. These sets overlap. The Arabic-TOD misses include 53 interrogative-shaped requests and 11 candidate clitic forms from a broad Arabic suffix pattern. These pattern counts identify where to inspect development rows. They do not establish a gold failure cause.

The development review found named entities lost during extraction, including multiword Latin names with digits and single-word venues. Other misses had the named offer present but no resolver selection after a short property question or a demonstrative phrase. In CANARD misses where the exact name was present but unselected, 189 decisions reported an unresolved explicit reference and 144 called the question an explicit new subject. In mixed Arabic-TOD, 47 of 61 such misses treated the question as an explicit new subject. The matching candidates in these misses were usually untyped mentions from the visible assistant answer. The exact CANARD name proxy also occasionally includes a capitalized auxiliary at the start of a question. We retained the unchanged heuristic across both comparisons. Exact rewrite misses include 60 cases where the reference was correct but the wording differed, as well as 18 cases with the correct reference and no rewrite.

## Results

The published resolver scored 1,801/2,995 (60.1%) on development turn type, 112/1,013 (11.1%) on reference resolution, and 25/904 (2.8%) on exact standalone rewriting across 821 dialogue instances. The candidate and held-out scores will be recorded after the candidate is frozen.

## Reproduce

Clone the four source repositories outside Mohassan and check out the revisions above. Extract the Arabic dialogue JSON from the Multi3WOZ archive. The commands below use fixed scratch paths.

```bash
unzip -p /tmp/mohassan-multi3woz-source/data.zip data/Arabic/data.json > /tmp/mohassan-multi3woz-arabic.json
git worktree add --detach /workspace/work/mohassan-decision-baseline fb8e45289dd3a7b607d9c7c7b7188bf08c2c70f0
cp -al node_modules /workspace/work/mohassan-decision-baseline/node_modules
npx --no-install tsx scripts/conversation-state/decision-eval.ts --cod /tmp/mohassan-cod-source --canard /tmp/mohassan-canard-source/data/release/test.json --arabic-tod /tmp/mohassan-arabic-tod/Dataset/ar_test.json --dialect-dialogues /tmp/mohassan-multi3woz-arabic.json --baseline-dir /workspace/work/mohassan-decision-baseline --split development --diagnostics /tmp/mohassan-dev-failures.jsonl
```

For the held-out comparison, use `--split held-out --frozen-commit <full candidate commit SHA>` in place of `--split development --diagnostics /tmp/mohassan-dev-failures.jsonl`. The runner returns a failing exit code if aggregate turn-type accuracy decreases within the evaluated partition.
