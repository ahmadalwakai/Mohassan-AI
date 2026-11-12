"""Stable Python boundary errors; messages never include prompts or tensor data."""

from __future__ import annotations

from typing import Any


class ExecutionModelError(Exception):
    code = "EXECUTION_MODEL_ERROR"

    def __init__(self, message: str, *, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.details = dict(details or {})

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": str(self), "details": self.details}


class ConfigurationError(ExecutionModelError):
    code = "INVALID_CONFIGURATION"


class InvalidRequestError(ExecutionModelError):
    code = "INVALID_REQUEST"


class UnsupportedRequestError(ExecutionModelError):
    code = "UNSUPPORTED_REQUEST"


class ContextLengthError(ExecutionModelError):
    code = "CONTEXT_OVERFLOW"


class TokenizerError(ExecutionModelError):
    code = "TOKENIZER_ERROR"


class ConstraintError(ExecutionModelError):
    code = "CONSTRAINT_UNSATISFIABLE"


class ModelLoadError(ExecutionModelError):
    code = "MODEL_LOAD_FAILED"


class ModelNotLoadedError(ExecutionModelError):
    code = "MODEL_NOT_LOADED"


class ResourceError(ExecutionModelError):
    code = "RESOURCE_ERROR"


class NumericalError(ExecutionModelError):
    code = "NONFINITE_MODEL_OUTPUT"
