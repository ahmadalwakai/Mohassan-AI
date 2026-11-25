# Test-driven coding evaluation data

The synthesizer uses a hand-written Python operator library and the assertions supplied in each request. It has no training corpus. The public MBPP rows below are evaluation inputs.

## Public MBPP splits

Jacob Austin et al. and Google Research released Mostly Basic Python Problems as crowdworker-written descriptions, reference implementations and assertions. This evaluation uses the `full` configuration at Hugging Face revision `4bb6404fdc6cacfda99d4ac4205087b89d32030c`, licensed CC BY 4.0. [Dataset and license](https://huggingface.co/datasets/google-research-datasets/mbpp/blob/4bb6404fdc6cacfda99d4ac4205087b89d32030c/README.md) · [Paper](https://arxiv.org/abs/2108.07732) · [Upstream repository notice](https://github.com/google-research/google-research/blob/f46ca8374b4cddef97ca4208ad986049d74d296a/LICENSE)

| Public file | Original task IDs | Downloaded | Exclusion drops | Duplicate IDs after exclusion | Eligible |
| --- | --- | ---: | ---: | ---: | ---: |
| `full/prompt-00000-of-00001.parquet` | 1–10 | 10 | 0 | 0 | 10 |
| `full/validation-00000-of-00001.parquet` | 511–600 | 90 | 1 | 0 | 89 |
| `full/train-00000-of-00001.parquet` | 601–974 | 374 | 1 | 0 | 373 |
| **Total** | | **474** | **2** | **0** | **472** |

The SHA-256 fingerprints below follow the table order.

```text
a053e4bb85ceb77430ae80592addb4ca4dc6ba087592f9e04537800ee88b7431
3f0ec060987432d99fe8fb409d31e6c67445b208a01741c5583517c80a10fe80
09d125ca31edacb7800be8c67c45abff618faf0214ff551291817d06bdb914ae
```

Only these three Parquet files were downloaded. The v2 exclusion filter checked source ID, native description, test-inclusive prompt, assertions, setup, reference code and challenge assertions against both release manifests before local deduplication. The two drops were normalized description matches with distinct source IDs. Eligible rows retained their published split labels.

The offline controller replay supplies the description and published example assertions in the original test-inclusive format. Reference implementations and the challenge tests serve only the exclusion check. An independent replay submits each returned Python function to the verification worker with the original assertions. Cases where the controller declines to return code count as functional failures. One eligible train row has nonempty upstream test setup, which the offline replay keeps with the assertions.

## Source check

The source guard compares raw and JSON-escaped v2 input texts, including the native forms recognized by the exclusion filter, against tracked and unignored source files. By default any occurrence fails the check. The baseline already contains short literal overlaps, including small-talk strings. With `--allow-baseline-matches`, the guard also reports the strict result and fails on any new occurrence in a file relative to `c2a0ff7`.

Run both partitions on the frozen scratch merge. The command reports paths and digests for additions.

```bash
python3 -B tests/no-v2-case-text.test.py --allow-baseline-matches
```

Use `--development-only` during development so the sealed release stays closed.
