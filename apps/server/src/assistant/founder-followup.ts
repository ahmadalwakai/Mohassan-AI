import { answerSubject, fold, plainTitle, tidy, webQuestion, type HandsStep } from './hands.js';
import { splitReplyDirective } from './reply-directive.js';

// Founding and biographical forms adapted from PR #13, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/pull/13/files
const arabicBiography = /^(?:و\s*)?(?:متي|اين|وين|هل|كم)\s+(?:ولد|ولدت|توفي|توفيت|مات|ماتت|تزوج|تزوجت|عاش|عاشت|درس|درست|عمره|عمرها)$/u;
const englishBiography = /^(?:(?:and\s+)?(?:when|where)\s+(?:was\s+(?:he|she)\s+born|did\s+(?:he|she)\s+(?:die|live|study|marry))|(?:and\s+)?how old (?:is|was) (?:he|she))$/u;
const groupDescription = /^(?:ال)?(?:فريق|مجموعه|جماعه|شركه|موسسه|صاحب|اصحاب|احد|احدي|عده|عدد|شخص|اشخاص)\s|\s(?:من|هذا|هذه|هولاء|الذي|التي)(?=\s|$)/u;
const personName = /^[\p{Script=Arabic}]+(?:\s+[\p{Script=Arabic}]+){1,3}$/u;
const isPerson = (candidate: string) => personName.test(candidate) && !groupDescription.test(fold(candidate));

function namedFounder(line: string, title: string): string | null {
  const text = tidy(line);
  const name = title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const organization = `(?:(?:شركة|مؤسسة)\\s+)?${name}`;
  const active = new RegExp(`(?:^|[،\\s])و?[أا]سس(?:ها|\\s+${organization})\\s+(?:كل\\s+من\\s+)?(.+)$`, 'u');
  const passive = new RegExp(`^(?:${organization}\\s+)?(?:ت[أا]سست|[أا]سست)(?:\\s+${organization}(?:\\s+ال[\\p{Script=Arabic}]+){0,2})?\\s+(?:على يد|بواسطة|من قبل)\\s+(.+)$`, 'u');
  const arabic = active.exec(text)?.[1] ?? passive.exec(text)?.[1]
    ?? /^(?:تجدر الإشارة\s+(?:إلى\s+)?أن\s+)?(.+?)\s+(?:هما المؤسسان|هو المؤسس|هي المؤسسة)(?=\s|[،,.]|$)/u.exec(text)?.[1];
  if (arabic) {
    const names = arabic.split(/\s+(?:في|عام|سنة|يوم|لتطوير|لإنشاء)(?=\s)|[،,.؛:()0-9٠-٩]/u, 1)[0]!.trim();
    const pair = /^(.+?)\s+و\s*(.+)$/u.exec(names);
    if (pair && isPerson(pair[1]!) && isPerson(pair[2]!)) return pair[1]!;
    return isPerson(names) ? names : null;
  }
  const english = new RegExp(`^(?:${name}\\s+(?:was|is)\\s+)?[Ff]ounded by\\s+(?!(?:The|An?)\\s)([A-Z][\\p{L}'’-]+(?:\\s+[A-Z][\\p{L}'’-]+){1,3})`, 'u').exec(text);
  return english?.[1] ?? null;
}

/** Resolve a person's biography from the prior answer's explicit founding statement. */
function founderFollowup(request: string, found: { title: string; lines: readonly string[] }): HandsStep[] | null {
  const body = tidy(splitReplyDirective(request).body);
  const key = fold(body);
  const arabic = arabicBiography.test(key);
  if (!arabic && !englishBiography.test(key)) return null;
  const founder = namedFounder(found.lines[0] ?? '', plainTitle(found.title));
  if (!founder) return null;

  const steps = webQuestion(request);
  const step = steps?.[0];
  if (step?.kind !== 'search') return null;
  const query = arabic
    ? `${step.query.replace(/عمره(?:ا)?$/u, 'عمر')} ${founder}`
    : step.query.replace(/\b(?:he|she)\b/iu, founder);
  return [{ ...step, query }];
}

export function sourcedFollowup(request: string, found: { title: string; lines: readonly string[] }): HandsStep[] | null {
  const subject = answerSubject(found);
  return subject ? founderFollowup(request, found) ?? webQuestion(request, [subject]) : null;
}
