"""Smoke test of the Phase 2/3 seam: scratch tokenizer, synthetic data, tiny real training."""
import json, sys, tempfile, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import execution_pipeline  # noqa
import torch
from execution_model.tokenizer import ByteBPETokenizer
from execution_training.provenance import LocalEvidenceStore
from execution_training.schemas import UsageAuthorization
from execution_training.synthetic import generate_synthetic, synthetic_family_plan, DOMAINS
from execution_training.splitting import reserve_families
from execution_training.privacy import PrivacyPolicy
from execution_training.dataset import prepare_dataset
from execution_training.curriculum import CurriculumPlan
from execution_training.configuration import preset_config
from execution_training.tokenization import TokenizerAdapter, render_prompt
from execution_training.training import train
from execution_pipeline.bridge import Phase2TokenizerBridge, execution_model_factory
from execution_model.config import ARCHITECTURE_VERSION

work = Path(tempfile.mkdtemp(prefix="smoke-"))
store = LocalEvidenceStore(work / "evidence")
auth = UsageAuthorization("project-owned-synthetic", "owner-approval-pending-smoke", "smoke", ("training","validation","evaluation"), True, "synthetic", None, None)
plan = synthetic_family_plan()
res = reserve_families([(v["project_family"], v["template_family"]) for v in plan.values()], dataset_version="smoke-1", seed=17,
    explicit_assignments={"project:synthetic-v1:unsupported_task":"test","template:synthetic-v1:unsupported_task":"test",
                          "project:synthetic-v1:missing_context":"validation","template:synthetic-v1:missing_context":"validation"})
scopes = {"unsupported_task":"test","missing_context":"validation"}
t=time.time()
ex = list(generate_synthetic(seed=1, count_per_domain=20, authorization=auth, evidence_store=store, collected_at="2026-11-12T00:00:00Z", evidence_scope_by_domain=scopes))
print("examples", len(ex), "gen s", round(time.time()-t,1))
ds = prepare_dataset(ex, dataset_version="smoke-1", evidence_resolver=store, privacy_policy=PrivacyPolicy(), seed=17, reserved_families=res)
print({s: len(ds.for_split(s)) for s in ("train","validation","test")})
corpus = [render_prompt(e)+e.expected_output for e in ds.for_split("train")]
tok = ByteBPETokenizer.train(corpus, target_vocab_size=8192, max_corpus_bytes=8_000_000)
print("vocab", tok.vocab_size, tok.identity[:12])
adapter = TokenizerAdapter(Phase2TokenizerBridge(tok))
cur = CurriculumPlan.for_budget(60_000, ("A","B"))
cfg = preset_config("17m", architecture_id=ARCHITECTURE_VERSION, device="cuda", precision="fp16", max_processed_tokens=60_000,
    warmup_tokens=5_000, checkpoint_interval_steps=2, validation_interval_steps=2, deterministic_algorithms=False, profile_enabled=True, gradient_accumulation_steps=4)
rep = train(config=cfg, dataset=ds, evidence_resolver=store, privacy_policy=PrivacyPolicy(), curriculum=cur, tokenizer=adapter,
    model_factory=execution_model_factory, output_directory=work/"run", handle_signals=False)
print(rep["status"], rep["failure_code"], rep["state"])
print(json.dumps(rep["resources"], default=str)[:800])
print([round(m["mean_token_loss"],3) for m in rep["recent_metrics"]][:12])
