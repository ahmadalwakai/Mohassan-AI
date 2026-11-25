import { requestTerms, skillStems } from '../../../../../../packages/skills/src/stems.js';
import { matchText } from '../../mind/normalize.js';
import { inline, quote } from '../citation.js';
import { exactOrRedundant, wordCount, type EvidenceSpan, type WritingSource } from '../evidence.js';
import type { ExtractiveWritingReply } from '../render.js';
import type { ExtractiveWritingTask } from '../request.js';
import { sameEntity } from './alignment.js';
import { sourceBodyIdentity, sourceIdentity } from './gather.js';
import type { Claim, ClaimConflict, ClaimGroup } from './types.js';

const labels = {
  en: { mechanism: 'Mechanism', factors: 'Factors', examples: 'Examples', limits: 'Limits', conflicts: 'Conflicting sources',
    missing: 'No matching evidence', aspect: 'Aspect' },
  ar: { mechanism: 'الآلية', factors: 'العوامل', examples: 'أمثلة', limits: 'الحدود', conflicts: 'المصادر المتعارضة',
    missing: 'لم أجد أدلة مطابقة', aspect: 'الجانب' },
};

const attributes: Record<string, readonly [string, string]> = {
  definition: ['Definition', 'التعريف'], composition: ['Composition', 'التركيب'], mechanism: ['Mechanism', 'الآلية'],
  function: ['Function', 'الوظيفة'], input: ['Input', 'المدخلات'], output: ['Output', 'المخرجات'],
  location: ['Location', 'الموقع'], size: ['Size', 'الحجم'], length: ['Length', 'الطول'], width: ['Width', 'العرض'],
  height: ['Height', 'الارتفاع'], area: ['Area', 'المساحة'], distance: ['Distance', 'المسافة'], capacity: ['Capacity', 'السعة'],
  cost: ['Cost', 'التكلفة'], power: ['Power', 'القدرة'], duration: ['Duration', 'المدة'], speed: ['Speed', 'السرعة'],
  schedule: ['Schedule', 'الجدول الزمني'], property: ['Properties', 'الخصائص'], contrast: ['Direct comparison', 'مقارنة مباشرة'],
};

const questionVerbs = new Set(skillStems('explain describe work operate function happen occur cause form works تعمل يعمل يحدث تحدث يحصل تحصل يسبب تسبب يتكون تتكون'));

function validQuote({ span }: Claim, format: ExtractiveWritingTask['format']): boolean {
  const maxLength = format === 'line' ? 360 : format === 'detailed' ? 1600 : 900;
  return Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0 && span.end > span.start
    && span.end <= span.source.text.length && span.text.length <= maxLength
    && (format !== 'line' || wordCount(span.text) <= 45) && span.source.text.slice(span.start, span.end) === span.text;
}

interface Relevance { score: number; direct: boolean }

function rankForTopic(task: ExtractiveWritingTask): (claim: Claim) => Relevance {
  const terms = requestTerms(task.topic ?? '', 500);
  const anchors = terms.filter(term => !term.variants.some(variant => questionVerbs.has(variant)));
  const queryTerms = anchors.length ? anchors : terms;
  const matches = (text: string | undefined): number => {
    if (!text) return 0;
    const terms = new Set(skillStems(text));
    return queryTerms.filter(term => term.variants.some(variant => terms.has(variant))).length;
  };
  return claim => {
    if (!validQuote(claim, task.format)) return { score: 0, direct: false };
    if (!queryTerms.length) return { score: 1, direct: true };
    const subject = matches(claim.subject);
    const text = matches(claim.span.text);
    const title = matches(claim.span.source.title);
    const effect = task.intent === 'why' ? matches(claim.effect) : 0;
    const required = Math.min(queryTerms.length, 2);
    const directMatches = Math.max(text, subject, effect);
    if (Math.max(directMatches, title) < required) return { score: 0, direct: false };
    const languageMatch = /\p{Script=Arabic}/u.test(claim.span.text) === (task.language === 'ar');
    return { score: effect * 3 + subject * 2 + text + title / 2 + Number(languageMatch) / 4, direct: directMatches >= required };
  };
}

interface RankedGroup {
  choices: { claim: Claim; relevance: Relevance }[];
  support: number;
}

function rankedGroups(groups: readonly ClaimGroup[], relevance: (claim: Claim) => Relevance): RankedGroup[] {
  return groups.flatMap(group => {
    const choices = group.claims.map(claim => ({ claim, relevance: relevance(claim) })).filter(choice => choice.relevance.score > 0)
      .sort((a, b) => Number(b.relevance.direct) - Number(a.relevance.direct) || b.relevance.score - a.relevance.score);
    return choices.length ? [{ choices, support: group.support }] : [];
  }).sort((a, b) => b.support - a.support || b.choices[0].relevance.score - a.choices[0].relevance.score);
}

function conflictSection(task: ExtractiveWritingTask, conflicts: readonly ClaimConflict[], applies: (claim: Claim) => boolean) {
  const pairs = conflicts.filter(({ left, right }) => validQuote(left, task.format) && validQuote(right, task.format)
    && applies(left) && applies(right)).slice(0, task.format === 'detailed' ? 5 : 3);
  const title = `**${labels[task.language].conflicts}**`;
  const entries = pairs.map(({ left, right }) => `${quote(left.span, task)} · ${quote(right.span, task)}`);
  const text = !entries.length ? '' : task.format === 'line' && task.kind !== 'comparison' ? `${title} · ${entries.join(' · ')}`
    : [title, ...entries.map(entry => `- ${entry}`)].join('\n\n');
  return { text, spans: pairs.flatMap(({ left, right }) => [left.span, right.span]) };
}

function explanation(task: ExtractiveWritingTask, groups: readonly ClaimGroup[], conflicts: readonly ClaimConflict[]): ExtractiveWritingReply {
  const relevance = rankForTopic(task);
  const ranked = rankedGroups(groups, relevance);
  const name = labels[task.language];
  const evidence: EvidenceSpan[] = [];
  const selected = new Set<RankedGroup>();
  const blocks: string[] = [];
  const line = task.format === 'line';
  const compact = task.format !== 'detailed';
  const conflict = conflictSection(task, conflicts, claim => relevance(claim).score > 0);
  const disputed = new Set(conflicts.flatMap(({ left, right }) => [left.span, right.span]));
  const coreKinds: Claim['kind'][] = task.intent === 'why' ? ['causal', 'mechanism', 'definition', 'attribute']
    : ['mechanism', 'causal', 'definition', 'attribute'];
  const best = (group: RankedGroup) => group.choices[0].claim;
  const coreFor = (candidates: RankedGroup[]) => coreKinds.map(kind => candidates.find(group => best(group).kind === kind)).find(group => group !== undefined);
  const core = coreFor(ranked.filter(group => group.choices[0].relevance.direct)) ?? coreFor(ranked);
  if (core) {
    selected.add(core);
    const sources = new Set<string | WritingSource>();
    const bodies = new Set<string>();
    const spans: EvidenceSpan[] = [];
    for (const { claim: { span } } of core.choices) {
      const source = sourceIdentity(span.source) ?? span.source;
      if (sources.has(source)) continue;
      const body = sourceBodyIdentity(span.source);
      if (bodies.has(body)) continue;
      sources.add(source);
      bodies.add(body);
      spans.push(span);
      if (spans.length >= Math.min(core.support, line ? 1 : compact ? 2 : 3)) break;
    }
    evidence.push(...spans);
    blocks.push(spans.map(span => quote(span, task)).join(line ? ' · ' : '\n\n'));
  }
  const addSection = (title: string, kind: Claim['kind'], maximum: number) => {
    const candidates = ranked.filter(group => best(group).kind === kind && !selected.has(group)
      && (kind !== 'causal' || group.choices[0].relevance.direct)
      && !group.choices.some(({ claim }) => disputed.has(claim.span)));
    if (kind === 'mechanism') candidates.sort((a, b) => (best(a).step ?? Number.MAX_SAFE_INTEGER) - (best(b).step ?? Number.MAX_SAFE_INTEGER));
    const entries: string[] = [];
    for (const group of candidates) {
      const { span } = best(group);
      if (evidence.some(other => exactOrRedundant(span.text, other.text))) continue;
      entries.push(quote(span, task));
      evidence.push(span);
      if (entries.length === maximum) break;
    }
    if (entries.length) blocks.push(`**${title}**\n\n${entries.map(entry => `- ${entry}`).join('\n')}`);
  };
  if (!line) {
    addSection(name.mechanism, 'mechanism', compact ? 3 : 5);
    addSection(name.factors, 'causal', compact ? 2 : 4);
    addSection(name.examples, 'example', compact ? 1 : 2);
    addSection(name.limits, 'limit', compact ? 1 : 2);
  }
  if (conflict.text) blocks.push(conflict.text);
  evidence.push(...conflict.spans);
  const coreKind = core && best(core).kind;
  const direct = core?.choices[0].relevance.direct || task.source.kind !== 'search';
  return { text: blocks.join(line ? ' · ' : '\n\n') || name.missing, evidence,
    complete: Boolean(direct && (coreKind === 'causal' || coreKind === 'mechanism' && task.intent !== 'why')) };
}

function entityForms(text: string): string[] {
  const alias = /\(([^()]{2,30})\)\s*$/u.exec(text);
  if (alias) return [text.slice(0, alias.index).trim(), alias[1]];
  const apposition = /[,،]\s*(?:also known as|ويعرف باسم|المعروف باسم)\s+([^,،]{1,60})$/iu.exec(text);
  return apposition ? [text.slice(0, apposition.index).trim(), apposition[1]] : [text];
}

function claimSubject(claim: Claim): string | undefined {
  if (claim.subject || claim.kind !== 'mechanism' || !claim.predicate) return claim.subject;
  // A mechanism predicate can identify the actor when its literal lead is the full requested name.
  const lead = claim.span.text.slice(0, Math.max(claim.span.text.indexOf(claim.predicate), 0));
  return /\s$/u.test(lead) ? lead.trim().replace(/[,،]$/u, '').trim() : undefined;
}

interface ComparisonEntry {
  claim: Claim;
  support: number;
}

interface ComparisonRow {
  label: string;
  cells: (ComparisonEntry | undefined)[];
  shared: boolean;
}

function comparison(task: ExtractiveWritingTask, groups: readonly ClaimGroup[], conflicts: readonly ClaimConflict[]): ExtractiveWritingReply {
  const subjects = task.subjects ?? [];
  const name = labels[task.language];
  const requested = subjects.map(subject => {
    const scoped = /^(.+?)\s+(?:in|for|after|during|upon|في|بعد|تحت|عند)\s+(.+)$/iu.exec(subject);
    return { forms: entityForms(subject), scope: scoped && { entity: scoped[1], terms: skillStems(scoped[2]) } };
  });
  const subjectIndex = (subject: string | undefined, span: EvidenceSpan): number => {
    if (!subject) return -1;
    const forms = entityForms(subject);
    const matches = requested.flatMap((item, index) => item.forms.some(variant => forms.some(form => sameEntity(form, variant))) ? [index] : []);
    if (matches.length) return matches.length === 1 ? matches[0] : -1;
    // A shorter name needs literal evidence of the requested context in its sentence or page title.
    const terms = new Set(skillStems(`${span.source.title} ${span.text}`));
    const scoped = requested.flatMap(({ scope }, index) => scope?.terms.length
      && forms.some(form => sameEntity(form, scope.entity)) && scope.terms.every(term => terms.has(term)) ? [index] : []);
    return scoped.length === 1 ? scoped[0] : -1;
  };
  const rows = new Map<string, ComparisonRow>();
  const language = task.language === 'ar' ? 1 : 0;
  for (const group of groups) for (const claim of group.claims) {
    if (!validQuote(claim, task.format)) continue;
    const index = subjectIndex(claimSubject(claim), claim.span);
    if (index < 0) continue;
    const contrasted = subjectIndex(claim.contrasted, claim.span);
    const shared = claim.kind === 'contrast' && contrasted >= 0 && contrasted !== index;
    if (claim.kind === 'contrast' && !shared) continue;
    const attribute = shared ? 'contrast' : claim.attribute ?? (claim.kind === 'definition' || claim.kind === 'mechanism' ? claim.kind : '');
    const key = matchText(attribute).trim();
    if (!key) continue;
    const label = attributes[key]?.[language] ?? (attribute.length <= 80 && claim.span.text.includes(attribute) ? attribute : '');
    if (!label) continue;
    const row = rows.get(key) ?? { label, cells: subjects.map(() => undefined), shared: false };
    row.shared ||= shared;
    if (!row.cells[index] || row.cells[index]!.support < group.support) row.cells[index] = { claim, support: group.support };
    rows.set(key, row);
  }
  const filled = (row: ComparisonRow) => row.shared || row.cells.every(Boolean);
  const support = (row: ComparisonRow) => Math.max(...row.cells.map(entry => entry?.support ?? 0));
  const ranked = [...rows.values()].sort((a, b) => Number(filled(b)) - Number(filled(a)) || support(b) - support(a));
  const evidence: EvidenceSpan[] = [];
  const missing = '—';
  const table = [`| ${name.aspect} | ${subjects.map(inline).join(' | ')} |`, `| --- | ${subjects.map(() => '---').join(' | ')} |`];
  for (const row of ranked.slice(0, task.format === 'detailed' ? 10 : 6)) {
    const cells = row.cells.map(entry => {
      if (!entry) return missing;
      const { span } = entry.claim;
      evidence.push(span);
      return quote(span, task);
    });
    table.push(`| ${inline(row.label)} | ${cells.join(' | ')} |`);
  }
  const conflict = conflictSection(task, conflicts, claim => subjectIndex(claimSubject(claim), claim.span) >= 0);
  evidence.push(...conflict.spans);
  const blocks = [...(ranked.length ? [table.join('\n')] : []), ...(conflict.text ? [conflict.text] : [])];
  return { text: blocks.join('\n\n') || name.missing, evidence, complete: ranked.some(filled) };
}

export function composeExplanation(task: ExtractiveWritingTask, groups: readonly ClaimGroup[], conflicts: readonly ClaimConflict[]): ExtractiveWritingReply {
  return task.kind === 'comparison' ? comparison(task, groups, conflicts) : explanation(task, groups, conflicts);
}
