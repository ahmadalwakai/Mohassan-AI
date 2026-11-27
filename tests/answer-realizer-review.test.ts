import { describe, expect, it } from "vitest";
import { realize } from "../packages/realizer/src/index.js";
import type { AnswerFrame, CalendarDate, Language, LocalizedText, Presentation } from "../packages/realizer/src/frame.js";
import { developmentFrames } from "./fixtures/answer-realizer/development.js";

// These are local, deterministic development checks. They call no model/API and are never training data.
const isolate = /[\u2066-\u2069]/gu;
const terminal = /[.?!؟]$/u;
const unsafeDirection = /[\u202A-\u202E]/u;

function hasBalancedIsolates(text: string): boolean {
  let depth = 0;
  for (const control of text.match(isolate) ?? []) {
    depth += control === "\u2069" ? -1 : 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

interface Sample {
  readonly language: Language;
  readonly text: string;
}

function grade({ language, text }: Sample) {
  const plain = text.replace(isolate, "");
  const words = plain.match(/\p{L}+/gu) ?? [];
  const labeledValue = /\p{L}:\s*[-−+]?\p{Nd}/u.test(plain);
  return {
    grammaticality: {
      completeUtterance: plain === plain.trim() && terminal.test(plain) && (words.length >= 2 || labeledValue),
      punctuationAndSpacing: !/[ \t]{2,}|[ \t]+[.,;!?،؛؟)]|[([][ \t]+|\.{2,}|[!?؟]{2,}/u.test(plain),
      languageOrthography: language === "ar"
        ? /\p{Script=Arabic}/u.test(plain) && !/\?/u.test(plain)
        : /[A-Za-z]/u.test(plain) && !/[،؛؟]/u.test(plain),
      commonAgreement: language === "ar"
        ? !/(?<!\p{L})(?:هو\s+كانت|هي\s+كان|هما\s+كان|هم\s+كنا|هن\s+كنا)(?!\p{L})/u.test(plain)
        : !/\b(?:(?:he|she|it)\s+are|(?:they|we|you)\s+is|a\s+(?:engineer|hour)|an\s+(?:book|program))\b/iu.test(plain),
      repeatedFunctionWords: !/(?<!\p{L})(and|or|the|a|an|to|في|من|ثم|أو)\s+\1(?!\p{L})/iu.test(plain),
    },
    naturalness: {
      presentable: !/[\u0000-\u0008\u000B-\u001F\u007F\uFFFD]|\b(?:undefined|null|NaN)\b|\{\{.*?\}\}/u.test(plain),
      readableMixedDirection: hasBalancedIsolates(text) && !unsafeDirection.test(text),
      readablePacing: plain.split("\n").every((line) => line.length > 0 && !/[,،;؛:]\s*[,،;؛:]/u.test(line)),
    },
  };
}

const probeNames = Array.from({ length: 12 }, (_, id): LocalizedText => {
  const suffix = "BCDFGHJKLMNP"[id]!;
  return { en: `Qvex${suffix}`, ar: id % 2 === 0 ? `Qvex${suffix}` : `اسم«${"أبتثجحخدذرزس"[id]}»` };
});
const probes = probeNames.map((name) => ({ kind: "name" as const, name }));

function groundingFrames(): AnswerFrame[] {
  return (["ar", "en"] as const).flatMap((language) =>
    (["western", "arabic-indic"] as const).flatMap((digits) =>
      (["long", "day-first", "iso"] as const).flatMap((dateStyle) =>
        Array.from({ length: 3 }, (_, replyIndex) => {
          const settings: Presentation = { language, conversationSeed: "grounding-audit", replyIndex, digits, dateStyle, length: "detailed" };
          const gregorian = { calendar: "gregorian", year: 2078, month: 9, day: 17 } as const;
          const hijri = { calendar: "hijri", year: 1504, month: 9, day: 23 } as const;
          const lower = { kind: "number", amount: -9054.125 } as const;
          const upper = { kind: "number", amount: 24780.0625 } as const;
          const sources = [{ label: probeNames[8]! }, { label: probeNames[9]! }] as const;
          return [
            { ...settings, intent: "fact", subject: probes[0]!, value: { kind: "date", date: gregorian }, sources },
            { ...settings, intent: "disagreement", subject: probes[1]!, claims: [
              { source: sources[0], value: lower }, { source: sources[1], value: upper },
            ] },
            { ...settings, intent: "compare", left: probes[2]!, right: probes[3]!, relation: "less", values: [lower, upper] },
            { ...settings, intent: "rank", entries: [{ entity: probes[4]!, rank: 27, value: upper }] },
            { ...settings, intent: "calculation", label: probeNames[5]!, value: { kind: "range", min: lower.amount, max: upper.amount } },
            { ...settings, intent: "plan", plan: probes[6]!, status: "completed", steps: [{ step: probes[2]!, status: "completed", value: lower }] },
            { ...settings, intent: "memory", subject: probes[7]!, value: { kind: "date", date: hijri }, recordedOn: gregorian },
            { ...settings, intent: "decline", reason: "missing-evidence", subject: probes[0]! },
          ] satisfies AnswerFrame[];
        }).flat(),
      ),
    ),
  );
}

function normalize(text: string): string {
  return text.replace(isolate, "")
    .replace(/(?<=\d)[,\u202F\u00A0](?=\d{3}(?!\d))/gu, "")
    .normalize("NFKC")
    .replace(/[\u061C\u200E\u200F]/gu, "")
    .replace(/[٠-٩۰-۹]/gu, (digit) => String(digit.charCodeAt(0) & 15))
    .replace(/−/gu, "-").replace(/٫/gu, ".").replace(/٬/gu, ",")
    .replace(/(?<=\d)[,\u202F\u00A0](?=\d{3}(?!\d))/gu, "");
}

function walk(value: unknown, visit: (field: string, item: unknown) => void): void {
  if (value === null || typeof value !== "object") return;
  for (const [field, item] of Object.entries(value)) {
    visit(field, item);
    walk(item, visit);
  }
}

function atomInventory(frame: AnswerFrame) {
  const strings = new Set<string>();
  const quantities = new Set<number>();
  const dates: CalendarDate[] = [];
  walk(frame, (field, item) => {
    if (field === frame.language && typeof item === "string") strings.add(normalize(item));
    if (["amount", "min", "max", "rank"].includes(field) && typeof item === "number") quantities.add(item);
    if (item !== null && typeof item === "object" && "calendar" in item) dates.push(item as CalendarDate);
  });
  return { strings, quantities, dates };
}

const digitToken = /[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?/giu;

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const gregorianMonths = Array.from({ length: 12 }, (_, index) =>
  (["ar", "en"] as const).map((language) =>
    new Intl.DateTimeFormat(language, { calendar: "gregory", month: "long", timeZone: "UTC" }).format(Date.UTC(2000, index, 1)),
  ),
);
const auditedMonthNames = [
  ...gregorianMonths.flatMap((names, index) => names.map((name) => ({ name, month: index + 1, calendar: "gregorian" as const }))),
  ...["Ramadan", "رمضان"].map((name) => ({ name, month: 9, calendar: "hijri" as const })),
];

function auditGrounding(frame: AnswerFrame, rendered: string): string[] {
  const { strings, quantities, dates } = atomInventory(frame);
  const violations: string[] = [];
  let text = normalize(rendered);
  for (const name of probeNames) {
    const localized = normalize(name[frame.language]);
    if (text.includes(localized) && !strings.has(localized)) violations.push(`name ${localized}`);
  }
  // Remove literal frame atoms before inspecting prose. A label or value can itself contain digits or month names.
  for (const atom of [...strings].sort((a, b) => b.length - a.length)) {
    if (atom) text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapePattern(atom)}(?![\\p{L}\\p{N}])`, "giu"), " ");
  }
  if (frame.language === "ar") {
    for (const foreign of text.match(/[a-z]+/giu) ?? []) {
      if (!strings.has(foreign) && !/^(?:AH|AD|H|CE|e)$/iu.test(foreign)) violations.push(`foreign name ${foreign}`);
    }
  }

  // Check complete dates before scalar tokens so separate supplied date components cannot authorize a new date.
  text = text.replace(/(?<!\d)(\d{4,})-(\d{2})(?:-(\d{2}))?(?!\d)(?:\s*(AH|هـ|CE|AD|م)(?!\p{L}))?/giu, (raw, year, month, day, era) => {
    const calendar = /^(?:AH|هـ)$/iu.test(era ?? "") ? "hijri" : "gregorian";
    if (!dates.some((date) => date.calendar === calendar && date.year === Number(year)
      && date.month === Number(month) && date.day === (day === undefined ? undefined : Number(day)))) {
      violations.push(`date ${raw}`);
    }
    return " ";
  });
  for (const { name, month, calendar } of auditedMonthNames) {
    const monthName = escapePattern(name);
    const dayFirst = `(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:من\\s+)?)?${monthName}\\s+(\\d{4,})`;
    const monthFirst = `${monthName}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,)?\\s+(\\d{4,})`;
    text = text.replace(new RegExp(`(?<![\\p{L}\\d])(?:${dayFirst}|${monthFirst})(?!\\d)`, "giu"), (raw, day, year, otherDay, otherYear) => {
      const candidateDay = day ?? otherDay;
      if (!dates.some((date) => date.calendar === calendar && date.year === Number(year ?? otherYear)
        && date.month === month && date.day === (candidateDay === undefined ? undefined : Number(candidateDay)))) {
        violations.push(`date ${raw}`);
      }
      return " ";
    });
  }
  if (frame.language === "en") {
    // Ordinary English capitalizes proper names inside a clause. Sentence and label starts are ambiguous.
    for (const word of text.matchAll(/\b[A-Z][a-z]+\b/gu)) {
      const previous = text.slice(0, word.index).trimEnd();
      if (previous && !/[.?!:;\n(]$/u.test(previous) && !/^(?:Gregorian|Hijri)$/u.test(word[0])) {
        violations.push(`capitalized name ${word[0]}`);
      }
    }
  }
  for (const date of dates) {
    quantities.add(date.year);
    if (date.month !== undefined) quantities.add(date.month);
    if (date.day !== undefined) quantities.add(date.day);
  }
  for (const number of text.match(digitToken) ?? []) {
    if (!quantities.has(Number(number))) violations.push(`number ${number}`);
  }
  return violations;
}

describe("realizer development-only blind review", () => {
  it("scores output-only scripts for grammaticality and naturalness in both languages", () => {
    // The scorer sees only the language and rendered output, never intents, input values, or exact expected text.
    const samples: Sample[] = [...developmentFrames(), ...groundingFrames()].map((frame) => ({
      language: frame.language,
      text: realize(frame),
    }));
    for (const language of ["ar", "en"] as const) {
      const group = samples.filter((sample) => sample.language === language);
      expect(group.length).toBeGreaterThanOrEqual(300);
      let grammatical = 0;
      let natural = 0;
      const failures: { text: string; rules: string[] }[] = [];
      for (const sample of group) {
        const { grammaticality, naturalness } = grade(sample);
        if (Object.values(grammaticality).every(Boolean)) grammatical += 1;
        if (Object.values(naturalness).every(Boolean)) natural += 1;
        const rules = [...Object.entries(grammaticality), ...Object.entries(naturalness)]
          .filter(([, passed]) => !passed).map(([rule]) => rule);
        if (rules.length > 0) failures.push({ text: sample.text, rules });
      }
      console.info(`realizer blind development review ${language} | grammaticality ${grammatical}/${group.length} | naturalness ${natural}/${group.length}`);
      expect(failures).toEqual([]);
    }
  });

  it("rejects ungrammatical or unreadable negative controls", () => {
    const { grammaticality, naturalness } = grade({ language: "en", text: "the  the {{slot}} \u2066result!!" });
    expect(grammaticality.punctuationAndSpacing).toBe(false);
    expect(naturalness.presentable).toBe(false);
    expect(naturalness.readableMixedDirection).toBe(false);
    expect(grade({ language: "ar", text: "في في البيت." }).grammaticality.repeatedFunctionWords).toBe(false);
    expect(grade({ language: "ar", text: "هي كان مهندسة." }).grammaticality.commonAgreement).toBe(false);
    expect(grade({ language: "en", text: "She are a engineer." }).grammaticality.commonAgreement).toBe(false);
    expect(grade({ language: "en", text: "Total: 12." }).grammaticality.completeUtterance).toBe(true);
  });

  it("finds no absent name, numeric literal, or date across every intent and presentation in the grounding probes", () => {
    const frames = groundingFrames();
    expect(frames).toHaveLength(288);
    for (const frame of frames) {
      const rendered = realize(frame);
      expect(auditGrounding(frame, rendered), `${frame.language}/${frame.intent}: ${rendered}`).toEqual([]);
    }
  });

  it("keeps inserted Latin names isolated in Arabic replies", () => {
    const frames = groundingFrames().filter((frame) => frame.language === "ar");
    let checked = 0;
    for (const frame of frames) {
      const rendered = realize(frame);
      const { strings } = atomInventory(frame);
      for (const name of probeNames.map(({ ar }) => ar)) {
        if (!strings.has(name) || !rendered.includes(name) || !/^[A-Za-z]/u.test(name)) continue;
        checked += 1;
        expect(rendered, `${frame.intent}/${name}`).toMatch(new RegExp(`[\\u2066\\u2068]${name}\\u2069`, "u"));
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("flags unknown names, a changed sign/digit and a date assembled from separate allowed components", () => {
    const frame = groundingFrames().find((sample) => sample.language === "en" && sample.intent === "memory")!;
    const rendered = realize(frame);
    const badDate = "2078-09-23"; // Day 23 is supplied for a different calendar date.
    const unknown = probeNames[11]!.en;
    expect(auditGrounding(frame, `${rendered} ${unknown}, −٩٬٠٥٤٫١٢٥ and ${badDate}.`)).toEqual([
      `name ${unknown}`, `date ${badDate}`, "number -9054.125",
    ]);
    const arabic = groundingFrames().find((sample) => sample.language === "ar" && sample.intent === "decline")!;
    expect(auditGrounding(arabic, `${realize(arabic)} ${probeNames[11]!.ar}.`)).toContain(`name ${probeNames[11]!.ar}`);
    expect(auditGrounding(frame, `${rendered} It refers to London.`)).toContain("capitalized name London");
  });
});
