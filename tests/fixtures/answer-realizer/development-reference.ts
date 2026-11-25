// Development test oracle only. The finite paradigms below are grammatical
// reference data. The code expands them locally and never calls a model/API.
// This file and every sentence it produces are excluded from training.
import type { CalendarDate, Entity, Noun, Presentation, Value } from "../../../packages/realizer/src/frame.js";
import type { DevelopmentCase } from "./development.js";

type NounForm = "singular" | "plural" | "accusative" | "partitive" | "one" | "dual";
type Cardinal = [number, string, string, NounForm];

// Nominative numeral forms before a masculine / feminine counted noun.
// Each row also names the required noun form (3–10 plural genitive, 11–99
// singular accusative, exact hundreds and scale nouns singular genitive).
const cardinals: Cardinal[] = [
  [0, "صفر", "صفر", "partitive"],
  [1, "واحد", "واحدة", "one"],
  [2, "", "", "dual"],
  [3, "ثلاثة", "ثلاث", "plural"],
  [4, "أربعة", "أربع", "plural"],
  [5, "خمسة", "خمس", "plural"],
  [6, "ستة", "ست", "plural"],
  [7, "سبعة", "سبع", "plural"],
  [8, "ثمانية", "ثماني", "plural"],
  [9, "تسعة", "تسع", "plural"],
  [10, "عشرة", "عشر", "plural"],
  [11, "أحد عشر", "إحدى عشرة", "accusative"],
  [12, "اثنا عشر", "اثنتا عشرة", "accusative"],
  [13, "ثلاثة عشر", "ثلاث عشرة", "accusative"],
  [14, "أربعة عشر", "أربع عشرة", "accusative"],
  [15, "خمسة عشر", "خمس عشرة", "accusative"],
  [16, "ستة عشر", "ست عشرة", "accusative"],
  [17, "سبعة عشر", "سبع عشرة", "accusative"],
  [18, "ثمانية عشر", "ثماني عشرة", "accusative"],
  [19, "تسعة عشر", "تسع عشرة", "accusative"],
  [20, "عشرون", "عشرون", "accusative"],
  [21, "واحد وعشرون", "إحدى وعشرون", "accusative"],
  [22, "اثنان وعشرون", "اثنتان وعشرون", "accusative"],
  [23, "ثلاثة وعشرون", "ثلاث وعشرون", "accusative"],
  [28, "ثمانية وعشرون", "ثمانٍ وعشرون", "accusative"],
  [30, "ثلاثون", "ثلاثون", "accusative"],
  [40, "أربعون", "أربعون", "accusative"],
  [50, "خمسون", "خمسون", "accusative"],
  [60, "ستون", "ستون", "accusative"],
  [70, "سبعون", "سبعون", "accusative"],
  [80, "ثمانون", "ثمانون", "accusative"],
  [90, "تسعون", "تسعون", "accusative"],
  [99, "تسعة وتسعون", "تسع وتسعون", "accusative"],
  [100, "مئة", "مئة", "singular"],
  [101, "مئة وواحد", "مئة وواحدة", "partitive"],
  [102, "مئة واثنان", "مئة واثنتان", "partitive"],
  [103, "مئة وثلاثة", "مئة وثلاث", "plural"],
  [110, "مئة وعشرة", "مئة وعشر", "plural"],
  [111, "مئة وأحد عشر", "مئة وإحدى عشرة", "accusative"],
  [112, "مئة واثنا عشر", "مئة واثنتا عشرة", "accusative"],
  [120, "مئة وعشرون", "مئة وعشرون", "accusative"],
  [122, "مئة واثنان وعشرون", "مئة واثنتان وعشرون", "accusative"],
  [199, "مئة وتسعة وتسعون", "مئة وتسع وتسعون", "accusative"],
  [200, "مئتا", "مئتا", "singular"],
  [202, "مئتان واثنان", "مئتان واثنتان", "partitive"],
  [203, "مئتان وثلاثة", "مئتان وثلاث", "plural"],
  [300, "ثلاثمئة", "ثلاثمئة", "singular"],
  [800, "ثمانمئة", "ثمانمئة", "singular"],
  [999, "تسعمئة وتسعة وتسعون", "تسعمئة وتسع وتسعون", "accusative"],
  [1000, "ألف", "ألف", "singular"],
  [2000, "ألفا", "ألفا", "singular"],
  [3000, "ثلاثة آلاف", "ثلاثة آلاف", "singular"],
  [101000, "مئة ألف وألف", "مئة ألف وألف", "singular"],
  [102000, "مئة ألف وألفا", "مئة ألف وألفا", "singular"],
  [1000000, "مليون", "مليون", "singular"],
];

const numeralReference = new Map(cardinals.map(([n, m, f, form]) => [n, { m, f, form }]));

function displayDigits(western: string, { language, digits }: Presentation): string {
  const display = digits === "arabic-indic"
    ? [...western].map(character => {
        if (character === ",") return "٬";
        if (character === ".") return "٫";
        return "0123456789".includes(character) ? "٠١٢٣٤٥٦٧٨٩"[Number(character)] : character;
      }).join("")
    : western;
  return language === "ar" ? `\u2066${display}\u2069` : display;
}

const westernDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 20 });
const numberText = (amount: number, frame: Presentation) => displayDigits(westernDecimal.format(amount), frame);

function cardinal(amount: number, unit: Noun, options: Presentation): string {
  if (options.language === "en") {
    const noun = amount === 1 ? unit.en.singular : unit.en.plural ?? `${unit.en.singular}s`;
    return `${numberText(amount, options)} ${noun}`;
  }
  const entry = numeralReference.get(amount);
  if (!entry) throw new Error(`Missing Arabic numeral oracle for ${amount}`);
  const noun = unit.ar;
  const word = noun.gender === "masculine" ? entry.m : entry.f;
  const numeral = options.numberStyle === "words" ? word : numberText(amount, options);
  switch (entry.form) {
    case "one":
      return options.numberStyle === "words" ? `${noun.singular} ${numeral}` : `${numeral} ${noun.singular}`;
    case "dual":
      return options.numberStyle === "words" ? noun.dual!.nominative : `${numeral} ${noun.singular}`;
    case "partitive":
      return amount === 0 && options.numberStyle !== "words"
        ? `${numeral} ${noun.singular}`
        : `${numeral} من ال${noun.plural}`;
    case "plural":
      return `${numeral} ${noun.plural}`;
    case "accusative":
      return `${numeral} ${noun.accusativeSingular}`;
    case "singular":
      return `${numeral} ${noun.singular}`;
  }
}

const gregorianMonth = {
  ar: new Intl.DateTimeFormat("ar-EG-u-ca-gregory", { month: "long", timeZone: "UTC" }),
  en: new Intl.DateTimeFormat("en-US-u-ca-gregory", { month: "long", timeZone: "UTC" }),
};
const hijriMonth = {
  ar: ["المحرم", "صفر", "ربيع الأول", "ربيع الآخر", "جمادى الأولى", "جمادى الآخرة", "رجب", "شعبان", "رمضان", "شوال", "ذو القعدة", "ذو الحجة"],
  en: ["Muharram", "Safar", "Rabi al-Awwal", "Rabi al-Thani", "Jumada al-Awwal", "Jumada al-Thani", "Rajab", "Shaban", "Ramadan", "Shawwal", "Dhu al-Qadah", "Dhu al-Hijjah"],
};

function calendarDate(date: CalendarDate, options: Presentation): string {
  const { language, dateStyle } = options;
  const era = date.calendar === "gregorian" ? "" : language === "ar" ? " هـ" : " AH";
  if (dateStyle === "iso") {
    const iso = [date.year, date.month, date.day].join("-").replace(/-(\d)(?=-|$)/g, "-0$1");
    return displayDigits(iso, options) + era;
  }
  const day = displayDigits(String(date.day), options);
  const year = displayDigits(String(date.year), options) + era;
  const month = date.calendar === "hijri"
    ? language === "ar" && date.month! > 10
      ? date.month === 11 ? "ذي القعدة" : "ذي الحجة"
      : hijriMonth[language][date.month! - 1]
    : gregorianMonth[language].format(Date.UTC(date.year, date.month! - 1, date.day));
  return language === "en" && dateStyle === "long" ? `${month} ${day}, ${year}` : `${day} ${month} ${year}`;
}

function valueText(value: Value, frame: Presentation): string {
  switch (value.kind) {
    case "date": return calendarDate(value.date, frame);
    case "number": return value.unit ? cardinal(value.amount, value.unit, frame) : numberText(value.amount, frame);
    case "text": return value.text[frame.language];
    default: throw new Error(`Missing oracle for value kind ${value.kind}`);
  }
}

const arabicOrdinals = new Map([
  [1, "الأول"], [2, "الثاني"], [3, "الثالث"], [4, "الرابع"], [8, "الثامن"], [10, "العاشر"],
  [11, "الحادي عشر"], [12, "الثاني عشر"], [13, "الثالث عشر"], [18, "الثامن عشر"], [19, "التاسع عشر"],
  [20, "العشرين"], [21, "الحادي والعشرين"], [22, "الثاني والعشرين"], [28, "الثامن والعشرين"],
  [30, "الثلاثين"], [31, "الحادي والثلاثين"], [90, "التسعين"], [99, "التاسع والتسعين"],
]);

const englishOrdinal = new Intl.PluralRules("en-US", { type: "ordinal" });
const englishSuffix: Partial<Record<Intl.LDMLPluralRule, string>> = { one: "st", two: "nd", few: "rd" };

function ordinal(rank: number, options: Presentation) {
  const digits = numberText(rank, options);
  if (options.language === "ar") return arabicOrdinals.get(rank) ?? digits;
  return digits + (englishSuffix[englishOrdinal.select(rank)] ?? "th");
}

const agreement = new Map([
  // Nominative subject / subject of إنّ / pronoun / finite verb
  ["ms", ["المهندس", "المهندس", "هو", "فشل"]],
  ["md", ["المهندسان", "المهندسين", "هما", "فشلا"]],
  ["mp", ["المهندسون", "المهندسين", "هم", "فشلوا"]],
  ["fs", ["المهندسة", "المهندسة", "هي", "فشلت"]],
  ["fd", ["المهندستان", "المهندستين", "هما", "فشلتا"]],
  ["fp", ["المهندسات", "المهندسات", "هن", "فشلن"]],
  ["np", ["البرامج", "البرامج", "هي", "فشلت"]],
]);

const projects = new Map([
  ["ms", ["المشروع", "مكتمل", "فشل", "متعذر"]],
  ["md", ["المشروعان", "مكتملان", "فشلا", "متعذران"]],
  ["mp", ["المشاريع", "مكتملة", "فشلت", "متعذرة"]],
  ["fs", ["المهمة", "مكتملة", "فشلت", "متعذرة"]],
  ["fd", ["المهمتان", "مكتملتان", "فشلتا", "متعذرتان"]],
  ["fp", ["المهام", "مكتملة", "فشلت", "متعذرة"]],
]);

function referenceSubject(subject: Entity, language: Presentation["language"]): string {
  if (subject.kind !== "name") throw new Error("Expected a named subject in this reference pattern");
  return subject.name[language];
}

const englishPlan = { completed: "complete", partial: "partially complete", failed: "failed", blocked: "blocked" };
const decline = {
  ar: {
    "missing-evidence": "لا تتوفر لدي أدلة كافية للإجابة.",
    unsupported: "لا أستطيع الإجابة عن هذا الطلب.",
    unverified: "لم أتمكن من التحقق من الإجابة.",
    "not-allowed": "لا أستطيع المساعدة في هذا الطلب.",
  },
  en: {
    "missing-evidence": "I don't have enough evidence to answer.",
    unsupported: "I can't answer this request.",
    unverified: "I couldn't verify the answer.",
    "not-allowed": "I can't help with this request.",
  },
};

export function developmentExpectation({ id, frame }: DevelopmentCase): string {
  const { language } = frame;
  const arabic = language === "ar";
  const named = (entity: Entity) => referenceSubject(entity, language);
  const render = (value: Value) => valueText(value, frame);

  switch (frame.intent) {
    case "calculation":
      return arabic ? `الناتج هو ${render(frame.value)}.` : `The result is ${render(frame.value)}.`;
    case "fact": {
      const subject = named(frame.subject);
      return frame.property
        ? arabic ? `مدة ${subject} هي ${render(frame.value)}.` : `The duration of ${subject} is ${render(frame.value)}.`
        : `${subject}: ${render(frame.value)}.`;
    }
    case "compare": {
      const left = named(frame.left);
      const right = named(frame.right);
      if (arabic) {
        const gender = frame.left.kind === "name" ? frame.left.agreement?.gender : undefined;
        const form = { less: "أقل من", equal: gender === "feminine" ? "تساوي" : "يساوي", greater: "أكبر من" };
        return `${left} ${form[frame.relation]} ${right}.`;
      }
      const form = { less: "lower than", equal: "equal to", greater: "higher than" };
      return `${left} is ${form[frame.relation]} ${right}.`;
    }
    case "rank": {
      const { entity, rank } = frame.entries[0];
      return arabic ? `${named(entity)} في المركز ${ordinal(rank, frame)}.` : `${named(entity)} ranks ${ordinal(rank, frame)}.`;
    }
    case "plan": {
      const [family, key] = id.split("/");
      const singular = key.endsWith("s");
      if (arabic) {
        if (family === "agreement") {
          const [subject, , , failed] = agreement.get(key)!;
          return `${subject} ${failed}.`;
        }
        const [subject, complete, failed, blocked] = projects.get(key)!;
        const statuses = { completed: complete, partial: complete + " جزئيًا", failed, blocked };
        return `${subject} ${statuses[frame.status]}.`;
      }
      const singularName = family === "agreement" ? "engineer" : key.startsWith("m") ? "project" : "task";
      const subject = singular ? singularName : singularName + "s";
      const copula = frame.status === "failed" ? "" : singular ? " is" : " are";
      return `The ${subject}${copula} ${englishPlan[frame.status]}.`;
    }
    case "memory": {
      const [, key] = id.split("/");
      if (arabic) {
        const [, subject, pronoun] = agreement.get(key)!;
        return `أتذكر أن ${subject} ${pronoun} ${render(frame.value)}.`;
      }
      const subject = key === "np" ? "programs" : key.endsWith("s") ? "engineer" : "engineers";
      const copula = key.endsWith("s") ? "is" : "are";
      return `I remember that the ${subject} ${copula} ${render(frame.value)}.`;
    }
    case "disagreement": {
      const [first, second] = frame.claims;
      const label = (claim: typeof first) => claim.source.label[language];
      return arabic
        ? `تختلف المصادر بشأن ${named(frame.subject)}: يفيد ${label(first)} بأن القيمة ${render(first.value)}؛ ويفيد ${label(second)} بأن القيمة ${render(second.value)}.`
        : `Sources disagree about ${named(frame.subject)}: ${label(first)} reports ${render(first.value)}; ${label(second)} reports ${render(second.value)}.`;
    }
    case "decline":
      return decline[language][frame.reason];
  }
}
