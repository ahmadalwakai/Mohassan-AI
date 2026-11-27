# Owner model council and models page

Owner request, 2026-11-26: connect every trained model in the web app and publish.

On a choice between a models page and automatic use, the owner chose both and added:

- «يتناقش النماذج و يعطوا الجواب الأدق»: the models discuss and give the most accurate answer.
- «البحث يجب ان يتم في الباكاند و يناقش الجواب قبل ان يصدر ل المستخدم من قبل النماذج»: the search runs in the backend, and the models discuss the answer before it is issued.
- «يقرأ الصفحات المتعلقة و ليس ب الضرورة ويكبيديا»: it reads the relevant pages, not necessarily Wikipedia.

## What runs

`MOHASSAN_MODEL_COUNCIL=owner` turns the council on. It runs only on the owner's plain answer turns, inside `finish()` in `apps/server/src/command-chat.ts`, before the judge and before the reply is stored. Members never meet it.

It is skipped for:

- action and plan turns;
- memory publications;
- monitors and campaigns;
- prejudged multi-answer replies;
- enforced supervision.

`apps/server/src/assistant/model-council.ts` runs three rounds:

1. **Understanding.** The classifiers read the request through the shadow organizer's `ModelRelationsManager`: refusal, speech act, route and follow-up. The owner sees their labels; they do not change the turn.
2. **Web search, when needed.** The council searches in the backend only when all of these hold:
   - the pipeline read no page and has no answer that stands;
   - the rules or a routing model send the request to `web_search` or `news`;
   - the public-query guard (`assertPublicSearch`) admits the question.

   It uses the chat's own search engine and page reader. It ranks hits by question words in their title and snippet, takes one per site whatever the site is, and attempts up to three page reads over HTTP. Evidence for a reading answer comes from a successful page read.
3. **Answers and decision.** The members are:
   - the pipeline;
   - v5, through the resident worker;
   - one reading model (`reading-v3-last`) over the best passage of the pages;
   - `chat-v4` when nothing was read;
   - the arithmetic ranker for an English word problem.

   The deterministic judge (`judge.ts`) screens reply form and certain source-specific properties. A `send` decision means the rules produced neither a block nor a mechanical repair. It can occur with unmeasured source support and for mutually contradictory answers. The council records technical execution, screening, textual evidence matching, and eligibility under its publication rules for that turn. The pipeline has priority when it completes and the judge returns `send` or `fix`.

The reading model can supply an alternative when its output passes screening, occurs in its cited passage, and matches the full normalized text of another candidate's screened answer. The reply includes the source and the model's measured result. Text matching supplies corroboration for this rule and leaves factual correctness unmeasured. A repair recommendation or failed screening prevents an experimental candidate from advancing. A definition request also requires a direct definition of the subject in the question's language from the cited page. The owner-only v5 fallback stays available for other requests where configured and after successful screening, with its experimental label. Otherwise the pipeline's reply and status stay in place.

The record is stored in `chat_messages.council` (jsonb, migration `chat_message_council_v1`). It reaches the owner as `council` on the message (`ModelCouncilSchema` in `packages/contracts`), and the web chat shows it under the reply as «نقاش النماذج».

- A conversation with a reply the council took from a model cannot be shared, like v5's.
- iPhone and Android ignore the field; they show the sent text, which carries its model label.
- Older records retain their original results and selection explanations. The screen labels their source and answer comparisons as approximate historical results. Publication eligibility is recorded on new records.

## Models page

The owner's workspace has an «النماذج» view (`apps/web/components/models-workspace.tsx`). Its server routes are in `apps/server/src/models-routes.ts`, are owner-only and are not in `MEMBER_ROUTES`:

- `GET /api/models` lists every registered model, whether its files are on this server, and where it is used (chat replies, council, page).
- `POST /api/models/:id/run` runs one model on the owner's text, question and passage, or image.

A completed trial run reports technical execution. The model cards list registered checks and any recorded measurements separately.

v5 runs on the resident worker, never in a second process. Models without a runner, such as the executor's task format, parameter deltas, the retriever, or the routers without a runtime export, say why.

## Runtime and model store

- `MOHASSAN_MODELS_ROOT` names the server's model store. It holds the registry paths, for example `artifacts/router/router-b0.bin`.
- The runtime looks there first, then in the checkout, which carries the checked-in models.
- The council and the page share one runtime. A model's worker starts on first use and unloads after 15 minutes idle. Only one Python model is loaded at a time, beside the resident v5 worker.

The Python worker gained a raw `prompt` request: a plain text continuation without chat framing. The reading fine-tunes need it; they were trained on «passage, سؤال/Question, الجواب/Answer».

Registry changes:

- Three execution exports are now found under their real folders (`inference-train-3m/6m/9m`).
- `chat-v4`, both reading models and the Ads and code foundations now carry `workerHead: 'lm'`, so the runtime can run them.

## Measurement

`scripts/quality/council-questions.ts` asks the 12 frozen date and population questions of `date-questions.ts` through an isolated server, with the council on and the owner's models. The expected answers were written into the script before its first run.

The first run, 2026-11-26 19:38 UTC, had the council skip every turn that searched. That was a defect in the turn condition, fixed before the second run. The run still measured the pipeline alone: 10 of 12 first answer lines correct.

The second run, 19:41 UTC, on this PC's CPU (`council-questions-2026-11-26T19-41-48.json`):

| Measure | Result |
| --- | --- |
| Pipeline answer correct | 10 of 12 |
| Sent answer correct | 10 of 12; the council changed no reply |
| Reading model | Answered 7 and was right in 1 of them («September 2, 1945»); abstained on 5 |
| Council web search | None; the pipeline had read pages for every question |
| Council time | 5.4 s on the first question, with the reading model cold; 0.3–0.5 s after that |

On this set the council did not raise accuracy. It kept six wrong model answers from replacing right ones. These results set the rule above: a model answer needs the pages and a second member.

The production server is an ARM CPU, so its times will differ. They are not measured here.

## Switches and rollback

| Setting | Value | Effect |
| --- | --- | --- |
| `MOHASSAN_MODEL_COUNCIL` | `owner` | The council runs on the owner's turns. Any other value: off, and replies are published as before. |
| `MOHASSAN_MODELS_ROOT` | `/var/lib/mohassan/models` | The server's model store for the council and the page. |

Turning the council off restores the previous behaviour exactly, including v5's own last resort. The `council` column stays; earlier releases ignore it.
