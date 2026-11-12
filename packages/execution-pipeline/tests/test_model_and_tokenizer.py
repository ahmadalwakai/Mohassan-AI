"""Step 7: tokenizer and model validation. Tensor checks prove mechanics, not intelligence."""
import json
import math
import sys
from pathlib import Path

import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import execution_pipeline  # noqa: E402,F401

from execution_model.config import ModelConfig, model_preset  # noqa: E402
from execution_model.errors import ContextLengthError, ModelLoadError  # noqa: E402
from execution_model.model import ExecutionModel  # noqa: E402
from execution_model.tokenizer import ByteBPETokenizer  # noqa: E402

CORPUS = [
    "export function applyDelta(value: number | null): number { return value ?? 0; }\n",
    '{"status":"missing_context","fields":["source","destination"]}',
    "مرحبا بالعالم — نموذج تنفيذ محلي",
    "Hello world, the quick brown fox.\n\t  indented\r\nwindows line",
] * 20

SAMPLES = {
    "arabic": "اكتب دالة تعيد صفرًا عند القيمة الفارغة، وإلا أضف الزيادة.",
    "english": "Return the identifier exactly, with no explanation.",
    "typescript": "export const f = <T,>(x: T[]): T | undefined => x.at(-1);\n",
    "json": '{"a":[1,2.5,-0.0,true,null],"b":"\\u0627\\n","c":{"d":"\\"q\\""}}',
    "whitespace": " \t\n\r\n      leading and trailing  \n",
    "escaping": "\\n is not a newline; \\\\ and \\\" and `${x}` and </script>",
    "unfamiliar_identifier": "zxqv_ÆØÅ_$weird9__ident𝔘𝔫𝔦𝔠𝔬𝔡𝔢 <|eos|> <|pad|>",
    "emoji_and_combining": "é 👩‍💻 ﷺ",
}


@pytest.fixture(scope="module")
def tokenizer():
    return ByteBPETokenizer.train(CORPUS, target_vocab_size=8192)


@pytest.mark.parametrize("name", sorted(SAMPLES))
def test_lossless_round_trip(tokenizer, name):
    text = SAMPLES[name]
    ids = tokenizer.encode(text)
    assert tokenizer.decode(ids) == text
    # Literal special-token spellings in user text are bytes, never control tokens.
    assert not set(ids) & set(tokenizer.special_token_ids.values())


def test_arbitrary_bytes_round_trip(tokenizer):
    data = bytes(range(256)) * 3
    assert tokenizer.decode_bytes(tokenizer.encode_bytes(data)) == data


def test_tokenizer_trained_from_scratch_and_identity_stable(tokenizer, tmp_path):
    assert tokenizer.vocab_size > 256 + len(tokenizer.special_token_ids)  # learned merges exist
    path = (tmp_path / "tok.json").resolve()
    tokenizer.save(path)
    loaded = ByteBPETokenizer.load(path)
    assert loaded.identity == tokenizer.identity
    document = json.loads(path.read_text())
    document["merges"][0] = [document["merges"][0][1], document["merges"][0][0]]
    path.write_text(json.dumps(document))
    with pytest.raises(Exception):
        ByteBPETokenizer.load(path)  # tampering breaks the identity check


def small_config(**overrides):
    values = dict(vocab_size=512, hidden_size=64, intermediate_size=128, num_layers=2, num_heads=4,
                  max_context_length=32, seed=7)
    values.update(overrides)
    return ModelConfig(**values)


def test_parameter_count_matches_formula_and_preset():
    model = ExecutionModel(small_config())
    assert model.parameter_count() == small_config().parameter_count()
    preset = model_preset("A", vocab_size=3545, max_context_length=128)
    assert 11_000_000 < preset.parameter_count() < 13_000_000


def test_random_initialization_is_seeded_and_not_pretrained():
    first, second, other = (ExecutionModel(small_config(seed=s)) for s in (7, 7, 8))
    for (name, a), (_, b), (_, c) in zip(first.state_dict().items(), second.state_dict().items(), other.state_dict().items()):
        assert torch.equal(a, b), name
        if "norm" not in name:
            assert not torch.equal(a, c), name
    weights = first.token_embedding.weight.detach()
    assert abs(float(weights.std()) - 0.02) < 0.005 and abs(float(weights.mean())) < 0.005
    assert first.weight_origin == "random_initialized"


def test_causal_masking_future_tokens_do_not_affect_past():
    model = ExecutionModel(small_config()).eval()
    a = torch.tensor([[5, 9, 11, 13, 17, 19]])
    b = a.clone()
    b[0, 4:] = torch.tensor([300, 301])
    with torch.no_grad():
        la, lb = model(a).logits, model(b).logits
    assert torch.allclose(la[:, :4], lb[:, :4], atol=1e-6)
    assert not torch.allclose(la[:, 4:], lb[:, 4:])


def test_loss_at_init_near_uniform_and_decreases_when_overfitting():
    torch.manual_seed(0)
    model = ExecutionModel(small_config())
    ids = torch.randint(0, 512, (2, 16))
    first = float(model(ids, labels=ids).loss)
    assert abs(first - math.log(512)) < 0.5
    optimizer = torch.optim.AdamW(model.parameters(), lr=3e-3)
    for _ in range(60):
        optimizer.zero_grad()
        loss = model(ids, labels=ids).loss
        loss.backward()
        optimizer.step()
    assert float(loss) < first / 4


def test_context_limit_is_enforced_without_truncation():
    model = ExecutionModel(small_config())
    with pytest.raises(ContextLengthError):
        model(torch.zeros((1, 33), dtype=torch.long))


@pytest.mark.skipif(not torch.cuda.is_available(), reason="CUDA not available")
def test_cpu_and_cuda_forward_agree():
    model = ExecutionModel(small_config()).eval()
    ids = torch.tensor([[1, 2, 3, 4, 5]])
    with torch.no_grad():
        cpu = model(ids).logits
        cuda = model.to("cuda")(ids.to("cuda")).logits.cpu()
    assert torch.allclose(cpu, cuda, atol=1e-4)


def test_generation_is_deterministic_greedy():
    from execution_model.generation import GenerationConfig, generate
    model = ExecutionModel(small_config()).eval()
    one = generate(model, [1, 2, 3], GenerationConfig(max_new_tokens=8))
    two = generate(model, [1, 2, 3], GenerationConfig(max_new_tokens=8))
    assert one.token_ids == two.token_ids and one.output_tokens == 8


def test_isolate_digits_and_max_token_bytes_constrain_learned_merges():
    corpus = ["applyDelta123 value + 7;", "applyDelta456 value + 9;", "applyDelta789 value - 3;"] * 30
    constrained = ByteBPETokenizer.train(corpus, target_vocab_size=8192, max_token_bytes=8, isolate_digits=True)
    for token_id in range(256 + len(constrained.special_token_ids), constrained.vocab_size):
        token = constrained.token_bytes(token_id)
        digits = sum(48 <= b <= 57 for b in token)
        assert len(token) <= 8 and digits in (0, len(token))
    unseen = "applyDelta90017 value + 4;"
    assert constrained.decode(constrained.encode(unseen)) == unseen
    # Encoding needs only the merge table: a reloaded tokenizer encodes identically.
    assert ByteBPETokenizer.from_dict(constrained.to_dict()).encode(unseen) == constrained.encode(unseen)
