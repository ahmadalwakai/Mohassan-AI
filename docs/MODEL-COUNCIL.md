# Model council and owner models page

Owner request, 2026-11-26: connect every trained model in the web app and publish.

On a choice between a models page and automatic use, the owner chose both and added:

- «يتناقش النماذج و يعطوا الجواب الأدق»: the models discuss and give the most accurate answer.
- «البحث يجب ان يتم في الباكاند و يناقش الجواب قبل ان يصدر ل المستخدم من قبل النماذج»: the search runs in the backend, and the models discuss the answer before it is issued.
- «يقرأ الصفحات المتعلقة و ليس ب الضرورة ويكبيديا»: it reads the relevant pages, not necessarily Wikipedia.

## What runs

The council starts off. The owner can enable it for their own plain answer turns with `MOHASSAN_MODEL_COUNCIL=owner` or include invited members with `MOHASSAN_MODEL_COUNCIL=all`. It runs inside `finish()` in `apps/server/src/command-chat.ts`, before the judge and before the reply is stored.

It is skipped for:

- action and plan turns;
- memory publications;
- monitors and campaigns;
- prejudged multi-answer replies;
- enforced supervision.

`apps/server/src/assistant/model-council.ts` runs three rounds:

1. **Understanding.** The classifiers read the request through the shadow organizer's `ModelRelationsManager`: refusal, speech act, route and follow-up. Their labels appear in the turn's record.
2. **Web search, when needed.** The council searches in the backend only when all of these hold:
   - the pipeline read no page and has no answer that stands;
   - the rules or a routing model send the request to `web_search` or `news`;
   - the public-query guard (`assertPublicSearch`) admits the question.

   It uses the chat's own search engine and page reader. It ranks hits by question words in their title and snippet, takes one per site whatever the site is, reads three pages over HTTP, and uses a hit's snippet when its page cannot be read.
3. **Answers and decision.** The members are:
   - the pipeline;
   - v5 on owner turns when the owner v5 experiment is enabled, through the resident worker;
   - one reading model (`reading-v3-last`) over the best passage of the pages;
   - `chat-v4` when nothing was read;
   - the arithmetic ranker for an English word problem.

   The judge (`judge.ts`) checks every answer, the council checks each answer against the pages, and the answers are compared with each other. The pipeline's answer stays whenever it completed and the judge would not withhold it, because it is the only member with a passed product evaluation.

Otherwise a model answer is sent only when it is found in a page read for this turn and another member says the same thing. It goes out with its page and a label stating the model's measured result. A lone guess stays in the record and is not sent. After that, v5 answers where it already did as the owner's labelled last resort. Failing all of these, the pipeline's reply stays.

The record is stored in `chat_messages.council` (jsonb, migration `chat_message_council_v1`). It reaches the account that owns the conversation as `council` on the message (`ModelCouncilSchema` in `packages/contracts`). The web chat shows it under the reply as «نقاش النماذج».

- A conversation with a reply the council took from a model cannot be shared, like v5's.
- Conversation Markdown and PDF exports contain the sent messages. The member account-data ZIP includes the member's private council records, and account deletion removes them with the messages.
- iPhone and Android ignore the field; they show the sent text, which carries its model label.

## Member rollout limits

In `all` mode, the single API process shares one active council slot and one waiting slot across the owner and members. An owner turn can take the waiting slot from a member when the queue is full. Active work finishes before the next turn starts. A member whose turn is rejected or displaced receives the pipeline reply with a short note that the models' discussion was skipped because of load. These limits are for the two-OCPU ARM deployment. [Deployment sizing](https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/scripts/cloud-linux/README.md#L7), retrieved 2026-11-27.

Waiting and deliberation together take at most 45 seconds or half of the remaining chat turn time, whichever is shorter. The chat turn has a 15-minute limit. If a local model call is still settling after a council timeout, the slot stays occupied until the call settles. Each admitted member turn uses one run from the existing rolling 24-hour quota, including when the council runs or is skipped.

The owner models API (`GET /api/models`) and the enabled production metrics exports (`GET /api/ops/metrics` and `GET /api/ops/metrics.csv`) show aggregate member counts for completed discussions, model replies selected, load skips, deadline skips and failures. These counters contain no member text or identifiers and reset on API restart.

## Models page

The owner's workspace has an «النماذج» view (`apps/web/components/models-workspace.tsx`). Its server routes are in `apps/server/src/models-routes.ts`, are owner-only and are not in `MEMBER_ROUTES`:

- `GET /api/models` lists every registered model, whether its files are on this server, and where it is used (chat replies, council, page).
- `POST /api/models/:id/run` runs one model on the owner's text, question and passage, or image.

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
| `MOHASSAN_MODEL_COUNCIL` | `owner` | Enable the council for the owner's eligible turns. |
| `MOHASSAN_MODEL_COUNCIL` | `all` | Enable the council for eligible owner and invited member turns with the shared limits above. |
| `MOHASSAN_MODEL_COUNCIL` | Unset or any other value | Off. |
| `MOHASSAN_MODELS_ROOT` | `/var/lib/mohassan/models` | The server's model store for the council and the page. |

When the owner decides to enable member access, set `MOHASSAN_MODEL_COUNCIL=all` and the absolute `MOHASSAN_MODELS_ROOT` in `/etc/mohassan/server.env`. The deploy preflight checks that the shared limits are set and that the service account can read and traverse the model-store directory. Run it with the flag for the current deployment phase, for example `--owner-v5` on the owner v5 deployment. Restart the API after the preflight passes.

```sh
sudo /usr/local/bin/node /opt/mohassan/app/scripts/cloud-linux/preflight-wave-6.mjs --owner-v5
```

Set `MOHASSAN_MODEL_COUNCIL=owner` and restart to roll back member access. Set it to `off` and restart to disable the council. The v5 switch controls its own last resort. Existing records remain in their private conversations.
