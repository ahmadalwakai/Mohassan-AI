# Mohassan capability benchmark v2 by branch — 25 November 2026

The study measured 15 of 15 available candidates on the same 1,200 sealed cases. The release draws from public human-written datasets. The paired baseline replay at `c2a0ff765071657cf200b5ee7d12fabaad738c0b` matched the published v2 pass counts overall and in every area and language group. Each candidate was measured on a separate scratch merge with frozen measurement commit `74035b9cca7e94a750234abf574cdbad2e692239`, based on the PR #56 release at `a130b239d9e6d2b1f6728128019d24bb26e9293f`. [V2 release audit](CAPABILITY-BENCH-V2-2026-11-25.md) · [V2 data and mapping](CAPABILITY-BENCH-V2-DATA.md)

## Ranking

The baseline passed **247/1200 (20.6%)**, with a Wilson 95% interval of 18.4%–23.0%. Deltas are against that baseline. Equal deltas share a rank.

| Rank | Candidate | V2 passed | Wilson 95% CI | Delta passes | Delta rate | Newly passing | Newly failing | McNemar p | Holm p |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | [#57](https://github.com/ahmadalwakai/Mohassan-AI/pull/57) `e2e/refusal-generalization` | 341/1200 | 25.9%–31.0% | +94 | +7.83 pp | 94 | 0 | 1.01e-28 | 1.414e-27 |
| 2 | [#47](https://github.com/ahmadalwakai/Mohassan-AI/pull/47) `feat/scratch-classifiers` | 335/1200 | 25.5%–30.5% | +88 | +7.33 pp | 122 | 34 | 7.714e-13 | 1.003e-11 |
| 3 | [#23](https://github.com/ahmadalwakai/Mohassan-AI/pull/23) `feat/arabic-understanding-core` | 254/1200 | 18.9%–23.6% | +7 | +0.58 pp | 9 | 2 | 0.06543 | 0.75 |
| 4 | [#40](https://github.com/ahmadalwakai/Mohassan-AI/pull/40) `feat/small-talk-manners` | 252/1200 | 18.8%–23.4% | +5 | +0.42 pp | 5 | 0 | 0.0625 | 0.75 |
| 5 | [#51](https://github.com/ahmadalwakai/Mohassan-AI/pull/51) `e2e/follow-up-end-to-end` | 248/1200 | 18.5%–23.0% | +1 | +0.08 pp | 1 | 0 | 1 | 1 |
| 6 | [#60](https://github.com/ahmadalwakai/Mohassan-AI/pull/60) `e2e/calculation-end-to-end` | 247/1200 | 18.4%–23.0% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| 6 | [#59](https://github.com/ahmadalwakai/Mohassan-AI/pull/59) `e2e/clarification-end-to-end` | 247/1200 | 18.4%–23.0% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| 6 | [#50](https://github.com/ahmadalwakai/Mohassan-AI/pull/50) `e2e/comparison-end-to-end` | 247/1200 | 18.4%–23.0% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| 6 | [#55](https://github.com/ahmadalwakai/Mohassan-AI/pull/55) `e2e/deliberation-no-regressions` | 247/1200 | 18.4%–23.0% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| 6 | [#58](https://github.com/ahmadalwakai/Mohassan-AI/pull/58) `e2e/document-file-end-to-end` | 247/1200 | 18.4%–23.0% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| 6 | [#53](https://github.com/ahmadalwakai/Mohassan-AI/pull/53) `e2e/memory-end-to-end` | 247/1200 | 18.4%–23.0% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| 6 | [#28](https://github.com/ahmadalwakai/Mohassan-AI/pull/28) `feat/conversation-reviewer` | 247/1200 | 18.4%–23.0% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| 6 | [#49](https://github.com/ahmadalwakai/Mohassan-AI/pull/49) `feat/explanations-multisource` | 247/1200 | 18.4%–23.0% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| 14 | [#52](https://github.com/ahmadalwakai/Mohassan-AI/pull/52) `e2e/multi-step-end-to-end` | 245/1200 | 18.2%–22.8% | -2 | -0.17 pp | 0 | 2 | 0.5 | 1 |
| 15 | [#54](https://github.com/ahmadalwakai/Mohassan-AI/pull/54) `e2e/factual-end-to-end` | 73/1200 | 4.9%–7.6% | -174 | -14.50 pp | 0 | 174 | 8.352e-53 | 1.253e-51 |

## Recommended merge set

The recommendation rule was fixed before sealed evaluation. A candidate qualifies with a positive overall delta at Holm-adjusted p ≤ 0.05 and no negative area or language delta at subgroup Holm-adjusted p ≤ 0.05. Holm correction is applied separately to all frozen candidates overall and to the family of candidate-by-area and candidate-by-language tests. An unavailable result occupies its planned place in each applicable family with p = 1 for correction only.

- Recommend `e2e/refusal-generalization` with its included parent stack. +94 passing cases (+7.83 pp), overall Holm p = 1.414e-27. [#57](https://github.com/ahmadalwakai/Mohassan-AI/pull/57) · [#39](https://github.com/ahmadalwakai/Mohassan-AI/pull/39)

The measured configuration for each recommendation includes its listed flags and inherited commits. Joint effects of separately measured candidates are unverified.

`feat/scratch-classifiers` had a significant overall gain and significant losses in `factual` (-24 passes, Holm p = 1.681e-5). [#47](https://github.com/ahmadalwakai/Mohassan-AI/pull/47)

## V1 development gains and v2 evidence

The table includes each reported positive v1 development delta, including gains in individual areas of a branch with a flat overall result. V2 evidence is always against the common product baseline. V1 comparisons against a stacked parent have a different reference, and v1 and v2 use different cases and area weights. “No gain” indicates a zero or negative v2 pass-count delta. A positive v2 delta with adjusted p > 0.05 is labelled below the significance threshold. [V1 branch audit](https://github.com/ahmadalwakai/Mohassan-AI/pull/41)

| Candidate | Group | V1 delta passes | V1 comparison | V2 result vs product baseline |
| --- | --- | ---: | --- | --- |
| [#40](https://github.com/ahmadalwakai/Mohassan-AI/pull/40) `feat/small-talk-manners` | `overall` | +15 | v1 development baseline | +5 passes, +0.42 pp · gain below the significance threshold |
| [#40](https://github.com/ahmadalwakai/Mohassan-AI/pull/40) `feat/small-talk-manners` | `small-talk` | +15 | v1 development baseline | +5 passes, +10.00 pp · gain below the significance threshold |
| [#51](https://github.com/ahmadalwakai/Mohassan-AI/pull/51) `e2e/follow-up-end-to-end` | `overall` | +27 | enabled PR #35, which matched the v1 development baseline | +1 passes, +0.08 pp · gain below the significance threshold |
| [#51](https://github.com/ahmadalwakai/Mohassan-AI/pull/51) `e2e/follow-up-end-to-end` | `follow-up` | +18 | enabled PR #35, which matched the v1 development baseline | 0 passes, 0.00 pp · no gain |
| [#51](https://github.com/ahmadalwakai/Mohassan-AI/pull/51) `e2e/follow-up-end-to-end` | `explanation` | +3 | enabled PR #35, which matched the v1 development baseline | No v2 cases in this area |
| [#51](https://github.com/ahmadalwakai/Mohassan-AI/pull/51) `e2e/follow-up-end-to-end` | `factual` | +6 | enabled PR #35, which matched the v1 development baseline | +1 passes, +0.19 pp · gain below the significance threshold |
| [#52](https://github.com/ahmadalwakai/Mohassan-AI/pull/52) `e2e/multi-step-end-to-end` | `overall` | +17 | v1 development baseline | -2 passes, -0.17 pp · no gain |
| [#52](https://github.com/ahmadalwakai/Mohassan-AI/pull/52) `e2e/multi-step-end-to-end` | `multi-step` | +17 | v1 development baseline | No v2 cases in this area |
| [#52](https://github.com/ahmadalwakai/Mohassan-AI/pull/52) `e2e/multi-step-end-to-end` | `overall` | +20 | enabled PR #24 | -2 passes, -0.17 pp · no gain |
| [#52](https://github.com/ahmadalwakai/Mohassan-AI/pull/52) `e2e/multi-step-end-to-end` | `calculation` | +2 | enabled PR #24 | 0 passes, 0.00 pp · no gain |
| [#52](https://github.com/ahmadalwakai/Mohassan-AI/pull/52) `e2e/multi-step-end-to-end` | `multi-step` | +18 | enabled PR #24 | No v2 cases in this area |
| [#53](https://github.com/ahmadalwakai/Mohassan-AI/pull/53) `e2e/memory-end-to-end` | `overall` | +16 | enabled PR #31, which matched the v1 development baseline | 0 passes, 0.00 pp · no gain |
| [#53](https://github.com/ahmadalwakai/Mohassan-AI/pull/53) `e2e/memory-end-to-end` | `memory` | +16 | enabled PR #31, which matched the v1 development baseline | No v2 cases in this area |
| [#49](https://github.com/ahmadalwakai/Mohassan-AI/pull/49) `feat/explanations-multisource` | `explanation` | +8 | enabled PR #33, which matched the v1 development baseline | No v2 cases in this area |
| [#49](https://github.com/ahmadalwakai/Mohassan-AI/pull/49) `feat/explanations-multisource` | `comparison` | +1 | enabled PR #33, which matched the v1 development baseline | 0 passes, 0.00 pp · no gain |
| [#55](https://github.com/ahmadalwakai/Mohassan-AI/pull/55) `e2e/deliberation-no-regressions` | `overall` | +3 | v1 development baseline | 0 passes, 0.00 pp · no gain |
| [#55](https://github.com/ahmadalwakai/Mohassan-AI/pull/55) `e2e/deliberation-no-regressions` | `clarification` | +1 | v1 development baseline | 0 passes, 0.00 pp · no gain |
| [#55](https://github.com/ahmadalwakai/Mohassan-AI/pull/55) `e2e/deliberation-no-regressions` | `refusal` | +2 | v1 development baseline | 0 passes, 0.00 pp · no gain |
| [#55](https://github.com/ahmadalwakai/Mohassan-AI/pull/55) `e2e/deliberation-no-regressions` | `overall` | +13 | enabled PR #37 | 0 passes, 0.00 pp · no gain |
| [#55](https://github.com/ahmadalwakai/Mohassan-AI/pull/55) `e2e/deliberation-no-regressions` | `desktop` | +5 | enabled PR #37 | No v2 cases in this area |
| [#55](https://github.com/ahmadalwakai/Mohassan-AI/pull/55) `e2e/deliberation-no-regressions` | `document-file` | +5 | enabled PR #37 | No v2 cases in this area |
| [#55](https://github.com/ahmadalwakai/Mohassan-AI/pull/55) `e2e/deliberation-no-regressions` | `refusal` | +3 | enabled PR #37 | 0 passes, 0.00 pp · no gain |
| [#58](https://github.com/ahmadalwakai/Mohassan-AI/pull/58) `e2e/document-file-end-to-end` | `overall` | +13 | v1 development baseline | 0 passes, 0.00 pp · no gain |
| [#58](https://github.com/ahmadalwakai/Mohassan-AI/pull/58) `e2e/document-file-end-to-end` | `document-file` | +13 | v1 development baseline | No v2 cases in this area |
| [#50](https://github.com/ahmadalwakai/Mohassan-AI/pull/50) `e2e/comparison-end-to-end` | `overall` | +18 | enabled PR #26, which matched the v1 development baseline | 0 passes, 0.00 pp · no gain |
| [#50](https://github.com/ahmadalwakai/Mohassan-AI/pull/50) `e2e/comparison-end-to-end` | `comparison` | +18 | enabled PR #26, which matched the v1 development baseline | 0 passes, 0.00 pp · no gain |
| [#54](https://github.com/ahmadalwakai/Mohassan-AI/pull/54) `e2e/factual-end-to-end` | `overall` | +10 | v1 development baseline | -174 passes, -14.50 pp · no gain |
| [#54](https://github.com/ahmadalwakai/Mohassan-AI/pull/54) `e2e/factual-end-to-end` | `factual` | +10 | v1 development baseline | -137 passes, -26.60 pp · no gain |
| [#54](https://github.com/ahmadalwakai/Mohassan-AI/pull/54) `e2e/factual-end-to-end` | `overall` | +13 | enabled PR #25 | -174 passes, -14.50 pp · no gain |
| [#54](https://github.com/ahmadalwakai/Mohassan-AI/pull/54) `e2e/factual-end-to-end` | `factual` | +13 | enabled PR #25 | -137 passes, -26.60 pp · no gain |
| [#57](https://github.com/ahmadalwakai/Mohassan-AI/pull/57) `e2e/refusal-generalization` | `overall` | +15 | v1 development baseline | +94 passes, +7.83 pp · significant gain |
| [#57](https://github.com/ahmadalwakai/Mohassan-AI/pull/57) `e2e/refusal-generalization` | `refusal` | +15 | v1 development baseline | +94 passes, +36.43 pp · significant gain |
| [#47](https://github.com/ahmadalwakai/Mohassan-AI/pull/47) `feat/scratch-classifiers` | `overall` | +5 | v1 development baseline | +88 passes, +7.33 pp · significant gain |
| [#47](https://github.com/ahmadalwakai/Mohassan-AI/pull/47) `feat/scratch-classifiers` | `refusal` | +3 | v1 development baseline | +120 passes, +46.51 pp · significant gain |
| [#47](https://github.com/ahmadalwakai/Mohassan-AI/pull/47) `feat/scratch-classifiers` | `small-talk` | +2 | v1 development baseline | +2 passes, +4.00 pp · gain below the significance threshold |
| [#59](https://github.com/ahmadalwakai/Mohassan-AI/pull/59) `e2e/clarification-end-to-end` | `overall` | +12 | v1 development baseline | 0 passes, 0.00 pp · no gain |
| [#59](https://github.com/ahmadalwakai/Mohassan-AI/pull/59) `e2e/clarification-end-to-end` | `clarification` | +12 | v1 development baseline | 0 passes, 0.00 pp · no gain |
| [#59](https://github.com/ahmadalwakai/Mohassan-AI/pull/59) `e2e/clarification-end-to-end` | `overall` | +16 | enabled PR #32 | 0 passes, 0.00 pp · no gain |
| [#59](https://github.com/ahmadalwakai/Mohassan-AI/pull/59) `e2e/clarification-end-to-end` | `clarification` | +16 | enabled PR #32 | 0 passes, 0.00 pp · no gain |
| [#60](https://github.com/ahmadalwakai/Mohassan-AI/pull/60) `e2e/calculation-end-to-end` | `overall` | +7 | enabled PR #26, which matched the v1 development baseline | 0 passes, 0.00 pp · no gain |
| [#60](https://github.com/ahmadalwakai/Mohassan-AI/pull/60) `e2e/calculation-end-to-end` | `calculation` | +7 | enabled PR #26, which matched the v1 development baseline | 0 passes, 0.00 pp · no gain |

## Shared source datasets

The seal is a separately sampled, pinned release. The branches below had prior exposure to some upstream datasets. Exact overlap with the sealed cases remains unverified.

- `e2e/follow-up-end-to-end` inherits PR #35, which used the byte-identical official CANARD test file for its retrospective development and holdout evaluation. V2 also uses that source for follow-up cases. [PR #51](https://github.com/ahmadalwakai/Mohassan-AI/pull/51) · [PR #35 freeze manifest](https://github.com/ahmadalwakai/Mohassan-AI/blob/2d171b0dce3ab9eac4721aee0a6b6d0f436d2a64/scripts/conversation-state/decision-eval-freeze.json) · [V2 source pins](../scripts/agent-capability-bench/v2/sources.ts)
- `feat/scratch-classifiers` uses first-party linear classifiers trained from zero initialization on human-labelled data. Its data card records CLINC150 at the same pin as v2, the official CANARD test split and MASSIVE v1.0. V2 uses MASSIVE v1.1. Official test splits were used for classifier evaluation after fitting and selection. [PR #47 data card](https://github.com/ahmadalwakai/Mohassan-AI/blob/76b1a9325a5ef4edda84816cc6523aa06026121e/packages/scratch-classifiers/DATA-CARD.md) · [Model card](https://github.com/ahmadalwakai/Mohassan-AI/blob/76b1a9325a5ef4edda84816cc6523aa06026121e/packages/scratch-classifiers/MODEL-CARD.md)
- `e2e/refusal-generalization` uses CLINC150 at the same pin as v2 and Arabic MASSIVE v1.0. After fitting and calibration, its evaluation used the official test splits for the classifier and replayed official CLINC150 test rows through the application-integrated refusal policy. [PR #57 training README](https://github.com/ahmadalwakai/Mohassan-AI/blob/f1ea533a3a33302b621b9e416c543941ccabbc53/scripts/refusal-classifier/README.md)

## Area and language results

Each table uses the same paired cases within the group. Wilson 95% intervals describe each pass proportion. Exact two-sided McNemar p-values use the counts of cases that switched from fail to pass and pass to fail. The per-case paired difference is +1, −1 or 0 for a gain, a loss or an unchanged outcome. Receipts with per-case differences stay in the private measurement workspace.

Areas without v2 cases are `explanation`, `multi-step`, `document-file`, `google-ads`, `desktop`, `memory`. Arabic and English have different area and source mixes. [V2 coverage and interpretation](CAPABILITY-BENCH-V2-2026-11-25.md#coverage-and-interpretation)

| Baseline group | Passed | Wilson 95% CI |
| --- | ---: | ---: |
| Arabic | 191/600 | 28.2%–35.7% |
| English | 56/600 | 7.3%–11.9% |
| `calculation` | 0/110 | 0.0%–3.4% |
| `clarification` | 0/17 | 0.0%–18.4% |
| `coding` | 0/85 | 0.0%–4.3% |
| `comparison` | 40/70 | 45.5%–68.1% |
| `factual` | 203/515 | 35.3%–43.7% |
| `follow-up` | 0/95 | 0.0%–3.9% |
| `refusal` | 0/258 | 0.0%–1.5% |
| `small-talk` | 4/50 | 3.2%–18.8% |

### Pass-count deltas at a glance

| Candidate | Arabic | English | `calculation` | `clarification` | `coding` | `comparison` | `factual` | `follow-up` | `refusal` | `small-talk` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| [#57](https://github.com/ahmadalwakai/Mohassan-AI/pull/57) `e2e/refusal-generalization` | +31 | +63 | 0 | 0 | 0 | 0 | 0 | 0 | +94 | 0 |
| [#47](https://github.com/ahmadalwakai/Mohassan-AI/pull/47) `feat/scratch-classifiers` | +32 | +56 | 0 | 0 | 0 | -10 | -24 | 0 | +120 | +2 |
| [#23](https://github.com/ahmadalwakai/Mohassan-AI/pull/23) `feat/arabic-understanding-core` | +5 | +2 | 0 | 0 | 0 | +1 | +6 | 0 | 0 | 0 |
| [#40](https://github.com/ahmadalwakai/Mohassan-AI/pull/40) `feat/small-talk-manners` | 0 | +5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | +5 |
| [#51](https://github.com/ahmadalwakai/Mohassan-AI/pull/51) `e2e/follow-up-end-to-end` | 0 | +1 | 0 | 0 | 0 | 0 | +1 | 0 | 0 | 0 |
| [#60](https://github.com/ahmadalwakai/Mohassan-AI/pull/60) `e2e/calculation-end-to-end` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| [#59](https://github.com/ahmadalwakai/Mohassan-AI/pull/59) `e2e/clarification-end-to-end` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| [#50](https://github.com/ahmadalwakai/Mohassan-AI/pull/50) `e2e/comparison-end-to-end` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| [#55](https://github.com/ahmadalwakai/Mohassan-AI/pull/55) `e2e/deliberation-no-regressions` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| [#58](https://github.com/ahmadalwakai/Mohassan-AI/pull/58) `e2e/document-file-end-to-end` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| [#53](https://github.com/ahmadalwakai/Mohassan-AI/pull/53) `e2e/memory-end-to-end` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| [#28](https://github.com/ahmadalwakai/Mohassan-AI/pull/28) `feat/conversation-reviewer` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| [#49](https://github.com/ahmadalwakai/Mohassan-AI/pull/49) `feat/explanations-multisource` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| [#52](https://github.com/ahmadalwakai/Mohassan-AI/pull/52) `e2e/multi-step-end-to-end` | -2 | 0 | 0 | 0 | 0 | 0 | -2 | 0 | 0 | 0 |
| [#54](https://github.com/ahmadalwakai/Mohassan-AI/pull/54) `e2e/factual-end-to-end` | -124 | -50 | 0 | 0 | 0 | -37 | -137 | 0 | 0 | 0 |

### Paired subgroup statistics

<details>
<summary>#57 e2e/refusal-generalization</summary>

| Group | Baseline passed | Candidate passed | Candidate Wilson 95% CI | Delta passes | Delta rate | Newly passing | Newly failing | McNemar p | Holm p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Arabic | 191/600 | 222/600 | 33.2%–40.9% | +31 | +5.17 pp | 31 | 0 | 9.313e-10 | 1.322e-7 |
| English | 56/600 | 119/600 | 16.8%–23.2% | +63 | +10.50 pp | 63 | 0 | 2.168e-19 | 3.166e-17 |
| `calculation` | 0/110 | 0/110 | 0.0%–3.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `clarification` | 0/17 | 0/17 | 0.0%–18.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `coding` | 0/85 | 0/85 | 0.0%–4.3% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `comparison` | 40/70 | 40/70 | 45.5%–68.1% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `factual` | 203/515 | 203/515 | 35.3%–43.7% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `follow-up` | 0/95 | 0/95 | 0.0%–3.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `refusal` | 0/258 | 94/258 | 30.8%–42.5% | +94 | +36.43 pp | 94 | 0 | 1.01e-28 | 1.484e-26 |
| `small-talk` | 4/50 | 4/50 | 3.2%–18.8% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |

</details>

<details>
<summary>#47 feat/scratch-classifiers</summary>

| Group | Baseline passed | Candidate passed | Candidate Wilson 95% CI | Delta passes | Delta rate | Newly passing | Newly failing | McNemar p | Holm p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Arabic | 191/600 | 223/600 | 33.4%–41.1% | +32 | +5.33 pp | 61 | 29 | 9.728e-4 | 0.1362 |
| English | 56/600 | 112/600 | 15.8%–22.0% | +56 | +9.33 pp | 61 | 5 | 2.631e-13 | 3.788e-11 |
| `calculation` | 0/110 | 0/110 | 0.0%–3.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `clarification` | 0/17 | 0/17 | 0.0%–18.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `coding` | 0/85 | 0/85 | 0.0%–4.3% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `comparison` | 40/70 | 30/70 | 31.9%–54.5% | -10 | -14.29 pp | 0 | 10 | 0.001953 | 0.2715 |
| `factual` | 203/515 | 179/515 | 30.8%–39.0% | -24 | -4.66 pp | 0 | 24 | 1.192e-7 | 1.681e-5 |
| `follow-up` | 0/95 | 0/95 | 0.0%–3.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `refusal` | 0/258 | 120/258 | 40.5%–52.6% | +120 | +46.51 pp | 120 | 0 | 1.505e-36 | 2.227e-34 |
| `small-talk` | 4/50 | 6/50 | 5.6%–23.8% | +2 | +4.00 pp | 2 | 0 | 0.5 | 1 |

</details>

<details>
<summary>#23 feat/arabic-understanding-core</summary>

| Group | Baseline passed | Candidate passed | Candidate Wilson 95% CI | Delta passes | Delta rate | Newly passing | Newly failing | McNemar p | Holm p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Arabic | 191/600 | 196/600 | 29.0%–36.5% | +5 | +0.83 pp | 7 | 2 | 0.1797 | 1 |
| English | 56/600 | 58/600 | 7.6%–12.3% | +2 | +0.33 pp | 2 | 0 | 0.5 | 1 |
| `calculation` | 0/110 | 0/110 | 0.0%–3.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `clarification` | 0/17 | 0/17 | 0.0%–18.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `coding` | 0/85 | 0/85 | 0.0%–4.3% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `comparison` | 40/70 | 41/70 | 46.9%–69.4% | +1 | +1.43 pp | 2 | 1 | 1 | 1 |
| `factual` | 203/515 | 209/515 | 36.4%–44.9% | +6 | +1.17 pp | 7 | 1 | 0.07031 | 1 |
| `follow-up` | 0/95 | 0/95 | 0.0%–3.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `refusal` | 0/258 | 0/258 | 0.0%–1.5% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `small-talk` | 4/50 | 4/50 | 3.2%–18.8% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |

</details>

<details>
<summary>#40 feat/small-talk-manners</summary>

| Group | Baseline passed | Candidate passed | Candidate Wilson 95% CI | Delta passes | Delta rate | Newly passing | Newly failing | McNemar p | Holm p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Arabic | 191/600 | 191/600 | 28.2%–35.7% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| English | 56/600 | 61/600 | 8.0%–12.8% | +5 | +0.83 pp | 5 | 0 | 0.0625 | 1 |
| `calculation` | 0/110 | 0/110 | 0.0%–3.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `clarification` | 0/17 | 0/17 | 0.0%–18.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `coding` | 0/85 | 0/85 | 0.0%–4.3% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `comparison` | 40/70 | 40/70 | 45.5%–68.1% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `factual` | 203/515 | 203/515 | 35.3%–43.7% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `follow-up` | 0/95 | 0/95 | 0.0%–3.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `refusal` | 0/258 | 0/258 | 0.0%–1.5% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `small-talk` | 4/50 | 9/50 | 9.8%–30.8% | +5 | +10.00 pp | 5 | 0 | 0.0625 | 1 |

</details>

<details>
<summary>#51 e2e/follow-up-end-to-end</summary>

| Group | Baseline passed | Candidate passed | Candidate Wilson 95% CI | Delta passes | Delta rate | Newly passing | Newly failing | McNemar p | Holm p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Arabic | 191/600 | 191/600 | 28.2%–35.7% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| English | 56/600 | 57/600 | 7.4%–12.1% | +1 | +0.17 pp | 1 | 0 | 1 | 1 |
| `calculation` | 0/110 | 0/110 | 0.0%–3.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `clarification` | 0/17 | 0/17 | 0.0%–18.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `coding` | 0/85 | 0/85 | 0.0%–4.3% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `comparison` | 40/70 | 40/70 | 45.5%–68.1% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `factual` | 203/515 | 204/515 | 35.5%–43.9% | +1 | +0.19 pp | 1 | 0 | 1 | 1 |
| `follow-up` | 0/95 | 0/95 | 0.0%–3.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `refusal` | 0/258 | 0/258 | 0.0%–1.5% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `small-talk` | 4/50 | 4/50 | 3.2%–18.8% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |

</details>

<details>
<summary>#60 e2e/calculation-end-to-end</summary>

| Group | Baseline passed | Candidate passed | Candidate Wilson 95% CI | Delta passes | Delta rate | Newly passing | Newly failing | McNemar p | Holm p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Arabic | 191/600 | 191/600 | 28.2%–35.7% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| English | 56/600 | 56/600 | 7.3%–11.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `calculation` | 0/110 | 0/110 | 0.0%–3.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `clarification` | 0/17 | 0/17 | 0.0%–18.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `coding` | 0/85 | 0/85 | 0.0%–4.3% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `comparison` | 40/70 | 40/70 | 45.5%–68.1% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `factual` | 203/515 | 203/515 | 35.3%–43.7% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `follow-up` | 0/95 | 0/95 | 0.0%–3.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `refusal` | 0/258 | 0/258 | 0.0%–1.5% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `small-talk` | 4/50 | 4/50 | 3.2%–18.8% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |

</details>

<details>
<summary>#59 e2e/clarification-end-to-end</summary>

| Group | Baseline passed | Candidate passed | Candidate Wilson 95% CI | Delta passes | Delta rate | Newly passing | Newly failing | McNemar p | Holm p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Arabic | 191/600 | 191/600 | 28.2%–35.7% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| English | 56/600 | 56/600 | 7.3%–11.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `calculation` | 0/110 | 0/110 | 0.0%–3.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `clarification` | 0/17 | 0/17 | 0.0%–18.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `coding` | 0/85 | 0/85 | 0.0%–4.3% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `comparison` | 40/70 | 40/70 | 45.5%–68.1% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `factual` | 203/515 | 203/515 | 35.3%–43.7% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `follow-up` | 0/95 | 0/95 | 0.0%–3.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `refusal` | 0/258 | 0/258 | 0.0%–1.5% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `small-talk` | 4/50 | 4/50 | 3.2%–18.8% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |

</details>

<details>
<summary>#50 e2e/comparison-end-to-end</summary>

| Group | Baseline passed | Candidate passed | Candidate Wilson 95% CI | Delta passes | Delta rate | Newly passing | Newly failing | McNemar p | Holm p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Arabic | 191/600 | 191/600 | 28.2%–35.7% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| English | 56/600 | 56/600 | 7.3%–11.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `calculation` | 0/110 | 0/110 | 0.0%–3.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `clarification` | 0/17 | 0/17 | 0.0%–18.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `coding` | 0/85 | 0/85 | 0.0%–4.3% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `comparison` | 40/70 | 40/70 | 45.5%–68.1% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `factual` | 203/515 | 203/515 | 35.3%–43.7% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `follow-up` | 0/95 | 0/95 | 0.0%–3.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `refusal` | 0/258 | 0/258 | 0.0%–1.5% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `small-talk` | 4/50 | 4/50 | 3.2%–18.8% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |

</details>

<details>
<summary>#55 e2e/deliberation-no-regressions</summary>

| Group | Baseline passed | Candidate passed | Candidate Wilson 95% CI | Delta passes | Delta rate | Newly passing | Newly failing | McNemar p | Holm p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Arabic | 191/600 | 191/600 | 28.2%–35.7% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| English | 56/600 | 56/600 | 7.3%–11.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `calculation` | 0/110 | 0/110 | 0.0%–3.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `clarification` | 0/17 | 0/17 | 0.0%–18.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `coding` | 0/85 | 0/85 | 0.0%–4.3% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `comparison` | 40/70 | 40/70 | 45.5%–68.1% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `factual` | 203/515 | 203/515 | 35.3%–43.7% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `follow-up` | 0/95 | 0/95 | 0.0%–3.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `refusal` | 0/258 | 0/258 | 0.0%–1.5% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `small-talk` | 4/50 | 4/50 | 3.2%–18.8% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |

</details>

<details>
<summary>#58 e2e/document-file-end-to-end</summary>

| Group | Baseline passed | Candidate passed | Candidate Wilson 95% CI | Delta passes | Delta rate | Newly passing | Newly failing | McNemar p | Holm p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Arabic | 191/600 | 191/600 | 28.2%–35.7% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| English | 56/600 | 56/600 | 7.3%–11.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `calculation` | 0/110 | 0/110 | 0.0%–3.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `clarification` | 0/17 | 0/17 | 0.0%–18.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `coding` | 0/85 | 0/85 | 0.0%–4.3% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `comparison` | 40/70 | 40/70 | 45.5%–68.1% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `factual` | 203/515 | 203/515 | 35.3%–43.7% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `follow-up` | 0/95 | 0/95 | 0.0%–3.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `refusal` | 0/258 | 0/258 | 0.0%–1.5% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `small-talk` | 4/50 | 4/50 | 3.2%–18.8% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |

</details>

<details>
<summary>#53 e2e/memory-end-to-end</summary>

| Group | Baseline passed | Candidate passed | Candidate Wilson 95% CI | Delta passes | Delta rate | Newly passing | Newly failing | McNemar p | Holm p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Arabic | 191/600 | 191/600 | 28.2%–35.7% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| English | 56/600 | 56/600 | 7.3%–11.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `calculation` | 0/110 | 0/110 | 0.0%–3.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `clarification` | 0/17 | 0/17 | 0.0%–18.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `coding` | 0/85 | 0/85 | 0.0%–4.3% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `comparison` | 40/70 | 40/70 | 45.5%–68.1% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `factual` | 203/515 | 203/515 | 35.3%–43.7% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `follow-up` | 0/95 | 0/95 | 0.0%–3.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `refusal` | 0/258 | 0/258 | 0.0%–1.5% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `small-talk` | 4/50 | 4/50 | 3.2%–18.8% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |

</details>

<details>
<summary>#28 feat/conversation-reviewer</summary>

| Group | Baseline passed | Candidate passed | Candidate Wilson 95% CI | Delta passes | Delta rate | Newly passing | Newly failing | McNemar p | Holm p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Arabic | 191/600 | 191/600 | 28.2%–35.7% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| English | 56/600 | 56/600 | 7.3%–11.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `calculation` | 0/110 | 0/110 | 0.0%–3.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `clarification` | 0/17 | 0/17 | 0.0%–18.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `coding` | 0/85 | 0/85 | 0.0%–4.3% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `comparison` | 40/70 | 40/70 | 45.5%–68.1% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `factual` | 203/515 | 203/515 | 35.3%–43.7% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `follow-up` | 0/95 | 0/95 | 0.0%–3.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `refusal` | 0/258 | 0/258 | 0.0%–1.5% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `small-talk` | 4/50 | 4/50 | 3.2%–18.8% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |

</details>

<details>
<summary>#49 feat/explanations-multisource</summary>

| Group | Baseline passed | Candidate passed | Candidate Wilson 95% CI | Delta passes | Delta rate | Newly passing | Newly failing | McNemar p | Holm p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Arabic | 191/600 | 191/600 | 28.2%–35.7% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| English | 56/600 | 56/600 | 7.3%–11.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `calculation` | 0/110 | 0/110 | 0.0%–3.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `clarification` | 0/17 | 0/17 | 0.0%–18.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `coding` | 0/85 | 0/85 | 0.0%–4.3% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `comparison` | 40/70 | 40/70 | 45.5%–68.1% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `factual` | 203/515 | 203/515 | 35.3%–43.7% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `follow-up` | 0/95 | 0/95 | 0.0%–3.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `refusal` | 0/258 | 0/258 | 0.0%–1.5% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `small-talk` | 4/50 | 4/50 | 3.2%–18.8% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |

</details>

<details>
<summary>#52 e2e/multi-step-end-to-end</summary>

| Group | Baseline passed | Candidate passed | Candidate Wilson 95% CI | Delta passes | Delta rate | Newly passing | Newly failing | McNemar p | Holm p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Arabic | 191/600 | 189/600 | 27.9%–35.3% | -2 | -0.33 pp | 0 | 2 | 0.5 | 1 |
| English | 56/600 | 56/600 | 7.3%–11.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `calculation` | 0/110 | 0/110 | 0.0%–3.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `clarification` | 0/17 | 0/17 | 0.0%–18.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `coding` | 0/85 | 0/85 | 0.0%–4.3% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `comparison` | 40/70 | 40/70 | 45.5%–68.1% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `factual` | 203/515 | 201/515 | 34.9%–43.3% | -2 | -0.39 pp | 0 | 2 | 0.5 | 1 |
| `follow-up` | 0/95 | 0/95 | 0.0%–3.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `refusal` | 0/258 | 0/258 | 0.0%–1.5% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `small-talk` | 4/50 | 4/50 | 3.2%–18.8% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |

</details>

<details>
<summary>#54 e2e/factual-end-to-end</summary>

| Group | Baseline passed | Candidate passed | Candidate Wilson 95% CI | Delta passes | Delta rate | Newly passing | Newly failing | McNemar p | Holm p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Arabic | 191/600 | 67/600 | 8.9%–13.9% | -124 | -20.67 pp | 0 | 124 | 9.404e-38 | 1.401e-35 |
| English | 56/600 | 6/600 | 0.5%–2.2% | -50 | -8.33 pp | 0 | 50 | 1.776e-15 | 2.576e-13 |
| `calculation` | 0/110 | 0/110 | 0.0%–3.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `clarification` | 0/17 | 0/17 | 0.0%–18.4% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `coding` | 0/85 | 0/85 | 0.0%–4.3% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `comparison` | 40/70 | 3/70 | 1.5%–11.9% | -37 | -52.86 pp | 0 | 37 | 1.455e-11 | 2.081e-9 |
| `factual` | 203/515 | 66/515 | 10.2%–16.0% | -137 | -26.60 pp | 0 | 137 | 1.148e-41 | 1.722e-39 |
| `follow-up` | 0/95 | 0/95 | 0.0%–3.9% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `refusal` | 0/258 | 0/258 | 0.0%–1.5% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |
| `small-talk` | 4/50 | 4/50 | 3.2%–18.8% | 0 | 0.00 pp | 0 | 0 | 1 | 1 |

</details>

## Unavailable candidates

- `integration/wave-1` was absent from origin when tips were frozen.

## Frozen settings and execution

- Sealed payload SHA-256 `6ab7dac41ba54eccf0a48fd0958eada651e0c0fcb3a1156913bd6b9fdb25abbf`
- Manifest SHA-256 `c7ab3fbe2340053fca18ed892da1f248fc5fb92ffbc76d14cf2d2300aa20daf6`

| Candidate | Origin tip | Scratch merge | Stacked parent | Flags on | Harness adapter |
| --- | --- | --- | --- | --- | --- |
| [#40](https://github.com/ahmadalwakai/Mohassan-AI/pull/40) `feat/small-talk-manners` | `f50520112a23632ec4f6e4a121018077d1c422be` | `f0b4393f729ea03ab7724182855ea881988cb809` | — | `MOHASSAN_SMALL_TALK_MANNERS=1` | — |
| [#28](https://github.com/ahmadalwakai/Mohassan-AI/pull/28) `feat/conversation-reviewer` | `eb5166e0431d0706be8a61dbdcf085ed4df3b3c4` | `4fa83447e401b54c21d1114bf5f20a0528871dfc` | — | `MOHASSAN_CONVERSATION_REVIEW_APPLY=1` | `conversation-reviewer` |
| [#51](https://github.com/ahmadalwakai/Mohassan-AI/pull/51) `e2e/follow-up-end-to-end` | `4f17a0cab6c9aec71780b2794aa6f3d87b3f4e85` | `e032bf044a537628da1d96a6fb0da96b77dbebc7` | [#35](https://github.com/ahmadalwakai/Mohassan-AI/pull/35) | `MOHASSAN_CONVERSATION_SHADOW=decide` | — |
| [#52](https://github.com/ahmadalwakai/Mohassan-AI/pull/52) `e2e/multi-step-end-to-end` | `e150f149223e3ad6570f2d3a72a06fbe22fa5c2e` | `bb85143e42af5b3d03e6c10f53c31a5e913470cd` | [#24](https://github.com/ahmadalwakai/Mohassan-AI/pull/24) | `MOHASSAN_PLAN_COMPILER=on` | — |
| [#53](https://github.com/ahmadalwakai/Mohassan-AI/pull/53) `e2e/memory-end-to-end` | `06f2a00cc96d1e2edf99c5496ccac3a9860d3704` | `e5b9b24f9fd3c966a4cfc42a3ccadadc8c626f36` | [#31](https://github.com/ahmadalwakai/Mohassan-AI/pull/31) | `MOHASSAN_STRUCTURED_MEMORY=1` | `structured-memory` |
| [#49](https://github.com/ahmadalwakai/Mohassan-AI/pull/49) `feat/explanations-multisource` | `70c0ba4588dc472bdbbdc89aaab0681b90fd333e` | `30816cc55336262528cd68638bbd5324e4b5d5e8` | [#33](https://github.com/ahmadalwakai/Mohassan-AI/pull/33) | `MOHASSAN_EXTRACTIVE_WRITING=1` | — |
| [#55](https://github.com/ahmadalwakai/Mohassan-AI/pull/55) `e2e/deliberation-no-regressions` | `4a0a54fbe7429ddcc88a542d71391b67f3cd40b5` | `9fce409e5aa53857d84e365a6edd4539f6607357` | [#37](https://github.com/ahmadalwakai/Mohassan-AI/pull/37) | Defaults | `deliberation` |
| [#58](https://github.com/ahmadalwakai/Mohassan-AI/pull/58) `e2e/document-file-end-to-end` | `bdabd28b2f8f09010f6e26b4ca80296032447000` | `c286cbe043ab56ad0cb0260ebf63f62d2506789c` | — | Defaults | — |
| [#50](https://github.com/ahmadalwakai/Mohassan-AI/pull/50) `e2e/comparison-end-to-end` | `27d09463d6d386c63707f5c68fc68fc319690a7c` | `d284d573ca5051ae5ea332f83fc9fdf066122b08` | [#26](https://github.com/ahmadalwakai/Mohassan-AI/pull/26) | `MOHASSAN_REASONING=1` | — |
| [#54](https://github.com/ahmadalwakai/Mohassan-AI/pull/54) `e2e/factual-end-to-end` | `e245184feaf17a98aff4fff64814db1efac60888` | `d643451300f63eb0c3d4f0b9d71e619468e2d964` | [#25](https://github.com/ahmadalwakai/Mohassan-AI/pull/25) | `MOHASSAN_ANSWER_SELECTION=1` | — |
| [#57](https://github.com/ahmadalwakai/Mohassan-AI/pull/57) `e2e/refusal-generalization` | `f1ea533a3a33302b621b9e416c543941ccabbc53` | `1374bc44c0d73e8567acb5814e938f2576676fde` | [#39](https://github.com/ahmadalwakai/Mohassan-AI/pull/39) | `MOHASSAN_REFUSAL_POLICY=1` | — |
| [#47](https://github.com/ahmadalwakai/Mohassan-AI/pull/47) `feat/scratch-classifiers` | `76b1a9325a5ef4edda84816cc6523aa06026121e` | `8d6be4c66329679eb901e8129690562cb5df183a` | — | `MOHASSAN_SCRATCH_CLASSIFIERS=1` | — |
| [#23](https://github.com/ahmadalwakai/Mohassan-AI/pull/23) `feat/arabic-understanding-core` | `72575f37799c1de1299a48eafd61c6e57d10ca8f` | `219e2ea258e2a323dd13bcda38b341929a41a9a8` | — | `MOHASSAN_ARABIC_UNDERSTANDING=1` | — |
| [#59](https://github.com/ahmadalwakai/Mohassan-AI/pull/59) `e2e/clarification-end-to-end` | `3d1dff31267e489d68aeab5aaeab0cb6e4029f1f` | `8f83117c6bd2c81bee4a7b2e6046c8b6fe085f93` | [#32](https://github.com/ahmadalwakai/Mohassan-AI/pull/32) | `MOHASSAN_CLARIFY_CHOICES=1` | `clarification` |
| [#60](https://github.com/ahmadalwakai/Mohassan-AI/pull/60) `e2e/calculation-end-to-end` | `88865ba46c55ce2e1d3accb63c75a3256e89b69f` | `757cae8176b832063a24932f471ae87b897b5794` | [#26](https://github.com/ahmadalwakai/Mohassan-AI/pull/26) | `MOHASSAN_REASONING=1` | — |

<details>
<summary>Freeze and report commands</summary>

```bash
node --import tsx scripts/agent-capability-bench/measure-by-branch.ts measure --directory /workspace/work/mohassan-v2-by-branch-study --browsers /workspace/work/mohassan-playwright --jobs 4
git ls-remote --heads origin test/capability-bench-v2-human feat/small-talk-manners feat/conversation-reviewer e2e/follow-up-end-to-end e2e/multi-step-end-to-end e2e/memory-end-to-end feat/explanations-multisource e2e/deliberation-no-regressions e2e/document-file-end-to-end e2e/comparison-end-to-end e2e/factual-end-to-end e2e/refusal-generalization feat/scratch-classifiers feat/arabic-understanding-core e2e/clarification-end-to-end e2e/calculation-end-to-end integration/wave-1
git fetch --no-tags origin a130b239d9e6d2b1f6728128019d24bb26e9293f f50520112a23632ec4f6e4a121018077d1c422be eb5166e0431d0706be8a61dbdcf085ed4df3b3c4 4f17a0cab6c9aec71780b2794aa6f3d87b3f4e85 e150f149223e3ad6570f2d3a72a06fbe22fa5c2e 06f2a00cc96d1e2edf99c5496ccac3a9860d3704 70c0ba4588dc472bdbbdc89aaab0681b90fd333e 4a0a54fbe7429ddcc88a542d71391b67f3cd40b5 bdabd28b2f8f09010f6e26b4ca80296032447000 27d09463d6d386c63707f5c68fc68fc319690a7c e245184feaf17a98aff4fff64814db1efac60888 f1ea533a3a33302b621b9e416c543941ccabbc53 76b1a9325a5ef4edda84816cc6523aa06026121e 72575f37799c1de1299a48eafd61c6e57d10ca8f 3d1dff31267e489d68aeab5aaeab0cb6e4029f1f 88865ba46c55ce2e1d3accb63c75a3256e89b69f
git merge-tree --write-tree 74035b9cca7e94a750234abf574cdbad2e692239 f50520112a23632ec4f6e4a121018077d1c422be
env 'GIT_AUTHOR_NAME=Capability benchmark' GIT_AUTHOR_EMAIL=capability-benchmark@example.invalid GIT_AUTHOR_DATE=2026-11-25T03:24:11Z 'GIT_COMMITTER_NAME=Capability benchmark' GIT_COMMITTER_EMAIL=capability-benchmark@example.invalid GIT_COMMITTER_DATE=2026-11-25T03:24:11Z git commit-tree 46fa65275217f44fffd22b7f0c8c166c53e2072a -p 74035b9cca7e94a750234abf574cdbad2e692239 -p f50520112a23632ec4f6e4a121018077d1c422be -m 'Scratch capability v2: feat/small-talk-manners'
git merge-tree --write-tree 74035b9cca7e94a750234abf574cdbad2e692239 eb5166e0431d0706be8a61dbdcf085ed4df3b3c4
env 'GIT_AUTHOR_NAME=Capability benchmark' GIT_AUTHOR_EMAIL=capability-benchmark@example.invalid GIT_AUTHOR_DATE=2026-11-25T03:24:11Z 'GIT_COMMITTER_NAME=Capability benchmark' GIT_COMMITTER_EMAIL=capability-benchmark@example.invalid GIT_COMMITTER_DATE=2026-11-25T03:24:11Z git commit-tree bd439aef67976d4ebf2febcac857fb0967cf296f -p 74035b9cca7e94a750234abf574cdbad2e692239 -p eb5166e0431d0706be8a61dbdcf085ed4df3b3c4 -m 'Scratch capability v2: feat/conversation-reviewer'
git merge-tree --write-tree 74035b9cca7e94a750234abf574cdbad2e692239 4f17a0cab6c9aec71780b2794aa6f3d87b3f4e85
env 'GIT_AUTHOR_NAME=Capability benchmark' GIT_AUTHOR_EMAIL=capability-benchmark@example.invalid GIT_AUTHOR_DATE=2026-11-25T03:24:11Z 'GIT_COMMITTER_NAME=Capability benchmark' GIT_COMMITTER_EMAIL=capability-benchmark@example.invalid GIT_COMMITTER_DATE=2026-11-25T03:24:11Z git commit-tree 0b1e0e9e97cc5f93b8835ee7f4405a85cda77a07 -p 74035b9cca7e94a750234abf574cdbad2e692239 -p 4f17a0cab6c9aec71780b2794aa6f3d87b3f4e85 -m 'Scratch capability v2: e2e/follow-up-end-to-end'
git merge-tree --write-tree 74035b9cca7e94a750234abf574cdbad2e692239 e150f149223e3ad6570f2d3a72a06fbe22fa5c2e
env 'GIT_AUTHOR_NAME=Capability benchmark' GIT_AUTHOR_EMAIL=capability-benchmark@example.invalid GIT_AUTHOR_DATE=2026-11-25T03:24:11Z 'GIT_COMMITTER_NAME=Capability benchmark' GIT_COMMITTER_EMAIL=capability-benchmark@example.invalid GIT_COMMITTER_DATE=2026-11-25T03:24:11Z git commit-tree b6e87195f3235fc2679a44fd754f9ee971b2b45b -p 74035b9cca7e94a750234abf574cdbad2e692239 -p e150f149223e3ad6570f2d3a72a06fbe22fa5c2e -m 'Scratch capability v2: e2e/multi-step-end-to-end'
git merge-tree --write-tree 74035b9cca7e94a750234abf574cdbad2e692239 06f2a00cc96d1e2edf99c5496ccac3a9860d3704
env 'GIT_AUTHOR_NAME=Capability benchmark' GIT_AUTHOR_EMAIL=capability-benchmark@example.invalid GIT_AUTHOR_DATE=2026-11-25T03:24:11Z 'GIT_COMMITTER_NAME=Capability benchmark' GIT_COMMITTER_EMAIL=capability-benchmark@example.invalid GIT_COMMITTER_DATE=2026-11-25T03:24:11Z git commit-tree b4a4531e517ef07bda415702b3665bd65d65afc4 -p 74035b9cca7e94a750234abf574cdbad2e692239 -p 06f2a00cc96d1e2edf99c5496ccac3a9860d3704 -m 'Scratch capability v2: e2e/memory-end-to-end'
git merge-tree --write-tree 74035b9cca7e94a750234abf574cdbad2e692239 70c0ba4588dc472bdbbdc89aaab0681b90fd333e
env 'GIT_AUTHOR_NAME=Capability benchmark' GIT_AUTHOR_EMAIL=capability-benchmark@example.invalid GIT_AUTHOR_DATE=2026-11-25T03:24:11Z 'GIT_COMMITTER_NAME=Capability benchmark' GIT_COMMITTER_EMAIL=capability-benchmark@example.invalid GIT_COMMITTER_DATE=2026-11-25T03:24:11Z git commit-tree 9782245e016387949552e95f00007e139c4a3081 -p 74035b9cca7e94a750234abf574cdbad2e692239 -p 70c0ba4588dc472bdbbdc89aaab0681b90fd333e -m 'Scratch capability v2: feat/explanations-multisource'
git merge-tree --write-tree 74035b9cca7e94a750234abf574cdbad2e692239 4a0a54fbe7429ddcc88a542d71391b67f3cd40b5
env 'GIT_AUTHOR_NAME=Capability benchmark' GIT_AUTHOR_EMAIL=capability-benchmark@example.invalid GIT_AUTHOR_DATE=2026-11-25T03:24:11Z 'GIT_COMMITTER_NAME=Capability benchmark' GIT_COMMITTER_EMAIL=capability-benchmark@example.invalid GIT_COMMITTER_DATE=2026-11-25T03:24:11Z git commit-tree 37601b04597cdb9203cc244523574012e785c6f7 -p 74035b9cca7e94a750234abf574cdbad2e692239 -p 4a0a54fbe7429ddcc88a542d71391b67f3cd40b5 -m 'Scratch capability v2: e2e/deliberation-no-regressions'
git merge-tree --write-tree 74035b9cca7e94a750234abf574cdbad2e692239 bdabd28b2f8f09010f6e26b4ca80296032447000
env 'GIT_AUTHOR_NAME=Capability benchmark' GIT_AUTHOR_EMAIL=capability-benchmark@example.invalid GIT_AUTHOR_DATE=2026-11-25T03:24:11Z 'GIT_COMMITTER_NAME=Capability benchmark' GIT_COMMITTER_EMAIL=capability-benchmark@example.invalid GIT_COMMITTER_DATE=2026-11-25T03:24:11Z git commit-tree d21fe90789a20f84c746d3810b501c3f6c722934 -p 74035b9cca7e94a750234abf574cdbad2e692239 -p bdabd28b2f8f09010f6e26b4ca80296032447000 -m 'Scratch capability v2: e2e/document-file-end-to-end'
git merge-tree --write-tree 74035b9cca7e94a750234abf574cdbad2e692239 27d09463d6d386c63707f5c68fc68fc319690a7c
env 'GIT_AUTHOR_NAME=Capability benchmark' GIT_AUTHOR_EMAIL=capability-benchmark@example.invalid GIT_AUTHOR_DATE=2026-11-25T03:24:11Z 'GIT_COMMITTER_NAME=Capability benchmark' GIT_COMMITTER_EMAIL=capability-benchmark@example.invalid GIT_COMMITTER_DATE=2026-11-25T03:24:11Z git commit-tree 9287a7248ec54d256c30756ce4613133dae1173a -p 74035b9cca7e94a750234abf574cdbad2e692239 -p 27d09463d6d386c63707f5c68fc68fc319690a7c -m 'Scratch capability v2: e2e/comparison-end-to-end'
git merge-tree --write-tree 74035b9cca7e94a750234abf574cdbad2e692239 e245184feaf17a98aff4fff64814db1efac60888
env 'GIT_AUTHOR_NAME=Capability benchmark' GIT_AUTHOR_EMAIL=capability-benchmark@example.invalid GIT_AUTHOR_DATE=2026-11-25T03:24:11Z 'GIT_COMMITTER_NAME=Capability benchmark' GIT_COMMITTER_EMAIL=capability-benchmark@example.invalid GIT_COMMITTER_DATE=2026-11-25T03:24:11Z git commit-tree 5844509ca63fb4c4468e9e23a389d56130f65350 -p 74035b9cca7e94a750234abf574cdbad2e692239 -p e245184feaf17a98aff4fff64814db1efac60888 -m 'Scratch capability v2: e2e/factual-end-to-end'
git merge-tree --write-tree 74035b9cca7e94a750234abf574cdbad2e692239 f1ea533a3a33302b621b9e416c543941ccabbc53
env 'GIT_AUTHOR_NAME=Capability benchmark' GIT_AUTHOR_EMAIL=capability-benchmark@example.invalid GIT_AUTHOR_DATE=2026-11-25T03:24:11Z 'GIT_COMMITTER_NAME=Capability benchmark' GIT_COMMITTER_EMAIL=capability-benchmark@example.invalid GIT_COMMITTER_DATE=2026-11-25T03:24:11Z git commit-tree 15f3f0a29cd3a9281482b723835da8811c1f02a7 -p 74035b9cca7e94a750234abf574cdbad2e692239 -p f1ea533a3a33302b621b9e416c543941ccabbc53 -m 'Scratch capability v2: e2e/refusal-generalization'
git merge-tree --write-tree 74035b9cca7e94a750234abf574cdbad2e692239 76b1a9325a5ef4edda84816cc6523aa06026121e
env 'GIT_AUTHOR_NAME=Capability benchmark' GIT_AUTHOR_EMAIL=capability-benchmark@example.invalid GIT_AUTHOR_DATE=2026-11-25T03:24:11Z 'GIT_COMMITTER_NAME=Capability benchmark' GIT_COMMITTER_EMAIL=capability-benchmark@example.invalid GIT_COMMITTER_DATE=2026-11-25T03:24:11Z git commit-tree 2a60c7f37a7aefa158456ef7e95a962e2a61884e -p 74035b9cca7e94a750234abf574cdbad2e692239 -p 76b1a9325a5ef4edda84816cc6523aa06026121e -m 'Scratch capability v2: feat/scratch-classifiers'
git merge-tree --write-tree 74035b9cca7e94a750234abf574cdbad2e692239 72575f37799c1de1299a48eafd61c6e57d10ca8f
env 'GIT_AUTHOR_NAME=Capability benchmark' GIT_AUTHOR_EMAIL=capability-benchmark@example.invalid GIT_AUTHOR_DATE=2026-11-25T03:24:11Z 'GIT_COMMITTER_NAME=Capability benchmark' GIT_COMMITTER_EMAIL=capability-benchmark@example.invalid GIT_COMMITTER_DATE=2026-11-25T03:24:11Z git commit-tree 47ea14c1de6cbd516ce516f37950b35bc13acc51 -p 74035b9cca7e94a750234abf574cdbad2e692239 -p 72575f37799c1de1299a48eafd61c6e57d10ca8f -m 'Scratch capability v2: feat/arabic-understanding-core'
git merge-tree --write-tree 74035b9cca7e94a750234abf574cdbad2e692239 3d1dff31267e489d68aeab5aaeab0cb6e4029f1f
env 'GIT_AUTHOR_NAME=Capability benchmark' GIT_AUTHOR_EMAIL=capability-benchmark@example.invalid GIT_AUTHOR_DATE=2026-11-25T03:24:11Z 'GIT_COMMITTER_NAME=Capability benchmark' GIT_COMMITTER_EMAIL=capability-benchmark@example.invalid GIT_COMMITTER_DATE=2026-11-25T03:24:11Z git commit-tree c97a335549e6f14291cd8186b5764e2b51d14c3b -p 74035b9cca7e94a750234abf574cdbad2e692239 -p 3d1dff31267e489d68aeab5aaeab0cb6e4029f1f -m 'Scratch capability v2: e2e/clarification-end-to-end'
git merge-tree --write-tree 74035b9cca7e94a750234abf574cdbad2e692239 88865ba46c55ce2e1d3accb63c75a3256e89b69f
env 'GIT_AUTHOR_NAME=Capability benchmark' GIT_AUTHOR_EMAIL=capability-benchmark@example.invalid GIT_AUTHOR_DATE=2026-11-25T03:24:11Z 'GIT_COMMITTER_NAME=Capability benchmark' GIT_COMMITTER_EMAIL=capability-benchmark@example.invalid GIT_COMMITTER_DATE=2026-11-25T03:24:11Z git commit-tree d3bd5affc84c9fde58be0f8017d81d6bb957edab -p 74035b9cca7e94a750234abf574cdbad2e692239 -p 88865ba46c55ce2e1d3accb63c75a3256e89b69f -m 'Scratch capability v2: e2e/calculation-end-to-end'
node --import tsx scripts/agent-capability-bench/measure-by-branch.ts report --directory /workspace/work/mohassan-v2-by-branch-study --output docs/CAPABILITY-V2-BY-BRANCH-2026-11-25.md --checks /workspace/work/mohassan-v2-by-branch-study/checks.json
```

</details>

<details>
<summary>Baseline replay</summary>

Evaluation HEAD `c2a0ff765071657cf200b5ee7d12fabaad738c0b`. linux x64, Node.js `v24.22.3`, timezone `Europe/London`. Started `2026-11-25T03:25:02.399Z` and finished `2026-11-25T03:31:05.967Z`.

- Lockfile SHA-256 `be0681e77c59af142f13a81cf84a835322b654238e7a030739d2907cda325738`
- Receipt SHA-256 `1d16d3274c40d452d597ae988ed30b20845d14e492f82117cfab4ef768851318`
- `collect-paired-outcomes.ts` SHA-256 `5e3c96492703f5529972ffe61390fd7e1ad67868806d8f745c13fe228bc3d1bd`
- `corpus.ts` SHA-256 `39a2ad493bb86a84e1801ea7a97a99de55d3f0ab4f14fd7275944fe8e3779204`
- `observe.ts` SHA-256 `d7fc412372917c89f0fdcd100133dc4fa5b667f3969244badcefaae980e9bdff`
- `score.ts` SHA-256 `f4bfa46fd5eda8e8c8cf08f19382652567439c49512caffd6caf0a5d32b5abdf`
- `v2/manifest.json` SHA-256 `c7ab3fbe2340053fca18ed892da1f248fc5fb92ffbc76d14cf2d2300aa20daf6`
- `v2/mapping.ts` SHA-256 `5e78c21948fbc1d3072053ef44fce6b57930757428e9747578918421bd2af883`
- `v2/sealed.ts` SHA-256 `8323800cca8f31856e6e7ddde060e45004fa0196b6af54c465cb389e8b37ea94`

```bash
git worktree add --detach /workspace/work/mohassan-v2-by-branch-study/worktrees/baseline c2a0ff765071657cf200b5ee7d12fabaad738c0b
git archive a130b239d9e6d2b1f6728128019d24bb26e9293f scripts/agent-capability-bench | tar -x -C /workspace/work/mohassan-v2-by-branch-study/worktrees/baseline
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/baseline && npm ci --no-audit --no-fund --prefer-offline --cache /workspace/work/mohassan-v2-by-branch-study/npm-cache)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/baseline && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --preflight true --output /workspace/work/mohassan-v2-by-branch-study/receipts/baseline.preflight.json)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/baseline && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --sealed /workspace/work/Mohassan-AI/tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output /workspace/work/mohassan-v2-by-branch-study/receipts/baseline.paired.json --baseline true)
```

</details>

<details>
<summary>feat/small-talk-manners</summary>

Evaluation HEAD `f0b4393f729ea03ab7724182855ea881988cb809`. linux x64, Node.js `v24.22.3`, timezone `Europe/London`. Started `2026-11-25T03:25:00.656Z` and finished `2026-11-25T03:31:04.949Z`.

- Lockfile SHA-256 `be0681e77c59af142f13a81cf84a835322b654238e7a030739d2907cda325738`
- Receipt SHA-256 `eceefe5bb2a14ffc83dcc404b7c3ed3a1970ce76d86b0acad53dff8e88960d8f`
- `collect-paired-outcomes.ts` SHA-256 `5e3c96492703f5529972ffe61390fd7e1ad67868806d8f745c13fe228bc3d1bd`
- `corpus.ts` SHA-256 `39a2ad493bb86a84e1801ea7a97a99de55d3f0ab4f14fd7275944fe8e3779204`
- `observe.ts` SHA-256 `d7fc412372917c89f0fdcd100133dc4fa5b667f3969244badcefaae980e9bdff`
- `score.ts` SHA-256 `f4bfa46fd5eda8e8c8cf08f19382652567439c49512caffd6caf0a5d32b5abdf`
- `v2/manifest.json` SHA-256 `c7ab3fbe2340053fca18ed892da1f248fc5fb92ffbc76d14cf2d2300aa20daf6`
- `v2/mapping.ts` SHA-256 `5e78c21948fbc1d3072053ef44fce6b57930757428e9747578918421bd2af883`
- `v2/sealed.ts` SHA-256 `8323800cca8f31856e6e7ddde060e45004fa0196b6af54c465cb389e8b37ea94`

```bash
git worktree add --detach /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-40 f0b4393f729ea03ab7724182855ea881988cb809
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-40 && npm ci --no-audit --no-fund --prefer-offline --cache /workspace/work/mohassan-v2-by-branch-study/npm-cache)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-40 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_SMALL_TALK_MANNERS=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --preflight true --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-40.preflight.json)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-40 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_SMALL_TALK_MANNERS=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --sealed /workspace/work/Mohassan-AI/tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-40.paired.json)
```

</details>

<details>
<summary>feat/conversation-reviewer</summary>

Evaluation HEAD `4fa83447e401b54c21d1114bf5f20a0528871dfc`. linux x64, Node.js `v24.22.3`, timezone `Europe/London`. Started `2026-11-25T03:25:00.865Z` and finished `2026-11-25T03:31:08.501Z`.

- Lockfile SHA-256 `be0681e77c59af142f13a81cf84a835322b654238e7a030739d2907cda325738`
- Receipt SHA-256 `9a05a90698acf87842ca777759af2e9a98677daae92a487f999bbee1756005b0`
- `by-branch-observe.ts` SHA-256 `0374cc3d21651a10638ef97e7fe1075bc6b0855670ac2706cedfbb5d2a36d715`
- `collect-paired-outcomes.ts` SHA-256 `5e3c96492703f5529972ffe61390fd7e1ad67868806d8f745c13fe228bc3d1bd`
- `corpus.ts` SHA-256 `39a2ad493bb86a84e1801ea7a97a99de55d3f0ab4f14fd7275944fe8e3779204`
- `score.ts` SHA-256 `f4bfa46fd5eda8e8c8cf08f19382652567439c49512caffd6caf0a5d32b5abdf`
- `v2/manifest.json` SHA-256 `c7ab3fbe2340053fca18ed892da1f248fc5fb92ffbc76d14cf2d2300aa20daf6`
- `v2/mapping.ts` SHA-256 `5e78c21948fbc1d3072053ef44fce6b57930757428e9747578918421bd2af883`
- `v2/sealed.ts` SHA-256 `8323800cca8f31856e6e7ddde060e45004fa0196b6af54c465cb389e8b37ea94`

```bash
git worktree add --detach /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-28 4fa83447e401b54c21d1114bf5f20a0528871dfc
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-28 && npm ci --no-audit --no-fund --prefer-offline --cache /workspace/work/mohassan-v2-by-branch-study/npm-cache)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-28 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_CONVERSATION_REVIEW_APPLY=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --preflight true --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-28.preflight.json --adapted-observer true)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-28 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_CONVERSATION_REVIEW_APPLY=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --sealed /workspace/work/Mohassan-AI/tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-28.paired.json --adapted-observer true)
```

</details>

<details>
<summary>e2e/follow-up-end-to-end</summary>

Evaluation HEAD `e032bf044a537628da1d96a6fb0da96b77dbebc7`. linux x64, Node.js `v24.22.3`, timezone `Europe/London`. Started `2026-11-25T03:25:00.556Z` and finished `2026-11-25T03:31:11.125Z`.

- Lockfile SHA-256 `be0681e77c59af142f13a81cf84a835322b654238e7a030739d2907cda325738`
- Receipt SHA-256 `a0ec18d0b0a9b577b4d6c60753658b8e8299192373c1a04b35b8a4e657ce354c`
- `collect-paired-outcomes.ts` SHA-256 `5e3c96492703f5529972ffe61390fd7e1ad67868806d8f745c13fe228bc3d1bd`
- `corpus.ts` SHA-256 `39a2ad493bb86a84e1801ea7a97a99de55d3f0ab4f14fd7275944fe8e3779204`
- `observe.ts` SHA-256 `d7fc412372917c89f0fdcd100133dc4fa5b667f3969244badcefaae980e9bdff`
- `score.ts` SHA-256 `f4bfa46fd5eda8e8c8cf08f19382652567439c49512caffd6caf0a5d32b5abdf`
- `v2/manifest.json` SHA-256 `c7ab3fbe2340053fca18ed892da1f248fc5fb92ffbc76d14cf2d2300aa20daf6`
- `v2/mapping.ts` SHA-256 `5e78c21948fbc1d3072053ef44fce6b57930757428e9747578918421bd2af883`
- `v2/sealed.ts` SHA-256 `8323800cca8f31856e6e7ddde060e45004fa0196b6af54c465cb389e8b37ea94`

```bash
git worktree add --detach /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-51 e032bf044a537628da1d96a6fb0da96b77dbebc7
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-51 && npm ci --no-audit --no-fund --prefer-offline --cache /workspace/work/mohassan-v2-by-branch-study/npm-cache)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-51 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_CONVERSATION_SHADOW=decide node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --preflight true --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-51.preflight.json)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-51 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_CONVERSATION_SHADOW=decide node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --sealed /workspace/work/Mohassan-AI/tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-51.paired.json)
```

</details>

<details>
<summary>e2e/multi-step-end-to-end</summary>

Evaluation HEAD `bb85143e42af5b3d03e6c10f53c31a5e913470cd`. linux x64, Node.js `v24.22.3`, timezone `Europe/London`. Started `2026-11-25T03:31:39.405Z` and finished `2026-11-25T03:37:39.715Z`.

- Lockfile SHA-256 `be0681e77c59af142f13a81cf84a835322b654238e7a030739d2907cda325738`
- Receipt SHA-256 `c01dd74716f81b6c7a5a8ae20e79cbaf96ff06488687acf0948d3768046d501c`
- `collect-paired-outcomes.ts` SHA-256 `5e3c96492703f5529972ffe61390fd7e1ad67868806d8f745c13fe228bc3d1bd`
- `corpus.ts` SHA-256 `39a2ad493bb86a84e1801ea7a97a99de55d3f0ab4f14fd7275944fe8e3779204`
- `observe.ts` SHA-256 `d7fc412372917c89f0fdcd100133dc4fa5b667f3969244badcefaae980e9bdff`
- `score.ts` SHA-256 `f4bfa46fd5eda8e8c8cf08f19382652567439c49512caffd6caf0a5d32b5abdf`
- `v2/manifest.json` SHA-256 `c7ab3fbe2340053fca18ed892da1f248fc5fb92ffbc76d14cf2d2300aa20daf6`
- `v2/mapping.ts` SHA-256 `5e78c21948fbc1d3072053ef44fce6b57930757428e9747578918421bd2af883`
- `v2/sealed.ts` SHA-256 `8323800cca8f31856e6e7ddde060e45004fa0196b6af54c465cb389e8b37ea94`

```bash
git worktree add --detach /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-52 bb85143e42af5b3d03e6c10f53c31a5e913470cd
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-52 && npm ci --no-audit --no-fund --prefer-offline --cache /workspace/work/mohassan-v2-by-branch-study/npm-cache)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-52 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_PLAN_COMPILER=on node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --preflight true --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-52.preflight.json)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-52 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_PLAN_COMPILER=on node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --sealed /workspace/work/Mohassan-AI/tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-52.paired.json)
```

</details>

<details>
<summary>e2e/memory-end-to-end</summary>

Evaluation HEAD `e5b9b24f9fd3c966a4cfc42a3ccadadc8c626f36`. linux x64, Node.js `v24.22.3`, timezone `Europe/London`. Started `2026-11-25T03:31:42.387Z` and finished `2026-11-25T03:37:36.810Z`.

- Lockfile SHA-256 `be0681e77c59af142f13a81cf84a835322b654238e7a030739d2907cda325738`
- Receipt SHA-256 `614c5c2760239551c5e503310e6c6c180a9fb67fc56d9151f337344bb921b2f9`
- `by-branch-observe.ts` SHA-256 `c48bf757fc843c796936fd58f851b354424b04d1731ecaddbb5aa108a66b875e`
- `collect-paired-outcomes.ts` SHA-256 `5e3c96492703f5529972ffe61390fd7e1ad67868806d8f745c13fe228bc3d1bd`
- `corpus.ts` SHA-256 `39a2ad493bb86a84e1801ea7a97a99de55d3f0ab4f14fd7275944fe8e3779204`
- `score.ts` SHA-256 `f4bfa46fd5eda8e8c8cf08f19382652567439c49512caffd6caf0a5d32b5abdf`
- `v2/manifest.json` SHA-256 `c7ab3fbe2340053fca18ed892da1f248fc5fb92ffbc76d14cf2d2300aa20daf6`
- `v2/mapping.ts` SHA-256 `5e78c21948fbc1d3072053ef44fce6b57930757428e9747578918421bd2af883`
- `v2/sealed.ts` SHA-256 `8323800cca8f31856e6e7ddde060e45004fa0196b6af54c465cb389e8b37ea94`

```bash
git worktree add --detach /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-53 e5b9b24f9fd3c966a4cfc42a3ccadadc8c626f36
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-53 && npm ci --no-audit --no-fund --prefer-offline --cache /workspace/work/mohassan-v2-by-branch-study/npm-cache)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-53 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_STRUCTURED_MEMORY=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --preflight true --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-53.preflight.json --adapted-observer true)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-53 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_STRUCTURED_MEMORY=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --sealed /workspace/work/Mohassan-AI/tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-53.paired.json --adapted-observer true)
```

</details>

<details>
<summary>feat/explanations-multisource</summary>

Evaluation HEAD `30816cc55336262528cd68638bbd5324e4b5d5e8`. linux x64, Node.js `v24.22.3`, timezone `Europe/London`. Started `2026-11-25T03:31:47.825Z` and finished `2026-11-25T03:37:38.708Z`.

- Lockfile SHA-256 `be0681e77c59af142f13a81cf84a835322b654238e7a030739d2907cda325738`
- Receipt SHA-256 `74b13f2465f6384a5dbf9f7fb2c79e06603c76e6cad73b9489dd84c63b8c612a`
- `collect-paired-outcomes.ts` SHA-256 `5e3c96492703f5529972ffe61390fd7e1ad67868806d8f745c13fe228bc3d1bd`
- `corpus.ts` SHA-256 `39a2ad493bb86a84e1801ea7a97a99de55d3f0ab4f14fd7275944fe8e3779204`
- `observe.ts` SHA-256 `d7fc412372917c89f0fdcd100133dc4fa5b667f3969244badcefaae980e9bdff`
- `score.ts` SHA-256 `f4bfa46fd5eda8e8c8cf08f19382652567439c49512caffd6caf0a5d32b5abdf`
- `v2/manifest.json` SHA-256 `c7ab3fbe2340053fca18ed892da1f248fc5fb92ffbc76d14cf2d2300aa20daf6`
- `v2/mapping.ts` SHA-256 `5e78c21948fbc1d3072053ef44fce6b57930757428e9747578918421bd2af883`
- `v2/sealed.ts` SHA-256 `8323800cca8f31856e6e7ddde060e45004fa0196b6af54c465cb389e8b37ea94`

```bash
git worktree add --detach /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-49 30816cc55336262528cd68638bbd5324e4b5d5e8
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-49 && npm ci --no-audit --no-fund --prefer-offline --cache /workspace/work/mohassan-v2-by-branch-study/npm-cache)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-49 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_EXTRACTIVE_WRITING=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --preflight true --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-49.preflight.json)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-49 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_EXTRACTIVE_WRITING=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --sealed /workspace/work/Mohassan-AI/tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-49.paired.json)
```

</details>

<details>
<summary>e2e/deliberation-no-regressions</summary>

Evaluation HEAD `9fce409e5aa53857d84e365a6edd4539f6607357`. linux x64, Node.js `v24.22.3`, timezone `Europe/London`. Started `2026-11-25T03:31:47.758Z` and finished `2026-11-25T03:37:50.558Z`.

- Lockfile SHA-256 `be0681e77c59af142f13a81cf84a835322b654238e7a030739d2907cda325738`
- Receipt SHA-256 `3c915bbf5b1249c8faad30a1c4d192709ffa8b4cfcb763a30618236f856010e1`
- `by-branch-observe.ts` SHA-256 `d05ef6d80e6d1216f7030b0a00e21980bfa6d628d4d4a4038f0c231501307bbf`
- `collect-paired-outcomes.ts` SHA-256 `5e3c96492703f5529972ffe61390fd7e1ad67868806d8f745c13fe228bc3d1bd`
- `corpus.ts` SHA-256 `39a2ad493bb86a84e1801ea7a97a99de55d3f0ab4f14fd7275944fe8e3779204`
- `score.ts` SHA-256 `f4bfa46fd5eda8e8c8cf08f19382652567439c49512caffd6caf0a5d32b5abdf`
- `v2/manifest.json` SHA-256 `c7ab3fbe2340053fca18ed892da1f248fc5fb92ffbc76d14cf2d2300aa20daf6`
- `v2/mapping.ts` SHA-256 `5e78c21948fbc1d3072053ef44fce6b57930757428e9747578918421bd2af883`
- `v2/sealed.ts` SHA-256 `8323800cca8f31856e6e7ddde060e45004fa0196b6af54c465cb389e8b37ea94`

```bash
git worktree add --detach /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-55 9fce409e5aa53857d84e365a6edd4539f6607357
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-55 && npm ci --no-audit --no-fund --prefer-offline --cache /workspace/work/mohassan-v2-by-branch-study/npm-cache)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-55 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --preflight true --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-55.preflight.json --adapted-observer true)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-55 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --sealed /workspace/work/Mohassan-AI/tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-55.paired.json --adapted-observer true)
```

</details>

<details>
<summary>e2e/document-file-end-to-end</summary>

Evaluation HEAD `c286cbe043ab56ad0cb0260ebf63f62d2506789c`. linux x64, Node.js `v24.22.3`, timezone `Europe/London`. Started `2026-11-25T03:38:11.701Z` and finished `2026-11-25T03:44:08.981Z`.

- Lockfile SHA-256 `be0681e77c59af142f13a81cf84a835322b654238e7a030739d2907cda325738`
- Receipt SHA-256 `ca54d8476e1d6ada899f9c53f3882e011c0100743d590451fc7abbcbbb743c6f`
- `collect-paired-outcomes.ts` SHA-256 `5e3c96492703f5529972ffe61390fd7e1ad67868806d8f745c13fe228bc3d1bd`
- `corpus.ts` SHA-256 `39a2ad493bb86a84e1801ea7a97a99de55d3f0ab4f14fd7275944fe8e3779204`
- `observe.ts` SHA-256 `d7fc412372917c89f0fdcd100133dc4fa5b667f3969244badcefaae980e9bdff`
- `score.ts` SHA-256 `f4bfa46fd5eda8e8c8cf08f19382652567439c49512caffd6caf0a5d32b5abdf`
- `v2/manifest.json` SHA-256 `c7ab3fbe2340053fca18ed892da1f248fc5fb92ffbc76d14cf2d2300aa20daf6`
- `v2/mapping.ts` SHA-256 `5e78c21948fbc1d3072053ef44fce6b57930757428e9747578918421bd2af883`
- `v2/sealed.ts` SHA-256 `8323800cca8f31856e6e7ddde060e45004fa0196b6af54c465cb389e8b37ea94`

```bash
git worktree add --detach /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-58 c286cbe043ab56ad0cb0260ebf63f62d2506789c
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-58 && npm ci --no-audit --no-fund --prefer-offline --cache /workspace/work/mohassan-v2-by-branch-study/npm-cache)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-58 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --preflight true --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-58.preflight.json)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-58 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --sealed /workspace/work/Mohassan-AI/tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-58.paired.json)
```

</details>

<details>
<summary>e2e/comparison-end-to-end</summary>

Evaluation HEAD `d284d573ca5051ae5ea332f83fc9fdf066122b08`. linux x64, Node.js `v24.22.3`, timezone `Europe/London`. Started `2026-11-25T03:38:18.369Z` and finished `2026-11-25T03:44:15.827Z`.

- Lockfile SHA-256 `be0681e77c59af142f13a81cf84a835322b654238e7a030739d2907cda325738`
- Receipt SHA-256 `5ffc380d55f6eb8ccc3810dd72b6d3f153b8657d92937b04444c30bc2f5c4627`
- `collect-paired-outcomes.ts` SHA-256 `5e3c96492703f5529972ffe61390fd7e1ad67868806d8f745c13fe228bc3d1bd`
- `corpus.ts` SHA-256 `39a2ad493bb86a84e1801ea7a97a99de55d3f0ab4f14fd7275944fe8e3779204`
- `observe.ts` SHA-256 `d7fc412372917c89f0fdcd100133dc4fa5b667f3969244badcefaae980e9bdff`
- `score.ts` SHA-256 `f4bfa46fd5eda8e8c8cf08f19382652567439c49512caffd6caf0a5d32b5abdf`
- `v2/manifest.json` SHA-256 `c7ab3fbe2340053fca18ed892da1f248fc5fb92ffbc76d14cf2d2300aa20daf6`
- `v2/mapping.ts` SHA-256 `5e78c21948fbc1d3072053ef44fce6b57930757428e9747578918421bd2af883`
- `v2/sealed.ts` SHA-256 `8323800cca8f31856e6e7ddde060e45004fa0196b6af54c465cb389e8b37ea94`

```bash
git worktree add --detach /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-50 d284d573ca5051ae5ea332f83fc9fdf066122b08
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-50 && npm ci --no-audit --no-fund --prefer-offline --cache /workspace/work/mohassan-v2-by-branch-study/npm-cache)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-50 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_REASONING=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --preflight true --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-50.preflight.json)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-50 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_REASONING=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --sealed /workspace/work/Mohassan-AI/tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-50.paired.json)
```

</details>

<details>
<summary>e2e/factual-end-to-end</summary>

Evaluation HEAD `d643451300f63eb0c3d4f0b9d71e619468e2d964`. linux x64, Node.js `v24.22.3`, timezone `Europe/London`. Started `2026-11-25T03:38:18.445Z` and finished `2026-11-25T03:44:13.408Z`.

- Lockfile SHA-256 `be0681e77c59af142f13a81cf84a835322b654238e7a030739d2907cda325738`
- Receipt SHA-256 `08547cbdaab2a258bdcd9652e26dd21cebcfd843bf72ae899d61f7b4a56200a8`
- `collect-paired-outcomes.ts` SHA-256 `5e3c96492703f5529972ffe61390fd7e1ad67868806d8f745c13fe228bc3d1bd`
- `corpus.ts` SHA-256 `39a2ad493bb86a84e1801ea7a97a99de55d3f0ab4f14fd7275944fe8e3779204`
- `observe.ts` SHA-256 `d7fc412372917c89f0fdcd100133dc4fa5b667f3969244badcefaae980e9bdff`
- `score.ts` SHA-256 `f4bfa46fd5eda8e8c8cf08f19382652567439c49512caffd6caf0a5d32b5abdf`
- `v2/manifest.json` SHA-256 `c7ab3fbe2340053fca18ed892da1f248fc5fb92ffbc76d14cf2d2300aa20daf6`
- `v2/mapping.ts` SHA-256 `5e78c21948fbc1d3072053ef44fce6b57930757428e9747578918421bd2af883`
- `v2/sealed.ts` SHA-256 `8323800cca8f31856e6e7ddde060e45004fa0196b6af54c465cb389e8b37ea94`

```bash
git worktree add --detach /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-54 d643451300f63eb0c3d4f0b9d71e619468e2d964
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-54 && npm ci --no-audit --no-fund --prefer-offline --cache /workspace/work/mohassan-v2-by-branch-study/npm-cache)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-54 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_ANSWER_SELECTION=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --preflight true --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-54.preflight.json)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-54 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_ANSWER_SELECTION=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --sealed /workspace/work/Mohassan-AI/tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-54.paired.json)
```

</details>

<details>
<summary>e2e/refusal-generalization</summary>

Evaluation HEAD `1374bc44c0d73e8567acb5814e938f2576676fde`. linux x64, Node.js `v24.22.3`, timezone `Europe/London`. Started `2026-11-25T03:38:25.935Z` and finished `2026-11-25T03:44:14.023Z`.

- Lockfile SHA-256 `be0681e77c59af142f13a81cf84a835322b654238e7a030739d2907cda325738`
- Receipt SHA-256 `262066bff577ee02cd53536c2ceda325d8ea76980eb43ad40408219df9b70b7c`
- `collect-paired-outcomes.ts` SHA-256 `5e3c96492703f5529972ffe61390fd7e1ad67868806d8f745c13fe228bc3d1bd`
- `corpus.ts` SHA-256 `39a2ad493bb86a84e1801ea7a97a99de55d3f0ab4f14fd7275944fe8e3779204`
- `observe.ts` SHA-256 `d7fc412372917c89f0fdcd100133dc4fa5b667f3969244badcefaae980e9bdff`
- `score.ts` SHA-256 `f4bfa46fd5eda8e8c8cf08f19382652567439c49512caffd6caf0a5d32b5abdf`
- `v2/manifest.json` SHA-256 `c7ab3fbe2340053fca18ed892da1f248fc5fb92ffbc76d14cf2d2300aa20daf6`
- `v2/mapping.ts` SHA-256 `5e78c21948fbc1d3072053ef44fce6b57930757428e9747578918421bd2af883`
- `v2/sealed.ts` SHA-256 `8323800cca8f31856e6e7ddde060e45004fa0196b6af54c465cb389e8b37ea94`

```bash
git worktree add --detach /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-57 1374bc44c0d73e8567acb5814e938f2576676fde
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-57 && npm ci --no-audit --no-fund --prefer-offline --cache /workspace/work/mohassan-v2-by-branch-study/npm-cache)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-57 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_REFUSAL_POLICY=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --preflight true --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-57.preflight.json)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-57 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_REFUSAL_POLICY=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --sealed /workspace/work/Mohassan-AI/tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-57.paired.json)
```

</details>

<details>
<summary>feat/scratch-classifiers</summary>

Evaluation HEAD `8d6be4c66329679eb901e8129690562cb5df183a`. linux x64, Node.js `v24.22.3`, timezone `Europe/London`. Started `2026-11-25T03:44:49.056Z` and finished `2026-11-25T03:49:25.903Z`.

- Lockfile SHA-256 `5ca3eb97d734f4403734d865f08e52065675e46877f75000e3646b1fddbdbb4e`
- Receipt SHA-256 `4057d32a8dd75e29aba35a474cb3a21d0cdbab574a166d2d5dcef48c8def42d5`
- `collect-paired-outcomes.ts` SHA-256 `5e3c96492703f5529972ffe61390fd7e1ad67868806d8f745c13fe228bc3d1bd`
- `corpus.ts` SHA-256 `39a2ad493bb86a84e1801ea7a97a99de55d3f0ab4f14fd7275944fe8e3779204`
- `observe.ts` SHA-256 `d7fc412372917c89f0fdcd100133dc4fa5b667f3969244badcefaae980e9bdff`
- `score.ts` SHA-256 `f4bfa46fd5eda8e8c8cf08f19382652567439c49512caffd6caf0a5d32b5abdf`
- `v2/manifest.json` SHA-256 `c7ab3fbe2340053fca18ed892da1f248fc5fb92ffbc76d14cf2d2300aa20daf6`
- `v2/mapping.ts` SHA-256 `5e78c21948fbc1d3072053ef44fce6b57930757428e9747578918421bd2af883`
- `v2/sealed.ts` SHA-256 `8323800cca8f31856e6e7ddde060e45004fa0196b6af54c465cb389e8b37ea94`

```bash
git worktree add --detach /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-47 8d6be4c66329679eb901e8129690562cb5df183a
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-47 && npm ci --no-audit --no-fund --prefer-offline --cache /workspace/work/mohassan-v2-by-branch-study/npm-cache)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-47 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_SCRATCH_CLASSIFIERS=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --preflight true --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-47.preflight.json)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-47 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_SCRATCH_CLASSIFIERS=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --sealed /workspace/work/Mohassan-AI/tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-47.paired.json)
```

</details>

<details>
<summary>feat/arabic-understanding-core</summary>

Evaluation HEAD `219e2ea258e2a323dd13bcda38b341929a41a9a8`. linux x64, Node.js `v24.22.3`, timezone `Europe/London`. Started `2026-11-25T03:44:54.769Z` and finished `2026-11-25T03:51:23.501Z`.

- Lockfile SHA-256 `be0681e77c59af142f13a81cf84a835322b654238e7a030739d2907cda325738`
- Receipt SHA-256 `9c1b5570a5db18483c67c585cc36059b3a4761deb072ce311a1b9b55b3cf4cfb`
- `collect-paired-outcomes.ts` SHA-256 `5e3c96492703f5529972ffe61390fd7e1ad67868806d8f745c13fe228bc3d1bd`
- `corpus.ts` SHA-256 `39a2ad493bb86a84e1801ea7a97a99de55d3f0ab4f14fd7275944fe8e3779204`
- `observe.ts` SHA-256 `d7fc412372917c89f0fdcd100133dc4fa5b667f3969244badcefaae980e9bdff`
- `score.ts` SHA-256 `f4bfa46fd5eda8e8c8cf08f19382652567439c49512caffd6caf0a5d32b5abdf`
- `v2/manifest.json` SHA-256 `c7ab3fbe2340053fca18ed892da1f248fc5fb92ffbc76d14cf2d2300aa20daf6`
- `v2/mapping.ts` SHA-256 `5e78c21948fbc1d3072053ef44fce6b57930757428e9747578918421bd2af883`
- `v2/sealed.ts` SHA-256 `8323800cca8f31856e6e7ddde060e45004fa0196b6af54c465cb389e8b37ea94`

```bash
git worktree add --detach /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-23 219e2ea258e2a323dd13bcda38b341929a41a9a8
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-23 && npm ci --no-audit --no-fund --prefer-offline --cache /workspace/work/mohassan-v2-by-branch-study/npm-cache)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-23 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_ARABIC_UNDERSTANDING=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --preflight true --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-23.preflight.json)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-23 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_ARABIC_UNDERSTANDING=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --sealed /workspace/work/Mohassan-AI/tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-23.paired.json)
```

</details>

<details>
<summary>e2e/clarification-end-to-end</summary>

Evaluation HEAD `8f83117c6bd2c81bee4a7b2e6046c8b6fe085f93`. linux x64, Node.js `v24.22.3`, timezone `Europe/London`. Started `2026-11-25T03:44:56.347Z` and finished `2026-11-25T03:50:54.351Z`.

- Lockfile SHA-256 `be0681e77c59af142f13a81cf84a835322b654238e7a030739d2907cda325738`
- Receipt SHA-256 `e3c1c217c4948330ae191ce29fc9dbd06ba16770204eb6d537357381301c342a`
- `by-branch-observe.ts` SHA-256 `1333803818fa0f0f37eaefd1f059f57c1a30aecc194909886ce5d083fda124c9`
- `collect-paired-outcomes.ts` SHA-256 `5e3c96492703f5529972ffe61390fd7e1ad67868806d8f745c13fe228bc3d1bd`
- `corpus.ts` SHA-256 `39a2ad493bb86a84e1801ea7a97a99de55d3f0ab4f14fd7275944fe8e3779204`
- `score.ts` SHA-256 `f4bfa46fd5eda8e8c8cf08f19382652567439c49512caffd6caf0a5d32b5abdf`
- `v2/manifest.json` SHA-256 `c7ab3fbe2340053fca18ed892da1f248fc5fb92ffbc76d14cf2d2300aa20daf6`
- `v2/mapping.ts` SHA-256 `5e78c21948fbc1d3072053ef44fce6b57930757428e9747578918421bd2af883`
- `v2/sealed.ts` SHA-256 `8323800cca8f31856e6e7ddde060e45004fa0196b6af54c465cb389e8b37ea94`

```bash
git worktree add --detach /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-59 8f83117c6bd2c81bee4a7b2e6046c8b6fe085f93
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-59 && npm ci --no-audit --no-fund --prefer-offline --cache /workspace/work/mohassan-v2-by-branch-study/npm-cache)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-59 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_CLARIFY_CHOICES=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --preflight true --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-59.preflight.json --adapted-observer true)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-59 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_CLARIFY_CHOICES=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --sealed /workspace/work/Mohassan-AI/tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-59.paired.json --adapted-observer true)
```

</details>

<details>
<summary>e2e/calculation-end-to-end</summary>

Evaluation HEAD `757cae8176b832063a24932f471ae87b897b5794`. linux x64, Node.js `v24.22.3`, timezone `Europe/London`. Started `2026-11-25T03:44:55.171Z` and finished `2026-11-25T03:50:54.642Z`.

- Lockfile SHA-256 `be0681e77c59af142f13a81cf84a835322b654238e7a030739d2907cda325738`
- Receipt SHA-256 `b2b0ee9bb13a03149e3bda3faba67ac583aae1ae959eb4d1b8a23ca5c124e282`
- `collect-paired-outcomes.ts` SHA-256 `5e3c96492703f5529972ffe61390fd7e1ad67868806d8f745c13fe228bc3d1bd`
- `corpus.ts` SHA-256 `39a2ad493bb86a84e1801ea7a97a99de55d3f0ab4f14fd7275944fe8e3779204`
- `observe.ts` SHA-256 `d7fc412372917c89f0fdcd100133dc4fa5b667f3969244badcefaae980e9bdff`
- `score.ts` SHA-256 `f4bfa46fd5eda8e8c8cf08f19382652567439c49512caffd6caf0a5d32b5abdf`
- `v2/manifest.json` SHA-256 `c7ab3fbe2340053fca18ed892da1f248fc5fb92ffbc76d14cf2d2300aa20daf6`
- `v2/mapping.ts` SHA-256 `5e78c21948fbc1d3072053ef44fce6b57930757428e9747578918421bd2af883`
- `v2/sealed.ts` SHA-256 `8323800cca8f31856e6e7ddde060e45004fa0196b6af54c465cb389e8b37ea94`

```bash
git worktree add --detach /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-60 757cae8176b832063a24932f471ae87b897b5794
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-60 && npm ci --no-audit --no-fund --prefer-offline --cache /workspace/work/mohassan-v2-by-branch-study/npm-cache)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-60 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_REASONING=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --preflight true --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-60.preflight.json)
(cd /workspace/work/mohassan-v2-by-branch-study/worktrees/pr-60 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright MOHASSAN_REASONING=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --sealed /workspace/work/Mohassan-AI/tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output /workspace/work/mohassan-v2-by-branch-study/receipts/pr-60.paired.json)
```

</details>

## Verification

| Check | Result |
| --- | --- |
| `npm ci --cache /workspace/work/npm-cache --no-audit --no-fund --prefer-offline` | Exit 0. Installed the measurement checkout dependencies. |
| `PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright npm exec -- playwright install chromium` | Exit 0. Installed the lockfile's Chromium build and headless shell. |
| `npm test -- tests/agent-capability-by-branch-adapters.test.ts tests/agent-capability-by-branch-report.test.ts tests/agent-capability-by-branch-statistics.test.ts tests/agent-capability-measure-by-branch.test.ts tests/agent-capability-paired-outcomes.test.ts tests/agent-capability-observe.test.ts tests/agent-capability-score.test.ts` | Exit 0. 42 tests passed across seven files. |
| `npm run typecheck` | Exit 0 in the root project and web workspace. |
| `git diff --check a130b239d9e6d2b1f6728128019d24bb26e9293f...HEAD` | Exit 0. |
| `git diff --exit-code a130b239d9e6d2b1f6728128019d24bb26e9293f...HEAD -- apps packages package.json package-lock.json scripts/agent-capability-bench/run.ts scripts/agent-capability-bench/observe.ts scripts/agent-capability-bench/score.ts tests/fixtures/agent-capability-bench` | Exit 0. The measurement changes are isolated from the product, package manifests, original evaluation code and fixtures. |
| `node --import tsx scripts/agent-capability-bench/measure-by-branch.ts measure --directory /workspace/work/mohassan-v2-by-branch-study --browsers /workspace/work/mohassan-playwright --jobs 4` | Initial invocation exited 1 before the study was frozen or the seal opened because calculation PR #60 appeared on origin. After adding its verified configuration, the invocation exited 0. The baseline and all 15 candidates completed one sealed run each. |
