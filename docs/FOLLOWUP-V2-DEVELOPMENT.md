# Follow-up understanding development evaluation

## Diagnosis and held-back split

The split uses only `id` and `area` from the pinned V2 development payload published in [PR #62](https://github.com/ahmadalwakai/Mohassan-AI/pull/62) at `12cedfe592aab40cdd47ee00d05ea86a6d2bae89`. Select the 240 unique IDs whose area is `follow-up`. Sort the IDs by the ascending SHA-256 digest of their UTF-8 bytes, using the ID itself as a tie-breaker. The first 120 form D and the next 120 form H. Hash each ordered list as one UTF-8 ID per line with a final LF.

| Split | IDs | SHA-256 of ID list |
| --- | ---: | --- |
| D (diagnosis) | 120 | `081dc737f61f9b7c0a4b23f656903d65f2e9b13cd57de70a312fce9e78f770f9` |
| H (held back) | 120 | `f0b6635d69eaaef6f61231fbece5d61721dd1e75765707d737cfbfe87108a4e0` |

```bash
git show 12cedfe592aab40cdd47ee00d05ea86a6d2bae89:tests/fixtures/agent-capability-bench/v2/dev/payload.json | python3 -B -c '
from hashlib import sha256
import json
import sys

ids = [row["id"] for row in json.load(sys.stdin)["cases"] if row["area"] == "follow-up"]
assert len(ids) == len(set(ids)) == 240
ids.sort(key=lambda case_id: (sha256(case_id.encode("utf-8")).digest(), case_id))
for label, group in (("D", ids[:120]), ("H", ids[120:])):
    encoded = "".join(case_id + "\n" for case_id in group).encode("utf-8")
    print(label, len(group), sha256(encoded).hexdigest())
'
```

## Diagnosis at the requested base

The launcher ran commit `201321031293999003bb0ae55a29dbd250ac96ce` with the PR #95 arm C profile. Its coordinated receipt has SHA-256 `b2d8668a99ae9c40366f301a14ac2329352405e5bfcfed6a090ac1495243a6eb`. The baseline scored 21/120 on D. Each of the 99 misses completed on `writing/explicit_handler`. Its only failed check was `required-content-1`, which compares the response to one standalone rewrite from CANARD. The frozen report's routing counts describe an earlier sealed baseline. [Development launcher](../scripts/dev-bench/README.md) · [PR #95 profile](INTEGRATION-WAVE-5-2026-11-25.md#three-arm-development-run)

| Receipt stage | Failures |
| --- | ---: |
| Understanding | 0 |
| Routing | 0 |
| Planning | 0 |
| Tool | 0 |
| Answer | 99 |
| Verification | 0 |

| Primary cause | Failures |
| --- | ---: |
| Lost topic or omitted relation | 45 |
| Wrong referent | 21 |
| Different wording | 19 |
| No rewrite | 13 |
| Malformed question | 1 |

A partial rewrite that still needed an entity, event, or relation was counted as lost context. A dependent question repeated as supplied was counted as no rewrite. The wording category includes equivalent rewrites with a different alias, word order, or punctuation. Assignment is a qualitative diagnosis of D failures against the receipt and the supplied history. The ID ledger below gives one cause per receipt.

### Five whys for lost topic or omitted relation

1. The returned question still depended on a subject, titled work, event, or relation in the transcript.
2. The current sentence used a short description or omitted an argument that the previous exchange supplied. Examples include `human-aa6c6d304df48869d795437a`, `human-d064f927532d3ff6d689cb18` and `human-dffc1441eac061dec06dde66`.
3. The rewriter mostly substituted free pronouns. Its determiner guard preserved definite descriptions and its ellipsis matcher accepted a small set of whole-question forms.
4. It used the prior question for a few fixed templates and treated recognized section headings as undifferentiated referents. That lost the relationship between a short noun phrase and its title, or between a follow-up fragment and the prior question's frame.
5. The missing mechanism was a way to carry a question frame or named topic forward when the current grammar and recent history offer evidence for it. [Existing rewriter](../apps/server/src/assistant/question-rewriter.ts)

### Five whys for wrong referents

1. A completed reply named an entity other than the one the dialogue was asking about.
2. The article subject often won over a person, group, or title introduced in the recent exchange. Examples include `human-1ffb91905af0d4998865ffd5`, `human-59c99bf6b3605ed03f266295` and `human-6d8e0c6b05cdafb38f23cfad`.
3. The fallback ranked the article highly for personal and plural pronouns and chose section or name strings for other references.
4. Those strings carried no evidence that the referent performed the relevant action, filled the same preposition, or was the type of object under discussion.
5. The missing mechanism was a bounded way to prefer explicit evidence from the preceding question and answer when it identifies a more relevant referent. [Existing rewriter](../apps/server/src/assistant/question-rewriter.ts)

### D failure ledger

| Development ID | Receipt stage | Primary cause |
| --- | --- | --- |
| `human-01798318c854901690c3ed93` | answer | wrong referent |
| `human-01e4f3adcb5ed67267149708` | answer | different wording |
| `human-02853e132201ec7c61c3a505` | answer | wrong referent |
| `human-09a11ff00af5db96975b1ee3` | answer | no rewrite |
| `human-0da8623c10bd47fe1967fcb9` | answer | lost topic or omitted relation |
| `human-0f9b0d44b9be3a4ea42eef21` | answer | no rewrite |
| `human-1369b79624616d7b96e58779` | answer | lost topic or omitted relation |
| `human-186d19aa276081da015df561` | answer | lost topic or omitted relation |
| `human-1c0ee3cde6abd826a77767d3` | answer | wrong referent |
| `human-1ffb91905af0d4998865ffd5` | answer | wrong referent |
| `human-21fabbc285cdebb7238432bd` | answer | different wording |
| `human-2748c744f928051247078d84` | answer | lost topic or omitted relation |
| `human-292463b8abf4db9182896683` | answer | lost topic or omitted relation |
| `human-2bc0ec740cf2fcd75d875b2b` | answer | lost topic or omitted relation |
| `human-2c27fd63b8ef43d4d5f7fe56` | answer | no rewrite |
| `human-2ce14b220367d7e524fa322c` | answer | lost topic or omitted relation |
| `human-2d220c368015119af7e4c34a` | answer | different wording |
| `human-3045083ea53023461f23f0a7` | answer | lost topic or omitted relation |
| `human-30dcf80c4350ba0bff6815f8` | answer | wrong referent |
| `human-3169ec32fdec88826441e336` | answer | lost topic or omitted relation |
| `human-3210d2018d1ff04fc63e5495` | answer | no rewrite |
| `human-345a22bc15586909ab5f6c4e` | answer | lost topic or omitted relation |
| `human-363254d4124f7c518a810668` | answer | wrong referent |
| `human-3beb2c276b24145cf591f99b` | answer | lost topic or omitted relation |
| `human-3ce7717c3cce7ade2e004648` | answer | wrong referent |
| `human-3d1ab445054d99b25b6e7f0a` | answer | wrong referent |
| `human-3ff25f8ea39604216bd25745` | answer | wrong referent |
| `human-4700313ddf2be89f96dd132e` | answer | different wording |
| `human-48f9680ca12806c923af9731` | answer | no rewrite |
| `human-49e1335f00271aa0474d6088` | answer | lost topic or omitted relation |
| `human-53369803acb6c680c527b6f4` | answer | wrong referent |
| `human-57093466ebfd142477e9812a` | answer | lost topic or omitted relation |
| `human-59c99bf6b3605ed03f266295` | answer | wrong referent |
| `human-6299b4ddb75e425c209d2fe4` | answer | lost topic or omitted relation |
| `human-649fc1baa882b661e3952c46` | answer | wrong referent |
| `human-6538e572f671b77d679f7be7` | answer | no rewrite |
| `human-68996f82eb974814d222de01` | answer | wrong referent |
| `human-6d860f1f32fab153ed6ec195` | answer | lost topic or omitted relation |
| `human-6d8e0c6b05cdafb38f23cfad` | answer | wrong referent |
| `human-6ee83e13c508cd908edf2071` | answer | wrong referent |
| `human-6f00acb77170e74609c7ca16` | answer | wrong referent |
| `human-6f7e622ecde353c590790f7b` | answer | lost topic or omitted relation |
| `human-7156ace9ff827a80826f247a` | answer | different wording |
| `human-735319c937442b94a963e33e` | answer | no rewrite |
| `human-758a4cf3f2547964febe0ba8` | answer | wrong referent |
| `human-7b6ffd707556262b9f6a9ffc` | answer | lost topic or omitted relation |
| `human-7caf91558b80a77ae490849b` | answer | different wording |
| `human-7d289d2905f2bfe0c282cd9a` | answer | different wording |
| `human-81283be637a90badb336c876` | answer | different wording |
| `human-846234d739b48fbed6810e4f` | answer | lost topic or omitted relation |
| `human-8fc199714b8463512fd005a3` | answer | lost topic or omitted relation |
| `human-921155c5ce80a354eca7473d` | answer | lost topic or omitted relation |
| `human-92476a81c438ab13583fb72c` | answer | lost topic or omitted relation |
| `human-9ad5effec90f96c0eb49dd17` | answer | different wording |
| `human-9afd198f1e81263b4b9e9537` | answer | lost topic or omitted relation |
| `human-9c7000c1c873423e9219ed21` | answer | wrong referent |
| `human-9d56e98c02d5b78133d50e92` | answer | no rewrite |
| `human-9f652ae17cc6f469960685e4` | answer | wrong referent |
| `human-9fe8add03147737fdd0c34cc` | answer | lost topic or omitted relation |
| `human-a13c3503b27bd3ce96585644` | answer | lost topic or omitted relation |
| `human-a341c091476f32cc6509e88b` | answer | no rewrite |
| `human-a4e32463d2aeb9fbaf157549` | answer | lost topic or omitted relation |
| `human-aa6c6d304df48869d795437a` | answer | lost topic or omitted relation |
| `human-aaa7fcd8af4767a6eaabab0a` | answer | lost topic or omitted relation |
| `human-b6405a3cd74155a248eeb3d4` | answer | lost topic or omitted relation |
| `human-b764ef27cbe5884cac30c45d` | answer | lost topic or omitted relation |
| `human-b843a3a4b362b0b6433928be` | answer | lost topic or omitted relation |
| `human-ba2957a205e309b86cf8624b` | answer | different wording |
| `human-c04c75156fa6dce5e1e2fde8` | answer | no rewrite |
| `human-c0dfe593e9b2b6fc4d57a619` | answer | lost topic or omitted relation |
| `human-c24c7de7586cee353d7fa5a8` | answer | lost topic or omitted relation |
| `human-c3740a3d2b65fa96bef687e7` | answer | different wording |
| `human-c6d37f93fccb2119e6448e76` | answer | different wording |
| `human-c7a89b996089f740306940cf` | answer | different wording |
| `human-cdde2b5a70ba00813bbb3e81` | answer | lost topic or omitted relation |
| `human-d064f927532d3ff6d689cb18` | answer | lost topic or omitted relation |
| `human-d11a4b21500ca17350c734e2` | answer | wrong referent |
| `human-d34d95da33d1a31b8a3ddf8a` | answer | no rewrite |
| `human-d3d9b0b9a696336aa1d03a41` | answer | different wording |
| `human-d40045b434e3b5fec9ae7635` | answer | lost topic or omitted relation |
| `human-d551cacead1c503d64c9b5ab` | answer | no rewrite |
| `human-d92ea19c4d89cd1cb12bf457` | answer | lost topic or omitted relation |
| `human-da66b1ea3cf3e165ceae20c8` | answer | different wording |
| `human-dd4f4b62fbf377f7a300f249` | answer | different wording |
| `human-de96805201693edfdc6f3601` | answer | wrong referent |
| `human-df2ef2934ef76f274aa15853` | answer | no rewrite |
| `human-dffc1441eac061dec06dde66` | answer | lost topic or omitted relation |
| `human-e2a50761caa8ef8ea12e4b2a` | answer | lost topic or omitted relation |
| `human-e39d38d6e8e87a318157d4a5` | answer | malformed question |
| `human-e95eee4fe523a31b47f0bfe1` | answer | lost topic or omitted relation |
| `human-eaa0bbf3c63d828bd3504230` | answer | lost topic or omitted relation |
| `human-eb066b8fbfe420cdee1e1811` | answer | different wording |
| `human-ec4dfb2a57663300ad0eb2b6` | answer | lost topic or omitted relation |
| `human-ec572e8c754f4eeb88652ccb` | answer | lost topic or omitted relation |
| `human-f0f67674fd47ab47470d9a97` | answer | lost topic or omitted relation |
| `human-f1d069de44038aed929c3e2a` | answer | different wording |
| `human-f1dcc28719c4a334ecf589ed` | answer | lost topic or omitted relation |
| `human-f7fa47cfe9d3298e9be73e59` | answer | lost topic or omitted relation |
| `human-fa9cc30535694b334f69f4ca` | answer | different wording |

## Rollout

`MOHASSAN_FOLLOWUP_V2=1` enables two deterministic English modules. The referent resolver uses the previous answer's actor, a named group in the same grammatical role, or an explicitly typed topic to resolve references. The ellipsis resolver restores question frames and named subjects when the transcript supplies them. Supplied transcripts use the existing writing route. Live use requires `MOHASSAN_QUESTION_REWRITER=1`, an eligible previous public lookup and the existing scope, refusal and provenance checks. If the new candidate fails those checks, the live path tries the legacy rewrite and original route in order. No corpus is loaded at runtime.

The flag defaults to off. For rollback, set it to `0` or remove it. The Arabic branch still uses the legacy grammar. The focused Arabic tests exercise both the local rewriter and authorized public follow-up projection with the new flag on.

### Merge notes

There are zero hooks in the held files. The two assistant hooks are `question-rewriter.ts` and `question-rewrite-chat.ts`. The launcher adds the flag to its override allowlist and keeps its default profile. No migrations are required.

## Focused checks

The product commit measured by the coordinator is `e30a31b265bca6b50ee8a82284b5f992b925a72b`.

```bash
npm run typecheck
npm test -- --maxWorkers=2 --reporter=dot tests/followup-english-ellipsis.test.ts tests/followup-english-referents.test.ts tests/followup-v2-arabic.test.ts tests/followup-v2-chat.test.ts tests/question-rewriter.test.ts tests/question-rewrite-chat.test.ts tests/public-conversation-followup.test.ts tests/assistant-follow-up.test.ts tests/assistant-conversation-follow-up.test.ts
```

Typecheck exited 0 for the root and web projects. The focused suite exited 0 with 112 tests across nine files, including four Arabic rollout-on tests. An initial run identified a capitalized preposition in the date reconstruction and the final run verified the fix.

The separate CANARD run scored 685 exact and 787 normalized substring matches at base and with the feature flag off. With the feature flag on it scored 684 exact and 786 normalized substring matches. The commands, context-dependent subset and input hashes are in the evaluation data card. [CANARD evaluation](QUESTION-REWRITER-CANARD.md#follow-up-v2-measurement)

## Benchmark commands

The checkout used Git, Node 24.22.3, npm 11.19.1, Python 3.12.14 and Chromium 156.0.8078.4. The Docker image built from the committed recipe had ID `sha256:cdf6851e462e071097852f8a65bf444378655422f421618d0502361e198848e9`. Each setup command exited 0.

```bash
git fetch origin 12cedfe592aab40cdd47ee00d05ea86a6d2bae89 a130b239d9e6d2b1f6728128019d24bb26e9293f a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f 0dfff7c54d3658a02cf878ff11faac7f630a6c10 a1e1cb020b7ba093885edbf501149e7b8252c0cb
docker build -t mohassan-wave5-bench:2026-11-25 scripts/dev-bench
npm_config_cache=/workspace/work/followup-bench/npm-cache npm ci --no-audit --no-fund
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/followup-bench/chromium npm_config_cache=/workspace/work/followup-bench/npm-cache npx --no-install playwright install chromium
```

The diagnosis run exited 0 with 176/240 on V1 and 1,588/2,400 on V2, including 18/18 and 46/240 in their respective follow-up areas. The exact command was the following.

```bash
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
  --mount type=bind,source=/workspace/Mohassan-AI,target=/workspace/Mohassan-AI \
  --mount type=bind,source=/workspace/work/followup-bench,target=/workspace/work/followup-bench \
  --workdir /workspace/Mohassan-AI \
  --env PLAYWRIGHT_BROWSERS_PATH=/workspace/work/followup-bench/chromium \
  --env npm_config_cache=/workspace/work/followup-bench/npm-cache \
  mohassan-wave5-bench:2026-11-25 python3 -B scripts/dev-bench/run.py --workers 2 --offline \
  --output /workspace/work/followup-bench/diagnosis \
  --arm a=201321031293999003bb0ae55a29dbd250ac96ce \
  --set a:MOHASSAN_ARITHMETIC_SEARCH=1 --set a:TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3.12 \
  --set a:MOHASSAN_MODEL_RELATIONS=shadow \
  --set a:MOHASSAN_REPLY_POLICY_ENABLED=1 --set a:MOHASSAN_CONTEXT_POLICY_ENABLED=1 \
  --set a:MOHASSAN_LONG_RUN_ENABLED=1 --set a:MOHASSAN_BACKGROUND_RESULTS_ENABLED=1 \
  --set a:MOHASSAN_ARBITER_ROUTING=1 --set a:MOHASSAN_ARBITER_QUESTION_REWRITE=1 \
  --set a:MOHASSAN_ARBITER_LOCAL_COMPUTATION=1 --set a:MOHASSAN_ARBITER_COMPOUND_PLAN=1
```

Review found that a pronoun match could start inside another word and that the nominal rule could rewrite a quoted literal. The initial launcher invocation was stopped during arm A and returned 137. The corrected product was measured in a fresh output directory with all three arms.

The coordinated run uses one launcher invocation with the same Wave 5 flags on all arms and the arbiter in shadow. The launcher inherits the Wave 4 flags, including `MOHASSAN_QUESTION_REWRITER=1`, from its base profile. The command used this wrapper.

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 || ! "$2" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Usage: %s NEW_OUTPUT_DIRECTORY HEAD_SHA\n' "$0" >&2
  exit 2
fi
benchmark_dir=/workspace/work/followup-bench
repository=/workspace/Mohassan-AI
output=$1
head_commit=$2
base_commit=201321031293999003bb0ae55a29dbd250ac96ce
settings=()
for arm in a b c; do
  settings+=(
    --set "$arm:MOHASSAN_ARITHMETIC_SEARCH=1"
    --set "$arm:TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3.12"
    --set "$arm:MOHASSAN_MODEL_RELATIONS=shadow"
  )
  for flag in REPLY_POLICY_ENABLED CONTEXT_POLICY_ENABLED LONG_RUN_ENABLED \
    BACKGROUND_RESULTS_ENABLED ARBITER_ROUTING ARBITER_QUESTION_REWRITE \
    ARBITER_LOCAL_COMPUTATION ARBITER_COMPOUND_PLAN; do
    settings+=(--set "$arm:MOHASSAN_${flag}=1")
  done
done

docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
  --mount "type=bind,source=$repository,target=$repository" \
  --mount "type=bind,source=$benchmark_dir,target=$benchmark_dir" \
  --workdir "$repository" \
  --env "PLAYWRIGHT_BROWSERS_PATH=$benchmark_dir/chromium" \
  --env "npm_config_cache=$benchmark_dir/npm-cache" \
  mohassan-wave5-bench:2026-11-25 python3 -B scripts/dev-bench/run.py --workers 2 --offline \
  --output "$output" --arm "a=$base_commit" --arm "b=$head_commit" --arm "c=$head_commit" \
  "${settings[@]}" --set b:MOHASSAN_FOLLOWUP_V2=0 --set c:MOHASSAN_FOLLOWUP_V2=1
```

```bash
bash /workspace/work/followup-bench/run-final.sh /workspace/work/followup-bench/final-reviewed e30a31b265bca6b50ee8a82284b5f992b925a72b
```

## Source guards

The original guard baselines predate the required integration base. I ran the original commands on the detached base at `201321031293999003bb0ae55a29dbd250ac96ce` and on the measured product at `e30a31b265bca6b50ee8a82284b5f992b925a72b`. The first two commands each exited 1 on both checkouts. The synthetic check passed and the source check reported the same 12 inherited occurrences across 10 paths. The development-only case-text command exited 1 on both checkouts, with identical sets of 67 path/hash pairs and 142 occurrences above its historical baseline, plus 159 preexisting pairs. It scanned 2,400 development cases and 2,361 base files or 2,368 product files.

```bash
git worktree add --detach /workspace/work/followup-bench/guard-base 201321031293999003bb0ae55a29dbd250ac96ce

# From each checkout
python3 -B -m unittest discover -s tests -p test_v2_case_strings.py -v
python3 -B -m unittest discover -s tests -p test_v2_source_leakage.py -v
python3 -B tests/no-v2-case-text.test.py --development-only --allow-baseline-matches \
  --benchmark-root /workspace/work/followup-bench/guard-inputs
```

The same guard logic with the integration base supplied in memory passed on the measured product. The first two modules passed 4/4. The third exited 0 with zero new matches over 2,400 development cases and 2,368 files. It reported 225 existing path/hash pairs and `strict_passed: false` from those existing matches. The first invocation follows the release-relative method in [PR #89's report](RESPONSE-POLICY.md). The hash-based scans used both hash registries. The raw case-text scan opened only the development payload.

```bash
python3 -B -c 'import sys, unittest; sys.path.insert(0, "tests"); import test_v2_source_leakage as scan, test_v2_case_strings as fields; base="201321031293999003bb0ae55a29dbd250ac96ce"; scan.BASE=scan.WAVE_2_BASE=fields.BASELINE=fields.WAVE_2_BASE=base; suite=unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromModule(module) for module in (scan, fields)); sys.exit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())'
python3 -B -c 'import runpy, sys; guard=runpy.run_path("tests/no-v2-case-text.test.py"); guard["audit"].__globals__["BASELINE"]="201321031293999003bb0ae55a29dbd250ac96ce"; sys.exit(guard["main"]())' \
  --development-only --allow-baseline-matches --benchmark-root /workspace/work/followup-bench/guard-inputs
```

The scratch guard input directory contains `scripts/agent-capability-bench/v2/exclusion.py` from the measured source and only `manifest.json` and `payload.json` under `tests/fixtures/agent-capability-bench/v2/dev/` from the published development commit `12cedfe592aab40cdd47ee00d05ea86a6d2bae89`. The development payload SHA-256 is `6eda0e7052611d10fc87da4e3e8f3f30cfb64452c198eab20041b5da577508d1`.
