# Capability benchmark v2 sealed release

**Benchmark honor rule.** Keep this directory closed during development. Do not read, search, sample, train on, tune against, or use it to debug a change. Freeze the candidate commit and its evaluation settings before running v2. Run v2 once for that frozen candidate and retain the aggregate receipt. Run the ordinary v1 development benchmark for iteration.

The rule governs benchmark use. The license and attribution for reuse are in [the attribution bundle](attribution/ATTRIBUTION.md). The committed seal is procedural because the payload and sampling seed are available to anyone with the checkout. The SHA-256 manifest detects changes to the released bytes.

From the repository root, after dependencies are installed, use an unused output path for the frozen candidate's receipt.

```bash
npm run assistant:capability-bench -- --version 2 \
  --sealed tests/fixtures/agent-capability-bench/v2/sealed/payload.json \
  --output artifacts/agent-capability-bench/v2-frozen-candidate.json
```

The held-out payload contains 1,200 cases. The original seed is included as a binary file. Use the import and comparison commands in the audit to verify portability while acting as release custodian. [SHA-256 manifest](../../../../../scripts/agent-capability-bench/v2/manifest.json) · [Import accounting](accounting.json) · [Data cards](../../../../../docs/CAPABILITY-BENCH-V2-DATA.md) · [Baseline audit](../../../../../docs/CAPABILITY-BENCH-V2-2026-11-25.md)
