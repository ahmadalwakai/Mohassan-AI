import { matchText } from '../mind/normalize.js';
import { exactOrRedundant, sentenceSpans, wordCount, wordSet, type EvidenceSpan, type WritingLanguage, type WritingSource } from './evidence.js';

export const explanationSections = ['definition', 'how', 'why', 'example', 'limits'] as const;
export type ExplanationSection = typeof explanationSections[number];

export interface ExplanationGroup {
  subject?: string;
  sections: Record<ExplanationSection, EvidenceSpan[]>;
}

interface ExplanationOptions {
  subjects?: readonly string[];
  topic?: string;
  language: WritingLanguage;
  detailed?: boolean;
  short?: boolean;
}

// Check the more specific signals first, so «for example, X is a …» stays in the example section.
const cues: readonly [ExplanationSection, RegExp][] = [
  ['example', /\b(?:for example|for instance|such as|an example of)\b|\be\.g\.|(?<!\p{L})[وف]?(?:علي سبيل المثال|مثلا|من امثله|مثال علي|مثل)(?!\p{L})/u],
  ['limits', /\b(?:limitations?|drawbacks?|does not support|do not support|cannot|can['’]t|works only|only (?:works?|travels?|available)|restricted to|limited to|does not work|doesn['’]t work|is not suitable|are not suitable|must not exceed|not compatible)\b|(?<!\p{L})[وف]?(?:قيود|محدود(?:ه)?|لا يمكن|لا يستطيع|لا تستطيع|لا يدعم|لا تدعم|لا يعمل|لا تعمل|لا يناسب|لا يصلح|يقتصر|تقتصر|لا يتجاوز|الا في حال)(?!\p{L})/u],
  ['why', /\b(?:because|so that|in order to|the reason|the purpose|as a result|therefore)\b|(?<!\p{L})[وف]?(?:لان|بسبب|لكي|كي|حتي يتسني|بهدف|بغرض|الغرض من|السبب|لذلك|نتيجه لذلك)(?!\p{L})/u],
  ['definition', /\b(?:is (?:a|an|the)|are (?:a|an|the)|occurs? when|refers? to|means?|defined as|stands? for|known as)\b|(?<!\p{L})[وف]?(?:هو|هي|هما|يقصد ب|يشير الي|مصطلح|يعرف(?: بانه)?|تعرف(?: بانها)?|يعني|تعني|عباره عن)(?!\p{L})/u],
  ['how', /\b(?:works? by|works? through|operates? by|relies on|uses?|by \w+ing|by means of|by the (?:physical )?process(?:es)? of|first[,]? (?:it|the|a|an)|is used to|are used to|consists of|involves?|go(?:es)? through|converts?|transfers?|passes?|sends?|runs?|starts by|follows? these steps)\b|(?<!\p{L})[وف]?(?:من خلال|عن طريق|بواسطه|في البدايه|يعمل(?: علي)?|تعمل(?: علي)?|يستخدم|تستخدم|يعتمد علي|تعتمد علي|يتكون|تتكون|يحول|تحول|يرسل|ترسل|يبدا|تبدا|تمر)(?!\p{L})/u],
];

const comparisonClauses = /\b(?:while|whereas|but|however|in contrast)\b|[;؛]|(?<!\p{L})(?:بينما|في حين|ولكن|اما)(?!\p{L})/u;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

function subjectPattern(subject: string): RegExp {
  const words = matchText(subject).trim().replace(/^(?:the|a|an)\s+/u, '').split(/\s+/u).map(word => {
    if (!/^\p{Script=Arabic}{3,}$/u.test(word)) return escapeRegExp(word);
    const stem = word.length > 3 && word.startsWith('ال') ? word.slice(2) : word;
    return `(?:و)?(?:ال)?${escapeRegExp(stem)}`;
  });
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}+])${words.join('\\s+')}(?![\\p{L}\\p{M}\\p{N}+#])`, 'u');
}

function mentions(state: string, patterns: readonly RegExp[]): number[] {
  return patterns.flatMap((pattern, index) => pattern.test(state) ? [index] : []);
}

function subjectRelevance(text: string, title: string, patterns: readonly RegExp[], subject: number, section: ExplanationSection): number {
  const named = mentions(text, patterns);
  const inTitle = mentions(title, patterns);
  const titledSubject = inTitle.length === 1 ? inTitle[0] : undefined;
  const cue = cues.find(([kind]) => kind === section)![1];
  if (named.length === 1) {
    if (named[0] !== subject) return 0;
    const at = patterns[subject]!.exec(text)!.index;
    if (section === 'definition' && titledSubject !== subject && at > text.search(cue)) return 0;
    return titledSubject === subject ? 5 : 4;
  }
  if (!named.length) {
    return titledSubject === subject ? 1 : 0;
  }
  // If both names occur, attribute a claim to the first subject in a clause bearing an evidence cue.
  return text.split(comparisonClauses).some(clause => {
    const at = patterns[subject]!.exec(clause)?.index;
    if (at === undefined) return false;
    const firstMention = Math.min(...patterns.map(pattern => pattern.exec(clause)?.index ?? Infinity));
    return at === firstMention && (section === 'example' ? cue.test(clause) : cue.test(clause.slice(at)));
  }) ? 4 : 0;
}

function groupEvidence(
  candidates: readonly { span: EvidenceSpan; text: string; title: string; section: ExplanationSection }[],
  options: ExplanationOptions,
  relevance: (text: string, title: string, section: ExplanationSection) => number,
): ExplanationGroup['sections'] {
  const sections: ExplanationGroup['sections'] = { definition: [], how: [], why: [], example: [], limits: [] };
  const ranked = candidates.flatMap(candidate => {
    const score = relevance(candidate.text, candidate.title, candidate.section);
    if (!score) return [];
    const rightLanguage = /\p{Script=Arabic}/u.test(candidate.text) === (options.language === 'ar');
    return [{ ...candidate, score: score + (rightLanguage ? 0.25 : 0) }];
  }).sort((a, b) => b.score - a.score);
  const selected: EvidenceSpan[] = [];
  for (const { span, section } of ranked) {
    if (sections[section].length >= (options.detailed ? 2 : 1) || selected.some(other => exactOrRedundant(span.text, other.text))) continue;
    sections[section].push(span);
    selected.push(span);
  }
  return sections;
}

/** Every populated section contains a complete, literal span. Empty arrays signal missing evidence. */
export function explain(sources: readonly WritingSource[], options: ExplanationOptions): ExplanationGroup[] {
  const maxQuoteChars = options.short ? 360 : options.detailed ? 1600 : 900;
  const candidates = sources.flatMap(source => {
    const title = matchText(source.title);
    return sentenceSpans(source).flatMap(span => {
      if (span.text.length > maxQuoteChars || options.short && wordCount(span.text) > 45 || /^#{1,6}\s/u.test(span.text) || /[?؟][»”"')\]]*$/u.test(span.text)) return [];
      const text = matchText(span.text);
      const section = cues.find(([, cue]) => cue.test(text))?.[0];
      return section ? [{ span, text, title, section }] : [];
    });
  });
  const subjects = (options.subjects ?? []).map(subject => subject.trim()).filter(Boolean);
  const patterns = subjects.map(subjectPattern);
  if (subjects.length) return subjects.map((subject, index) => ({
    subject,
    sections: groupEvidence(candidates, options, (text, title, section) => subjectRelevance(text, title, patterns, index, section)),
  }));

  const topic = options.topic?.trim();
  const topicWords = topic ? wordSet(topic) : new Set<string>();
  const pattern = topic && topicWords.size ? subjectPattern(topic) : undefined;
  return [{ sections: groupEvidence(candidates, options, (text, title) => {
    if (!pattern) return 1;
    if (pattern.test(text)) return 4;
    if (pattern.test(title)) return 2;
    const words = wordSet(text);
    return topicWords.size > 1 && [...topicWords].filter(word => words.has(word)).length >= Math.ceil(topicWords.size / 2) ? 1 : 0;
  }) }];
}
