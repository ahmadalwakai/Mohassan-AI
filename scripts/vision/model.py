"""The OCR network: five 3x3 convolutions, a bidirectional GRU and a CTC head.

Only operations the TypeScript reader implements are used: convolution with
padding 1, ReLU, max pooling, GRU and a linear layer. Batch normalisation is
folded into the convolutions at export time.
"""
from __future__ import annotations

import math

import torch
from torch import nn

CHANNELS = (24, 48, 64, 96, 128)
HIDDEN = 128
HEIGHT = 32
DOWNSAMPLE = 4
# Pooling after each of the five convolutions: height x width factors, None for no pooling.
# The product of the height factors must be 16 (32 rows -> 2) and of the width factors 4.
POOLS: tuple[tuple[int, int] | None, ...] = ((2, 2), (2, 2), None, (2, 1), (2, 1))
# v2: lighter and pooled earlier, about 2.2x fewer multiplications per line in the TypeScript reader.
CHANNELS_V2 = (16, 32, 48, 64, 96)
POOLS_V2: tuple[tuple[int, int] | None, ...] = ((2, 2), (2, 2), (2, 1), None, (2, 1))


class OCRModel(nn.Module):
    def __init__(self, classes: int, channels: tuple[int, ...] = CHANNELS, hidden: int = HIDDEN, pools: tuple[tuple[int, int] | None, ...] = POOLS) -> None:
        super().__init__()
        c1, c2, c3, c4, c5 = channels
        pools = tuple(tuple(p) if p else None for p in pools)
        assert len(pools) == 5 and math.prod(p[0] for p in pools if p) == 16 and math.prod(p[1] for p in pools if p) == DOWNSAMPLE, pools
        self.channels, self.hidden, self.classes, self.pools = tuple(channels), hidden, classes, pools

        def block(i: int, o: int) -> list[nn.Module]:
            return [nn.Conv2d(i, o, 3, 1, 1, bias=False), nn.BatchNorm2d(o), nn.ReLU(inplace=True)]

        layers: list[nn.Module] = []
        for index, (i, o) in enumerate(zip((1, c1, c2, c3, c4), (c1, c2, c3, c4, c5))):
            layers += block(i, o)
            if pools[index]:
                layers.append(nn.MaxPool2d(pools[index], pools[index]))
        self.cnn = nn.Sequential(*layers)
        self.rnn = nn.GRU(c5 * 2, hidden, bidirectional=True, batch_first=True)
        self.fc = nn.Linear(hidden * 2, classes)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        features = self.cnn(x)  # B, C, 2, W/4
        b, c, h, w = features.shape
        # Per time step: channel-major, then the two remaining rows (index c*2 + row).
        sequence = features.permute(0, 3, 1, 2).reshape(b, w, c * h)
        output, _ = self.rnn(sequence)
        return self.fc(output)  # B, T, classes


def fold_batchnorm(model: OCRModel) -> list[tuple[str, torch.Tensor]]:
    """Export-time tensors in a fixed order, with batch norm folded into conv weight and bias."""
    tensors: list[tuple[str, torch.Tensor]] = []
    layers = list(model.cnn)
    conv_index = 0
    for i, layer in enumerate(layers):
        if isinstance(layer, nn.Conv2d):
            bn = layers[i + 1]
            assert isinstance(bn, nn.BatchNorm2d)
            scale = bn.weight.detach() / torch.sqrt(bn.running_var.detach() + bn.eps)
            weight = layer.weight.detach() * scale[:, None, None, None]
            bias = bn.bias.detach() - bn.running_mean.detach() * scale
            tensors.append((f"conv{conv_index}.weight", weight.contiguous()))
            tensors.append((f"conv{conv_index}.bias", bias.contiguous()))
            conv_index += 1
    for name in ["weight_ih_l0", "weight_hh_l0", "bias_ih_l0", "bias_hh_l0", "weight_ih_l0_reverse", "weight_hh_l0_reverse", "bias_ih_l0_reverse", "bias_hh_l0_reverse"]:
        tensors.append((f"rnn.{name}", getattr(model.rnn, name).detach().contiguous()))
    tensors.append(("fc.weight", model.fc.weight.detach().contiguous()))
    tensors.append(("fc.bias", model.fc.bias.detach().contiguous()))
    return tensors


def greedy_decode(logits: torch.Tensor, lengths: torch.Tensor) -> list[list[int]]:
    """CTC greedy decoding: collapse repeats, drop blanks (index 0)."""
    best = logits.argmax(-1).cpu()
    out = []
    for row, length in zip(best, lengths.tolist()):
        previous, chars = 0, []
        for value in row[:length].tolist():
            if value != previous and value != 0:
                chars.append(value)
            previous = value
        out.append(chars)
    return out
