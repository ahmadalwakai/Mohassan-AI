# Public programming questions

The two files contain 30 original Stack Overflow titles with three questions of each type in each split. The fixtures retain the displayed titles verbatim after decoding HTML character references. They include the question author, the author of the matching title revision, and links to their profiles, the source post, the title revision, and the licenses shown by the public API. Every question's latest edit predates 30 November 2022. [Stack Overflow licensing](https://stackoverflow.com/help/licensing) · [Questions API](https://api.stackexchange.com/docs/questions-by-ids) · [Revisions API](https://api.stackexchange.com/docs/revisions-by-ids)

Posts were selected by topic and reviewed against the question bodies. They cover JavaScript, Python, Node.js and TypeScript. The frozen splits have disjoint question IDs. The evaluator excludes all of their threads from both runs when Stack Overflow answers are present in the corpus. Development is available for tuning. Held-out measures the frozen implementation.

The expected evidence groups are case-sensitive alternatives. Each group must match at least one literal in a selected explanation sentence or code block. The runner normalizes whitespace and checks identifier boundaries. It records correct, wrong, and abstained by the question's labelled type. These checks measure whether key APIs, causes, fixes or distinctions are present. The sample is small and selected by topic. A title may omit context from the post body, and a literal match can miss subtle errors.

| Split | SHA-256 |
| --- | --- |
| Development | `e000a3dd3c731bbf3350bb42e2bd3937458441758db818171a8ce96bcba9b895` |
| Held-out | `d7887a7d01032c8725c12024fee66a3cac84aa43cf50309dad82931f59a4dcba` |

```bash
npx tsx scripts/code-knowledge/evaluate.ts --corpus artifacts/code-knowledge/corpus.json --split development
npx tsx scripts/code-knowledge/evaluate.ts --corpus artifacts/code-knowledge/corpus.json --split held-out
```
