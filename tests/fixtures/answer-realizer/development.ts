// Development-only regression fixtures. Generated locally by enumeration of
// finite linguistic and calendar domains, with no model/API calls. Never train on them.
// Fixture inputs ported from PR #42 (retrieved 2026-11-27):
// https://github.com/ahmadalwakai/Mohassan-AI/blob/14ea9894949f3e92382ed6cda6a4892595bddcdf/tests/fixtures/answer-realizer/development.ts
import type {
  AnswerFrame,
  ArabicGender,
  DeclineReason,
  Entity,
  GrammaticalNumber,
  Language,
  LocalizedText,
  Noun,
  Presentation,
} from "../../../packages/realizer/src/frame.js";

const languages = ["ar", "en"] as const;
const dates = ["long", "day-first", "iso"] as const;
const cardinalAmounts = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
  20, 21, 22, 23, 28, 30, 40, 50, 60, 70, 80, 90, 99,
  100, 101, 102, 103, 110, 111, 112, 120, 122, 199, 200, 202, 203, 300, 800, 999,
  1_000, 2_000, 3_000, 101_000, 102_000, 1_000_000,
] as const;

export const book: Noun = {
  ar: {
    gender: "masculine", singular: "كتاب", plural: "كتب", accusativeSingular: "كتابًا",
    dual: { nominative: "كتابان", oblique: "كتابين", constructNominative: "كتابا", constructOblique: "كتابي" },
  },
  en: { singular: "book" },
};

export const hour: Noun = {
  ar: {
    gender: "feminine", singular: "ساعة", plural: "ساعات", accusativeSingular: "ساعةً",
    dual: { nominative: "ساعتان", oblique: "ساعتين", constructNominative: "ساعتا", constructOblique: "ساعتي" },
  },
  en: { singular: "hour", article: "an" },
};

const duration: Noun = {
  ar: { gender: "feminine", singular: "مدة" },
  en: { singular: "duration" },
};

const engineer: Noun = {
  ar: {
    gender: "masculine", singular: "مهندس", plural: "مهندسون", obliquePlural: "مهندسين",
    constructPlural: "مهندسو", constructObliquePlural: "مهندسي", rational: true,
    dual: { nominative: "مهندسان", oblique: "مهندسين", constructNominative: "مهندسا", constructOblique: "مهندسي" },
  },
  en: { singular: "engineer" },
};

const femaleEngineer: Noun = {
  ar: {
    gender: "feminine", singular: "مهندسة", plural: "مهندسات", rational: true,
    dual: { nominative: "مهندستان", oblique: "مهندستين", constructNominative: "مهندستا", constructOblique: "مهندستي" },
  },
  en: { singular: "engineer" },
};

const program: Noun = {
  ar: { gender: "masculine", singular: "برنامج", plural: "برامج", rational: false },
  en: { singular: "program" },
};

const agreementSubjects = new Map<string, Entity>([
  ["ms", { kind: "noun", noun: engineer, number: "singular", definite: true }],
  ["md", { kind: "noun", noun: engineer, number: "dual", definite: true }],
  ["mp", { kind: "noun", noun: engineer, number: "plural", definite: true }],
  ["fs", { kind: "noun", noun: femaleEngineer, number: "singular", definite: true }],
  ["fd", { kind: "noun", noun: femaleEngineer, number: "dual", definite: true }],
  ["fp", { kind: "noun", noun: femaleEngineer, number: "plural", definite: true }],
  ["np", { kind: "noun", noun: program, number: "plural", definite: true }],
]);

const project: Noun = {
  ar: { gender: "masculine", singular: "مشروع", plural: "مشاريع", rational: false },
  en: { singular: "project" },
};

const mission: Noun = {
  ar: { gender: "feminine", singular: "مهمة", plural: "مهام", rational: false },
  en: { singular: "task" },
};

const projects = new Map<string, Entity>([
  ["ms", { kind: "noun", noun: project, number: "singular", definite: true }],
  ["md", { kind: "noun", noun: project, number: "dual", definite: true }],
  ["mp", { kind: "noun", noun: project, number: "plural", definite: true }],
  ["fs", { kind: "noun", noun: mission, number: "singular", definite: true }],
  ["fd", { kind: "noun", noun: mission, number: "dual", definite: true }],
  ["fp", { kind: "noun", noun: mission, number: "plural", definite: true }],
]);

const duties = new Map([
  ["ms", ["المناوب", "المسؤول", "الأقدم"]],
  ["md", ["المناوبان", "المسؤولان", "الأقدمان"]],
  ["mp", ["المناوبون", "المسؤولون", "الأقدمون"]],
  ["fs", ["المناوبة", "المسؤولة", "الأقدم"]],
  ["fd", ["المناوبتان", "المسؤولتان", "الأقدمان"]],
  ["fp", ["المناوبات", "المسؤولات", "الأقدم"]],
  ["np", ["المعتمدة", "المنشورة", "المنتهية"]],
]);

export const name = (ar: string, en: string, gender?: ArabicGender, number?: GrammaticalNumber): Entity => ({
  kind: "name", name: { ar, en }, agreement: gender ? { gender, number } : undefined,
});

const stations: readonly Entity[] = [
  name("المرصد", "Observatory", "masculine"),
  name("المنارة", "Lighthouse", "feminine"),
  name("المرفأ", "Harbor", "masculine"),
  name("المحطة", "Station", "feminine"),
  name("السد", "Dam", "masculine"),
  name("الجزيرة", "Island", "feminine"),
];

function show(language: Language, options: Partial<Presentation> = {}): Presentation {
  return { language, conversationSeed: "", ...options };
}

export interface DevelopmentCase {
  readonly id: string;
  readonly frame: AnswerFrame;
}

/** Input-only interface for scripted review. Fixture source never imports the realizer. */
export function developmentCases(): readonly DevelopmentCase[] {
  const cases: DevelopmentCase[] = [];
  const add = (id: string, frame: AnswerFrame) => cases.push({ id: `${id}/${frame.language}`, frame });

  for (const amount of cardinalAmounts) {
    for (const unit of [book, hour]) {
      const value = { kind: "number", amount, unit } as const;
      const key = `cardinal/${unit.en.singular}/${amount}`;
      add(`${key}/words`, { ...show("ar", { numberStyle: "words" }), intent: "calculation", value });
      for (const digits of ["western", "arabic-indic"] as const) {
        add(`${key}/${digits}`, { ...show("ar", { digits }), intent: "calculation", value });
      }
      add(`${key}/western`, { ...show("en"), intent: "calculation", value });
    }
  }

  for (const language of languages) {
    for (const calendar of ["gregorian", "hijri"] as const) {
      const year = calendar === "gregorian" ? 2024 : 1447;
      for (const dateStyle of dates) {
        for (let month = 1; month <= 12; month++) {
          const day = month === 2 ? 29 : month + 1;
          const subject = stations[(month - 1) % stations.length];
          add(`calendar/${calendar}/${dateStyle}/${month}`, {
            ...show(language, { dateStyle, digits: month % 2 ? "arabic-indic" : "western" }),
            intent: "fact",
            subject,
            value: { kind: "date", date: { calendar, year, month, day } },
          });
        }
      }
    }

    for (const [index, left] of stations.entries()) {
      const right = stations[(index + 1) % stations.length];
      for (const relation of ["less", "equal", "greater"] as const) {
        add(`comparison/${index}/${relation}`, { ...show(language), intent: "compare", left, right, relation });
      }
    }

    for (const [index, rank] of [1, 2, 3, 4, 8, 10, 11, 12, 13, 18, 19, 20, 21, 22, 28, 30, 31, 90, 99, 100, 101, 111, 112, 113, 1_001].entries()) {
      const entity = stations[index % stations.length];
      add(`rank/${rank}`, { ...show(language, { numberStyle: "words" }), intent: "rank", entries: [{ entity, rank }] });
    }

    for (const [key, plan] of projects) {
      for (const status of ["completed", "partial", "failed", "blocked"] as const) {
        add(`plan/${key}/${status}`, { ...show(language), intent: "plan", plan, status });
      }
    }

    for (const [key, subject] of agreementSubjects) {
      const descriptions = key === "np" ? ["the approved ones", "the published ones", "the completed ones"]
        : ["on duty", "in charge", "the most senior"];
      for (const [index, ar] of duties.get(key)!.entries()) {
        add(`memory/${key}/${index}`, {
          ...show(language), intent: "memory", subject, value: { kind: "text", text: { ar, en: descriptions[index] } },
        });
      }
      if (key !== "np") {
        add(`agreement/${key}/failed`, {
          ...show(language), intent: "plan", plan: subject, status: "failed",
        });
      }
    }

    const first: LocalizedText = { ar: "السجل", en: "Register" };
    const second: LocalizedText = { ar: "التقرير", en: "Report" };
    for (const [index, subject] of stations.entries()) {
      add(`disagreement/${index}`, {
        ...show(language), intent: "disagreement", subject,
        claims: [
          { source: { label: first }, value: { kind: "number", amount: 100 + index } },
          { source: { label: second }, value: { kind: "number", amount: 120 + index } },
        ],
      });
      add(`property/${index}`, {
        ...show(language), intent: "fact", subject, property: duration,
        value: { kind: "number", amount: index + 3, unit: hour },
      });
    }

    const declineReasons: readonly DeclineReason[] = ["missing-evidence", "unsupported", "unverified", "not-allowed"];
    for (const reason of declineReasons) {
      add(`decline/${reason}`, { ...show(language), intent: "decline", reason });
    }

    for (const [index, amount] of [-1234567.5, -0.125, 0.00000001, 12.75, 9223372036854776000, 1e21].entries()) {
      add(`number-format/${index}`, {
        ...show(language),
        intent: "calculation",
        value: { kind: "number", amount },
      });
    }
  }
  return cases;
}

export function developmentFrames(): readonly AnswerFrame[] {
  return developmentCases().map(({ frame }) => frame);
}
