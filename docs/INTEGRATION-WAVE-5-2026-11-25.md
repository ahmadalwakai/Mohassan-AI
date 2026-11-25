# Integration wave 5 · 25 November 2026

Draft targets `release/rc-2026-11-25` at `d3ebd9223f44445627b9d3d0bdea08d5f9b0550a`.

## Development benchmark reproduction

The launcher in [`scripts/dev-bench/`](../scripts/dev-bench/README.md) takes product SHAs and runs the pinned development bundles from scratch worktrees. It uses the #41 review and structured-memory adapters on both versions and adds clarification on V2. It applies #70 in a scratch `--no-commit` merge, restores the measured product, schedules each V2 case in lane `index % 8`, verifies the worker receipt hashes and release order, and recomputes summary groups from the pinned scorer's verdicts. V1 completes before V2 starts. The corpus, scorer and gates are unchanged.

The initial command with output `/workspace/work/wave5-frozen` exited 1 before V1 scoring. The #41 module's standalone CLI guard compared its path with Node's first argument. The committed adapter invocation now passes a separate argv label. The scored calibration exited 0 with the following command:

```bash
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/chromium npm_config_cache=/workspace/work/npm-cache python3 -B scripts/dev-bench/run.py --output /workspace/work/wave5-frozen-calibration --arm frozen=e7274aa6cc9aacbf3d03c1b3be572720cfb9c5a3
```

| Frozen Wave 4 development | Published | Reproduced |
| --- | ---: | ---: |
| V1 | 176/240 | 176/240 |
| V2 | 1,586/2,400 | 1,586/2,400 |

Every published area and language count matched. The launcher SHA-256 is `7cb2faa4557f4b4f17b9b7a6472c14301df97804e0aa43e1b945f7a53ac35f94`. The frozen summary SHA-256 is `0a45168785920c39444d6f5de1685d058de979982ed821c8241bd8becd394e20` and the coordinated case receipt SHA-256 is `756d4ad2d8ca461174b2597cb2a3476cf707f5a03f193dbe28d45911b67be5d4`. The measured lockfile matches Wave 4 at `5ca3eb97d734f4403734d865f08e52065675e46877f75000e3646b1fddbdbb4e`. [Wave 4 results](INTEGRATION-WAVE-4-2026-11-25.md#development-decisions)

The calibration used Node 24.22.3, npm 11.19.1, Python 3.12.14 on PATH, Linux libseccomp and Playwright Chromium and headless shell 156.0.8078.4 (build 1248). The launcher records the executable and libseccomp digests. The scratch worktrees held development fixtures only.

### PR #89 reproduction and 5 Whys

The launcher measured the implementation commit `7f9c417f2e06b77c26eb6ff677d06e3457da650b` with the same Wave 4 settings. Both splits exited 0 at **176/240** and **1,586/2,400**. All 2,640 verdicts matched our frozen run. `git diff --name-status 7f9c417 4c05dc7` returned only the added `docs/RESPONSE-POLICY.md`, so #92's measurement of `4c05dc7` used the same product code.

```bash
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/chromium npm_config_cache=/workspace/work/npm-cache python3 -B scripts/dev-bench/run.py --output /workspace/work/wave5-pr89-canonical --arm pr89=7f9c417f2e06b77c26eb6ff677d06e3457da650b
```

The coordinated case receipt SHA-256 is `331ae0d5f3921d95ec835e9c5710cd70b75feaab2d9c080b97457d50cb5f87c6`. The summary SHA-256 is `9eb47e6d23cfaea4dc9c20753f07cb11e728af05b9af7617c5841e415829a7f0`. The lockfile SHA-256 is `fe2989772964d7cbc188f017985ccaca7805553755510a0314ec4e6e018606f6`.

The following commands ran in the clean detached PR #89 implementation checkout at `/workspace/work/wave5-pr89-replay`. Each exited 0. The unmodified legacy launcher reproduced **169/240** and **1,567/2,400**.

```bash
npm_config_cache=/workspace/work/npm-cache npm ci --offline
env -u PLAYWRIGHT_BROWSERS_PATH node --import tsx scripts/response-policy/development-bench.mjs prepare /workspace/work/wave5-pr89-evidence/historical
env -u PLAYWRIGHT_BROWSERS_PATH node --import tsx scripts/response-policy/development-bench.mjs off /workspace/work/wave5-pr89-evidence/historical 4
bash /workspace/work/wave5-pr89-evidence/case-probes.sh v1
bash /workspace/work/wave5-pr89-evidence/case-probes.sh v2
```

1. **Why did the totals disagree?** The legacy replay lost seven document-file verdicts in V1 and 19 refusal or small-talk verdicts in V2. Joining the ordered receipts found zero other changed verdicts. The V1 and V2 legacy aggregate SHA-256 digests are `d85e554f2f7d7bfe1d5be0ad94c335757e44a601b376dd24210ee9b0f90d0d95` and `977e60ed061657fb1664823b0dc4dda70bfdd3e19637607dc99cb07346191674`. The per-case comparison SHA-256 is `7bd654df2a1201b6371a762e3f050a36c393d3e671bb0b8dd7a1966d021a5466`.
2. **Why did those seven documents fail?** The legacy replay lacked the default Playwright browser installation and failed the required tool order, content and run-status checks on the seven PDF cases. With the same regular passwd home, scorer and weight-free settings, adding only the Chromium path restored all seven and returned the document-file area to 16/18. The original #89 command does not specify Chromium, and its original host environment was unavailable for inspection. The control receipt SHA-256 is `ae2aa9412d842d909bfcce0db2e71dd539a890f940cdc75dac599650c7adb5c1`.
3. **Why did V2 route differently?** The legacy launcher sets `MOHASSAN_SCRATCH_CLASSIFIERS=0` and substitutes a null implementation for the learned refusal head. Restoring only scratch classification recovered 16 refusals via `scratch_out_of_scope` and two small-talk cases via `scratch_speech_act`. Restoring only learned refusal recovered the remaining English refusal via `request_refused`. The independent control SHA-256 digests are `ad823e523147c71a9af6beb1a9330fd823d09313b1142feae4524695a2d52756` and `f90be2aea7e6acb5e65a87100b02510e4767937d32ef62d330595f18d924bb36`.
4. **Why were those classifiers disabled?** #89 used a documented weight-free profile for its response-policy experiment and ran four lanes. Wave 4 enables the inherited classifiers. The controls isolated the recovered verdicts with the original scorer, independent of the lane counts.
5. **Why could the profiles be mistaken for equivalent measurements?** The published comparison shared product and corpus identifiers, while the Wave 4 launcher and runtime choices lived in scratch. The committed launcher makes the chosen settings and executable identities part of each receipt. [Response policy report](RESPONSE-POLICY.md) · [Background results report](BACKGROUND-RESULTS.md)

| Split and cause | Cases changing from failure to pass |
| --- | --- |
| V1 · Chromium · Arabic | `dev-document-file-127`, `dev-document-file-128`, `dev-document-file-129` |
| V1 · Chromium · English | `dev-document-file-136`, `dev-document-file-137`, `dev-document-file-138`, `dev-document-file-144` |
| V2 · scratch refusal · Arabic | `human-c074f9ac36920a2b72eae242`, `human-c783fb63e7b02962b20568ba`, `human-85b6eb7caf5cd9876150e7d5`, `human-8837bdef87d394dbd168e372`, `human-12605dab8673b95946b5f8b6`, `human-2ea64eb91262a1e8a3e3b10e`, `human-ef928e76492645e9005c3453`, `human-4b2192865f65dea7424703c5`, `human-69f9b3055c877c44cedc95fd`, `human-39d664eb41957fc6b41a5c32`, `human-9b37dd56ba233ca6e571f7cb`, `human-10ea4df3a8da49b94c50d425`, `human-3c465aea27c158c061ea2754`, `human-6ec883004d5b5f23ecb44215` |
| V2 · scratch refusal · English | `human-5502f004e5d2cb9a24045d57`, `human-fc98192c465a629207012c26` |
| V2 · scratch small talk · English | `human-07b12cdc95eca62733166fa8`, `human-8ed16738623850de8e941b80` |
| V2 · learned refusal · English | `human-95575077f10cd03e36fe5723` |
