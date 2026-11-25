import math
import unittest

import numpy as np
from scipy.sparse import csr_matrix

from training.linear import acceptance_threshold, logistic, perceptron, predict, quantize, score, temperature


class LinearTest(unittest.TestCase):
    def setUp(self):
        # Numeric optimizer fixture. Public textual training inputs are prepared separately.
        self.features = csr_matrix([[1, 0, 1, 0], [1, 0, 0, 1], [0, 1, 1, 0], [0, 1, 0, 1]])
        self.target = np.array([0, 0, 1, 1])

    def test_training_and_quantization_are_deterministic(self):
        for fit in (lambda: logistic(self.features, self.target, 2),
                    lambda: perceptron(self.features, self.target, 2, 20261125)):
            first_weights, first_bias = fit()
            next_weights, next_bias = fit()
            first_quantized, first_scale = quantize(first_weights)
            next_quantized, next_scale = quantize(next_weights)
            self.assertEqual(first_quantized.tobytes(), next_quantized.tobytes())
            self.assertEqual(first_scale, next_scale)
            np.testing.assert_array_equal(first_bias, next_bias)
            guessed = ((self.features @ first_quantized) * first_scale + first_bias).argmax(axis=1)
            np.testing.assert_array_equal(guessed, self.target)

    def test_perceptron_matches_a_dense_average(self):
        seed = 586
        random = np.random.default_rng(seed)
        dense = np.column_stack((self.features.toarray(), np.ones(len(self.target))))
        current = np.zeros((dense.shape[1], 2))
        states = []
        for _ in range(5):
            for row in random.permutation(len(self.target)):
                actual = self.target[row]
                guessed = np.argmax(dense[row] @ current)
                if guessed != actual:
                    current[:, actual] += dense[row]
                    current[:, guessed] -= dense[row]
                states.append(current.copy())
        weights, bias = perceptron(self.features, self.target, 2, seed)
        np.testing.assert_allclose(np.vstack((weights, bias)), np.mean(states, axis=0))

    def test_calibration_temperature_and_abstention(self):
        logits = np.array([[5, 0], [5, 0], [0, 1], [0, 1]])
        labels = np.array([0, 1, 1, 1])
        fitted = temperature(logits, labels)
        indexes = np.arange(len(labels))
        self.assertGreater(fitted, 1)
        self.assertLess(-np.log(predict(logits, fitted)[indexes, labels]).mean(),
                        -np.log(predict(logits, 1)[indexes, labels]).mean())

        probabilities = np.repeat([[0.97, 0.03], [0.61, 0.39]], [25, 20], axis=0)
        target = np.repeat([0, 1], [25, 20])
        threshold = acceptance_threshold(probabilities, target, 0.80)
        self.assertGreater(threshold, 0.61)
        self.assertLess(threshold, 0.97)
        self.assertEqual(acceptance_threshold(probabilities, 1 - target, 0.80), math.nextafter(1.0, math.inf))

    def test_calibration_does_not_hide_minority_errors(self):
        probabilities = np.repeat([[0.97, 0.03], [0.12, 0.88]], [100, 3], axis=0)
        threshold = acceptance_threshold(probabilities, np.zeros(len(probabilities), dtype=int), 0.80)
        self.assertGreater(threshold, 0.88)
        self.assertLess(threshold, 0.97)

    def test_metrics_report_absent_class_and_ece(self):
        result = score(np.array([[0.8, 0.1, 0.1], [0.1, 0.8, 0.1], [0.6, 0.3, 0.1], [0.1, 0.3, 0.6]]),
                       np.array([0, 1, 1, 0]), ["a", "b", "c"], 0.7)
        self.assertEqual(result["perClass"]["c"], {"support": 0, "recall": None})
        self.assertEqual(result["perClass"]["a"], {"support": 2, "recall": 0.5})
        self.assertEqual(result["accepted"], 2)
        self.assertEqual(result["acceptedAccuracy"], 1)
        self.assertAlmostEqual(result["macroF1"], (0.5 + 2 / 3) / 2)
        self.assertAlmostEqual(result["expectedCalibrationError"], 0.4)
