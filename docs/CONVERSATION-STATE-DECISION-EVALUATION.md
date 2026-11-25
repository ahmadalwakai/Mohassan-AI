# Conversation-state decision evaluation

The offline runner uses human-written development material. It downloads nothing, calls no models, and produces aggregate counts only. The datasets remain outside Mohassan and are reserved for evaluation here. The checked-in Claude-authored development fixture was excluded. The two user-specified regressions are exercised separately in focused tests.

## Rollout

Leave `MOHASSAN_CONVERSATION_SHADOW` unset for legacy routing with paired diagnostics in development. Set it to `decide` to use the new decision. The existing `0` setting disables diagnostics. Development logs record the legacy route and candidate query, the v2 type, confidence, reason codes, reference source, and agreement when both sides have a standalone query. Submitted card answers and v2 assistant-derived text stay out of those logs.

The resolver replays a bounded transcript. An assistant name can enter a public query only when the visible answer and its originating public read support it. Each inserted reference is checked against that boundary. The original request still supplies execution permissions and any restrictions on search.

## Sources and coverage

| Source | Revision | Coverage |
| --- | --- | --- |
| [COD](https://github.com/cambridgeltl/COD) | `38ccafdbf0a7e8dccaab3e1f363de16ced2100b9` | 194 Arabic and 194 English dialogues with at least two user turns. Native speakers wrote the Arabic dialogue from outlines. Crowdworkers wrote the English SGD dialogue. The language versions share 194 scenario IDs. [Collection methodology, §3 and §3.1](https://aclanthology.org/2023.tacl-1.9/) |
| [Arabic-TOD](https://github.com/En-J-A/Arabic-TOD) | `489e621a27ec2abf7f8dfad3273c0bb6ac7b75cf` | 260 test dialogues with at least two user turns and at least one user turn combining Arabic with a multiword Latin-script entity. Bilingual speakers translated the dialogues and retained embedded names and addresses. [Collection methodology, §3.2](https://doi.org/10.3390/app12041881) |
| [CANARD](https://github.com/aagohary/canard) | `da8639cee97a50b3c62dc4d7e800c93675731186` | 489 English test dialogues with at least one scoreable contextual question. QuAC questions and answers and CANARD rewrites came from crowdworkers. [CANARD collection methodology](https://aclanthology.org/D19-1605/) |
| [Multi3WOZ](https://github.com/cambridgeltl/multi3woz) | `c65e80fe120704125255de5cf582a51ebaa285cd` | 12 Arabic dialogues with at least two user turns and a user utterance containing a regional lexical marker. Human localizers culturally adapted the dialogue. [Collection methodology, §3](https://aclanthology.org/2023.tacl-1.79/) |

The scored datasets contain 1,149 multi-turn dialogue instances (955 source scenarios after counting COD parallels once). Mixed Arabic-TOD turns primarily mix scripts through names and addresses. The Multi3WOZ subset matches a fixed list of Egyptian (8 dialogues), Levantine (2) and Gulf (5) lexical markers. Some dialogues contain markers from more than one group. These labels indicate wording in the user turns rather than dialect metadata for the entire dialogue. That subset draws on the published upstream training split for local evaluation only. Graded reference and rewrite accuracy in regional dialects remains unverified.

## Scoring

“Before” uses the legacy v2 fields at `c2a0ff7`, which already supported the restricted public refinement. “After” uses the seven-way decision and answer-entity stack. Both process the same user turns. The new stack ingests the same visible prior answers, with public lookup provenance for CANARD and Arabic-TOD name references. This is a parser comparison. It measures neither search results nor the downstream answer.

- **Turn type.** For COD, Arabic-TOD and Multi3WOZ, score source dialogue acts that map directly to five of the seven types. Examples are the initial intent, a user slot supplying the prior system's requested slot, an affirmation after an explicit confirmation, and a question after an offer or information. Unmapped and mixed-intent acts are excluded. Corrections and refinements have no reliable act mapping in these sources. In the selected CANARD rows, the crowdworker rewrite introduces a single literal name that already appeared in the dialogue, which marks a contextual follow-up.
- **Reference resolution.** CANARD expects the single added proper name that appeared in a prior utterance. This conservative extraction is a deterministic proxy for antecedent annotation. Arabic-TOD expects the previous agent's single named offer when the user's next turn asks for a different property and the subsequent agent response records the same offered item. The reference must match the full name.
- **Standalone rewrite.** CANARD uses exact match to the writer's reference rewrite after case, whitespace, apostrophe and terminal punctuation normalization. Equivalent alternate wording can fail exact match. The Arabic sources supply no human standalone rewrites.

| Dataset and metric | Before | After |
| --- | ---: | ---: |
| COD Arabic turn type | 447/692 (64.6%) | 497/692 (71.8%) |
| COD English turn type | 389/692 (56.2%) | 409/692 (59.1%) |
| Multi3WOZ regional-marker Arabic turn type | 25/44 (56.8%) | 29/44 (65.9%) |
| Arabic-TOD mixed turn type | 621/1,459 (42.6%) | 702/1,459 (48.1%) |
| Arabic-TOD mixed reference resolution | 0/149 (0.0%) | 19/149 (12.8%) |
| CANARD English turn type | 334/1,249 (26.7%) | 851/1,249 (68.1%) |
| CANARD English reference resolution | 6/1,249 (0.5%) | 116/1,249 (9.3%) |
| CANARD English standalone rewrite exact match | 2/1,249 (0.2%) | 35/1,249 (2.8%) |

Across scored rows, turn type improved from 1,816/4,136 (43.9%) to 2,488/4,136 (60.2%). Reference resolution improved from 6/1,398 (0.4%) to 135/1,398 (9.7%). Exact standalone rewrite accuracy uses the CANARD rows above.

## Reproduce

Clone the four source repositories outside Mohassan and check out the revisions above. Extract the Arabic dialogue JSON from the Multi3WOZ archive.

```bash
unzip -p /tmp/mohassan-multi3woz-source/data.zip data/Arabic/data.json > /tmp/mohassan-multi3woz-arabic.json
npx --no-install tsx scripts/conversation-state/decision-eval.ts --cod /tmp/mohassan-cod-source --canard /tmp/mohassan-canard-source/data/release/test.json --arabic-tod /tmp/mohassan-arabic-tod/Dataset/ar_test.json --dialect-dialogues /tmp/mohassan-multi3woz-arabic.json
```
