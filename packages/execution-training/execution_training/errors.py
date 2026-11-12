"""Stable failure classifications; messages must not contain training content."""


class TrainingError(RuntimeError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)

