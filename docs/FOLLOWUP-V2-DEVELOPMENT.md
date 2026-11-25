# Follow-up understanding development evaluation

The candidate improved V2 follow-up from 46/240 to 55/240. All nine gains were in D. H stayed at 25/120, so commit `22725948c66a4c9bfd47b9dca5a6540af46788d4` removed the candidate, including its flag and tests. This draft retains the diagnosis and the measured results. [V2 follow-up by split](#v2-follow-up-by-split)

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

## Measured candidate

`MOHASSAN_FOLLOWUP_V2=1` enabled two deterministic English modules in the measured candidate. The referent resolver uses the previous answer's actor, a named group in the same grammatical role, or an explicitly typed topic to resolve references. The ellipsis resolver restores question frames and named subjects when the transcript supplies them. Supplied transcripts use the existing writing route. Live use requires `MOHASSAN_QUESTION_REWRITER=1`, an eligible previous public lookup and the existing scope, refusal and provenance checks. If the new candidate fails those checks, the live path tries the legacy rewrite and original route in order. No corpus is loaded at runtime.

The candidate flag defaulted to off. The Arabic branch still uses the legacy grammar. The focused Arabic tests exercise both the local rewriter and authorized public follow-up projection with the new flag on.

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

The coordinated run used one launcher invocation with the same Wave 5 flags on all arms and the arbiter in shadow. The launcher inherits the Wave 4 flags, including `MOHASSAN_QUESTION_REWRITER=1`, from its base profile. The wrapper below ran from the measured checkout. To reproduce after the rollback, use a detached checkout at `e30a31b265bca6b50ee8a82284b5f992b925a72b` and substitute its path in `repository`.

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

## Coordinated development run

| Arm | Commit | Coordinated receipt SHA-256 |
| --- | --- | --- |
| A | `201321031293999003bb0ae55a29dbd250ac96ce` | `4b9143307841be0ad224cd8844c1a1e993bee7e5e46b9a27077ac2527a92ca89` |
| B | `e30a31b265bca6b50ee8a82284b5f992b925a72b` | `626890b835dec81c4850ee352d8c2b10a7e7e4b85da3df3f3a5c601b4bc06e93` |
| C | `e30a31b265bca6b50ee8a82284b5f992b925a72b` | `da4b2a25ef563f57df82dada57656e4cea6cf52251118f4baed2c878eb2d9e76` |

### V1 results

| Group | Value | A | B | C | C − A |
| --- | --- | ---: | ---: | ---: | ---: |
| Overall | Overall | 176/240 | 176/240 | 176/240 | +0 |
| Area | calculation | 18/18 | 18/18 | 18/18 | +0 |
| Area | clarification | 16/16 | 16/16 | 16/16 | +0 |
| Area | coding | 0/16 | 0/16 | 0/16 | +0 |
| Area | comparison | 11/18 | 11/18 | 11/18 | +0 |
| Area | desktop | 11/16 | 11/16 | 11/16 | +0 |
| Area | document-file | 16/18 | 16/18 | 16/18 | +0 |
| Area | explanation | 8/18 | 8/18 | 8/18 | +0 |
| Area | factual | 10/18 | 10/18 | 10/18 | +0 |
| Area | follow-up | 18/18 | 18/18 | 18/18 | +0 |
| Area | google-ads | 0/16 | 0/16 | 0/16 | +0 |
| Area | memory | 16/16 | 16/16 | 16/16 | +0 |
| Area | multi-step | 18/18 | 18/18 | 18/18 | +0 |
| Area | refusal | 16/16 | 16/16 | 16/16 | +0 |
| Area | small-talk | 18/18 | 18/18 | 18/18 | +0 |
| Language | ar | 85/120 | 85/120 | 85/120 | +0 |
| Language | en | 91/120 | 91/120 | 91/120 | +0 |
| Area and language | calculation/ar | 9/9 | 9/9 | 9/9 | +0 |
| Area and language | calculation/en | 9/9 | 9/9 | 9/9 | +0 |
| Area and language | clarification/ar | 8/8 | 8/8 | 8/8 | +0 |
| Area and language | clarification/en | 8/8 | 8/8 | 8/8 | +0 |
| Area and language | coding/ar | 0/8 | 0/8 | 0/8 | +0 |
| Area and language | coding/en | 0/8 | 0/8 | 0/8 | +0 |
| Area and language | comparison/ar | 5/9 | 5/9 | 5/9 | +0 |
| Area and language | comparison/en | 6/9 | 6/9 | 6/9 | +0 |
| Area and language | desktop/ar | 5/8 | 5/8 | 5/8 | +0 |
| Area and language | desktop/en | 6/8 | 6/8 | 6/8 | +0 |
| Area and language | document-file/ar | 8/9 | 8/9 | 8/9 | +0 |
| Area and language | document-file/en | 8/9 | 8/9 | 8/9 | +0 |
| Area and language | explanation/ar | 4/9 | 4/9 | 4/9 | +0 |
| Area and language | explanation/en | 4/9 | 4/9 | 4/9 | +0 |
| Area and language | factual/ar | 3/9 | 3/9 | 3/9 | +0 |
| Area and language | factual/en | 7/9 | 7/9 | 7/9 | +0 |
| Area and language | follow-up/ar | 9/9 | 9/9 | 9/9 | +0 |
| Area and language | follow-up/en | 9/9 | 9/9 | 9/9 | +0 |
| Area and language | google-ads/ar | 0/8 | 0/8 | 0/8 | +0 |
| Area and language | google-ads/en | 0/8 | 0/8 | 0/8 | +0 |
| Area and language | memory/ar | 8/8 | 8/8 | 8/8 | +0 |
| Area and language | memory/en | 8/8 | 8/8 | 8/8 | +0 |
| Area and language | multi-step/ar | 9/9 | 9/9 | 9/9 | +0 |
| Area and language | multi-step/en | 9/9 | 9/9 | 9/9 | +0 |
| Area and language | refusal/ar | 8/8 | 8/8 | 8/8 | +0 |
| Area and language | refusal/en | 8/8 | 8/8 | 8/8 | +0 |
| Area and language | small-talk/ar | 9/9 | 9/9 | 9/9 | +0 |
| Area and language | small-talk/en | 9/9 | 9/9 | 9/9 | +0 |

#### V1 case changes by area

Compared 240 cases in release order. A scored failure signature contains each failed check's turn, stage and name.

| Area | A → C newly pass | A → C newly fail | A → B verdict differences | A → B failed check differences |
| --- | --- | --- | --- | --- |
| calculation | None | None | None | None |
| clarification | None | None | None | None |
| coding | None | None | None | None |
| comparison | None | None | None | None |
| desktop | None | None | None | None |
| document-file | None | None | None | None |
| explanation | None | None | None | None |
| factual | None | None | None | None |
| follow-up | None | None | None | None |
| google-ads | None | None | None | None |
| memory | None | None | None | None |
| multi-step | None | None | None | None |
| refusal | None | None | None | None |
| small-talk | None | None | None | None |

### V2 results

| Group | Value | A | B | C | C − A |
| --- | --- | ---: | ---: | ---: | ---: |
| Overall | Overall | 1588/2400 | 1588/2400 | 1597/2400 | +9 |
| Area | calculation | 7/277 | 7/277 | 7/277 | +0 |
| Area | clarification | 9/9 | 9/9 | 9/9 | +0 |
| Area | coding | 108/155 | 108/155 | 108/155 | +0 |
| Area | comparison | 28/32 | 28/32 | 28/32 | +0 |
| Area | factual | 976/1244 | 976/1244 | 976/1244 | +0 |
| Area | follow-up | 46/240 | 46/240 | 55/240 | +9 |
| Area | refusal | 348/375 | 348/375 | 348/375 | +0 |
| Area | small-talk | 66/68 | 66/68 | 66/68 | +0 |
| Language | ar | 982/1200 | 982/1200 | 982/1200 | +0 |
| Language | en | 606/1200 | 606/1200 | 615/1200 | +9 |
| Area and language | calculation/en | 7/277 | 7/277 | 7/277 | +0 |
| Area and language | clarification/ar | 2/2 | 2/2 | 2/2 | +0 |
| Area and language | clarification/en | 7/7 | 7/7 | 7/7 | +0 |
| Area and language | coding/en | 108/155 | 108/155 | 108/155 | +0 |
| Area and language | comparison/ar | 22/26 | 22/26 | 22/26 | +0 |
| Area and language | comparison/en | 6/6 | 6/6 | 6/6 | +0 |
| Area and language | factual/ar | 818/1017 | 818/1017 | 818/1017 | +0 |
| Area and language | factual/en | 158/227 | 158/227 | 158/227 | +0 |
| Area and language | follow-up/en | 46/240 | 46/240 | 55/240 | +9 |
| Area and language | refusal/ar | 140/155 | 140/155 | 140/155 | +0 |
| Area and language | refusal/en | 208/220 | 208/220 | 208/220 | +0 |
| Area and language | small-talk/en | 66/68 | 66/68 | 66/68 | +0 |

#### V2 case changes by area

Compared 2,400 cases in release order. A scored failure signature contains each failed check's turn, stage and name.

| Area | A → C newly pass | A → C newly fail | A → B verdict differences | A → B failed check differences |
| --- | --- | --- | --- | --- |
| calculation | None | None | None | None |
| clarification | None | None | None | None |
| coding | None | None | None | None |
| comparison | None | None | None | None |
| factual | None | None | None | None |
| follow-up | `human-3d1ab445054d99b25b6e7f0a`, `human-735319c937442b94a963e33e`, `human-649fc1baa882b661e3952c46`, `human-d34d95da33d1a31b8a3ddf8a`, `human-aa6c6d304df48869d795437a`, `human-59c99bf6b3605ed03f266295`, `human-6f7e622ecde353c590790f7b`, `human-dffc1441eac061dec06dde66`, `human-30dcf80c4350ba0bff6815f8` | None | None | None |
| refusal | None | None | None | None |
| small-talk | None | None | None | None |

### V2 follow-up by split

| Split | A | B | C | C − A | Newly pass | Newly fail |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| D | 21/120 | 21/120 | 30/120 | +9 | 9 | 0 |
| H | 25/120 | 25/120 | 25/120 | +0 | 0 | 0 |

### Turn latency

Percentiles use nearest rank over recorded turn latencies. Each row pools turns across that arm and version.

| Arm | Version | Measured turns | p50 (ms) | p95 (ms) |
| --- | --- | ---: | ---: | ---: |
| A | V1 | 279 | 73.058 | 578.111 |
| A | V2 | 2,400 | 114.116 | 1214.328 |
| A | Combined | 2,679 | 110.862 | 1189.185 |
| B | V1 | 279 | 67.867 | 510.126 |
| B | V2 | 2,400 | 113.696 | 1195.333 |
| B | Combined | 2,679 | 110.348 | 1178.753 |
| C | V1 | 279 | 66.717 | 567.861 |
| C | V2 | 2,400 | 109.534 | 1199.518 |
| C | Combined | 2,679 | 106.761 | 1160.016 |

### Acceptance checks from the coordinated receipts

- V1 follow-up remains 18/18 in all arms — PASS
- V1 has no group regression in C — PASS
- V1 A and B match every verdict — PASS
- V1 A and B match every scored failure signature — PASS
- V2 has no group regression in C — PASS
- V2 A and B match every verdict — PASS
- V2 A and B match every scored failure signature — PASS
- V2 held-back follow-up improved in C — FAIL

The coordinator exited 0 and wrote summary SHA-256 `1993cad7cb635963af452efc950a7b55ab8ee42d919197db3336c4993237c052`. The split and subgroup report exited 1 because H gained zero passes. All 68 overall or subgroup comparisons were at or above base. A and B matched all 2,640 scored verdicts and failure signatures. The metadata comparison also found zero structured routing differences. H was used for scored IDs and counts. The sealed benchmark sets stayed closed.

```bash
python3 -B /workspace/work/followup-v2/report-receipts.py /workspace/work/followup-bench/final-reviewed --expect-head e30a31b265bca6b50ee8a82284b5f992b925a72b > /workspace/work/followup-v2/receipt-report.md
python3 -B /workspace/work/followup-v2/compare-completed.py /workspace/work/followup-bench/final-reviewed/a/receipt.json /workspace/work/followup-bench/final-reviewed/b/receipt.json
python3 -B /workspace/work/followup-v2/compare-receipt-metadata.py /workspace/work/followup-bench/final-reviewed /workspace/work/followup-bench/diagnosis/a/receipt.json
sha256sum /workspace/work/followup-bench/final-reviewed/summary.json
```

Both metadata checks exited 0. The unmasked launcher comparator exited 1. It recorded A/B reply-byte differences in 30 V1 cases and 1,047 V2 cases, zero verdict differences and zero group regressions. The diagnosis and final base runs used the same product, inputs, settings and toolchain and differed in reply bytes on 31 V1 and 1,051 V2 cases. The base-run and A/B differences overlapped on 27 V1 and 1,041 V2 IDs. This establishes repeat variability for most of the differing IDs. Full byte parity was unverified. [PR #95 reply comparison](INTEGRATION-WAVE-5-2026-11-25.md#three-arm-development-run)

```bash
python3 -B scripts/dev-bench/compare.py \
  --baseline /workspace/work/followup-bench/final-reviewed/a/receipt.json \
  --flags-off /workspace/work/followup-bench/final-reviewed/b/receipt.json \
  --flags-on /workspace/work/followup-bench/final-reviewed/c/receipt.json \
  --output /workspace/work/followup-bench/final-reviewed/unmasked-comparison.json
```

## Final branch checks

The final diff contains the two report files. The application, packages, launcher and tests match the requested base byte for byte. Both source-delta checks examined the two changed files and found zero added or removed matching strings. Each command exited 0.

```bash
python3 -B /workspace/work/canard-followup/compare-hash-guards.py /workspace/work/canard-followup/base-guard /workspace/Mohassan-AI
python3 -B /workspace/work/canard-followup/compare-dev-raw-guard.py /workspace/work/canard-followup/base-guard /workspace/Mohassan-AI /workspace/work/canard-followup/dev-guard
git diff --exit-code 201321031293999003bb0ae55a29dbd250ac96ce HEAD -- apps packages scripts tests
git diff --check 201321031293999003bb0ae55a29dbd250ac96ce
```
