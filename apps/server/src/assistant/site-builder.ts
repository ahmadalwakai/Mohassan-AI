import type { SiteBrief, SiteDetail, SitePartialBrief, SiteWant } from '@mohassan/contracts';
import { applyAnswers, commandExamples, completeBrief, isSiteRequest, MAX_ROUNDS, missingWants, siteQuestion, siteSentence, WANT_LABELS, type SiteQuestionField } from '@mohassan/sites';
import type { WorkspaceRole } from '../members.js';

/**
 * The website flow in the chat, with no model: the sentence is read, a card asks for whatever is missing
 * (as many rounds as needed, six fields at a time), the site is composed from the user's own words, and
 * later sentences edit it. Content a block needs is asked for, never invented.
 */
export interface SiteChatState {
  partial: SitePartialBrief;
  /** The wants of the pending card, in field order. */
  asked?: SiteWant[];
  requestText: string;
}
export interface SitesChatPort {
  createFromBrief(ownerId: string, brief: SiteBrief, options: { conversationId: string; role?: WorkspaceRole }): Promise<SiteDetail>;
  command(ownerId: string, siteId: string, input: { text: string; want?: SiteWant }): Promise<{ kind: 'patch' | 'undo' | 'ask' | 'unknown'; summary: string; want?: SiteWant; title?: string; detail: SiteDetail }>;
  detail(ownerId: string, siteId: string): Promise<SiteDetail>;
  roleOf?(ownerId: string): Promise<WorkspaceRole | null>;
  /** An absolute link to the site in the app; the chat renders only http(s) links. */
  link?(siteId: string): string;
}

/** Arabic counts read naturally: صفحة واحدة، صفحتان، 3 صفحات، 11 صفحة. */
export function pagesLabel(count: number, lang: 'ar' | 'en'): string {
  if (lang === 'en') return count === 1 ? 'one page' : `${count} pages`;
  if (count === 1) return 'صفحة واحدة';
  if (count === 2) return 'صفحتان';
  return count <= 10 ? `${count} صفحات` : `${count} صفحة`;
}

/** The start of the flow, or null when the sentence does not ask for a website. */
export function siteTask(request: string): SiteChatState | null {
  if (!isSiteRequest(request)) return null;
  const partial = siteSentence(request);
  return partial ? { partial, requestText: request } : null;
}

export interface SiteCard { prompt: string; fields: SiteQuestionField[]; wants: SiteWant[] }
/** The next card, or null when everything the brief needs is known. */
export function siteCard(state: SiteChatState): SiteCard | null {
  if (state.partial.rounds >= MAX_ROUNDS) return null;
  const question = siteQuestion(state.partial);
  return question ? { prompt: question.prompt, fields: question.fields, wants: question.wants } : null;
}

/** Folds the card's answers (field id → text) into the state. */
export function siteAnswers(state: SiteChatState, fields: Readonly<Record<string, string>>): SiteChatState {
  return { ...state, partial: applyAnswers(state.partial, fields), asked: undefined };
}

const say = (lang: 'ar' | 'en', ar: string, en: string) => (lang === 'ar' ? ar : en);
const previewLink = (port: SitesChatPort, detail: SiteDetail) => port.link?.(detail.id) ?? `/#sites=${detail.id}`;

/** Composes the site through the port and writes the reply: what was built, where to open it, how to edit it. */
export async function buildSiteReply(port: SitesChatPort, ownerId: string, state: SiteChatState, conversationId: string): Promise<{ text: string; status: 'completed' | 'partial' | 'blocked'; siteId?: string }> {
  const lang = state.partial.lang;
  const completion = completeBrief(state.partial, { requestText: state.requestText });
  if ('missing' in completion) {
    const labels = completion.missing.map(want => WANT_LABELS[lang][want]).join(lang === 'ar' ? '، ' : ', ');
    return { text: say(lang, `لم أستطع بناء الموقع لأن ما يلي ما زال ناقصاً: ${labels}. اكتبه لي وأكمل.`, `I could not build the site because this is still missing: ${labels}. Send it and I will continue.`), status: 'blocked' };
  }
  const role = port.roleOf ? (await port.roleOf(ownerId)) ?? undefined : undefined;
  const detail = await port.createFromBrief(ownerId, completion.brief, { conversationId, role });
  const skipped = state.partial.skipped.filter(want => state.partial.requested.includes(want));
  const pages = detail.pages.map(page => page.title).join(lang === 'ar' ? '، ' : ', ');
  const failed = detail.checks.checks.filter(check => !check.passed);
  const lines = lang === 'ar'
    ? [
      `بنيتُ موقع «${detail.name}» من كلماتك: ${pagesLabel(detail.pages.length, 'ar')} (${pages}).`,
      `[افتح المعاينة](${previewLink(port, detail)}) لتراه على الهاتف والحاسوب، وتنزّله ملف ZIP، أو تنشره.`,
      failed.length ? `تنبيه: لم تجتز ${failed.length} من الفحوص الآلية: ${failed.map(check => check.message).join(' | ')}` : 'اجتاز الموقع الفحوص الآلية كلها (روابط، تباين، أرقام من كلامك فقط، بلا مصادر خارجية).',
      skipped.length ? `تركتُ ما لم تعطني محتواه: ${skipped.map(want => WANT_LABELS.ar[want]).join('، ')}. اكتب لي محتواه متى شئت وسأضيفه.` : '',
      `للتعديل اكتب لي مباشرة، مثلاً: ${commandExamples('ar').slice(0, 4).map(example => `«${example}»`).join('، ')}.`,
    ]
    : [
      `I built the "${detail.name}" site from your words: ${pagesLabel(detail.pages.length, 'en')} (${pages}).`,
      `[Open the preview](${previewLink(port, detail)}) to see it on phone and desktop, download it as a ZIP, or publish it.`,
      failed.length ? `Note: ${failed.length} automatic checks did not pass: ${failed.map(check => check.message).join(' | ')}` : 'It passed every automatic check (links, contrast, numbers from your words only, no external sources).',
      skipped.length ? `I left out what you gave no content for: ${skipped.map(want => WANT_LABELS.en[want]).join(', ')}. Send it any time and I will add it.` : '',
      `To change anything just tell me, for example: ${commandExamples('en').slice(0, 4).map(example => `"${example}"`).join(', ')}.`,
    ];
  return { text: lines.filter(Boolean).join('\n\n'), status: failed.length ? 'partial' : 'completed', siteId: detail.id };
}

export interface SiteCommandTurn { text: string; pendingWant?: { want: SiteWant; title?: string } | null; handled: boolean }
/**
 * A later sentence about the conversation's site: an answer to a pending content question, or a command.
 * Returns handled=false when the sentence is neither, so the chat treats it as an ordinary request.
 */
export async function siteCommandTurn(port: SitesChatPort, ownerId: string, siteId: string, text: string, pending: { want: SiteWant; title?: string } | null | undefined): Promise<SiteCommandTurn> {
  // The command grammar first, so "undo" or "change the colour" never become the content of a pending question.
  const result = await port.command(ownerId, siteId, { text });
  const lang = result.detail.lang;
  switch (result.kind) {
    case 'patch': case 'undo': return { text: `${result.summary} [${say(lang, 'افتح المعاينة', 'Open the preview')}](${previewLink(port, result.detail)})`, pendingWant: null, handled: true };
    case 'ask': return { text: result.summary, pendingWant: { want: result.want!, ...(result.title ? { title: result.title } : {}) }, handled: true };
    default: break;
  }
  // Then the answer to a pending content question, unless the sentence is itself a question.
  if (pending && !/[؟?]\s*$/.test(text.trim())) {
    const filled = await port.command(ownerId, siteId, { text, want: pending.want });
    if (filled.kind === 'patch') return { text: `${filled.summary} [${say(filled.detail.lang, 'افتح المعاينة', 'Open the preview')}](${previewLink(port, filled.detail)})`, pendingWant: null, handled: true };
  }
  return { text: result.summary, pendingWant: pending ?? null, handled: Boolean(result.summary) };
}

/** What the chat says when a site sentence arrives but no site service is configured. */
export const siteUnavailableText = (lang: 'ar' | 'en') => say(lang, 'بناء المواقع غير مفعّل على هذا الخادم بعد.', 'Website building is not enabled on this server yet.');
export { missingWants };
