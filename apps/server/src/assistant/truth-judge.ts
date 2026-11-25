import { publicSearchScan, publicSearchText, safeResumeUrl } from '@mohassan/browser';
import { inspectTruth, isTruthSafetyNote, type TruthFinding, type TruthInspection, type TruthPage } from './truth-agreement.js';
import { independentTruthPages } from './truth-second-source.js';
import type { JudgeDecision } from './judge.js';
import { releaseLines, releaseQuestion } from './releases.js';

export type TruthPolicy = 'agreement' | 'corroborated' | 'require_two';
export const TRUTH_POLICY: TruthPolicy = 'corroborated';
export type TruthSourceStatus = 'not_needed' | 'single_source' | 'confirmed' | 'conflict';
export type TruthCode = TruthFinding | 'single_source' | 'source_conflict' | 'evidence_unavailable' | 'outside_scope';

export interface TruthVerdict {
  decision: JudgeDecision;
  codes: readonly TruthCode[];
  source: TruthSourceStatus;
  lookup: boolean;
  measured: boolean;
  repaired: boolean;
  replacement: string | null;
}
export interface TruthInput {
  question: string;
  reply: string;
  pages: readonly TruthPage[];
  /** The reply's cited page, when the host knows it. Other pages may corroborate that page. */
  primaryUrl?: string;
  lookup?: (supporting: readonly TruthPage[]) => Promise<TruthPage | null>;
  scope?: 'factual' | 'other' | 'ungrounded_fact';
}

const REASONS = {
  answer_type: 'لم أجد في الأدلة جوابًا من النوع الذي طلبته.',
  wrong_entity: 'الأدلة التي قرأتها تتحدث عن كيان مختلف عن المطلوب.',
  wrong_relation: 'الأدلة التي قرأتها تتحدث عن معلومة مختلفة عن التي طلبتها.',
  unsupported_claim: 'لم أجد في النص المقروء سندًا كافيًا للجواب.',
  source_conflict: 'وجدت قيمًا مختلفة للمعلومة المطلوبة في المصادر، فلم أؤكد أيًّا منها.',
  single_source: 'وجدت المعلومة في مصدر واحد فقط وتعذّر تأكيدها من مصدر مستقل.',
  evidence_unavailable: 'لم يتوفر نص موثوق أستطيع مطابقة الجواب معه.',
} satisfies Record<Exclude<TruthCode, 'outside_scope'>, string>;

const SOURCE = /^\s*\*\*(?:Source|المصدر):\*\*[^\n]*?\]\((https?:\/\/[^\s]+?)\)(?:\s|$)/imu;
const OLD_SOURCE_NOTE = /^\s*(?:\*\*(?:مصدر ثانٍ يؤكد|مصدر ثانٍ يختلف|A second source agrees|A second source differs):\*\*|لم أتحقق من هذا الرقم في مصدر ثانٍ|I did not check this figure against a second source)/iu;
const LTS = /\b(?:lts|long[- ]term support)\b|دعم (?:طويل|طويلة) [اأ]ل[اأ]مد/iu;
const LATEST_RELEASE = /\b(?:latest|newest|current) (?:stable )?(?:version|release)\b|(?:[اأ]حدث|آخر|اخر) (?:إصدار|اصدار|نسخة)/iu;

export function citedTruthUrl(reply: string): string | undefined {
  return SOURCE.exec(reply)?.[1];
}

function withoutSourceNote(reply: string): string {
  return reply.split('\n').filter(line => !OLD_SOURCE_NOTE.test(line)).join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function pageKey(raw: string): string {
  const url = URL.parse(raw);
  if (!url) return raw;
  url.hash = '';
  return url.href;
}

function sourceLinks(urls: Iterable<string>): string {
  return [...new Set(urls)].flatMap(raw => {
    const safe = safeResumeUrl(raw);
    if (!safe) return [];
    const scanned = publicSearchScan(safe);
    if (publicSearchText(scanned) !== scanned) return [];
    const url = new URL(safe);
    return [`[${url.hostname}](${url.href.replaceAll('(', '%28').replaceAll(')', '%29')})`];
  }).join(' · ');
}

function uniqueCodes(codes: TruthCode[]): TruthCode[] {
  return [...new Set(codes)];
}

function withheld(reason: Exclude<TruthCode, 'outside_scope'>, verdict: TruthVerdict, urls: string[] = []): TruthVerdict {
  const links = sourceLinks(urls);
  return { ...verdict, decision: 'withhold', repaired: false, codes: uniqueCodes([...verdict.codes, reason]),
    replacement: links ? `${REASONS[reason]}\n\nالمصادر: ${links}` : REASONS[reason] };
}

type Fragment = TruthInspection['fragments'][number];

/** Repair by selection only. All kept text comes from verified fragments of this reply. */
function supportedReply(fragments: Fragment[], input: TruthInput, arabic: boolean): string {
  const text = fragments.map(item => item.text).join('\n\n');
  const links = sourceLinks(fragments.flatMap(item => item.supportingUrls));
  const notes = input.reply.split('\n').filter(isTruthSafetyNote).join('\n');
  return [text, links && `**${arabic ? 'المصدر' : 'Source'}:** ${links}`, notes].filter(Boolean).join('\n\n');
}

function sourceAgreement(fragments: Fragment[], pages: readonly TruthPage[]) {
  const indexed = new Map(pages.map(page => [page.url, page]));
  const sources = new Set<string>();
  const single = new Set<string>();
  const conflicts = new Set<string>();
  for (const fragment of fragments) {
    for (const claim of fragment.quantities) {
      const supporting = claim.supportingUrls.flatMap(url => indexed.get(url) ?? []);
      const independent = supporting.some((primary, index) => supporting.slice(index + 1).some(other => independentTruthPages(primary, other)));
      if (!independent) supporting.forEach(page => single.add(page.url));
      supporting.forEach(page => sources.add(page.url));
      for (const url of claim.conflictingUrls) {
        const other = indexed.get(url);
        const primary = other && supporting.find(page => independentTruthPages(page, other));
        if (primary) {
          conflicts.add(primary.url);
          conflicts.add(other.url);
        }
      }
    }
  }
  const status: TruthSourceStatus = conflicts.size ? 'conflict' : single.size ? 'single_source' : sources.size ? 'confirmed' : 'not_needed';
  return { status, sources: [...sources], single: [...single], conflicts: [...conflicts] };
}

/** The release renderer derives its version and UTC timestamp by parsing the quoted directory entry. */
async function judgeOfficialRelease(input: TruthInput, page: TruthPage, policy: TruthPolicy, measured: TruthVerdict): Promise<TruthVerdict | null> {
  const source = releaseQuestion(input.question);
  if (!source || pageKey(page.url) !== pageKey(source.page)) return null;
  if (LTS.test(input.question)) return withheld('wrong_relation', measured);
  const fact = source.parse(page.quote);
  if (!fact) return withheld('unsupported_claim', measured);
  const arabic = /\p{Script=Arabic}/u.test(input.question);
  const line = releaseLines(source, fact, arabic ? 'ar' : 'en')[0]!;
  if (!input.reply.split('\n').includes(line)) return withheld('unsupported_claim', measured);

  const title = arabic ? 'المصدر' : 'Source';
  const conversion = arabic ? 'تحويل التاريخ والوقت من السطر المقتبس إلى صيغة UTC.' : 'Date and time converted from the quoted entry to UTC format.';
  const checked = `${line}\n\n> ${fact.evidence}\n\n${conversion}\n\n**${title}:** ${sourceLinks([page.url])}`;
  if (policy === 'agreement') return { ...measured, decision: 'fix', replacement: checked };
  let extra: TruthPage | null = null;
  if (input.lookup) {
    try { extra = await input.lookup([page]); } catch { /* Keep the verified directory as the primary source. */ }
  }
  const candidates = [...input.pages, ...(extra ? [extra] : [])].filter(item => independentTruthPages(page, item));
  const peers = candidates.flatMap(item => {
    const parsed = source.parse(item.quote);
    if (!parsed) return [];
    const entry = item.quote.split('\n').find(line => line.includes(parsed.evidence));
    const context = [item.title, entry].filter(Boolean).join(' ');
    return LATEST_RELEASE.test(context) && context.toLowerCase().includes(source.product.toLowerCase())
      ? [{ ...parsed, url: item.url }] : [];
  });
  const conflict = peers.find(peer => peer.version !== fact.version || peer.publishedAt !== fact.publishedAt);
  const checkedSources = { ...measured, lookup: Boolean(input.lookup) };
  if (conflict) return withheld('source_conflict', { ...checkedSources, source: 'conflict' }, [page.url, conflict.url]);
  if (peers.length) return { ...checkedSources, decision: 'fix', source: 'confirmed', replacement: `${checked}\n\n${sourceLinks(peers.map(peer => peer.url))}` };
  const single = { ...checkedSources, source: 'single_source' as const };
  if (policy === 'require_two') return withheld('single_source', single);
  return { ...single, decision: 'fix', codes: ['single_source'],
    replacement: `${arabic ? 'وفق مصدر واحد:' : 'According to one source:'}\n\n${checked}` };
}

export async function judgeTruth(input: TruthInput, policy: TruthPolicy = TRUTH_POLICY): Promise<TruthVerdict> {
  const result: TruthVerdict = {
    decision: 'send', codes: [], source: 'not_needed', lookup: false, measured: false, repaired: false, replacement: null,
  };
  if (input.scope === 'other') return { ...result, codes: ['outside_scope'] };
  if (input.scope === 'ungrounded_fact') return withheld('evidence_unavailable', result);

  const primaryUrl = input.primaryUrl ?? citedTruthUrl(input.reply);
  const initialPages = input.pages.filter(page => page.quote.trim());
  const primary = primaryUrl ? initialPages.filter(page => pageKey(page.url) === pageKey(primaryUrl)) : initialPages;
  if (!primary.length) return withheld('evidence_unavailable', result);

  const measured = { ...result, measured: true };
  if (primaryUrl && primary.length === 1) {
    const official = await judgeOfficialRelease(input, primary[0]!, policy, measured);
    if (official) return official;
  }
  const arabic = /\p{Script=Arabic}/u.test(input.question);
  const inspection = inspectTruth(input.question, input.reply, primary);
  const findings = inspection.fragments.flatMap(item => item.finding ? [item.finding] : []);
  const grounded = { ...measured, codes: uniqueCodes(findings) };
  const answers = inspection.fragments.filter(item => !item.finding && item.answering);
  if (!inspection.supportedAnswer || !answers.length) {
    return withheld(findings[0] ?? 'wrong_relation', grounded);
  }

  // The first surviving answer has to lead. Supported background can remain after it.
  const lead = answers[0]!;
  const kept = [lead, ...inspection.fragments.filter(item => item !== lead && !item.finding)];
  const repaired = findings.length > 0 || inspection.fragments[0] !== lead;
  let replacement = repaired ? supportedReply(kept, input, arabic) : withoutSourceNote(input.reply);
  let source: TruthSourceStatus = 'not_needed';
  let lookup = false;
  if (policy !== 'agreement' && kept.some(item => item.quantities.length)) {
    const claimsText = kept.map(item => item.text).join('\n\n');
    const recheck = (pages: readonly TruthPage[]) => {
      const reassessed = inspectTruth(input.question, claimsText, pages);
      const claims = reassessed.fragments.filter(item => !item.finding);
      // Corroboration cannot erase a claim that was already inspected against the primary.
      return claims.length === kept.length ? claims : kept;
    };
    let pages = initialPages;
    let agreement = sourceAgreement(recheck(pages), pages);
    if (agreement.status === 'single_source' && input.lookup) {
      lookup = true;
      const supporting = primary.filter(page => agreement.sources.includes(page.url));
      let extra: TruthPage | null = null;
      try { extra = await input.lookup(supporting.length ? supporting : primary); } catch { /* Attribute to the primary source. */ }
      if (extra) {
        const primaryPages = supporting.length ? supporting : primary;
        if (primaryPages.some(page => independentTruthPages(page, extra))) {
          pages = [...pages, extra];
          agreement = sourceAgreement(recheck(pages), pages);
        }
      }
    }
    source = agreement.status;
    const corroborated = { ...grounded, source, lookup };
    if (source === 'conflict') return withheld('source_conflict', corroborated, agreement.conflicts);
    if (source === 'single_source') {
      if (policy === 'require_two') return withheld('single_source', corroborated);
      replacement = `${arabic ? 'وفق مصدر واحد:' : 'According to one source:'}\n\n${replacement}`;
    }
    if (source === 'confirmed') {
      const label = arabic ? 'مصادر مستقلة تؤكد القيم' : 'Independent sources confirm the values';
      replacement += `\n\n**${label}:** ${sourceLinks(agreement.sources)}`;
    }
  }

  const codes = source === 'single_source' ? uniqueCodes([...grounded.codes, source]) : grounded.codes;
  if (replacement === input.reply.trim()) return { ...grounded, codes, source, lookup };
  return { ...grounded, decision: 'fix', codes, source, lookup, replacement, repaired };
}
