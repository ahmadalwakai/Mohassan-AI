# Frozen test sets

| File | sha256 | Frozen (UTC) | Role |
|---|---|---|---|
| `cases.json` | 4c272ed0daa0e3f8652593f339cce9f4c0b377c798d2c42f8963cfe4c0eecacb | 2026-11-22 | Development set: the first run and every revision were measured on it. |
| `heldout.json` | 883381fb96734fcd5e71dd5f7af737862df2ad90f55c1d8e93c12baec49b6e1c | 2026-11-22, before the first revision was measured | First held-out set. Its seven failures guided the second revision, so from that revision on it is a revision set, not a held-out set. |
| `heldout-2.json` | 83056176319a5b303eb4ae06e6ed615710e92d8ca77f39221953cfccf9051200 | 2026-11-22T23:35:06Z | Second held-out set, written before any change to the seven revised skills or to the reader. Run once after the second revision. Its failures guided the third revision of job-interview-prep, security-incident-response and verify-before-done, so for those three it is a revision set from then on; for the other four it stays the held-out result. |
| `heldout-3.json` | 53ffefcc3a76eb8d8df973b18c5ce28bba4c6c4d85021b3627cc0b79445a9298 | 2026-11-22T23:56:14Z | Third held-out set, written after heldout-2 was run once and before any change for the third revision (the three skills and the reader). Run once after that revision, never used to edit a skill. |

Last modifications before each freeze: before `heldout-2.json`, 2026-11-22T20:35:08Z (skills) and 2026-11-22T20:16:09Z (`apps/server/src/assistant/skill-reader.ts`); before `heldout-3.json`, 2026-11-22T23:51:50Z (the three skills) and 2026-11-22T23:47:00Z (the reader, second revision).
