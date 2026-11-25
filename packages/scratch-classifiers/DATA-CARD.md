# Scratch classifier data card

## Source data and licenses

| Source and attribution | License for the data | Material used |
| --- | --- | --- |
| CLINC150, Stefan Larson et al., *An Evaluation Dataset for Intent Classification and Out-of-Scope Prediction* | CC BY 3.0 Unported | English crowdsourced intent utterances from `data_full.json`, including the dedicated OOS train, validation and test splits. [Source paper](https://aclanthology.org/D19-1131/), [publisher's pinned license](https://github.com/clinc/oos-eval/blob/828f8093932c8fe6ca7936c3d2e52903b1c523de/LICENSE). |
| MASSIVE v1.0, Jack FitzGerald et al., © Amazon.com, Inc. or its affiliates. English SLURP text by Emanuele Bastianelli et al. | CC BY 4.0 International | `en-US` human utterances and human-localized `ar-SA` counterparts, with source intent annotations. [MASSIVE paper](https://aclanthology.org/2023.acl-long.235/), [publisher's data notice](https://github.com/alexa/massive/blob/f966f21846043aabef9b0f974fa7970027f43738/NOTICE.md), [SLURP license](https://github.com/pswietojanski/slurp/blob/master/LICENSE.txt). |
| CANARD, Ahmed Elgohary, Denis Peskov, Jordan Boyd-Graber, *Can You Unpack That? Learning to Rewrite Questions-in-Context* | CC BY-SA 4.0 International | Human dialogue questions, the immediately preceding available question, and human rewrites for annotation. [Paper](https://aclanthology.org/D19-1605/), [QANTA license and format](https://qanta-org.github.io/research/projects/canard.html), [publisher's archive and included license notice](https://drum.lib.umd.edu/items/4fe47f0e-51f1-47aa-8436-5eeceee40412). |
| ArBanking77, Mustafa Jarrar, Ahmet Birim, Mohammed Khalilia, Mustafa Erden, Sana Ghanem, © 2023 Sina Lab, Birzeit University | CC BY-SA 4.0 International | Original `PAL1` and `PAL2` Palestinian Arabic localizations written by human annotators. The standard Arabic columns include Google Translate outputs and are excluded. [ArBanking77 paper](https://aclanthology.org/2023.arabicnlp-1.22/), [publisher's pinned corpus license](https://github.com/SinaLab/ArBanking77/blob/2e3a5639e254bc28828ed0af6d3059d64d3b97fc/LICENSE), [upstream Banking77 license](https://github.com/PolyAI-LDN/task-specific-datasets/blob/master/LICENSE). |
| Aya Red-teaming, Aakanksha et al., Cohere Labs | Apache 2.0 | Original human-authored English and Arabic prompts with human harm annotations. [Publisher's pinned card and license](https://huggingface.co/datasets/CohereLabs/aya_redteaming/blob/5a16fee03c19d681b4f3527b6a750e1ed4d434c7/README.md), [paper and annotation protocol](https://arxiv.org/abs/2406.18682). |

[`data/sources.json`](data/sources.json) pins the exact download bytes and their licenses. Preparation verifies the SHA-256 of every cached or fetched file. Training uses public, human-authored text and selected human annotations. Aya use is restricted to the `prompt` and harm annotation fields. All downloads stay in the local cache. Preserve the original attribution and license terms, including ShareAlike for CANARD and ArBanking77, when sharing adapted source data. The Aya source files contain human red-team material.

## Label review

The machine-readable table in [`data/label-map.json`](data/label-map.json) lists each included intent. The review used the upstream taxonomy, inspected representative English and Arabic rows, and checked Mohassan's route and capability contracts in `routing-decision.ts`, `local-conversation.ts` and `unsupported-request.ts`. Labels absent from the table leave that head unlabeled. Human upstream intent labels are mapped to Mohassan's classes below.

| Mohassan target | Mapping rationale and coverage |
| --- | --- |
| `refusal=allow` | A mapped supported intent supplies a negative refusal example. Coverage includes conversation, arithmetic, reminders, writing, and public information or news. CLINC150's in-scope label alone was insufficient because many of its assistant intents require functions Mohassan does not offer. |
| `refusal=out_of_scope` | CLINC150's native OOS material and the mapped unavailable capabilities. These include direct booking, purchasing, playback and bank-specific operations. Upstream CLINC150 scope differs from Mohassan's and is used as a proxy. |
| `refusal=refuse` | Aya's globally harmful prompts in explicit harm classes listed in the map, constrained to original prompts with human labels. Excludes local-only harm, self-harm, and rows tagged only for graphic material, profanity, or harms of representation and service. A harm category is a refusal proxy for this head and carries no runtime authorization. |
| `speechAct=smalltalk` | CLINC150 greetings, thanks, farewells and assistant identity. MASSIVE supplies standalone greetings, well-being checks and assistant identity. Two bilingual greeting IDs with a different request were reviewed and excluded. |
| `speechAct=request` | Eligible task-directed questions and commands. Several MASSIVE intents are usable for speech act only because their route depends on the capability or prior context. The catch-all `general_quirky` includes commands and fact queries, so it was left unlabeled. |
| `route=chat` | Standalone social or identity turns identified above. |
| `route=compute` | Explicit calculator and mathematical question categories, plus time conversion. Dirty utterances within human-labelled categories can occur. |
| `route=news` | MASSIVE news queries. General fact questions, recommendations, public reference and weather go to `web_search`. |
| `route=reminder` | CLINC150 reminders and MASSIVE personal alarms. Calendar intents mix calendar management with reminder requests, so they are used only for speech act. |
| `route=writing` | CLINC150 translation requests. Direct email dispatch belongs to unavailable external actions. |
| `route=unsupported` | Clear bank-private or external actions and playback where Mohassan cannot perform the requested task. Compatibility with Mohassan's internal capability scope is a taxonomy mapping. |
| `followUp=new` | A later CANARD question that a human rewriter left unchanged ignoring case, spacing and punctuation. This measures whether the request stands alone, including standalone questions that stay on the prior topic. |
| `followUp=follow_up` | A later CANARD question whose human rewrite adds a substantive word from the prior dialogue or document title. The model sees the original question and preceding available question only. First turns and rewrites without evidence of context restoration are excluded. |

The selected corpora provide no credible route supervision for `ads`, `browser_command`, `clarify`, `coding`, `image`, `media` generation, `memory`, `pc`, `planning` or `reply`. The follow-up corpus is English information-seeking dialogue. It has no Arabic, conversation-card replies, approvals, or direct examples of switching tasks. Source-level test results measure the listed mappings. The independent capability benchmark measures transfer to Mohassan messages.

## Train, development, calibration and test splits

- Preserve upstream train and test groups. Split original validation groups into development and calibration with the fixed seed `20261125`. CLINC150 groups equivalent utterances. MASSIVE pairs locales by utterance ID and alternates the seeded order within each development intent. CANARD groups all turns by upstream dialogue ID.
- For ArBanking77, keep variants from an original question together. When variants span upstream partitions, retain variants from the highest-held-out partition. Omit malformed CSV rows and invalid variant IDs. Split its remaining source development groups by original question ID.
- Aya has no upstream folds in the selected release. Hash lexical prompt keys with the seed for a 70/10/10/10 allocation.
- Fold text with the production normalizer and strip punctuation for comparison. For CANARD the comparison key includes the previous question. Duplicate keys go to the most held-out split, and conflicting targets for the same head are omitted. Duplicate rows per dataset are folded into one per head. This catches exact collisions under the comparison, while semantically equivalent paraphrases can still occur across upstream splits.
- MASSIVE v1.0 has one held-out greeting group in each of the two locales. Its small-talk test recall reflects a single positive per locale. CANARD has many more context-dependent than standalone later questions. The Arabic dialect supplement contains banking requests only. The Aya subsets supply positive refusal coverage only.

The fixed seed produces 70,164 examples after filtering. Rows can carry labels for multiple heads.

| Dataset | Train | Development | Calibration | Test |
| --- | ---: | ---: | ---: | ---: |
| CLINC150 | 3,158 | 402 | 315 | 1,928 |
| MASSIVE Arabic | 8,563 | 782 | 761 | 2,308 |
| MASSIVE English | 9,102 | 817 | 796 | 2,357 |
| CANARD | 26,453 | 1,369 | 1,508 | 4,728 |
| ArBanking77 Palestinian | 2,719 | 155 | 163 | 894 |
| Aya Arabic | 369 | 54 | 51 | 60 |
| Aya English | 253 | 32 | 35 | 32 |
