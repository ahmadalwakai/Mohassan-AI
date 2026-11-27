# Factual reply checks

Set `MOHASSAN_TRUTH_CHECK` in the server environment and restart the server.

| Value | Behavior |
| --- | --- |
| Unset or `off` | The judge runs its existing checks. It skips the additional factual check. |
| `shadow` | The judge checks the candidate question type and evidence, and adds its verdict to the existing judge log. Publication uses the existing decision. |
| `on` | The judge can withhold an unconfirmed factual reply where it already has owner-scoped withhold authority. It sends a fixed Arabic or English message and links to the safely publishable pages read for that turn. |

The judge still requires `MOHASSAN_JUDGE_SHADOW` to be enabled. `MOHASSAN_JUDGE_WITHHOLD=0` disables enforcement. Member replies can produce shadow verdicts under the existing judge privacy rules. A withheld completed answer uses the judge's existing `partial` publication path.

The check covers public who, when, how-many and where questions that reach the pre-send judge. It checks the candidate after any legacy fix the host would apply. The lead must answer the requested relation and the factual claims must be supported by the text the turn actually read. A cited page must match the captured URL, including its path and query. The council's selected answer uses the same hook with the evidence and verdict already collected by the council. Search snippets alone do not count as a page read. The checker performs no additional searches or page reads.

The judge log's `truth` object contains the decision, reason codes and whether the truth check applied a withhold. `unavailable` indicates an unexpected evaluation failure and falls back to the existing decision. The truth object contains no question text, reply text or evidence excerpts. The existing log retention and conversation review policies apply.

The four question forms are matched by deterministic rules. Paraphrases, unfamiliar wording and incomplete or conflicting evidence can affect the verdict. The existing judge's publication scope governs local memory, standalone v5 experiment replies, tool actions and specialized publication paths.

Ported from [PR #27 at 7eb3713](https://github.com/ahmadalwakai/Mohassan-AI/tree/7eb3713c42a1a7ab7dc0a666cf3b8cd97b271e2b), retrieved 2026-11-27. See the [development benchmark](../scripts/dev-bench/README.md) for paired shadow and enforcement measurements.
