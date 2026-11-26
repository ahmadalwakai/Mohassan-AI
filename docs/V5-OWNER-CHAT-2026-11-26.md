# v5 owner chat experiment

Shortly after 01:00 UTC on 2026-11-26, the owner said «اربط v5» and chose to connect the internal v5 chat model to their own production chats. The owner knew the blind Gate 3 reading had failed both rules A and B. This activation overrides the failed gate by the owner’s decision. The gate remains failed.

The checkpoint is the 85,133,440-parameter `ExecutionModel` trained on Arabic and English conversations with a 512-token context. On the frozen probes measured on 2026-11-25, sampling at temperature `0.7`, top-p `0.9`, top-k `0`, up to `192` new tokens, and seeds 1–3 yielded these results. Greedy decoding looped more often.

| Frozen probes | EOS reached | Repetition loops |
| --- | ---: | ---: |
| Arabic | 49/60 | 9/60 |
| English | 47/60 | 7/60 |

## What the owner sees

Once the pinned CPU worker is ready, owner conversations advertise `configured: true` and the web’s no-model banner clears. Existing deterministic tools and capabilities take priority. For an eligible turn that would otherwise get the no-model reply, the worker can return experimental chat text. The last line reads «— نموذج v5 تجريبي (لم يجتز اختبار الجودة)» in web, iPhone and Android. The web badge uses the optional `experiment: 'v5'` message field. Members retain `configured: false`, their existing banner and their existing replies.

The worker calls the training formatter on the latest user and assistant messages and drops older messages to fit. It reduces the 192-token generation allowance only when the last user message needs the room. Sampling uses a fresh seed and stops at EOS or the token limit. The repetition guard scans case-folded Unicode word trigrams, ignoring punctuation for comparison, and cuts the original text before the first non-overlapping repeat. Only one generation runs at a time. Two turns can wait, and their 60-second time limit includes time in the queue. The existing fallback also covers an unavailable worker, a last turn that cannot fit, unusable output, and direct execution claims detected in the generated text. The experiment provides prose with no action receipt, tool calls, memory writes, routing decisions, judging, or rephrasing of capability answers.

The owner-only `/api/ops/metrics` and `/api/ops/metrics.csv` include v5 worker attempts, latency including queue time, EOS and length stops, loop cuts, timeouts and fallbacks. The worker and metrics record aggregate observations without prompt or reply text. Conversations containing experimental replies are ineligible for new public share links.

## Server setup

1. Use the existing Wave 6 cutover procedure to install the reviewed API release at `/opt/mohassan/app`. Keep the service stopped during preparation. Deploy the matching web release for the badge. [Wave 6 cutover](DEPLOY-WAVE-6-2026-11-25.md#deploy-and-verify)
2. On the Ubuntu aarch64 server, install the Python 3.12 venv package and run the opt-in setup script. It installs the hash-pinned CPU dependencies into `/opt/mohassan/venv-execution` and checks imports as `mohassan`.

   ```bash
   sudo apt-get install python3.12-venv
   sudo bash /opt/mohassan/app/scripts/cloud-linux/setup-model-worker.sh
   ```

3. Copy the two operator-held files to the root-owned model directory. Replace `/path/to` with the local transfer directory. Keep the release-independent config beside the files, with service-account read access. The worker configuration requires the training checkpoint, CPU, quantization disabled, and EOS token ID `258`, which follows the training tokenizer’s `<eos>` special-token mapping and is checked at load. Leave `own-model-provider.json` absent in this directory so the existing routing, follow-up and phrasing gates stay inactive.

   ```bash
   sudo install -d -o root -g mohassan -m 0750 /opt/mohassan/models /opt/mohassan/models/v5
   sudo install -o root -g mohassan -m 0640 /path/to/best.pt /path/to/tokenizer.json /opt/mohassan/models/v5/
   sudo install -o root -g mohassan -m 0640 \
     /opt/mohassan/app/scripts/cloud-linux/model-worker.v5.example.json \
     /opt/mohassan/models/v5/model-worker.json
   ```

   | File | Bytes | SHA-256 |
   | --- | ---: | --- |
   | `best.pt` | 1,021,749,913 | `246983b5a42a9a14de7379c6da7f74a599c3131d58c848ed4b5ad0922aa14c39` |
   | `tokenizer.json` | 284,174 | `297eaad3d1cd08b822fa1b7f215112633873d1603b83846dbf5bf7c48b49cbb7` |

4. Edit `/etc/mohassan/server.env` privately using `sudoedit /etc/mohassan/server.env`. Use the owner-trial configuration for the remaining switches. Keep the existing external-AI settings disabled.

   ```dotenv
   MOHASSAN_V5_CHAT=owner
   MOHASSAN_MODEL_WORKER=1
   MOHASSAN_MODEL_WORKER_CONFIG=/opt/mohassan/models/v5/model-worker.json
   EXECUTOR_PYTHON=/opt/mohassan/venv-execution/bin/python
   MOHASSAN_MONITORS_ENABLED=owner
   PRODUCTION_METRICS_ENABLED=true
   ```

5. Verify the installed runtime, config and file pins, then restart.

   ```bash
   sudo /usr/local/bin/node /opt/mohassan/app/scripts/cloud-linux/preflight-wave-6.mjs --owner-v5
   sudo systemctl restart mohassan.service
   sudo systemctl is-active mohassan.service
   curl --fail --silent --show-error http://127.0.0.1:4000/health
   ```

6. The operator must still test the real checkpoint on the server. Wait for `modelWorker.state` to become `ready`. In an authenticated owner chat, send a simple conversational turn and verify the footer, then send a deterministic calculation and verify the existing calculation answer. Check owner metrics for the attempt. In a member session, verify `configured: false` and the existing no-model reply. Local verification uses synthetic weights and makes no claim about real checkpoint quality, CPU latency, or memory use.

## Switch off

Set `MOHASSAN_V5_CHAT=off` and `MOHASSAN_MODEL_WORKER=0` in `/etc/mohassan/server.env`, then run `sudo systemctl restart mohassan.service`. Previously sent replies retain their experimental label in the conversation.
