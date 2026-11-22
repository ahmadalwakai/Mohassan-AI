"""The OCR network: five 3x3 convolutions, a bidirectional GRU and a CTC head.

Only operations the TypeScript reader implements are used: convolution with
padding 1, ReLU, max pooling, GRU and a linear layer. Batch normalisation is
folded into the convolutions at export time.
"""
from __future__ import annotations

import torch
from torch import nn

CHANNELS = (24, 48, 64, 96, 128)
HIDDEN = 128
HEIGHT = 32
DOWNSAMPLE = 4


class OCRModel(nn.Module):
    def __init__(self, classes: int, channels: tuple[int, ...] = CHANNELS, hidden: int = HIDDEN) -> None:
        super().__init__()
        c1, c2, c3, c4, c5 = channels
        self.channels, self.hidden, self.classes = tuple(channels), hidden, classes

        def block(i: int, o: int) -> list[nn.Module]:
            return [nn.Conv2d(i, o, 3, 1, 1, bias=False), nn.BatchNorm2d(o), nn.ReLU(inplace=True)]

        self.cnn = nn.Sequential(
            *block(1, c1), nn.MaxPool2d(2, 2),           # 16 x W/2
            *block(c1, c2), nn.MaxPool2d(2, 2),          # 8 x W/4
            *block(c2, c3),
            *block(c3, c4), nn.MaxPool2d((2, 1), (2, 1)),  # 4 x W/4
            *block(c4, c5), nn.MaxPool2d((2, 1), (2, 1)),  # 2 x W/4
        )
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
