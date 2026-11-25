import { arabicAgreement, arabicCardinal, arabicNoun, arabicOrdinal, arabicPronoun } from "./arabic.js";
import { englishNoun, englishOrdinal, indefiniteArticle } from "./english.js";
import { formatDate, formatNumber, formatText } from "./format.js";
import type {
  AnswerFrame, ArabicAgreement, ArabicForms, Certainty, Entity, LocalizedText, Noun, Presentation, Value,
} from "./frame.js";

export type * from "./frame.js";

type Variant = 0 | 1 | 2;
type ArabicCase = "nominative" | "oblique" | "accusative";

function selectPlan({ conversationSeed, replyIndex = 0 }: Presentation): Variant {
  if (!Number.isSafeInteger(replyIndex) || replyIndex < 0) throw new RangeError("Invalid reply index");
  let hash = 0;
  for (const character of conversationSeed) hash = (Math.imul(31, hash) + character.codePointAt(0)!) >>> 0;
  return ((hash % 3 + replyIndex % 3) % 3) as Variant;
}

function agreement(entity: Entity): ArabicAgreement | undefined {
  if (entity.kind === "name") {
    const { gender, number = "singular", rational } = entity.agreement ?? {};
    return gender ? { gender, number, rational } : undefined;
  }
  return { gender: entity.noun.ar.gender, number: entity.number ?? "singular", rational: entity.noun.ar.rational };
}

function englishPlural(entity: Entity): boolean {
  return entity.kind === "name"
    ? entity.agreement?.number === "dual" || entity.agreement?.number === "plural"
    : !entity.noun.en.mass && (entity.number === "dual" || entity.number === "plural");
}

function local(text: LocalizedText, context: Presentation): string {
  return formatText(text[context.language], context.language);
}

function sentenceHead(entity: Entity, text: string, context: Presentation): string {
  if (entity.kind === "name" || context.language === "ar") return text;
  return text.replace(/^\p{Ll}/u, letter => letter.toUpperCase());
}

function entityText(entity: Entity, context: Presentation, grammaticalCase: ArabicCase = "nominative"): string {
  if (entity.kind === "name") return local(entity.name, context);
  const { noun, owner, adjective, definite, number = "singular" } = entity;
  if (context.language === "en") {
    const plural = number !== "singular";
    const nounText = englishNoun(noun.en, plural);
    const phrase = formatText(adjective ? `${adjective.en} ${nounText}` : nounText, "en");
    if (owner) return `the ${phrase} of ${entityText(owner, context)}`;
    if (definite) return `the ${phrase}`;
    if (plural || noun.en.mass) return phrase;
    return `${indefiniteArticle(phrase, adjective ? undefined : noun.en.article)} ${phrase}`;
  }

  const head = arabicNoun(noun.ar, { number, definite, construct: !!owner, case: grammaticalCase });
  const parts = [formatText(head, "ar")];
  if (owner) parts.push(entityText(owner, context, "oblique"));
  if (adjective) {
    const isDefinite = owner ? definiteEntity(owner) : !!definite;
    const forms = isDefinite ? adjective.arDefinite ?? adjective.ar : adjective.ar;
    const features = agreement(entity)!;
    let form = arabicAgreement(forms, features);
    if (grammaticalCase !== "nominative") {
      if (features.number === "dual") form = form.replace(/ان$/u, "ين");
      if (features.number === "plural" && features.gender === "masculine" && features.rational !== false) {
        form = form.replace(/ون$/u, "ين");
      }
    }
    parts.push(formatText(isDefinite && !adjective.arDefinite ? "ال" + form : form, "ar"));
  }
  return parts.join(" ");
}

function definiteEntity(entity: Entity): boolean {
  if (entity.kind === "name") return true;
  return entity.owner ? definiteEntity(entity.owner) : !!entity.definite;
}

function propertyOf(subject: Entity, property?: Noun): Entity {
  return property ? { kind: "noun", noun: property, owner: subject } : subject;
}

function valueText(value: Value, context: Presentation): string {
  switch (value.kind) {
    case "text": return local(value.text, context);
    case "entity": return entityText(value.entity, context);
    case "date": return formatDate(value.date, context);
    case "number": return quantity(value.amount, value.unit, context);
    case "range": {
      if (value.min > value.max) throw new RangeError("Expected ascending range bounds");
      if (context.language === "ar") {
        return `من ${quantity(value.min, value.unit, context, "oblique")} إلى ${quantity(value.max, value.unit, context, "oblique")}`;
      }
      return `${formatNumber(value.min, context)}–${quantity(value.max, value.unit, context, "nominative", true)}`;
    }
  }
}

function quantity(
  amount: number, noun: Noun | undefined, context: Presentation, grammaticalCase: ArabicCase = "nominative", plural = false,
): string {
  const digits = (number: number) => formatNumber(number, context);
  if (!noun) return digits(amount);
  if (context.language === "en") return `${digits(amount)} ${formatText(englishNoun(noun.en, plural || Math.abs(amount) !== 1), "en")}`;
  if (!Number.isFinite(amount)) throw new RangeError("Expected a finite number");
  const { gender, rational, singular, ...forms } = noun.ar;
  const safeForms = Object.fromEntries(Object.entries(forms).map(([key, value]) => [
    key,
    typeof value === "string" ? formatText(value, "ar")
      : value && Object.fromEntries(Object.entries(value).map(([form, text]) => [form, typeof text === "string" ? formatText(text, "ar") : text])),
  ]));
  const safeNoun = { ...safeForms, gender, rational, singular: formatText(singular, "ar") };
  return arabicCardinal(amount, safeNoun, digits, context.numberStyle ?? "digits", grammaticalCase);
}

function approximately(text: string, context: Presentation): string {
  return context.language === "ar" ? `نحو ${text}` : `approximately ${text}`;
}

function sentence(text: string): string {
  return /[.!?؟]\u2069?$/u.test(text) ? text : text + ".";
}

function asOf(text: string, date: Extract<Value, { kind: "date" }>["date"] | undefined, context: Presentation): string {
  if (!date) return text;
  const rendered = formatDate(date, context);
  return context.language === "ar" ? `${text} (في ${rendered})` : `${text} (as of ${rendered})`;
}

function fact(frame: Extract<AnswerFrame, { intent: "fact" }>, variant: Variant, value: string): string {
  const entity = propertyOf(frame.subject, frame.property);
  const subject = entityText(entity, frame);
  const label = entityText(frame.subject, frame);
  if (frame.language === "en") {
    const head = sentenceHead(entity, subject, frame);
    if (!frame.property) return [`${head}: ${value}`, `For ${subject}, the answer is ${value}`, `The answer for ${subject} is ${value}`][variant];
    const copula = englishPlural(entity) ? "are" : "is";
    return [`${head} ${copula} ${value}`, `For ${label}, the ${formatText(frame.property.en.singular, "en")} ${copula} ${value}`, `${head}: ${value}`][variant];
  }
  if (!frame.property) return [`${subject}: ${value}`, `بشأن ${entityText(entity, frame, "oblique")}، الإجابة هي ${value}`, `الإجابة بشأن ${entityText(entity, frame, "oblique")} هي ${value}`][variant];
  const pronoun = arabicPronoun(agreement(entity)!);
  return [`${subject} ${pronoun} ${value}`, `${subject}: ${value}`, `بالنسبة إلى ${entityText(frame.subject, frame, "oblique")}، ${entityText({ kind: "noun", noun: frame.property, definite: true }, frame)} ${pronoun} ${value}`][variant];
}

const equalVerb: ArabicForms = {
  masculine: { singular: "يساوي", dual: "يساويان", plural: "يساوون" },
  feminine: { singular: "تساوي", dual: "تساويان", plural: "يساوين" },
};

function compare(frame: Extract<AnswerFrame, { intent: "compare" }>, variant: Variant): string {
  const left = propertyOf(frame.left, frame.property);
  const right = propertyOf(frame.right, frame.property);
  const a = entityText(left, frame);
  const b = entityText(right, frame);
  const equal = frame.relation === "equal";
  const greater = frame.relation === "greater";
  const values = frame.values?.map(value => valueText(value, frame));
  if (variant === 1 || (variant === 2 && !equal)) values?.reverse();
  let result: string;
  if (frame.language === "en") {
    const copula = englishPlural(left) ? "are" : "is";
    const relation = equal ? "equal to" : greater ? "higher than" : "lower than";
    const head = sentenceHead(left, a, frame);
    result = [
      `${head} ${copula} ${relation} ${b}`,
      `Compared with ${b}, ${a} ${copula} ${equal ? "the same" : greater ? "higher" : "lower"}`,
      equal ? `${head} and ${b} are equal` : `${sentenceHead(right, b, frame)} ${englishPlural(right) ? "are" : "is"} ${greater ? "lower" : "higher"} than ${a}`,
    ][variant];
    return values ? `${result} (${values[0]} vs. ${values[1]})` : result;
  }
  const rightOblique = entityText(right, frame, "oblique");
  const verb = arabicAgreement(equalVerb, agreement(left) ?? { gender: "masculine", number: "singular" });
  const relation = equal ? `${verb} ${entityText(right, frame, "accusative")}` : `${greater ? "أكبر" : "أقل"} من ${rightOblique}`;
  const leftOblique = entityText(left, frame, "oblique");
  result = [
    `${a} ${relation}`,
    `مقارنةً بـ${rightOblique}، ${a} ${equal ? `${verb} القيمة نفسها` : greater ? "أكبر" : "أقل"}`,
    equal ? `هناك تساوٍ بين ${leftOblique} و${rightOblique}` : `${b} ${greater ? "أقل" : "أكبر"} من ${leftOblique}`,
  ][variant];
  return values ? `${result} (${values[0]} مقابل ${values[1]})` : result;
}

function ranking(frame: Extract<AnswerFrame, { intent: "rank" }>, variant: Variant): string {
  return frame.entries.map(({ entity, rank, value }, index) => {
    if (!Number.isSafeInteger(rank) || rank < 1) throw new RangeError("Expected a positive integer rank");
    const entityLabel = entityText(entity, frame);
    const name = index === 0 ? sentenceHead(entity, entityLabel, frame) : entityLabel;
    const digits = (amount: number) => formatNumber(amount, frame);
    const detail = value === undefined ? "" : ` (${valueText(value, frame)})`;
    if (frame.language === "en") {
      const ordinal = englishOrdinal(rank, digits(rank));
      const plural = englishPlural(entity);
      return [`${name} ${plural ? "rank" : "ranks"} ${ordinal}`, `${name} ${plural ? "are" : "is"} in ${ordinal} place`, `${ordinal} place goes to ${entityLabel}`][variant] + detail;
    }
    const notation = frame.numberStyle ?? "digits";
    const position = variant === 1 ? "المرتبة" : "المركز";
    const ordinal = arabicOrdinal(rank, variant === 1 ? "feminine" : "masculine", digits, notation, variant === 2 ? "nominative" : "oblique");
    return [`${name} في ${position} ${ordinal}`, `${name} في ${position} ${ordinal}`, `${position} ${ordinal}: ${name}`][variant] + detail;
  }).join(frame.language === "ar" ? "؛ " : "; ");
}

const completed: ArabicForms = {
  masculine: { singular: "مكتمل", dual: "مكتملان", plural: "مكتملون" },
  feminine: { singular: "مكتملة", dual: "مكتملتان", plural: "مكتملات" },
};
const failed: ArabicForms = {
  masculine: { singular: "فشل", dual: "فشلا", plural: "فشلوا" },
  feminine: { singular: "فشلت", dual: "فشلتا", plural: "فشلن" },
};
const blocked: ArabicForms = {
  masculine: { singular: "متعذر", dual: "متعذران", plural: "متعذرون" },
  feminine: { singular: "متعذرة", dual: "متعذرتان", plural: "متعذرات" },
};

const planStatus = {
  completed: { en: "complete", ar: completed, neutral: "اكتمل العمل على" },
  partial: { en: "partially complete", ar: completed, neutral: "اكتمل جزء من العمل على" },
  failed: { en: "failed", ar: failed, neutral: "أخفق العمل على" },
  blocked: { en: "blocked", ar: blocked, neutral: "تعذر العمل على" },
} as const;

function plan(frame: Extract<AnswerFrame, { intent: "plan" }>, variant: Variant): string {
  const title = entityText(frame.plan, frame);
  const status = planStatus[frame.status];
  const subjectAgreement = agreement(frame.plan);
  let result: string;
  if (frame.language === "en") {
    const englishStatus = frame.status === "failed" ? "failed" : `${englishPlural(frame.plan) ? "are" : "is"} ${status.en}`;
    const head = sentenceHead(frame.plan, title, frame);
    result = [`${head} ${englishStatus}`, `Status of ${title}: ${status.en}`, `${head}: ${status.en}`][variant];
  } else if (!subjectAgreement || variant === 2) {
    const work = `${status.neutral} ${entityText(frame.plan, frame, "oblique")}`;
    result = variant === 1 ? `النتيجة: ${work}` : work;
  } else {
    const predicate = arabicAgreement(status.ar, subjectAgreement) + (frame.status === "partial" ? " جزئيًا" : "");
    result = variant === 0 ? `${title} ${predicate}` : `${title}: ${predicate}`;
  }

  if (frame.length !== "detailed" || !frame.steps?.length) return result;
  const stepStatus = {
    ar: { completed: "تم التنفيذ", failed: "تعذر التنفيذ", skipped: "تم التجاوز", unverified: "تعذر التحقق من أثر التنفيذ" },
    en: { completed: "completed", failed: "failed", skipped: "skipped", unverified: "effect unverified" },
  }[frame.language];
  const details = frame.steps.map(({ step, status, value }) => {
    const stepName = entityText(step, frame);
    return `${stepName}: ${stepStatus[status]}${value === undefined ? "" : ` (${valueText(value, frame)})`}`;
  });
  return `${sentence(result)} ${details.join(frame.language === "ar" ? "؛ " : "; ")}`;
}

function memory(frame: Extract<AnswerFrame, { intent: "memory" }>, variant: Variant, value: string): string {
  const entity = propertyOf(frame.subject, frame.property);
  const subject = entityText(entity, frame);
  const features = agreement(entity);
  const recalled = frame.language === "en"
    ? [`I remember that ${subject} ${englishPlural(entity) ? "are" : "is"} ${value}`,
      `From memory, ${subject} ${englishPlural(entity) ? "are" : "is"} ${value}`,
      `I have this in memory: ${subject} — ${value}`][variant]
    : [
      features
        ? `أتذكر أن ${entityText(entity, frame, "accusative")} ${arabicPronoun(features)} ${value}`
        : `أتذكر ما يلي عن ${entityText(entity, frame, "oblique")}: ${value}`,
      `في الذاكرة: ${subject} — ${value}`,
      `هذا ما أتذكره بشأن ${entityText(entity, frame, "oblique")}: ${value}`,
    ][variant];
  const details: string[] = [];
  if (frame.validity?.since) {
    details.push((frame.language === "en" ? "from " : "منذ ") + formatDate(frame.validity.since, frame));
  }
  if (frame.validity?.until) {
    details.push((frame.language === "en" ? "until " : "حتى ") + formatDate(frame.validity.until, frame));
  }
  if (frame.length === "detailed" && frame.recordedOn) {
    details.push((frame.language === "en" ? "recorded " : "تاريخ الحفظ ") + formatDate(frame.recordedOn, frame));
  }
  return details.length ? `${recalled} (${details.join(frame.language === "en" ? ", " : "، ")})` : recalled;
}

const declines = {
  en: {
    "missing-evidence": ["I don't have enough evidence to answer", "I need more evidence to answer", "There isn't enough evidence for an answer"],
    unsupported: ["I can't answer this request", "This request is outside what I can answer", "I can't provide an answer to this request"],
    unverified: ["I couldn't verify the answer", "I can't confirm the answer", "I don't have a verified answer"],
    "not-allowed": ["I can't help with this request", "I can't carry out this request", "I'm unable to help with this request"],
  },
  ar: {
    "missing-evidence": ["لا تتوفر لدي أدلة كافية للإجابة", "أحتاج إلى مزيد من الأدلة للإجابة", "الأدلة المتاحة لا تكفي للإجابة"],
    unsupported: ["لا أستطيع الإجابة عن هذا الطلب", "هذا الطلب خارج نطاق ما أستطيع الإجابة عنه", "لا يمكنني تقديم إجابة عن هذا الطلب"],
    unverified: ["لم أتمكن من التحقق من الإجابة", "لا أستطيع تأكيد الإجابة", "ليست لدي إجابة متحقق منها"],
    "not-allowed": ["لا أستطيع المساعدة في هذا الطلب", "لا يمكنني تنفيذ هذا الطلب", "يتعذر عليّ تقديم المساعدة في هذا الطلب"],
  },
};

function disagreement(frame: Extract<AnswerFrame, { intent: "disagreement" }>, variant: Variant): string {
  const topic = entityText(propertyOf(frame.subject, frame.property), frame, "oblique");
  const { language } = frame;
  const intro = language === "en"
    ? [`Sources disagree about ${topic}`, `The sources give different answers for ${topic}`, `There is conflicting evidence about ${topic}`][variant]
    : [`تختلف المصادر بشأن ${topic}`, `تتباين إجابات المصادر بشأن ${topic}`, `تتعارض الأدلة بشأن ${topic}`][variant];
  const claims = frame.claims.map(({ source, value, approximate, asOf: on }, index) => {
    const label = local(source.label, frame);
    const text = valueText(value, frame);
    const reading = asOf(approximate ? approximately(text, frame) : text, on, frame);
    return language === "en" ? `${label} reports ${reading}` : `${index ? "و" : ""}يفيد ${label} بأن القيمة ${reading}`;
  });
  return `${intro}: ${claims.join(language === "en" ? "; " : "؛ ")}`;
}

function calculation(frame: Extract<AnswerFrame, { intent: "calculation" }>, variant: Variant, value: string): string {
  if (frame.label) return `${local(frame.label, frame)}: ${value}`;
  return frame.language === "en"
    ? [`The result is ${value}`, `The calculation gives ${value}`, `The calculated result is ${value}`][variant]
    : [`الناتج هو ${value}`, `أسفر الحساب عن ${value}`, `بلغ الناتج ${value}`][variant];
}

function approximate(certainty: Certainty | undefined): boolean {
  return certainty === "approximate" || certainty === "single-source-approximate";
}

/** Realize only the values, relations, and evidence scope supplied by the caller. */
export function realize(frame: AnswerFrame): string {
  const variant = selectPlan(frame);
  const { language } = frame;
  if (frame.intent === "disagreement") return sentence(disagreement(frame, variant));
  if (frame.intent === "decline") {
    const refusal = declines[language][frame.reason][variant];
    const topic = frame.subject ? ` (${entityText(frame.subject, frame)})` : "";
    return sentence(refusal + topic);
  }

  let result: string;
  if ("value" in frame) {
    const text = valueText(frame.value, frame);
    const value = approximate(frame.certainty) ? approximately(text, frame) : text;
    if (frame.intent === "calculation") result = calculation(frame, variant, value);
    else if (frame.intent === "fact") result = asOf(fact(frame, variant, value), frame.asOf, frame);
    else result = memory(frame, variant, value);
  } else {
    if (frame.intent === "compare") result = compare(frame, variant);
    else if (frame.intent === "rank") result = ranking(frame, variant);
    else result = plan(frame, variant);
    if (approximate(frame.certainty)) {
      result = (language === "ar" ? "على وجه التقريب، " : "Approximately, ") + result;
    }
  }

  const sources = frame.sources ?? [];
  if (frame.certainty === "single-source" || frame.certainty === "single-source-approximate") {
    const attribution = sources.length === 1 && frame.length === "detailed"
      ? (language === "ar" ? "وفق مصدر واحد، " : "According to one source, ") + local(sources[0].label, frame)
      : language === "ar" ? "وفق مصدر واحد" : "According to one source";
    return sentence(result + ` (${attribution})`);
  }

  const main = sentence(result);
  if (frame.length !== "detailed" || sources.length === 0) return main;
  const labels = sources.map(source => local(source.label, frame)).join(language === "ar" ? "، " : ", ");
  return main + " " + sentence((language === "ar" ? "المصادر: " : "Sources: ") + labels);
}
