# Local inference and constrained generation

The Python interface is synchronous and in-process. It does not expose a service,
connect to providers, or execute generated content. The examples below describe
later use and were not executed during Phase 2.

## Explicit initialization or loading

```python
from execution_model.config import model_preset
from execution_model.generation import GenerationConfig
from execution_model.inference import InferenceEngine
from execution_model.resources import ResourceConfig
from execution_model.tokenizer import ByteBPETokenizer

tokenizer = ByteBPETokenizer.load("approved-artifacts/tokenizer.json")
config = model_preset("A", vocab_size=tokenizer.vocab_size, seed=7)
engine = InferenceEngine(ResourceConfig(device="cpu", dtype="float32"))
metadata = engine.initialize_random(config, tokenizer)  # explicitly UNTRAINED
# Alternatively load approved local weights, with independent expected identity:
# metadata = engine.load_local_model(
#     approved_directory, expected_config=config,
#     expected_tokenizer_identity=approved_tokenizer_identity,
# )
info = engine.get_model_info()
capabilities = engine.get_supported_capabilities()
input_ids = engine.encode_task_input("Compiled narrow task", framing="task")
response = engine.generate_candidate(
    "Compiled narrow task",
    GenerationConfig(max_new_tokens=32, do_sample=False, seed=7),
    framing="task",
)
```

The facade freezes model parameters for inference. Phase 3 should instantiate
`ExecutionModel` directly for training. The engine can hold random or locally
loaded weights; it never chooses a trained fallback. Loading a replacement is
atomic at the engine reference level: failure preserves the old model. Peak
replacement memory can include both old and new models; hosts should account
for this or create a fresh process when replacing a large model.

`plain` framing inserts BOS then ordinary text. `task` framing inserts
`BOS, TASK, INPUT, encoded_text, OUTPUT`. Special-token spellings within text
remain ordinary data and cannot inject reserved ids. These are package-local
training conventions, not finalized Phase 1 contracts. The host must use the
same framing for training and inference. PAD/BOS/task delimiters are blocked
during candidate generation unless explicitly designated stop tokens. EOS is
always a stop token; `end_task` can be selected in `GenerationConfig.stop_token_ids`.

## Generation behavior

`generation.generate(model, input_ids, config, ...)` returns `GenerationResult`.
`generation.stream_generate(...)` yields token events and one final result.
The model must already be in eval mode. These low-level interfaces accept one
nonempty unpadded list/tuple, including any desired BOS, and raise typed errors.
They do not change model mode or process-wide determinism settings.

`GenerationConfig` includes `max_new_tokens`, `do_sample`, `temperature`, `top_k`,
`top_p`, `seed`, `stop_token_ids`, and `require_deterministic_algorithms`.
Greedy chooses the largest legal logit, with the lowest id winning a tie.
Sampling uses float32 CPU logits and a request-local CPU `torch.Generator`.
Allowed/blocked-token filtering happens before temperature, top-k, then nucleus
top-p filtering. At least one token crossing the nucleus threshold is retained.
Sampling-only settings with `do_sample=False` are rejected rather than ignored.
Seeds affect sampling without resetting global RNG state.

Strict deterministic mode requires the host to have enabled deterministic
algorithms with warn-only disabled. It does not change environment variables or
global torch settings. Device, dtype, torch version and kernel choices can still
change numerical results; seeds alone do not promise cross-platform equivalence.
Unsupported deterministic kernels report an error.

The complete prompt plus the effective maximum output budget must fit the selected
context window **before** decoding starts, even if early EOS might have fit.
Nothing is silently truncated or shifted out. Context overflow includes input,
requested output, and supported context sizes in a typed error. New-token budget
zero is allowed. A constraint may impose a smaller output-token budget, reported
as `token_budget` when reached.

Cancellation is a trusted local `Callable[[], bool]`, such as `event.is_set`.
It is checked before and after each forward pass. It cannot interrupt a kernel
already executing; an in-flight proposed token is discarded when cancellation
is observed. No files or network calls occur in generation code. Callbacks and
custom constraints are trusted host code and must themselves avoid side effects.

## Streaming, output, and errors

```python
stream = engine.stream_candidate(
    "Compiled narrow task", GenerationConfig(max_new_tokens=32),
    cancelled=cancel_event.is_set,
)
try:
    for event in stream:
        if event.kind == "token":
            consume_untrusted_bytes(event.output_bytes)
        else:
            final_response = event.response
finally:
    stream.close()
```

The engine permits one active operation. A stream holds its lock until exhausted
or explicitly closed; even after receiving its final event, exhaust/close it
before calling another engine operation. A conflicting call reports `ENGINE_BUSY`.
The generator does not leave `inference_mode` active across a yield into caller
code. Multiple engines still require host-level memory/concurrency limits.

Token events contain the id, raw bytes, and a terminal flag. Terminal stop tokens
have empty output bytes. The final generation result includes **all** sampled ids
(including the terminal token), exact input/output token counts, stop reason,
terminal id, constraint acceptance, seed, and deterministic-algorithm state.
Stop reasons are `eos`, `stop_token`, `length`, `token_budget`,
`constraint_complete`, and `cancelled`. A token stop rule is not a string stop rule.

Final `CandidateOutput` contains raw candidate `output_bytes` excluding the terminal
token, `text` when strictly valid UTF-8 (otherwise `None`), `utf8_valid`, generation
metadata, requested sampling configuration, model provenance, and resolved placement.
Token boundaries need not align to Unicode characters. Nothing is decoded using
replacement/ignore behavior. `trusted` and `independently_verified` remain false.
`InferenceResponse.to_dict()` is Python-native and preserves bytes; a later IPC
adapter must explicitly encode them, for example as base64.

Facade response status is `completed`, `cancelled`, or `error`. `completed` means
decoding ended; inspect stop reason and constraint acceptance for truncation.
`error` has a `{code, message, details}` record and no completed candidate; earlier
streamed token events may already exist and must be discarded as a usable result.
Initialization, encoding, loading, and metadata calls raise `ExecutionModelError`
subclasses; callers can serialize them with `to_dict()`. Generation catches these
errors and emits one final error response. Host callback/programming exceptions
are intentionally not disguised as model success. Relevant error codes include
`INVALID_CONFIGURATION`, `INVALID_REQUEST`, `UNSUPPORTED_REQUEST`,
`CONTEXT_OVERFLOW`, `MODEL_NOT_LOADED`, `MODEL_LOAD_FAILED`, `TOKENIZER_ERROR`,
`CONSTRAINT_UNSATISFIABLE`, `NONFINITE_MODEL_OUTPUT`, and `RESOURCE_ERROR`.
Cancellation has its own response/stop status rather than an exception.

## Implemented constraints

`constraint_from_spec(spec, tokenizer)` accepts only these data-only forms:

```python
{"kind": "allowed_tokens", "token_ids": [65, 66], "token_budget": 8}
{"kind": "token_sequences", "sequences": [[65, 66], [67, 68]]}
{"kind": "json_choices", "choices": [{"action": "accept"}, {"action": "reject"}]}
```

`token_budget` is optional on all forms. Allowed tokens filter every step. Finite
sequences form a trie, must be nonempty, distinct and prefix-free, and finish
automatically on a complete candidate. They cannot contain stop/blocked ids.
JSON choices are strictly bounded JSON values serialized canonically with sorted
keys, no NaN/Infinity, and no whitespace separators, then encoded into finite token
sequences. Completion selects exactly one of the supplied serialized values.
If candidate encodings overlap by prefix, the request is rejected explicitly.
Output budgets/cancellation can still produce an incomplete prefix with
`constraint_satisfied=False`; it must not be advertised as valid JSON.

Extend `DecodingConstraint` only with trusted application code implementing
`allowed_token_ids`, optionally `validate`, `is_complete`, `accepts`, and
`token_budget`. Prefixes contain generated content, excluding prompt and terminal
stop tokens. Empty allowed sets produce a structured failure; no unconstrained
retry occurs. Unknown kinds/fields and requests for JSON Schema are unsupported.
Finite JSON choices are **not** general JSON grammar or JSON Schema decoding.
Syntax membership cannot establish semantic correctness, authority, or safe
execution; those decisions stay outside the model.
