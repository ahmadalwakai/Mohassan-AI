"""Five explicit curriculum stages; future specializations are opt-in modules."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping, Any

from .errors import TrainingError
from .schemas import TrainingExample

STAGE_ORDER = ("A", "B", "C", "D", "E")
STAGE_FAMILIES = {
    "A": frozenset({"identifier_copy", "value_preservation", "structured_operations", "missing_context", "unsupported_task"}),
    "B": frozenset({"typescript_function", "input_validation", "boundary_conditions", "type_transform"}),
    "C": frozenset({"repair"}),
    "D": frozenset({"skill_composition"}),
    "E": frozenset({"future_specialization"}),
}
STAGE_DESCRIPTIONS = {
    "A": "Exact identifiers and numeric values; structured operations; required fields; missing context and unsupported tasks.",
    "B": "Small TypeScript functions, explicit contracts and imports, null/undefined, boundaries and type preservation.",
    "C": "Verified corrections from failed candidates and concrete failure evidence; preserve regression tests and typechecking.",
    "D": "Two or three operations, novel combinations, dependency ordering, multistep transformations and limited multifile tasks.",
    "E": "Separately authorized React/Next.js, full-stack, Google Ads, iOS or Android datasets and independent evaluation.",
}
FUTURE_SPECIALIZATIONS = frozenset({"react", "nextjs", "full_stack", "google_ads", "ios", "android"})


def validate_stage(example: TrainingExample) -> None:
    stage = example.curriculum_stage
    if stage not in STAGE_FAMILIES or example.task_family not in STAGE_FAMILIES[stage]:
        raise TrainingError("INVALID_CURRICULUM", "Task family is not valid for its declared curriculum stage.")
    if stage == "C" and example.repair is None:
        raise TrainingError("INVALID_REPAIR", "Repair curriculum requires failed input and verified correction evidence.")
    if stage != "C" and example.repair is not None:
        raise TrainingError("INVALID_CURRICULUM", "Repair examples must be classified as Stage C.")
    if stage == "E" and example.operation_category not in FUTURE_SPECIALIZATIONS:
        raise TrainingError("INVALID_SPECIALIZATION", "Stage E requires an explicitly registered specialization category.")


@dataclass(frozen=True)
class StageBudget:
    stage: str
    processed_tokens: int

    def __post_init__(self) -> None:
        if self.stage not in STAGE_ORDER or type(self.processed_tokens) is not int or self.processed_tokens <= 0:
            raise TrainingError("INVALID_CURRICULUM", "A curriculum stage needs a positive processed-token budget.")

    def to_dict(self) -> dict:
        return {"stage": self.stage, "processed_tokens": self.processed_tokens}


@dataclass(frozen=True)
class FutureSpecialization:
    """Registration references, NOT a claim that a model has passed evaluation."""
    name: str
    dataset_version: str
    evaluation_reference: str
    authorization_reference: str

    def __post_init__(self) -> None:
        if self.name not in FUTURE_SPECIALIZATIONS or any(type(value) is not str or not value.strip() for value in (
            self.dataset_version, self.evaluation_reference, self.authorization_reference,
        )):
            raise TrainingError("INVALID_SPECIALIZATION", "Future specializations require a separate dataset, evaluation reference and authorization.")

    def to_dict(self) -> dict:
        return {"name": self.name, "dataset_version": self.dataset_version,
                "evaluation_reference": self.evaluation_reference, "authorization_reference": self.authorization_reference}


@dataclass(frozen=True)
class CurriculumPlan:
    stages: tuple[StageBudget, ...]
    replay_previous: bool = True
    future_specializations: tuple[FutureSpecialization, ...] = ()

    def __post_init__(self) -> None:
        if not self.stages or any(not isinstance(item, StageBudget) for item in self.stages):
            raise TrainingError("INVALID_CURRICULUM", "A curriculum needs at least one StageBudget.")
        names = tuple(item.stage for item in self.stages)
        if len(set(names)) != len(names) or names != tuple(sorted(names, key=STAGE_ORDER.index)):
            raise TrainingError("INVALID_CURRICULUM", "Curriculum stages must be unique and ordered A through E.")
        if type(self.replay_previous) is not bool:
            raise TrainingError("INVALID_CURRICULUM", "replay_previous must be a boolean.")
        if any(not isinstance(item, FutureSpecialization) for item in self.future_specializations):
            raise TrainingError("INVALID_SPECIALIZATION", "Future modules must be explicitly registered.")
        module_names = [item.name for item in self.future_specializations]
        if len(module_names) != len(set(module_names)):
            raise TrainingError("INVALID_SPECIALIZATION", "A future specialization may be registered once.")
        if "E" in names and not self.future_specializations:
            raise TrainingError("FUTURE_SPECIALIZATION_DISABLED", "Stage E is disabled without separate dataset, evaluation and authorization references.")
        if "E" not in names and self.future_specializations:
            raise TrainingError("INVALID_CURRICULUM", "Future-specialization registrations require an explicit Stage E budget.")

    @property
    def processed_token_budget(self) -> int:
        return sum(item.processed_tokens for item in self.stages)

    def stage_for_tokens(self, processed_tokens: int) -> str | None:
        if type(processed_tokens) is not int or processed_tokens < 0:
            raise TrainingError("INVALID_TOKEN_COUNT", "Processed token count must be a nonnegative integer.")
        boundary = 0
        for stage in self.stages:
            boundary += stage.processed_tokens
            if processed_tokens < boundary:
                return stage.stage
        return None

    def eligible_examples(self, examples: Iterable[TrainingExample], stage: str) -> tuple[TrainingExample, ...]:
        planned = {item.stage for item in self.stages}
        if stage not in planned:
            raise TrainingError("INVALID_CURRICULUM", "Requested stage is not in the curriculum plan.")
        allowed = {value for value in planned if STAGE_ORDER.index(value) <= STAGE_ORDER.index(stage)} if self.replay_previous else {stage}
        registered = {item.name for item in self.future_specializations}
        result: list[TrainingExample] = []
        for example in examples:
            validate_stage(example)
            if example.curriculum_stage not in allowed:
                continue
            if example.curriculum_stage == "E" and example.operation_category not in registered:
                raise TrainingError("FUTURE_SPECIALIZATION_DISABLED", "A Stage E example has no explicit module registration.")
            result.append(example)
        return tuple(sorted(result, key=lambda item: item.sample_id))

    def validate_dataset(self, examples: Iterable[TrainingExample], dataset_version: str) -> None:
        records = tuple(examples)
        for example in records:
            validate_stage(example)
        for registration in self.future_specializations:
            if registration.dataset_version != dataset_version:
                raise TrainingError("DATASET_MANIFEST_CHANGED", "Future-specialization registration references a different dataset version.")
        for budget in self.stages:
            current = tuple(example for example in records if example.curriculum_stage == budget.stage)
            if not current:
                raise TrainingError("EMPTY_CURRICULUM_STAGE", "Every enabled stage requires its own examples; replay alone does not establish stage coverage.")
            self.eligible_examples(current, budget.stage)

    def to_dict(self) -> dict:
        return {"schema_version": "execution-curriculum-v1",
                "stages": [item.to_dict() for item in self.stages],
                "replay_previous": self.replay_previous,
                "future_specializations": [item.to_dict() for item in self.future_specializations]}

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "CurriculumPlan":
        if not isinstance(raw, Mapping) or set(raw) != {"schema_version", "stages", "replay_previous", "future_specializations"} or raw["schema_version"] != "execution-curriculum-v1":
            raise TrainingError("INVALID_CURRICULUM", "Curriculum schema is invalid.")
        if not isinstance(raw["stages"], (list, tuple)) or not isinstance(raw["future_specializations"], (list, tuple)):
            raise TrainingError("INVALID_CURRICULUM", "Curriculum stages and modules must be arrays.")
        stages: list[StageBudget] = []
        modules: list[FutureSpecialization] = []
        for value in raw["stages"]:
            if not isinstance(value, Mapping) or set(value) != {"stage", "processed_tokens"}:
                raise TrainingError("INVALID_CURRICULUM", "Stage budget fields are invalid.")
            stages.append(StageBudget(**value))
        for value in raw["future_specializations"]:
            if not isinstance(value, Mapping) or set(value) != {"name", "dataset_version", "evaluation_reference", "authorization_reference"}:
                raise TrainingError("INVALID_SPECIALIZATION", "Specialization fields are invalid.")
            modules.append(FutureSpecialization(**value))
        return cls(tuple(stages), raw["replay_previous"], tuple(modules))

    @classmethod
    def for_budget(cls, processed_tokens: int, stages: tuple[str, ...] = ("A", "B")) -> "CurriculumPlan":
        """Equal experimental budgets; these are not verified optimal allocations."""
        if type(processed_tokens) is not int or not stages or processed_tokens < len(stages):
            raise TrainingError("INVALID_CURRICULUM", "Budget must cover every requested stage.")
        quotient, remainder = divmod(processed_tokens, len(stages))
        return cls(tuple(StageBudget(stage, quotient + (index < remainder)) for index, stage in enumerate(stages)))
