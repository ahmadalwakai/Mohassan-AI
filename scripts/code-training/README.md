# Experimental local TypeScript model requests

The local model is an experiment for bounded function implementations and repairs. A request
supplies its natural-language message, exact TypeScript signature and independent
behavioral probes. Arabic and English messages use the same request format.
See `request.example.json` for a complete request.

The selected checkpoint is `bilingual-code-v2`, step 300, with SHA-256
`ece9513215d72fae080bd72c216e08c8b1e3229e307275b3938d1a713948800d`.
It has not met readiness criteria: independent Ads goal tests scored **18% Arabic**
and **26% English** raw exact accuracy. Independent code cases passed **2/32
(6.25%)**, with **1/16** passing in each language. Cases derived from known task
templates passed **172/480 (35.83%)**. These measurements do not establish general
programming ability or production readiness. Bound evidence is recorded in
`artifacts/model-readiness-20261115/code-summary-ece9513215d7.json`.

From the repository root, using this exact checkpoint:

```powershell
$env:OMP_NUM_THREADS='1'
$env:MKL_NUM_THREADS='1'
.\.venv-execution\Scripts\python.exe packages/execution-pipeline/scripts/ask_code.py --input scripts/code-training/request.example.json --output artifacts/code-training/add-numbers-answer.json --run artifacts/execution-model-runs/text-b2-2026-11-12 --finetune bilingual-code-v2 --checkpoint-sha256 ece9513215d72fae080bd72c216e08c8b1e3229e307275b3938d1a713948800d --device cpu
if ($LASTEXITCODE -eq 0) {
  npx tsx scripts/code-training/verify.ts artifacts/code-training/add-numbers-answer.verify-job.json artifacts/code-training/add-numbers-verification.json
}
```

The checkpoint hash is mandatory in the recorded command above. Generation is
greedy. Existing output paths are refused; choose a new output filename for another
request. The first command writes
the model's actual text to a JSON artifact and creates a verification job only
when generation finishes. It never replaces a wrong answer with template code.

The recorded run of this exact Arabic example returned `incomplete_generation`.
Its actual output is preserved in
`artifacts/model-readiness-20261115/cli-add-numbers-ece9513215d7.json`; no verification
job was created and no generated code was executed or applied. A single example's
result does not override the failed readiness assessment.

The verifier checks the trusted function signature, permits a bounded expression
grammar and executes accepted candidates inside Windows AppContainer with network
denied. It compares behavior with the supplied expected probe outputs and records
checkpoint-independent source/job hashes and isolation receipts. A passing result
covers the declared signature and supplied probes; it is not a general proof of
TypeScript correctness or arbitrary application-programming ability.

For repair, set `mode` to `repair` and add `failed_candidate` plus
`failure_evidence: {"args": [...], "observed": ..., "expected": ...}`. Expectations
come from the supplied contract or tests, never from the generated answer. Neither
command applies code to a project, publishes anything or uses an external model.
