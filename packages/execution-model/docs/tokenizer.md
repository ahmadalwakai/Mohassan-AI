# Tokenizer

`execution_model.tokenizer.ByteBPETokenizer` implements byte-level byte-pair
encoding using only the Python standard library. There is no pretrained
vocabulary, tokenizer library, normalization, regex pretokenization, download, or
neural model involved in vocabulary training.

The permanent alphabet has one token for every byte value, ids 0 through 255.
Explicit special tokens follow in declaration order. The defaults are `pad`,
`bos`, `eos`, `task`, `input`, `output`, and `end_task`, with spellings such as
`<|task|>`. Learned merge tokens follow the specials. The default base vocabulary
therefore contains 263 tokens before learning any merges.

`train` repeatedly merges the most frequent adjacent pair within the provided
records. Incremental occurrence sets and linked positions update only the
affected pair counts. A priority queue selects the next pair. Frequency ties
use ascending `(left_token_id, right_token_id)`; overlapping occurrences merge
left-to-right. Encoding uses learned merge ranks and a position queue. Neither
operation depends on a random seed or a neural model. Reproducibility requires
the same bytes, record boundaries, record order, special-token order, and
training options.

The supported vocabulary targets are 8,192, 16,384, and 24,576 **including** all
bytes and specials. These are ceilings, not promises that a small corpus can
produce that many useful merges. Learning stops when no eligible pair remains
or its frequency is below `min_pair_frequency` (default 2). Tokens cannot exceed
256 bytes. Inspect `tokenizer.vocab_size`, and use that exact value for a new
model configuration. `tokenizer.target_vocab_size` records the requested ceiling.
No fabricated filler tokens are added to reach the target.

Text encoding uses strict UTF-8 without normalization. Arabic, English,
indentation, tabs, CRLF/LF, code punctuation, escape characters, and unfamiliar
valid Unicode symbols are preserved. `decode(encode(text))` equals the original
valid Unicode scalar text. Lone Python surrogate characters are rejected
explicitly; original arbitrary bytes can instead use `encode_bytes` and
`decode_bytes`, whose round trip is lossless for every byte value. There is no
unknown-token substitution.

Special spellings in ordinary input are encoded as ordinary bytes. For example,
text containing `<|eos|>` never terminates a request merely because it contains
that spelling. Callers insert reserved ids explicitly using
`tokenizer.special_token_ids`, or use `encode(..., add_bos=True, add_eos=True)`.
Default decoding renders special ids as their literal spellings.
`skip_special_tokens=True` removes them only when explicitly requested.

Unconstrained generated tokens can form invalid or incomplete UTF-8. The default
text decoder raises `TokenizerError` rather than substituting replacement
characters. Preserve `decode_bytes(ids)` and the original ids when this occurs.
`decode(..., errors="surrogateescape")` is also available for a reversible
Python string representation; recovering its raw bytes requires UTF-8 encoding
with `errors="surrogateescape"`. Such a string is not valid Unicode interchange
text. `errors="replace"` and `errors="ignore"` are rejected. Streaming consumers
must accumulate bytes or use an incremental UTF-8 decoder; one token need not
contain a complete Unicode character.

The following is an example for a later, explicitly authorized vocabulary
training session. It has not been executed in Phase 2:

```python
from execution_model.tokenizer import ByteBPETokenizer

tokenizer = ByteBPETokenizer.train_files(
    ["local-approved-corpus/tasks.txt", "local-approved-corpus/examples.txt"],
    target_vocab_size=16384,
    max_corpus_bytes=2_097_152,
)
tokenizer.save("local-artifacts/tokenizer.json")
ids = tokenizer.encode("    نتيجة = value + 1\r\n")
original_text = tokenizer.decode(ids)
```

`train_files` reads explicitly named local files in binary mode and uses 64 KiB
chunks as records by default. File and chunk boundaries are merge-training
boundaries. A UTF-8 sequence split across records remains represented by its
original bytes. `train` can instead consume caller-defined `str` or `bytes`
records. Corpus budgets apply across all records/files; excess input produces an
error and never silently trains on a prefix.

Defaults are 2 MiB of corpus bytes, 256 KiB per record, and 100,000 records. The
configurable hard ceilings are 64 MiB of corpus bytes, 1 MiB per record, and
100,000 records/files. Pair occurrence sets have substantial Python overhead;
these limits are not memory-use measurements or guarantees. The tokenizer
trainer is an in-memory CPU implementation intended for controlled local corpora,
not a distributed trainer. Per-call encoding is bounded at 1 MiB; decoding is
bounded at 1,048,576 input tokens and 8 MiB of output bytes.

Serialization is a versioned UTF-8 JSON object:

```text
format: "mohassan-byte-bpe"
version: 1
target_vocab_size: 8192 | 16384 | 24576
special_tokens: ordered [[name, spelling], ...]
merges: ordered [[left_id, right_id], ...]
identity: lowercase SHA-256 hex digest
```

Bytes 0..255 are implicit. Each merge's result id is its zero-based rank plus
256 plus the number of specials. All operands must refer to earlier ordinary
tokens; specials cannot be operands. The loader checks ids, dependencies,
duplicate pairs, token sizes, unique special names/spellings, supported fields,
and the recomputed identity. The identity is SHA-256 of every field except
`identity`, serialized by `json.dumps(..., ensure_ascii=True, sort_keys=True,
separators=(",", ":"), allow_nan=False).encode("ascii")`.

`save` atomically replaces the explicitly named file using a temporary file in
the same directory. Parent directories must already exist; the final file may
be new or an existing regular file. `load` and `train_files` require existing
regular files. `load` reads at most
4 MiB plus one byte and rejects duplicate JSON object keys. It never uses
pickle. Path validation rejects NUL characters, remote URLs, UNC/device paths,
reserved Windows device filenames (including names with extensions), alternate
data streams, parent traversal, and ambiguous trailing dots/spaces. It checks
every existing path component without following symlinks, junctions, or other
Windows reparse points. Windows mapped network drives and unavailable/unknown
drive types are rejected. Read handles are checked for a regular file and for
detectable replacement while opening. These checks are not a filesystem sandbox
against a process concurrently replacing directories or modifying open files;
the host must control the source/artifact directories during each operation.
Network mounts on non-Windows systems remain the host's responsibility.
`to_dict` returns a detached serializable document;
`from_dict` validates a previously parsed document and its identity. A caller
using `from_dict` on untrusted JSON must perform its own byte-size and
duplicate-key checks first.

The identity detects mismatched content; it is not a signature or proof of a
trusted corpus. Vocabulary selection, source approval, training/evaluation split
control, and model training belong to later phases. No corpus was read and no
vocabulary was trained while implementing this module.
