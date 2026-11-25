import { describe, expect, it } from "vitest";
import {
  fromKnowledgeFact, fromPlanExecution, fromReasoning, fromStructuredEvidence, fromStructuredMemory, fromTruthChecks,
} from "../packages/realizer/src/adapters.js";
import type { Entity, Noun, Presentation } from "../packages/realizer/src/frame.js";
import { realize } from "../packages/realizer/src/index.js";

// Development-only contract fixtures, constructed locally from literal inputs and arithmetic. Never training data.
const presentation: Presentation = { language: "en", conversationSeed: "producer-contracts", length: "detailed" };
const name = (en: string, ar: string): Entity => ({ kind: "name", name: { en, ar } });
const target = { subject: name("Archive", "الأرشيف") };
const unit: Noun = { en: { singular: "meter" }, ar: { singular: "متر", plural: "أمتار", gender: "masculine" } };
const findUnit = (id: string) => id === "m" || id === "http://www.wikidata.org/entity/Q11573" ? unit : undefined;
const magnitude = 6 * 7;
const date = { calendar: "gregorian", year: 2024, month: 3, day: 5 } as const;
const sourceDate = new Date(Date.UTC(date.year, date.month - 1, date.day));
const unusedProse = "The unselected Robot recorded 873 units in 2099.";

describe("structured evidence adapter", () => {
  const first = {
    value: { kind: "number", value: magnitude, unit: "m" },
    approximate: true, referenceTime: date,
    evidence: { title: "Archive Register", url: "https://register.example/" },
  } as const;
  const second = {
    value: { kind: "range", min: magnitude + 1, max: magnitude + 2, unit: "m" },
    approximate: false, referenceTime: date,
    evidence: { title: "Survey Register", url: "https://survey.example/" },
  } as const;

  it("uses the selected value, stated date, approximation, and single source", () => {
    const frame = fromStructuredEvidence(presentation, target, { status: "value", top: first, conflicts: [] }, findUnit);
    expect(frame).toMatchObject({
      intent: "fact", value: { kind: "number", amount: magnitude, unit }, asOf: date,
      certainty: "single-source-approximate", sources: [{ label: { en: first.evidence.title }, url: first.evidence.url }],
    });
    expect(realize(frame)).toContain(`${magnitude} meters`);
    expect(realize(frame)).toContain("March 5, 2024");
  });

  it("keeps mismatched values attached to the two actual conflicting sources", () => {
    const unrelated = { ...first, referenceTime: null, evidence: { title: "Other", url: "https://other.example/" } };
    const frame = fromStructuredEvidence(presentation, target, {
      status: "conflict", top: unrelated, conflicts: [{ first, second }],
    }, findUnit);
    expect(frame).toMatchObject({ intent: "disagreement", claims: [
      { source: { label: { en: first.evidence.title } }, value: { kind: "number", amount: magnitude }, approximate: true, asOf: date },
      { source: { label: { en: second.evidence.title } }, value: { kind: "range", min: magnitude + 1, max: magnitude + 2 }, asOf: date },
    ] });
    const reply = realize(frame);
    expect(reply).toContain(first.evidence.title);
    expect(reply).toContain(second.evidence.title);
    expect(reply).not.toContain(unrelated.evidence.title);
  });

  it("preserves the precision of a date-valued observation", () => {
    const top = { ...first, value: { kind: "date", date: { calendar: "hijri", year: 1445 } }, referenceTime: null } as const;
    expect(fromStructuredEvidence(presentation, target, { status: "value", top, conflicts: [] }, findUnit))
      .toMatchObject({ intent: "fact", value: top.value });
  });

  it("declines gaps, missing conflicts, and unknown units", () => {
    expect(fromStructuredEvidence(presentation, target, { status: "gap", top: null, conflicts: [] }, findUnit))
      .toMatchObject({ intent: "decline", reason: "missing-evidence" });
    expect(fromStructuredEvidence(presentation, target, { status: "conflict", top: first, conflicts: [] }, findUnit))
      .toMatchObject({ intent: "decline", reason: "unverified" });
    expect(fromStructuredEvidence(presentation, target, { status: "value", top: first, conflicts: [] }, () => undefined))
      .toMatchObject({ intent: "decline", reason: "unsupported" });
  });
});

describe("reasoning adapter", () => {
  const reasoningValue = (value: string): Parameters<typeof fromReasoning>[1] => ({
    status: "completed", lang: "en",
    claims: [{ text: unusedProse, status: "confirmed", support: ["reasoning-result"] }],
    evidence: [{ id: "reasoning-result", source: "computed", quote: unusedProse, value }],
  });

  it("expresses the supported computed value from evidence and ignores the old sentence", () => {
    const frame = fromReasoning(presentation, reasoningValue(String(magnitude)), { kind: "number", unit });
    expect(frame).toMatchObject({ intent: "calculation", value: { kind: "number", amount: magnitude, unit } });
    const reply = realize(frame);
    expect(reply).toContain(`${magnitude} meters`);
    expect(reply).not.toContain("873");
  });

  it("marks arithmetic calendar conversion as approximate and retains the producer's calendar date", () => {
    const calendarValue = { calendar: "hijri", year: 1445, month: 8, day: 24 } as const;
    const raw = [calendarValue.year, calendarValue.month, calendarValue.day].map(part => String(part).padStart(2, "0")).join("-");
    const frame = fromReasoning(presentation, reasoningValue(raw), { kind: "calendar-conversion", calendar: calendarValue.calendar });
    expect(frame).toMatchObject({ intent: "calculation", certainty: "approximate", value: { kind: "date", date: calendarValue } });
    expect(realize(frame)).toContain("Shaban 24, 1445 AH");
  });

  it("declines blocked, unsubstantiated, prose-only and lossy results", () => {
    const ready = reasoningValue(String(magnitude));
    expect(fromReasoning(presentation, { ...ready, status: "blocked" }, { kind: "number" }))
      .toMatchObject({ intent: "decline", reason: "missing-evidence" });
    expect(fromReasoning(presentation, { ...ready, claims: [] }, { kind: "number" }))
      .toMatchObject({ intent: "decline", reason: "unverified" });
    for (const raw of [unusedProse, String(BigInt(Number.MAX_SAFE_INTEGER) + 1n)]) {
      expect(fromReasoning(presentation, reasoningValue(raw), { kind: "number" }))
        .toMatchObject({ intent: "decline", reason: "unsupported" });
    }
  });
});

describe("plan execution adapter", () => {
  it("reports verified values and separates skipped, failed, and unverified steps in compiler order", () => {
    const steps = [
      { stepId: "compute", status: "succeeded", value: { type: "number", value: magnitude, unit: "m" } },
      { stepId: "read", status: "succeeded", value: { type: "entity", value: "stored-id", label: "Measured Archive" } },
      { stepId: "write", status: "failed", reason: "unknown_effect" },
      { stepId: "search", status: "failed", reason: "no_result" },
      { stepId: "publish", status: "skipped", blockedBy: ["search"] },
    ] as const;
    const labels = new Map<string, Entity>([
      ["compute", name("Measurement", "القياس")], ["read", name("Read", "القراءة")],
      ["write", name("Save", "الحفظ")], ["search", name("Search", "البحث")], ["publish", name("Publish", "النشر")],
    ]);
    const result = { status: "partial", steps, text: unusedProse, question: null } as const;
    const frame = fromPlanExecution(presentation, name("Archive plan", "خطة الأرشيف"), result, labels, findUnit);
    expect(frame).toMatchObject({ intent: "plan", status: "partial", steps: [
      { status: "completed", value: { kind: "number", amount: magnitude, unit } },
      { status: "completed", value: { kind: "entity", entity: { name: { en: "Measured Archive" } } } },
      { status: "unverified" }, { status: "failed" }, { status: "skipped" },
    ] });
    const reply = realize(frame);
    expect(reply).toContain("Measured Archive");
    expect(reply).toContain(`${magnitude} meters`);
    expect(reply).not.toContain("873");
  });

  it("preserves verified list, text, and file labels and omits an unknown-unit result", () => {
    const values = [
      { type: "list", value: ["Register", "Survey"] },
      { type: "text", value: "Found" },
      { type: "file", value: "/archive.pdf", label: "Archive PDF" },
      { type: "number", value: magnitude, unit: "unsupported-unit" },
    ] as const;
    const steps = values.map(value => ({ stepId: value.type, status: "succeeded" as const, value }));
    const labels = new Map(values.map(value => [value.type, target.subject]));
    const frame = fromPlanExecution(presentation, target.subject, { status: "completed", steps }, labels, findUnit);
    expect(frame).toMatchObject({ intent: "plan", steps: [
      { value: { text: { ar: "Register، Survey", en: "Register, Survey" } } },
      { value: { text: { en: "Found" } } },
      { value: { text: { en: "Archive PDF" } } },
      { status: "completed", value: undefined },
    ] });
  });
});

describe("structured memory adapter", () => {
  const fact = { value: "Archive Register", date: sourceDate, statement: unusedProse, since: null, until: null };

  it("uses the verified stored value and the UTC recording date", () => {
    const frame = fromStructuredMemory(presentation, target, { kind: "recalled", fact });
    expect(frame).toMatchObject({ intent: "memory", value: { kind: "text", text: { en: fact.value } }, recordedOn: date });
    const reply = realize(frame);
    expect(reply).toContain(fact.value);
    expect(reply).toContain("March 5, 2024");
    expect(reply).not.toContain("873");
  });

  it("does not assert missing, ambiguous, deleted, or verbatim time-qualified memories", () => {
    for (const [kind, reason] of [["missing", "missing-evidence"], ["ambiguous", "unverified"], ["forgotten", "unsupported"]] as const) {
      expect(fromStructuredMemory(presentation, target, { kind })).toMatchObject({ intent: "decline", reason });
    }
    const qualified = { ...fact, since: "last summer" };
    expect(fromStructuredMemory(presentation, target, { kind: "recalled", fact: qualified }))
      .toMatchObject({ intent: "decline", reason: "unsupported" });
  });
});

describe("offline knowledge adapter", () => {
  const knowledge = (raw: unknown, rank: "preferred" | "normal" | "deprecated" = "normal"): Parameters<typeof fromKnowledgeFact>[2] => ({
    source: { dataset: "wikidata", url: "https://www.wikidata.org/wiki/Q1" },
    statement: { rank, snak: { snaktype: "value", datavalue: { type: "quantity", value: raw } } },
  });
  const raw = { amount: `+${magnitude}.0`, unit: "http://www.wikidata.org/entity/Q11573" };

  it("retains the exact amount, original unit, and snapshot source", () => {
    const frame = fromKnowledgeFact(presentation, target, knowledge(raw), findUnit);
    expect(frame).toMatchObject({ intent: "fact", value: { kind: "number", amount: magnitude, unit },
      sources: [{ label: { en: "wikidata" }, url: "https://www.wikidata.org/wiki/Q1" }], certainty: "single-source" });
    expect(realize(frame)).toContain(`${magnitude} meters`);
  });

  it("retains precision distinctions and declines unsupported or deprecated quantities", () => {
    expect(fromKnowledgeFact(presentation, target, knowledge({ ...raw, upperBound: String(magnitude + 1) }), findUnit))
      .toMatchObject({ intent: "fact", certainty: "single-source-approximate" });
    expect(fromKnowledgeFact(presentation, target, knowledge(raw, "deprecated"), findUnit))
      .toMatchObject({ intent: "decline", reason: "missing-evidence" });
    for (const value of [null, { ...raw, amount: `${magnitude}.0000000000000001` }, { ...raw, unit: "Q999" }]) {
      expect(fromKnowledgeFact(presentation, target, knowledge(value), findUnit))
        .toMatchObject({ intent: "decline", reason: "unsupported" });
    }
  });
});

describe("truth check adapter", () => {
  const fact = { ...target, value: { kind: "number", amount: magnitude, unit }, certainty: "approximate" } as const;
  const verdict = { decision: "fix", source: "single_source", measured: true, repaired: false, replacement: unusedProse } as const;

  it("applies source certainty to a separately verified fact and never reads replacement prose", () => {
    const frame = fromTruthChecks(presentation, verdict, fact);
    expect(frame).toMatchObject({ intent: "fact", value: fact.value, certainty: "single-source-approximate" });
    expect(realize(frame)).toContain(`${magnitude} meters`);
    expect(realize(frame)).not.toContain("873");
    expect(fromTruthChecks(presentation, { ...verdict, source: "confirmed" }, fact))
      .toMatchObject({ intent: "fact", certainty: "approximate" });
  });

  it("withholds declined, disputed, unmeasured, or substantively repaired claims", () => {
    for (const boundary of [
      { ...verdict, decision: "withhold" }, { ...verdict, source: "conflict" },
      { ...verdict, measured: false }, { ...verdict, repaired: true },
    ] as const) {
      const frame = fromTruthChecks(presentation, boundary, fact);
      expect(frame).toMatchObject({ intent: "decline", reason: "unverified" });
      expect(realize(frame)).not.toContain(String(magnitude));
    }
  });
});
