import { describe, expect, it } from "vitest";
import { realize, type AnswerFrame, type ArabicForms, type CalendarDate, type Entity, type GrammaticalNumber, type Noun, type Presentation } from "../packages/realizer/src/index.js";
import { book, developmentCases, hour, name } from "./fixtures/answer-realizer/development.js";
import { developmentExpectation } from "./fixtures/answer-realizer/development-reference.js";

const cases = developmentCases();

describe("answer realizer exact development cases (locally enumerated, never training data)", () => {
  it("covers at least 600 unique frames, both languages, all intents, and each Arabic cardinal range", () => {
    expect(cases.length).toBeGreaterThanOrEqual(600);
    expect(new Set(cases.map(({ id }) => id)).size).toBe(cases.length);
    expect(new Set(cases.map(({ frame }) => JSON.stringify(frame))).size).toBe(cases.length);
    for (const intent of ["fact", "compare", "rank", "calculation", "plan", "memory", "disagreement", "decline"]) {
      for (const language of ["ar", "en"]) {
        expect(cases.some(({ frame }) => frame.intent === intent && frame.language === language)).toBe(true);
      }
    }
    for (const gender of ["masculine", "feminine"]) {
      for (const [min, max] of [[0, 0], [1, 1], [2, 2], [3, 10], [11, 99], [100, Infinity]]) {
        expect(cases.some(({ frame }) =>
          frame.language === "ar" && frame.intent === "calculation" && frame.numberStyle === "words"
          && frame.value.kind === "number" && frame.value.unit?.ar.gender === gender
          && frame.value.amount >= min && frame.value.amount <= max,
        ), `${gender} cardinal range ${min}–${max}`).toBe(true);
      }
    }
  });

  it.each(cases)("$id", entry => {
    expect(realize(entry.frame)).toBe(developmentExpectation(entry));
  });
});

// Additional focused development probes reuse deterministic lexical forms and
// calendar constants. Like the matrix, no cases are acquired from a model or API.
describe("answer realizer grammar and evidence boundaries", () => {
  const en = { language: "en", conversationSeed: "" } as const;
  const ar = { language: "ar", conversationSeed: "" } as const;
  const day = { calendar: "hijri", year: 1447, month: 9, day: 15 } as const;
  const clock = name("الساعة", "Clock", "feminine");
  const isolate = (digits: string | number) => `\u2066${digits}\u2069`;

  const englishArticles = [
    ["article", "مقال", "an"], ["hour", "ساعة", "an"], ["university", "جامعة", "a"],
    ["MRI", "فحص بالرنين المغناطيسي", "an"], ["SQL", "إس كيو إل", "an", "an"], ["URL", "رابط", "a"],
  ] as const;
  it.each(englishArticles)("selects English articles for %s", (singular, translated, article, override?) => {
    const entity: Entity = {
      kind: "noun", noun: { ar: { gender: "masculine", singular: translated }, en: { singular, article: override } },
    };
    const label = { en: "Entry", ar: "المدخل" };
    const frame: AnswerFrame = { ...en, intent: "calculation", label, value: { kind: "entity", entity } };
    expect(realize(frame)).toBe(`${label.en}: ${article} ${singular}.`);
  });

  const englishPlurals = [
    ["church", "كنيسة", "churches"], ["child", "طفل", "children", "children"],
    ["city", "مدينة", "cities"], ["boy", "ولد", "boys"],
  ] as const;
  it.each(englishPlurals)("inflects English units for %s", (singular, translated, plural, override?) => {
    const unit = { ar: { gender: "masculine", singular: translated }, en: { singular, plural: override } } as const;
    const value = { kind: "number", amount: 2, unit } as const;
    expect(realize({ ...en, intent: "calculation", value })).toBe(`The result is ${value.amount} ${plural}.`);
  });

  const adjective: ArabicForms = {
    masculine: { singular: "جديد", dual: "جديدان", plural: "جديدون" },
    feminine: { singular: "جديدة", dual: "جديدتان", plural: "جديدات" },
  };
  const entrance: Noun = {
    ar: { gender: "masculine", singular: "مدخل", plural: "مداخل", rational: false },
    en: { singular: "entrance" },
  };
  const entries: readonly [GrammaticalNumber, string, string][] = [
    ["singular", "مدخل", "الجديد"], ["dual", "مدخلا", "الجديدان"], ["plural", "مداخل", "الجديدة"],
  ];
  it.each(entries)("forms definite Arabic iḍāfa with a %s head and agreeing adjective", (number, head, form) => {
    const city = name("المدينة", "City", "feminine");
    const subject: Entity = { kind: "noun", noun: entrance, number, owner: city, adjective: { en: "new", ar: adjective } };
    const value = { kind: "text", text: { ar: "مفتوح", en: "open" } } as const;
    const frame: AnswerFrame = { ...ar, intent: "fact", subject, value };
    expect(realize(frame)).toBe(`${head} المدينة ${form}: ${value.text.ar}.`);
  });

  it("inflects a dual construct noun and its adjective in an oblique position", () => {
    const subject: Entity = {
      kind: "noun", noun: entrance, number: "dual", owner: name("المدينة", "City", "feminine"),
      adjective: { en: "new", ar: adjective },
    };
    const property: Noun = { ar: { gender: "masculine", singular: "موقع" }, en: { singular: "location" } };
    const value = { kind: "text", text: { ar: "الجهة الشرقية", en: "the east side" } } as const;
    expect(realize({ ...ar, intent: "fact", subject, property, value }))
      .toBe(`${property.ar.singular} مدخلي المدينة الجديدين هو ${value.text.ar}.`);
  });

  const wordRange: readonly [Noun, string, string][] = [
    [book, "اثني عشر كتابًا", "اثنين وعشرين كتابًا"],
    [hour, "اثنتي عشرة ساعةً", "اثنتين وعشرين ساعةً"],
  ];
  it.each(wordRange)("uses oblique Arabic cardinals in ranges", (unit, lower, upper) => {
    const label = { ar: "المجال", en: "Range" };
    const value = { kind: "range", min: 12, max: 22, unit } as const;
    expect(realize({ ...ar, intent: "calculation", label, value, numberStyle: "words" })).toBe(`${label.ar}: من ${lower} إلى ${upper}.`);
    expect(realize({ ...en, intent: "calculation", label, value })).toBe(`${label.en}: ${value.min}–${value.max} ${unit.en.singular}s.`);
  });

  // Count agreement and case examples (retrieved 2026-11-27):
  // https://computercollege.uoanbar.edu.iq/catalog/CS_depart/lectures/CS_1_2_arabic.pdf
  it.each([
    [book, ["كتابان", "كتابين", "كتابين"], ["عشرون كتابًا", "عشرين كتابًا", "عشرين كتابًا"]],
    [hour, ["ساعتان", "ساعتين", "ساعتين"], ["عشرون ساعةً", "عشرين ساعةً", "عشرين ساعةً"]],
  ] as const)("inflects the dual and tens for each Arabic calculation plan", (unit, dual, twenty) => {
    const clauses = ["الناتج هو", "أسفر الحساب عن", "بلغ الناتج"];
    for (const [replyIndex, clause] of clauses.entries()) {
      const frame = { ...ar, replyIndex, numberStyle: "words", intent: "calculation" } as const;
      expect(realize({ ...frame, value: { kind: "number", amount: 2, unit } })).toBe(`${clause} ${dual[replyIndex]}.`);
      expect(realize({ ...frame, value: { kind: "number", amount: 20, unit } })).toBe(`${clause} ${twenty[replyIndex]}.`);
    }
  });

  it("spells the approximate count in the case governed by نحو", () => {
    const frame = { ...ar, intent: "calculation", certainty: "approximate", numberStyle: "words" } as const;
    expect(realize({ ...frame, value: { kind: "number", amount: 2, unit: book } })).toBe("الناتج هو نحو كتابين.");
  });

  // Display atoms are test inputs. The expected reply inserts the same strings in each sentence plan.
  it.each([
    ["equals", "37 × 24", "888", (x: string, y: string) => [`ناتج ${x} هو ${y}.`, `${x} equals ${y}.`]],
    ["conversion", "1,200.00 km", "1 200 000.00 m", (x: string, y: string) => [`ما يعادل ${x} هو ${y}.`, `${x} is equivalent to ${y}.`]],
    ["weekday", "2026-11-27", "Friday", (x: string, y: string) => [`يوافق ${x} يوم ${y}.`, `${x} falls on ${y}.`]],
    ["interval", "2026-11-27 / 2026-11-29", "٢", (x: string, y: string) => [`المدة ${x} هي ${y}.`, `The interval ${x} is ${y}.`]],
  ] as const)("realizes the %s relation with exact display atoms in both languages", (relation, expression, value, expected) => {
    const both = (text: string) => ({ ar: text, en: text });
    const frame = { intent: "calculation", relation, expression: both(expression), value: { kind: "literal", text: both(value) } } as const;
    expect(realize({ ...ar, ...frame })).toBe(expected(isolate(expression), isolate(value))[0]);
    expect(realize({ ...en, ...frame })).toBe(expected(expression, value)[1]);
  });

  it("uses a compact Arabic unit label when the counted noun has no plural form", () => {
    const unit: Noun = { ar: { gender: "masculine", singular: book.ar.singular }, en: book.en };
    const amount = 3;
    expect(realize({ ...ar, intent: "calculation", numberStyle: "words", value: { kind: "number", amount, unit } }))
      .toBe(`الناتج هو ${isolate(amount)} (${unit.ar.singular}).`);
    const subject: Entity = { kind: "noun", noun: unit, number: "plural" };
    expect(() => realize({ ...ar, intent: "fact", subject, value: { kind: "number", amount } }))
      .toThrow(RangeError);
  });

  it("retains single-source provenance and approximate Hijri dates in both languages", () => {
    const source = { label: { ar: "الرصد", en: "Observation" } };
    const control = {
      intent: "calculation", label: { ar: "التاريخ", en: "Date" }, value: { kind: "date", date: day },
      sources: [source], certainty: "single-source-approximate", length: "detailed",
    } as const;
    expect(realize({ ...ar, ...control })).toBe(
      `${control.label.ar}: نحو ${isolate(day.day)} رمضان ${isolate(day.year)} هـ (وفق مصدر واحد، ${source.label.ar}).`,
    );
    expect(realize({ ...en, ...control, length: "short" })).toBe(
      `${control.label.en}: approximately Ramadan ${day.day}, ${day.year} AH (According to one source).`,
    );
  });

  it("renders explicit partial dates without defaulting absent components", () => {
    const value = (date: CalendarDate) => ({ kind: "date", date } as const);
    const year = { calendar: "hijri", year: 1447 } as const;
    const month = { ...year, month: 11 };
    const label = { ar: "التاريخ", en: "Date" };
    expect(realize({ ...ar, intent: "calculation", label, value: value(year) })).toBe(`${label.ar}: ${isolate(year.year)} هـ.`);
    expect(realize({ ...ar, intent: "calculation", label, value: value(month) })).toBe(`${label.ar}: ذو القعدة ${isolate(month.year)} هـ.`);
    expect(realize({ ...en, intent: "calculation", label, dateStyle: "iso", value: value(month) })).toBe(`${label.en}: ${month.year}-${month.month} AH.`);
  });

  it("isolates Latin atoms and western digits separately in Arabic", () => {
    const latin = "Atlas";
    const nameWithOverride = latin.slice(0, 2) + "\u202e" + latin.slice(2) + "\u202c";
    const subject = name(nameWithOverride, latin);
    const amount = 1200;
    const frame: AnswerFrame = { ...ar, intent: "fact", subject, value: { kind: "number", amount } };
    const display = new Intl.NumberFormat("en-US").format(amount);
    expect(realize(frame)).toBe(`\u2068${latin}\u2069: ${isolate(display)}.`);
  });

  it("selects different equivalent plans deterministically from conversation seed and turn", () => {
    const subject = clock;
    const value = { kind: "number", amount: 12 } as const;
    const base = { ...en, intent: "fact", subject, value } as const;
    const texts = [
      `Clock: ${value.amount}.`,
      `For Clock, the answer is ${value.amount}.`,
      `The answer for Clock is ${value.amount}.`,
    ];
    for (const replyIndex of [0, 1, 2, 3]) {
      const options: Partial<Presentation> = { conversationSeed: "A", replyIndex };
      expect(realize({ ...base, ...options })).toBe(texts[(2 + replyIndex) % 3]);
    }
    expect(realize({ ...base, conversationSeed: "B" })).toBe(texts[0]);
  });

  it("offers three stable variants for each intent in each language", () => {
    const seen = new Set<string>();
    for (const { frame } of cases) {
      const key = `${frame.intent}/${frame.language}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const turns = [0, 1, 2].map(replyIndex => ({ ...frame, replyIndex }));
      const sentences = turns.map(realize);
      expect(new Set(sentences).size, key).toBe(turns.length);
      expect(turns.map(realize)).toEqual(sentences);
    }
  });

  it("uses feminine Arabic ordinals after an inflected rank noun", () => {
    const labels = ["الأولى", "الحادية عشرة", "الحادية والعشرين"];
    for (const [index, rank] of [1, 11, 21].entries()) {
      const frame: AnswerFrame = {
        ...ar, replyIndex: 1, numberStyle: "words", intent: "rank", entries: [{ entity: clock, rank }],
      };
      expect(realize(frame)).toBe(`الساعة في المرتبة ${labels[index]}.`);
    }
  });

  const invalidDays = [
    { calendar: "gregorian", year: 2100, month: 2, day: 29 },
    { calendar: "gregorian", year: 2024, month: 13, day: 2 },
    { calendar: "hijri", year: 1448, month: 1, day: 31 },
    { calendar: "hijri", year: 0 },
  ] as const;
  it.each(invalidDays)("rejects out-of-domain dates", date => {
    expect(() => realize({ ...en, intent: "calculation", value: { kind: "date", date } })).toThrow(RangeError);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects out-of-domain ranks (%d)", rank => {
    expect(() => realize({ ...en, intent: "rank", entries: [{ entity: clock, rank }] })).toThrow(RangeError);
  });
  it.each([Infinity, -Infinity, NaN])("rejects non-finite numeric values (%d)", amount => {
    expect(() => realize({ ...en, intent: "calculation", value: { kind: "number", amount } })).toThrow(RangeError);
  });
  it("rejects reversed range bounds", () => {
    expect(() => realize({ ...en, intent: "calculation", value: { kind: "range", min: 2, max: 1 } })).toThrow(RangeError);
  });
});
