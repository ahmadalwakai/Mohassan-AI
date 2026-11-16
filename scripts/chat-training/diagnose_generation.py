"""Bounded read-only diagnosis of saved chat weights, never the frozen holdout."""
from __future__ import annotations

import hashlib
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/execution-pipeline"))
from execution_pipeline.ads_worker import AdsWorker
from execution_pipeline.ads_finetune import encode_pair
from execution_pipeline.chat import conversation_prompt, sha256_file
import torch
import torch.nn.functional as F

RUN = ROOT / "artifacts/execution-model-runs/text-b2-2026-11-12"
DATA = ROOT / "artifacts/chat-training/conversation-v2b/dataset"
OUT = ROOT / "artifacts/chat-training/diagnosis-v3"


def choose(rows, n):
    return sorted(rows, key=lambda r: hashlib.sha256(("diagnosis-v3:" + r["id"]).encode()).hexdigest())[:n]


def main():
    OUT.mkdir(parents=True, exist_ok=False)
    selected = []
    for split in ("train", "validation"):
        rows = [json.loads(line) for line in (DATA / f"{split}.jsonl").read_text(encoding="utf-8").splitlines()]
        for lang in ("ar", "en"):
            group = [r for r in rows if r["language"] == lang]
            if split == "train":
                sampled = choose([r for r in group if r["source"] == "aya_train"], 8)
                for source, n in (("authored_card", 2), ("authored_dialogue", 1), ("systematic_template", 1)):
                    sampled += choose([r for r in group if r["source"] == source], n)
            else:
                sampled = choose(group, 12)
            assert len(sampled) == 12
            selected += [{**r, "diagnostic_split": split} for r in sampled]
    (OUT / "selected.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in selected), encoding="utf-8")
    report = {"scope": "48 fixed training/development examples; no final holdout; no training", "selected_sha256": sha256_file(OUT / "selected.jsonl"), "models": {}, "notes": []}
    for name in ("pretrain", "conversation-v2b"):
        worker = AdsWorker(RUN, "cuda", name)
        encoder, model = worker.encoder, worker.model
        eos = worker.tokenizer.eos_token_id
        totals = defaultdict(lambda: Counter())
        row_metrics = []
        for row in selected:
            prompt = conversation_prompt(row["messages"])
            assert prompt == row["prompt"]
            prompt_ids = encoder.encode(prompt)
            answer_ids = encoder.encode(row["target"]) + [eos]
            ids_list, labels_list = encode_pair(encoder, row)
            assert ids_list == prompt_ids + answer_ids
            ids = torch.tensor([ids_list], device="cuda")
            labels = torch.tensor([labels_list], device="cuda")
            with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
                out = model(ids, labels=labels)
            logits = out.logits[0, :-1].float()
            expected = ids[0, 1:]
            nll = F.cross_entropy(logits, expected, reduction="none")
            correct = logits.argmax(-1) == expected
            boundary = len(prompt_ids) - 1
            answer_nll = nll[boundary:]
            assert abs(float(answer_nll.mean()) - float(out.loss)) < 1e-5
            key = f"{row['diagnostic_split']}:{row['language']}"
            for scope, lo, hi in (("prompt", 0, boundary), ("answer", boundary, len(expected))):
                totals[key][f"{scope}_nll"] += float(nll[lo:hi].sum())
                totals[key][f"{scope}_correct"] += int(correct[lo:hi].sum())
                totals[key][f"{scope}_tokens"] += hi - lo
            totals[key]["first_answer_correct"] += int(correct[boundary])
            totals[key]["eos_correct"] += int(correct[-1])
            totals[key]["rows"] += 1
            decoded = worker.tokenizer.decode_bytes(answer_ids[:-1]).decode("utf-8")
            normalized = row["target"].replace("\u00a0", " ")
            assert decoded == normalized
            totals[key]["answer_chars"] += len(normalized)
            totals[key]["answer_words"] += len(normalized.split())
            # Partial UTF-8 token accuracy can make Arabic token metrics look better
            # without indicating a correctly generated Arabic word.
            partial = []
            for tok in answer_ids[:-1]:
                try:
                    worker.tokenizer.decode_bytes([tok]).decode("utf-8", "strict")
                    partial.append(False)
                except UnicodeDecodeError:
                    partial.append(True)
            totals[key]["partial_utf8_answer_tokens"] += sum(partial)
            row_metrics.append({"id": row["id"], "split": row["diagnostic_split"], "language": row["language"], "source": row["source"],
                                "answer_tokens": len(answer_ids), "answer_loss": float(out.loss), "answer_accuracy": float(correct[boundary:].float().mean()),
                                "first_answer_correct": bool(correct[boundary]), "roundtrip": True})
        summaries = {}
        for key, value in totals.items():
            summary = dict(value)
            for scope in ("prompt", "answer"):
                summary[f"{scope}_loss"] = value[f"{scope}_nll"] / value[f"{scope}_tokens"]
                summary[f"{scope}_accuracy"] = value[f"{scope}_correct"] / value[f"{scope}_tokens"]
            summary["answer_tokens_per_word"] = (value["answer_tokens"] - value["rows"]) / value["answer_words"]
            summary["answer_tokens_per_char"] = (value["answer_tokens"] - value["rows"]) / value["answer_chars"]
            summaries[key] = summary
        parity = []
        for lang in ("ar", "en"):
            row = next(r for r in selected if r["language"] == lang)
            prompt = encoder.encode(row["prompt"])
            expected_answer = encoder.encode(row["target"])
            def forward(values, mask=None):
                with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
                    return model(torch.tensor([values], device="cuda"), attention_mask=None if mask is None else torch.tensor([mask], device="cuda"), last_token_only=True).logits[0, -1].float()
            prefix_logits = forward(prompt)
            with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
                full_logits = model(torch.tensor([prompt + expected_answer[:8]], device="cuda")).logits[0, len(prompt)-1].float()
            left_logits = forward([worker.tokenizer.pad_token_id]*7 + prompt, [False]*7 + [True]*len(prompt))
            right_logits = forward(prompt + [worker.tokenizer.pad_token_id]*7, [True]*len(prompt) + [False]*7)
            generated=[]
            done=False
            for _ in range(16):
                tok=int(forward(prompt+generated).argmax())
                if tok==eos:
                    done=True
                    break
                generated.append(tok)
            direct=worker.tokenizer.decode_bytes(generated).decode("utf-8","replace")
            sampled=worker.sample({"prompt":row["prompt"],"candidates":1,"max_new_tokens":16})[0]
            parity.append({"language":lang,"prefix_vs_teacher_forcing_same_argmax":int(prefix_logits.argmax())==int(full_logits.argmax()),
                           "prefix_vs_teacher_forcing_max_logit_delta":float((prefix_logits-full_logits).abs().max()),
                           "left_padding_same_argmax":int(prefix_logits.argmax())==int(left_logits.argmax()),
                           "right_padding_same_argmax":int(prefix_logits.argmax())==int(right_logits.argmax()),
                           "sampler_matches_direct_greedy":sampled=={"text":direct,"finished":done}})
        greedy=[]
        for split in ("train","validation"):
            for lang in ("ar","en"):
                subset=[r for r in selected if r['diagnostic_split']==split and r['language']==lang]
                # Include an authored row for known-training fit, where available.
                examples=choose(subset,2)
                if split=='train': examples.append(next(r for r in subset if r['source']=='authored_card'))
                else: examples+=choose([r for r in subset if r not in examples],1)
                for row in examples:
                    result=worker.sample({"prompt":row["prompt"],"candidates":1,"max_new_tokens":192})[0]
                    greedy.append({"id":row['id'],"split":split,"language":lang,"source":row['source'],"messages":row['messages'],"target":row['target'],**result,"exact":result['text'].strip()==row['target'].strip()})
        # Vocabulary efficiency is independent of checkpoint weights.
        tokens_with_arabic=0
        for tid in range(worker.tokenizer.vocab_size):
            try: text=worker.tokenizer.decode_bytes([tid]).decode('utf-8')
            except UnicodeDecodeError: continue
            if any('\u0621'<=c<='\u064a' for c in text):tokens_with_arabic+=1
        report['models'][name]={"checkpoint_sha256":worker.checkpoint_sha256,"metrics":summaries,"parity":parity,"vocab_size":worker.tokenizer.vocab_size,"tokens_containing_complete_arabic_character":tokens_with_arabic,"rows":row_metrics,"greedy":greedy}
        (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        print(json.dumps({"model":name,"metrics":summaries,"parity":parity,"complete_arabic_vocab_tokens":tokens_with_arabic}),flush=True)
        del worker,model,out,logits
        torch.cuda.empty_cache()
    report['completed']=True
    report['final_holdout_used']=False
    (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')


if __name__=='__main__':main()
