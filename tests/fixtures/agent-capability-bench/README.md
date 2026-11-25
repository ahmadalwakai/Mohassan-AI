# Chat capability evaluation corpus

The 300 cases are written directly by the coding agent. Every case carries `provenance.author: agent`. These files are evaluation-only and must never enter training, fine-tuning, or prompt examples used by the product.

`development.json` contains 240 visible cases. `holdout/sealed.json` contains 60 cases gated by the explicit `--sealed` flag. Both partitions have equal Arabic and English counts. The full suite covers all 14 areas and includes MSA, Gulf, Levantine, Egyptian, Iraqi, and mixed-language wording. The holdout was authored after the runner and development cases were frozen. Treat it as an evaluation input and keep it closed during development.

The recorded responses live with the cases. They are compact offline snapshots of public facts or invented evaluation records, with `.test` domains for the latter. The runner checks exact normalized search keys and URL matches. An unknown lookup appears as `fixture-miss`, while a declared empty result represents a successful replay of a search that returned nothing.

Run from the repository root. Install the repository's Playwright Chromium before running PDF cases.

```bash
npm run assistant:capability-bench -- --output artifacts/agent-capability-bench/development.json
npm run assistant:capability-bench -- --sealed tests/fixtures/agent-capability-bench/holdout/sealed.json --output artifacts/agent-capability-bench/audit.json
```

The manifest pins the raw bytes of both corpus files. The ordinary run loads the manifest and the development file. The audit command also validates and executes the holdout. Each report uses a new output path.
