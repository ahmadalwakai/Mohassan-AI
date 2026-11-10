import { ADS_LIMITS, adsLength, validateAdText } from '@mohassan/google-ads';

/** The chat's text check. The rules themselves live in the Ad Quality Validator, which the draft flow uses too. */
export const ADS_SKILL_SLUG = 'google-ads-campaign';
export { ADS_LIMITS, adsLength };

const LINE = /^(?:[-*•]\s*)?([hdpkn])\s*\d*\s*:\s*(.*)$/i;
type Kind = 'h' | 'd' | 'p' | 'k' | 'n';

/** Added by code because the model skipped these lines in the live check. */
export const ADS_DRAFT_NOTE = '\n\n---\n**هذه مسودة غير منشورة، ولم يتغير شيء في حساب Google Ads.**\n- لا تطلق الحملة قبل التأكد من عمل تتبع التحويلات.\n- الميزانية اليومية متوسط: في معظم الحملات قد يصل إنفاق اليوم إلى ضعفها، والحد الشهري 30.4 ضعفًا.';

const SECTIONS: readonly [Kind, string][] = [['h', 'العناوين'], ['d', 'الأوصاف'], ['p', 'مسارات العرض'], ['k', 'الكلمات المفتاحية'], ['n', 'الكلمات السلبية']];

export interface AdsCheckResult { passed: boolean; text: string; approved: string | null }
export type AdsItems = Record<Kind, string[]>;
export type AdsTextInput = { headlines: string[]; descriptions: string[]; paths: string[]; keywords: string[]; negativeKeywords: string[] };

/** Reads the one-item-per-line form. A line it cannot read is reported, never skipped. */
export function parseAdsLines(draft: string): { items: AdsItems; problems: string[]; total: number } {
  const items: AdsItems = { h: [], d: [], p: [], k: [], n: [] };
  const problems: string[] = [];
  for (const line of draft.split(/\r?\n/).map(entry => entry.trim()).filter(Boolean)) {
    const match = LINE.exec(line);
    // A line we cannot read would otherwise reach the owner unchecked.
    if (!match) { problems.push(`line not understood, use H:, D:, P:, K: or N: ${JSON.stringify(line.slice(0, 80))}`); continue; }
    const kind = match[1]!.toLowerCase() as Kind;
    // Models write both display paths as moving/glasgow; a rejection only costs another paid step.
    items[kind].push(...(kind === 'p' ? match[2]!.split('/') : [match[2]!]).map(item => item.trim()));
  }
  const total = Object.values(items).reduce((sum, list) => sum + list.length, 0);
  if (!total && !problems.length) problems.push('nothing to check, send one item per line starting with H:, D:, P:, K: or N:');
  return { items, problems, total };
}

export const adsTextInput = (items: AdsItems): AdsTextInput => ({ headlines: items.h, descriptions: items.d, paths: items.p, keywords: items.k, negativeKeywords: items.n });
export const adsItemsOf = (input: AdsTextInput): AdsItems => ({ h: input.headlines, d: input.descriptions, p: input.paths, k: input.keywords, n: input.negativeKeywords });
/** The same line form the model sends, so it can copy corrected text straight into the next tool. */
export const adsLines = (items: AdsItems) => [...(['h', 'd'] as const).flatMap(kind => items[kind].map(item => `${kind.toUpperCase()}: ${item}`)), ...(items.p.length ? [`P: ${items.p.join('/')}`] : []), ...(['k', 'n'] as const).flatMap(kind => items[kind].map(item => `${kind.toUpperCase()}: ${item}`))].join('\n');
export const adsApprovedText = (items: AdsItems) => SECTIONS.filter(([kind]) => items[kind].length).map(([kind, title]) => `**${title}**\n${items[kind].map(item => `- ${item}`).join('\n')}`).join('\n\n');
export const adsFailText = (problems: readonly string[], draft: string) => `FAIL: ${problems.length} problem(s). Fix them and run ads_check again.\n${problems.slice(0, 30).map(problem => `- ${problem}`).join('\n')}${draft.trim() ? `\nThe draft you sent:\n${draft.trim()}` : ''}`;
// The model cannot be trusted to copy this, so the program prints it and the model only explains.
export const adsPassText = (total: number, draft: string) => `PASS: ${total} items approved. Do not check again and do not repeat them in answer: the program adds them to your reply. Use answer now with a short explanation. For typing into Google Ads, the approved text is:\n${draft.trim()}`;

/** `evidence` is the owner's request and the open page. Without it, claims are not judged. */
export function checkAdsDraft(draft: string, evidence?: string): AdsCheckResult {
  const { items, problems, total } = parseAdsLines(draft);
  const issues = validateAdText(adsTextInput(items), evidence);
  problems.push(...issues.filter(issue => issue.severity === 'error').map(issue => issue.message));
  if (problems.length) return { passed: false, approved: null, text: adsFailText(problems, draft) };
  return { passed: true, approved: adsApprovedText(items), text: adsPassText(total, draft) };
}
