# Scratch classifiers model card

Four CPU classifiers score refusal and scope, small talk, routing, and follow-up. A model sees only the normalized message. The follow-up model also receives the previous user question in training and the host-persisted previous user topic in the server. The models share a feature space of 32,768 buckets with binary character 2–5-grams and word unigrams and bigrams. Follow-up adds separately hashed history features and a lexical overlap bucket.

## Data and selection

Training uses public human-authored inputs and source labels. Source URLs and checksums, label mapping, and split construction are versioned in this package. The source annotations are proxies for the application decisions. The mapped data cover `chat`, `compute`, `news`, `reminder`, `unsupported`, `web_search`, and `writing`. Every other route relies on the application rules. Follow-up labels use human rewrites and histories of English questions about Wikipedia topics. A score on these questions measures transfer within that task. Assistant conversations and Arabic follow-ups need their own evaluation. [Data card](DATA-CARD.md)

Both candidates start with zero weights. The multinomial logistic candidate uses L2 regularization and inverse-square-root class-frequency sample weighting. The averaged perceptron sees five shuffled passes with seed `20261125`. Each candidate is quantized first. Development macro-F1 selects the model, with logistic regression winning ties. The calibration split fits one positive temperature by minimizing negative log likelihood. It also selects the highest-coverage threshold at or above 0.80 that meets two criteria. The pooled accuracy of accepted examples must have a 95% Wilson lower bound of at least 80%. Each predicted class with accepted examples must also have at least 80% precision after adding one correct and one incorrect pseudocount. One threshold applies across a head's labels and datasets. Test and capability benchmark examples do not select a candidate or a threshold.

## Runtime and evaluation

Each `models/<head>.json` stores little-endian signed 16-bit weights in class-major order. Inference sums integer weights, applies the floating scale and bias, divides by the temperature, and applies stable softmax. `models/manifest.json` pins each serialized model with SHA-256. `models/golden.json` records the Python predictions and source attribution for development examples used in TypeScript parity tests.

The evaluation report covers development model selection, calibration statistics, and each applicable dataset test split. Its macro-F1 averages over classes with nonzero true support and counts every prediction, including those that would abstain. Per-class recall without support is `null`. Expected calibration error uses 15 equal-width top-score bins over all examples. Coverage and accepted accuracy show the effect of the abstention threshold. The capability benchmark is a separate measurement of application behavior. [Full split metrics](models/metrics.json)

| Head | Logistic development macro-F1 | Averaged-perceptron development macro-F1 | Threshold | Accepted calibration examples | Model bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Refusal and scope | 0.943 | 0.938 | 0.800 | 1,304/1,478 | 262,383 |
| Speech act | 0.954 | 0.944 | 0.806 | 1,969/1,981 | 174,990 |
| Route | 0.924 | 0.918 | 0.800 | 1,203/1,339 | 612,027 |
| Follow-up | 0.658 | 0.623 | 0.883 | 1,339/1,508 | 174,986 |

Logistic regression was selected for all four heads. The CLINC150 refusal-and-scope test yielded 0.576 macro-F1, 0.389 out-of-scope recall on 1,328 examples, and 0.320 ECE. CLINC's broad out-of-scope category remains difficult under this mapping. The CANARD follow-up test yielded 0.620 macro-F1, 0.987 follow-up recall on 4,337 examples, and 0.187 new-request recall on 391 examples. Each MASSIVE test locale has one mapped small-talk example. Arabic small-talk recall was 0/1, and English recall was 1/1. Neither locale provides a reliable estimate of chat recall. The single-class ArBanking77 PAL and Aya slices measure recall within their annotated domains.

The pinned training environment uses Python 3.12 with the NumPy and SciPy versions in `requirements.txt`. The trainer fixes the seed and uses one BLAS thread. Two independent executions in the same environment produced matching model, metrics, manifest, and golden files byte for byte.
