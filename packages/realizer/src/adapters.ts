import type { JudgeDecision } from "../../../apps/server/src/assistant/judge.js";
import type { LocalComputation } from "../../../apps/server/src/assistant/local-computation.js";
import type {
  AnswerFrame, CalendarDate, DeclineReason, Entity, LocalizedText, Noun, Presentation, Source, Value,
} from "./frame.js";

// These projections accept the sibling PRs' outputs structurally. Production code has no call sites.
type FactFrame = Extract<AnswerFrame, { intent: "fact" }>;
type FactSubject = Pick<FactFrame, "subject" | "property">;
type UnitLookup = (id: string) => Noun | undefined;

function literal(text: string): LocalizedText {
  return { ar: text, en: text };
}

function decline(presentation: Presentation, reason: DeclineReason, subject?: Entity): AnswerFrame {
  return { ...presentation, intent: "decline", reason, subject };
}

// #18, apps/server/src/assistant/structured-evidence{,-parsing}.ts at 0915bdc450fbad52ac2ed74ebf6c73417c872b.
interface EvidenceDate {
  readonly calendar: CalendarDate["calendar"];
  readonly year: number;
  readonly month?: number;
  readonly day?: number;
}

type EvidenceValue =
  | { readonly kind: "number"; readonly value: number; readonly unit: string }
  | { readonly kind: "range"; readonly min: number; readonly max: number; readonly unit: string }
  | { readonly kind: "date"; readonly date: EvidenceDate };

interface EvidenceCandidate {
  readonly value: EvidenceValue;
  readonly evidence: { readonly title: string; readonly url: string };
  readonly referenceTime: EvidenceDate | null;
  readonly approximate: boolean;
}

interface StructuredEvidenceOutput {
  readonly status: "value" | "conflict" | "gap";
  readonly top: EvidenceCandidate | null;
  readonly conflicts: readonly { readonly first: EvidenceCandidate; readonly second: EvidenceCandidate }[];
}

function evidenceDate(date: EvidenceDate): CalendarDate | undefined {
  const { calendar, year, month, day } = date;
  if (month !== undefined) return { calendar, year, month, day };
  if (day === undefined) return { calendar, year };
}

function evidenceClaim(candidate: EvidenceCandidate, units: UnitLookup) {
  const { value, approximate, referenceTime, evidence } = candidate;
  const date = value.kind === "date" ? evidenceDate(value.date) : undefined;
  const unit = value.kind !== "date" ? units(value.unit) : undefined;
  let rendered: Value;
  if (value.kind === "date" && date) rendered = { kind: "date", date };
  else if (value.kind === "number" && unit) rendered = { kind: "number", amount: value.value, unit };
  else if (value.kind === "range" && unit) rendered = { kind: "range", min: value.min, max: value.max, unit };
  else return undefined;
  const asOf = referenceTime ? evidenceDate(referenceTime) : undefined;
  if (referenceTime && !asOf) return undefined;
  const source: Source = { label: literal(evidence.title || evidence.url), url: evidence.url };
  return { source, value: rendered, approximate, asOf };
}

/** The caller supplies the verified target nouns and unit vocabulary. Only the selected observation is cited on success. */
export function fromStructuredEvidence(
  presentation: Presentation, target: FactSubject, result: StructuredEvidenceOutput, units: UnitLookup,
): AnswerFrame {
  if (result.status === "gap") return decline(presentation, "missing-evidence", target.subject);
  if (result.status === "conflict") {
    // Use an actual conflicting pair. The top observation is not necessarily involved in any conflict.
    const pair = result.conflicts.find(item => item.first === result.top || item.second === result.top) ?? result.conflicts[0];
    const first = pair && evidenceClaim(pair.first, units);
    const second = pair && evidenceClaim(pair.second, units);
    if (!first || !second) return decline(presentation, "unverified", target.subject);
    return { ...presentation, ...target, intent: "disagreement", claims: [first, second] };
  }
  const claim = result.top && evidenceClaim(result.top, units);
  if (!claim) return decline(presentation, "unsupported", target.subject);
  return {
    ...presentation, ...target, intent: "fact", value: claim.value, asOf: claim.asOf,
    sources: [claim.source], certainty: claim.approximate ? "single-source-approximate" : "single-source",
  };
}

// #26, apps/server/src/assistant/reasoning/{result,calendar}.ts at 5ccc61789b9a3ba93891897037e0e6b38fa6cd2f.
type ReasoningOutput = Pick<LocalComputation, "claims" | "evidence" | "lang"> & {
  readonly status: "completed" | "blocked";
};

// Keep the value exact at the frame's number representation. Large integers and decimals that round are unsupported.
function exactDecimal(raw: string): number | undefined {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/u.exec(raw);
  if (!match) return undefined;
  const [, sign, integral, fraction = ""] = match;
  const whole = integral.replace(/^0+(?=\d)/u, "");
  const fractional = fraction.replace(/0+$/u, "");
  const magnitude = fractional ? `${whole}.${fractional}` : whole;
  const canonical = sign === "-" && magnitude !== "0" ? `-${magnitude}` : magnitude;
  const amount = Number(canonical);
  if (String(amount) === canonical && (!Number.isInteger(amount) || Number.isSafeInteger(amount))) return amount;
}

/** The admitted operation supplies the expected value shape and target calendar. Comparison prose supplies neither. */
export function fromReasoning(
  presentation: Omit<Presentation, "language">, result: ReasoningOutput,
  shape: { readonly kind: "number"; readonly unit?: Noun; readonly approximate?: boolean }
    | { readonly kind: "calendar-conversion"; readonly calendar: CalendarDate["calendar"] },
): AnswerFrame {
  const style = { ...presentation, language: result.lang };
  if (result.status === "blocked") return decline(style, "missing-evidence");
  const resultId = "reasoning-result";
  const claim = result.claims.find(item => item.status === "confirmed" && item.support.includes(resultId));
  if (!claim) return decline(style, "unverified");
  const raw = result.evidence.find(item => item.id === resultId && item.source === "computed")?.value;
  if (raw === undefined) return decline(style, "unverified");
  const sources = result.evidence.filter(item => item.url && claim.support.includes(item.id))
    .map(item => ({ label: literal(item.title || item.url!), url: item.url }));
  if (shape.kind === "calendar-conversion") {
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(raw);
    if (!iso) return decline(style, "unsupported");
    const date = { calendar: shape.calendar, year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
    return { ...style, intent: "calculation", certainty: "approximate", sources, value: { kind: "date", date } };
  }
  const amount = exactDecimal(raw);
  if (amount === undefined) return decline(style, "unsupported");
  return {
    ...style, intent: "calculation", certainty: shape.approximate ? "approximate" : "verified", sources,
    value: { kind: "number", amount, unit: shape.unit },
  };
}

// #24, apps/server/src/assistant/plan/{executor,types}.ts at ccec5a67f543454fb214d0691e9fe1226da41b03.
type PlanValue =
  | { readonly type: "number"; readonly value: number; readonly unit?: string }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "list"; readonly value: readonly string[] }
  | { readonly type: "file" | "entity"; readonly value: string; readonly label?: string };

type StepOutcome =
  | { readonly stepId: string; readonly status: "succeeded"; readonly value: PlanValue }
  | { readonly stepId: string; readonly status: "failed"; readonly reason: string }
  | { readonly stepId: string; readonly status: "skipped" };

interface PlanExecutionOutput {
  readonly status: "completed" | "partial" | "blocked";
  readonly steps: readonly StepOutcome[];
}

function planValue(value: PlanValue, units: UnitLookup): Value | undefined {
  switch (value.type) {
    case "number": {
      const unit = value.unit === undefined ? undefined : units(value.unit);
      if (value.unit === undefined || unit) return { kind: "number", amount: value.value, unit };
      return undefined;
    }
    case "text": return { kind: "text", text: literal(value.value) };
    case "list": return { kind: "text", text: { ar: value.value.join("، "), en: value.value.join(", ") } };
    case "file": return { kind: "text", text: literal(value.label || value.value) };
    case "entity": return { kind: "entity", entity: { kind: "name", name: literal(value.label || value.value) } };
  }
}

/** Supply step labels from the admitted plan. The adapter does not use the executor's prewritten summary. */
export function fromPlanExecution(
  presentation: Presentation, plan: Entity, result: PlanExecutionOutput,
  labels: ReadonlyMap<string, Entity>, units: UnitLookup,
): AnswerFrame {
  type Step = NonNullable<Extract<AnswerFrame, { intent: "plan" }>["steps"]>[number];
  const steps: Step[] = [];
  for (const outcome of result.steps) {
    const step = labels.get(outcome.stepId);
    if (!step) continue;
    if (outcome.status === "succeeded") {
      steps.push({ step, status: "completed", value: planValue(outcome.value, units) });
    } else {
      const status = outcome.status === "failed" && outcome.reason === "unknown_effect" ? "unverified" : outcome.status;
      steps.push({ step, status });
    }
  }
  return { ...presentation, intent: "plan", plan, status: result.status, steps };
}

// #31, apps/server/src/assistant/structured-memory-storage.ts at c365b368446e178a15d39de55ec736e5f1343bff.
type StructuredMemoryOutput =
  | { readonly kind: "saved" | "unchanged" | "recalled"; readonly fact: {
    readonly date: Date; readonly value: string; readonly since: string | null; readonly until: string | null;
  } }
  | { readonly kind: "missing" | "ambiguous" | "forgotten" };

/** Uses a memory already read back by the producer. The UTC date records the save, not the fact's validity. */
export function fromStructuredMemory(
  presentation: Presentation, target: FactSubject, result: StructuredMemoryOutput,
): AnswerFrame {
  if (!("fact" in result)) {
    const reason = result.kind === "missing" ? "missing-evidence" : result.kind === "ambiguous" ? "unverified" : "unsupported";
    return decline(presentation, reason, target.subject);
  }
  const { date, value, since, until } = result.fact;
  // The producer keeps these qualifiers verbatim. They are not necessarily complete dates.
  if (since || until || !Number.isFinite(date.getTime())) return decline(presentation, "unsupported", target.subject);
  const recordedOn = { calendar: "gregorian" as const, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  return { ...presentation, ...target, intent: "memory", value: { kind: "text", text: literal(value) }, recordedOn };
}

// #38, packages/knowledge-base/src/{query,types}.ts at 9bdec96ef5f194646e19c9e1cb33642365dac9f2.
interface KnowledgeFact {
  readonly statement: {
    readonly rank: "preferred" | "normal" | "deprecated";
    readonly snak: { readonly snaktype: "value" | "somevalue" | "novalue"; readonly datavalue?: {
      readonly type: string; readonly value: unknown;
    } };
  };
  readonly source: { readonly dataset: "wikidata"; readonly url: string };
}

/** Example for representable Wikibase quantities. The caller supplies the vocabulary for the property and unit IDs. */
export function fromKnowledgeFact(
  presentation: Presentation, target: FactSubject, fact: KnowledgeFact, units: UnitLookup,
): AnswerFrame {
  const { snak, rank } = fact.statement;
  if (snak.snaktype !== "value" || rank === "deprecated") return decline(presentation, "missing-evidence", target.subject);
  const raw = snak.datavalue?.value;
  if (snak.datavalue?.type !== "quantity" || !raw || typeof raw !== "object" || Array.isArray(raw) || !("amount" in raw) || !("unit" in raw)
    || typeof raw.amount !== "string" || typeof raw.unit !== "string") return decline(presentation, "unsupported", target.subject);
  const amount = exactDecimal(raw.amount);
  const unit = raw.unit === "1" ? undefined : units(raw.unit);
  if (amount === undefined || (raw.unit !== "1" && !unit)) return decline(presentation, "unsupported", target.subject);
  const bounds = ["lowerBound" in raw ? raw.lowerBound : undefined, "upperBound" in raw ? raw.upperBound : undefined];
  const approximate = bounds.some(bound => bound != null && (typeof bound !== "string" || exactDecimal(bound) !== amount));
  return {
    ...presentation, ...target, intent: "fact", value: { kind: "number", amount, unit },
    sources: [{ label: literal(fact.source.dataset), url: fact.source.url }],
    certainty: approximate ? "single-source-approximate" : "single-source",
  };
}

// #27, apps/server/src/assistant/truth-judge.ts at 7eb3713c42a1a7ab7dc0a666cf3b8cd97b271e2b.
interface TruthOutput {
  readonly decision: JudgeDecision;
  readonly source: "not_needed" | "single_source" | "confirmed" | "conflict";
  readonly measured: boolean;
  readonly repaired: boolean;
}

/** The verdict qualifies a previously verified structured fact. Replacement prose cannot identify retained facts. */
export function fromTruthChecks(
  presentation: Presentation, verdict: TruthOutput,
  fact: Pick<FactFrame, "subject" | "property" | "value" | "asOf" | "certainty">,
): AnswerFrame {
  if (verdict.decision === "withhold" || verdict.source === "conflict" || !verdict.measured || verdict.repaired) {
    return decline(presentation, "unverified", fact.subject);
  }
  const approximate = fact.certainty === "approximate" || fact.certainty === "single-source-approximate";
  let certainty = fact.certainty;
  if (verdict.source === "single_source") certainty = approximate ? "single-source-approximate" : "single-source";
  if (verdict.source === "confirmed") certainty = approximate ? "approximate" : "verified";
  return { ...presentation, ...fact, intent: "fact", certainty };
}
