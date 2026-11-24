"""The cached decoder computes the reference decoder's function: same tokens, logits within float rounding."""
from pathlib import Path
import sys

import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import execution_pipeline  # noqa: F401  (puts the sibling execution_model package on sys.path)
from execution_model.cached_generation import _Cache, _forward, generate_cached
from execution_model.config import ModelConfig
from execution_model.errors import ContextLengthError
from execution_model.generation import GenerationConfig, generate
from execution_model.model import ExecutionModel


def small_model(seed=11):
    torch.manual_seed(seed)
    model = ExecutionModel(ModelConfig(vocab_size=256, hidden_size=48, intermediate_size=96, num_layers=3,
                                       num_heads=4, max_context_length=96, seed=seed)).eval()
    with torch.no_grad():  # sharper logits than a fresh initialisation, so greedy choices are not near-ties
        model.token_embedding.weight.mul_(6.0)
    return model


@pytest.mark.parametrize("prompt", [[5], [1, 2, 3, 4, 5, 6, 7], list(range(10, 40)), [60] * 12])
def test_cached_and_reference_decoders_choose_the_same_tokens(prompt):
    model = small_model()
    config = GenerationConfig(max_new_tokens=40)
    reference = generate(model, prompt, config)
    cached = generate_cached(model, prompt, config)
    assert cached.token_ids == reference.token_ids
    assert cached.stop_reason == reference.stop_reason == "length"
    assert cached.output_tokens == reference.output_tokens == 40


def test_every_step_logit_matches_a_full_recompute_within_float_rounding():
    model = small_model(seed=3)
    sequence = [4, 8, 15, 16, 23, 42]
    with torch.inference_mode():
        cache = _Cache(model, 40, torch.device("cpu"), torch.float32)
        pending, worst = list(sequence), 0.0
        for _ in range(20):
            cached = _forward(model, pending, cache, torch.device("cpu"))
            full = model(torch.tensor([sequence]), last_token_only=True).logits[0, -1]
            worst = max(worst, float((cached - full).abs().max()))
            token = int(torch.argmax(full))
            sequence.append(token)
            pending = [token]
    assert worst < 1e-4


def test_eos_stops_both_decoders_at_the_same_token():
    model = small_model(seed=5)
    prompt = [3, 1, 4, 1, 5]
    free = generate(model, prompt, GenerationConfig(max_new_tokens=30))
    eos = free.token_ids[7]
    reference = generate(model, prompt, GenerationConfig(max_new_tokens=30), eos_token_id=eos)
    cached = generate_cached(model, prompt, GenerationConfig(max_new_tokens=30), eos_token_id=eos)
    assert cached.token_ids == reference.token_ids
    assert cached.stop_reason == reference.stop_reason == "eos" and cached.terminal_token_id == eos


def test_prompt_and_budget_beyond_the_context_are_refused_like_the_reference():
    model = small_model()
    with pytest.raises(ContextLengthError):
        generate_cached(model, list(range(90)), GenerationConfig(max_new_tokens=10))
