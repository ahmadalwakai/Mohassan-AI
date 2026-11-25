"""Dense linear weights over sparse binary character and word features."""

from __future__ import annotations

import math

import numpy as np
from scipy.optimize import minimize, minimize_scalar
from scipy.special import logsumexp, softmax
from scipy.sparse import csr_matrix


def logistic(features: csr_matrix, target: np.ndarray, classes: int) -> tuple[np.ndarray, np.ndarray]:
    """Fit multinomial logistic regression from a zero initialization."""
    weights_shape = (features.shape[1], classes)
    sample_weight = 1 / np.sqrt(np.bincount(target, minlength=classes)[target])
    sample_weight /= sample_weight.sum()
    regularization = 0.0001
    row = np.arange(len(target))

    def objective(parameters: np.ndarray) -> tuple[float, np.ndarray]:
        weights = parameters[:-classes].reshape(weights_shape)
        logits = features @ weights + parameters[-classes:]
        normalizers = logsumexp(logits, axis=1)
        loss = sample_weight @ (normalizers - logits[row, target])
        loss += regularization * np.square(weights).sum() / 2
        error = np.exp(logits - normalizers[:, None])
        error[row, target] -= 1
        error *= sample_weight[:, None]
        gradient = features.T @ error + regularization * weights
        return float(loss), np.concatenate((gradient.ravel(), error.sum(axis=0)))

    result = minimize(
        objective,
        np.zeros((features.shape[1] + 1) * classes),
        method="L-BFGS-B",
        jac=True,
        options={"maxiter": 150, "ftol": 1e-8, "gtol": 1e-6},
    )
    if not np.isfinite(result.fun) or (not result.success and result.status != 1):
        raise RuntimeError(f"Logistic optimization failed: {result.message}")
    return result.x[:-classes].reshape(weights_shape), result.x[-classes:]


def perceptron(
    features: csr_matrix, target: np.ndarray, classes: int, seed: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Average the parameter vector after every training example, including correct predictions."""
    random = np.random.default_rng(seed)
    # The extra row is the bias and is active on every example.
    dimensions = features.shape[1]
    weights = np.zeros((dimensions + 1, classes))
    update_times = np.zeros_like(weights)
    step = 0
    for _ in range(5):
        for row in random.permutation(len(target)):
            ids = features.indices[features.indptr[row]:features.indptr[row + 1]]
            actual = target[row]
            guessed = np.argmax(weights[ids].sum(axis=0) + weights[dimensions])
            if actual != guessed:
                for label, change in ((actual, 1), (guessed, -1)):
                    weights[ids, label] += change
                    weights[dimensions, label] += change
                    update_times[ids, label] += change * step
                    update_times[dimensions, label] += change * step
            step += 1
    average = weights - update_times / step
    return average[:-1], average[-1]


def quantize(weights: np.ndarray) -> tuple[np.ndarray, float]:
    scale = (float(np.abs(weights).max()) or 1.0) / 32767
    return np.rint(weights / scale).astype("<i2"), scale


def temperature(logits: np.ndarray, target: np.ndarray) -> float:
    """Minimize multiclass negative log likelihood over one positive scalar."""
    row = np.arange(len(target))

    def loss(log_temperature: float) -> float:
        scaled = logits / math.exp(log_temperature)
        return float((logsumexp(scaled, axis=1) - scaled[row, target]).mean())

    result = minimize_scalar(loss, bounds=(-5, 8), method="bounded", options={"xatol": 1e-9})
    if not result.success:
        raise RuntimeError("Temperature calibration failed")
    return math.exp(result.x)


def acceptance_threshold(probabilities: np.ndarray, target: np.ndarray, minimum_accuracy: float) -> float:
    """Maximize coverage over confident, accurate predictions in every accepted class."""
    confidence = probabilities.max(axis=1)
    guessed = probabilities.argmax(axis=1)
    correct = guessed == target
    order = np.argsort(-confidence, kind="stable")
    # Consider only whole groups of equal scores, since runtime accepts >= threshold.
    ranked_confidence = confidence[order]
    ends = np.flatnonzero(np.r_[ranked_confidence[:-1] != ranked_confidence[1:], True])
    counts = ends + 1
    accuracy = np.cumsum(correct[order])[ends] / counts
    z = 1.96
    lower = (accuracy + z**2 / (2 * counts) - z * np.sqrt(
        (accuracy * (1 - accuracy) + z**2 / (4 * counts)) / counts
    )) / (1 + z**2 / counts)
    by_class = guessed[order, None] == np.arange(probabilities.shape[1])
    class_counts = np.cumsum(by_class, axis=0)[ends]
    class_correct = np.cumsum(by_class & correct[order, None], axis=0)[ends]
    # One prior success and failure stabilize precision when a class has little coverage.
    class_precision = (class_correct + 1) / (class_counts + 2)
    reliable_classes = ((class_counts == 0) | (class_precision >= minimum_accuracy)).all(axis=1)
    eligible = ends[(ranked_confidence[ends] >= minimum_accuracy) & (lower >= minimum_accuracy) & reliable_classes]
    if not eligible.size:
        return math.nextafter(1.0, math.inf)
    last = eligible[-1]
    if last == len(ranked_confidence) - 1:
        return minimum_accuracy
    next_score = float(ranked_confidence[last + 1])
    midpoint = (float(ranked_confidence[last]) + next_score) / 2
    return max(minimum_accuracy, math.nextafter(next_score, math.inf), midpoint)


def macro_f1(guessed: np.ndarray, target: np.ndarray, classes: int) -> float:
    support = np.bincount(target, minlength=classes)
    predicted = np.bincount(guessed, minlength=classes)
    true_positive = np.bincount(target[guessed == target], minlength=classes)
    present = support > 0
    return float(np.mean(2 * true_positive[present] / (support[present] + predicted[present])))


def score(probabilities: np.ndarray, target: np.ndarray, labels: list[str], threshold: float) -> dict:
    guessed = probabilities.argmax(axis=1)
    correct = guessed == target
    confidence = probabilities.max(axis=1)
    accepted = confidence >= threshold
    support = np.bincount(target, minlength=len(labels))
    true_positive = np.bincount(target[correct], minlength=len(labels))
    # Top-label ECE using 15 equal-width bins. Include confidence 1 in the final bin.
    bins = np.minimum((confidence * 15).astype(int), 14)
    residual = np.bincount(bins, weights=confidence - correct, minlength=15)
    return {
        "examples": len(target),
        "macroF1": macro_f1(guessed, target, len(labels)),
        "perClass": {
            label: {"support": int(support[index]),
                    "recall": float(true_positive[index] / support[index]) if support[index] else None}
            for index, label in enumerate(labels)
        },
        "expectedCalibrationError": float(np.abs(residual).sum() / len(target)),
        "accepted": int(accepted.sum()),
        "coverage": float(accepted.mean()),
        "acceptedAccuracy": float(correct[accepted].mean()) if accepted.any() else None,
    }


def predict(logits: np.ndarray, fitted_temperature: float) -> np.ndarray:
    return softmax(logits / fitted_temperature, axis=1)
