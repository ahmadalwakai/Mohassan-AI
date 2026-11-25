import { safeResumeUrl } from '@mohassan/browser';
import { MONITOR_V2_DEFAULT_FRESHNESS_MS, MonitorSourceSchema, MonitorSpecSchema, type MonitorSpec } from '@mohassan/contracts';
import { normalizeRequest } from '../../assistant/mind/normalize.js';
import { splitReplyDirective } from '../../assistant/reply-directive.js';
import { externalHistory, interactiveOnly, noHistory } from '../../assistant/response-policy-signals.js';
import { monitorMatchText, safeMonitorRequest, type MonitorNeed } from '../detection.js';
import { monitorTimingForNeed } from '../spec.js';
import type { MonitorAnswerPage } from '../v2-chat-intents.js';
import { githubMonitorUrl, type GithubMonitorSource } from './github.js';
import { githubPublicIdentifier } from './github-network.js';

const address = /https?:\/\/[^\s<>"'`«»“”]+/giu;
const repoPair = /(?<![\p{L}\p{N}./-])([a-z\d][a-z\d-]{0,38})\/([a-z\d_.-]{1,100})(?![\p{L}\p{N}./-])/iu;
const branchRef = /\bbranch\s+["'`«“]?([^\s"'`«»“”,!؟)،؛;]+)|(?<!\p{L})(?:الفرع|فرع)\s+["'`«“]?([^\s"'`«»“”,!؟)،؛;]+)/iu;
const pullRef = /(?:\b(?:pr|pull request)\s*|(?<!\p{L})(?:الطلب|طلب السحب|طلب الدمج)(?:\s+رقم)?\s*)#?\s*(\d+)\b/u;
const pullTalk = /\b(?:pull request|pr)\b|(?<!\p{L})(?:طلب السحب|طلب الدمج|الطلب)(?!\p{L})/u;
const branchTalk = /\bbranch\b|(?<!\p{L})(?:الفرع|فرع)(?!\p{L})/u;
const githubTalk = /\bgithub\b|جيت ?هاب/u;
const ci = /\b(?:ci|checks?|build status|pipeline)\b|(?<!\p{L})(?:الفحوص(?:ات)?|فحوص(?:ات)?|التكامل المستمر|اختبارات البناء)(?!\p{L})/u;
const release = /\breleases?\b|(?<!\p{L})(?:ال)?(?:اصدار(?:ات)?|نسخه|نسخ)(?!\p{L})/u;
const tag = /\btags?\b|(?<!\p{L})(?:ال)?(?:وسوم|وسم|علامات الاصدار)(?!\p{L})/u;
const latest = /\b(?:latest|current)\b|(?<!\p{L})(?:احدث|اخر|الحالي)(?!\p{L})/u;
const version = /\bversions?\b/u;
const head = /\b(?:commits?|head\s+sha)\b|(?<!\p{L})(?:ال)?(?:التزام(?:ات)?|تعديلات|كوميت)(?!\p{L})/u;
const merged = /\b(?:merges?|merged)\b|(?<!\p{L})(?:يدمج|يندمج|دمج|اندمج|مدموج)(?!\p{L})/u;
const closed = /\bclos(?:e|es|ed)\b|(?<!\p{L})(?:اغلق|يغلق|مغلق)(?!\p{L})/u;
const opened = /\b(?:opens?|opened|reopened|reopens?)\b|(?<!\p{L})(?:فتح|يفتح|مفتوح|اعيد فتحه)(?!\p{L})/u;
const success = /\b(?:pass(?:es|ed)?|succeed(?:s|ed)?|success(?:ful)?)\b|(?<!\p{L})(?:نجح(?:ت)?|تنجح|ينجح|ناجح(?:ه)?|نجاح)(?!\p{L})/u;
const failure = /\b(?:fail(?:s|ed|ure)?|broken)\b|(?<!\p{L})(?:فشل(?:ت)?|تفشل|يفشل|فاشل(?:ه)?)(?!\p{L})/u;
const pending = /\bpending\b|(?<!\p{L})(?:قيد التشغيل|قيد الانتظار|معلقه)(?!\p{L})/u;
const watch = /^(?:(?:please |can you |could you |would you )*)?(?:watch|monitor|track|keep an eye on|راقب|تابع)(?!\p{L})/u;
const notify = /^(?:(?:please |can you |could you |would you )*)?(?:(?:tell|alert|notify|ping|let) (?:me|us)(?: know)?|نبهني|اخبرني|خبرني|بلغني|قل لي|اعلمني)\s+(?:(?:if|when|once|whenever|as soon as)\b|(?:اذا|لما|عندما|حين|متي|عند|بمجرد)(?!\p{L}))/u;
const notWatch = /(?:\b(?:don't|do not|never) (?:watch|monitor|track|notify|tell|alert)\b|(?<!\p{L})لا (?:تراقب|تتابع|تنبه|تخبر))/u;
const userAction = /(?:\b(?:then|and) (?:merge|approve|comment|close|rerun|publish)\b|(?<!\p{L})(?:و|ثم )?(?:ادمج|وافق|علق|اغلق|اعد تشغيل|انشر)(?!\p{L}))/u;
const askLead = /^(?:(?:(?:when|has|have|is|are|did|will|check (?:if|whether)|tell me (?:if|whether|when))\b|(?:i(?: am|'m| have been) )?(?:still )?waiting (?:for|until)\b)|(?:هل|متي|امتي|اخبرني (?:هل|متي)|(?:انا )?(?:انتظر|بانتظار|منتظر|ناطر|مستني))(?!\p{L}))/u;
const refusal = /\b(?:i (?:cannot|can't|could not|couldn't|am unable to|was unable to)|unable to (?:verify|confirm)|i (?:did not|didn't) (?:verify|confirm)|if you (?:mean|meant)|which (?:pull request|pr|branch|repo(?:sitory)?|release))\b|(?:لم اتمكن|لا استطيع|لم اتحقق|لا يمكنني|لم يتضح|اذا كنت تقصد|اي (?:طلب|فرع|مستودع|اصدار) تقصد)/u;

type Reference = { owner: string; repo: string; number?: number; branch?: string; page?: 'ci' | 'release' | 'tag' };

function publicGithubUrl(raw: string): Reference | undefined {
  if (!safeResumeUrl(raw) || !githubPublicIdentifier(raw)) return;
  const url = new URL(raw);
  if (url.origin !== 'https://github.com') return;
  const parts = url.pathname.replace(/\/$/u, '').slice(1).split('/');
  const [owner, repo, category, id, subpath] = parts;
  if (!(owner && repo) || !repoPair.test(`${owner}/${repo}`)) return;
  const base = { owner: owner.toLowerCase(), repo: repo.toLowerCase() };
  if (category === 'pull' && /^\d+$/u.test(id) && (!subpath || ['checks', 'commits', 'files'].includes(subpath)) && parts.length <= 5) {
    const number = Number(id);
    if (Number.isSafeInteger(number) && number > 0) return { ...base, number, ...(subpath === 'checks' && { page: 'ci' }) };
  }
  if (category === 'tree' && id) {
    try { return { ...base, branch: decodeURIComponent(parts.slice(3).join('/')) }; } catch { return; }
  }
  if (category === 'releases' || category === 'tags') return { ...base, page: category === 'releases' ? 'release' : 'tag' };
  if (!category) return base;
}

function parsedReference(text: string): Reference | undefined {
  const links = [...text.matchAll(address)];
  if (links.length) {
    const refs = links.map(link => publicGithubUrl(link[0].replace(/[.,،;؛!?؟)\]]+$/u, ''))).filter(ref => ref !== undefined);
    return refs.length === 1 ? refs[0] : undefined;
  }
  const branch = branchRef.exec(text);
  const withoutBranch = branch ? `${text.slice(0, branch.index)} ${text.slice(branch.index + branch[0].length)}` : text;
  const match = repoPair.exec(withoutBranch);
  if (!match || !githubPublicIdentifier(match[0])) return;
  return { owner: match[1].toLowerCase(), repo: match[2].replace(/\.$/u, '').toLowerCase() };
}

function bodyOf(text: string) {
  return monitorMatchText(normalizeRequest(text.replace(address, ' ')).text.replace(repoPair, ' '));
}

const releaseTopic = (body: string) => release.test(body) || latest.test(body) && version.test(body);

export function githubIntentMayMatter(text: string) {
  if (!text || text.length > 8000) return false;
  const body = bodyOf(text);
  if (interactiveOnly.test(body) || notWatch.test(body) || !(watch.test(body) || notify.test(body))) return false;
  const ref = parsedReference(text);
  return githubTalk.test(body) || pullRef.test(body) || ref?.number !== undefined || ref?.branch !== undefined
    || ref?.page !== undefined || branchTalk.test(body) || Boolean(ref && (pullTalk.test(body) || ci.test(body) || releaseTopic(body) || tag.test(body)))
    || ci.test(body) && pullTalk.test(body);
}

export function detectGithubMonitorNeed(original: string, history: readonly { role: string; text: string }[] = []): MonitorNeed | null {
  const { body: raw, directive } = splitReplyDirective(original);
  if (!githubIntentMayMatter(raw) && history.length < 2) return null;
  const text = safeMonitorRequest(raw);
  if (!text || [...text.matchAll(address)].some(([link]) => !safeResumeUrl(link.replace(/[.,،;؛!?؟)\]]+$/u, '')))) return null;
  if (!githubIntentMayMatter(text)) {
    const [request, clarification] = history.slice(-2);
    const replacement = /^\s*(?:https:\/\/github\.com\/\S+|[a-z\d-]+\/[a-z\d_.-]+)\s*$/iu.test(text) && parsedReference(text);
    if (!replacement || clarification?.role !== 'assistant' || request?.role !== 'user'
        || !/public github repository|مستودع github العام/iu.test(clarification.text)) return null;
    const need = detectGithubMonitorNeed(request.text);
    return need && { ...need, sourceText: text };
  }
  const body = bodyOf(text);
  const earlier = noHistory.test(body) || externalHistory.test(body) ? undefined : history.filter(turn => turn.role === 'user').slice(-8).reverse()
    .find(turn => !!parsedReference(turn.text) && (turn.text.toLowerCase().includes('https://github.com/') || githubIntentMayMatter(turn.text)
      || /github|\bpull request\b|\bpr\s*#?\s*\d+|طلب السحب/iu.test(turn.text)) && Boolean(safeMonitorRequest(turn.text)));
  return { kind: 'explicit', text, language: directive?.lang ?? normalizeRequest(text).lang,
    ...(earlier && { sourceText: earlier.text }), actionRequested: userAction.test(body) };
}

function githubWatch(text: string, sourceText: string | undefined, language: MonitorSpec['language']):
  { source: GithubMonitorSource; read: MonitorSpec['read']; condition: MonitorSpec['condition']; title: string } | null {
  const body = bodyOf(text);
  const direct = parsedReference(text);
  const earlier = sourceText && parsedReference(sourceText) || undefined;
  const ref = direct ?? earlier;
  if (!ref) return null;
  const branch = branchRef.exec(text.replace(address, ' '));
  const requestedBranch = (branch?.[1] ?? branch?.[2])?.replace(/\.$/u, '') ?? direct?.branch;
  const requestedNumber = Number(pullRef.exec(body)?.[1]) || direct?.number;
  if (requestedBranch && direct?.branch && requestedBranch !== direct.branch) return null;
  if (requestedNumber && direct?.number && requestedNumber !== direct.number) return null;
  const sameRepo = !direct || earlier && direct.owner === earlier.owner && direct.repo === earlier.repo;
  const number = requestedNumber ?? (sameRepo && !requestedBranch ? earlier?.number ?? Number(pullRef.exec(bodyOf(sourceText ?? ''))?.[1]) : undefined);
  const branchName = requestedBranch ?? (sameRepo && !requestedNumber ? earlier?.branch : undefined);
  const ar = language === 'ar';
  let target: GithubMonitorSource['watch'];
  let read: MonitorSpec['read'] = { kind: 'main' };
  let condition: MonitorSpec['condition'] = { kind: 'change' };
  let description: string;
  if (ci.test(body) || direct?.page === 'ci') {
    if (number) target = { kind: 'pull-ci', number };
    else if (branchName) target = { kind: 'branch-ci', branch: branchName };
    else return null;
    read = { kind: 'status' };
    const state = failure.test(body) ? 'failure' : success.test(body) ? 'success' : pending.test(body) ? 'pending' : undefined;
    if (state) condition = { kind: 'equals', value: state };
    description = ar ? 'فحوص GitHub' : 'GitHub CI';
  } else if (tag.test(body) || direct?.page === 'tag') {
    target = { kind: latest.test(body) ? 'latest-tag' : 'tags' };
    if (target.kind === 'tags') { read = { kind: 'items' }; condition = { kind: 'new-item' }; }
    description = ar ? 'وسوم GitHub' : 'GitHub tags';
  } else if (releaseTopic(body) || direct?.page === 'release') {
    target = { kind: latest.test(body) ? 'latest-release' : 'releases' };
    if (target.kind === 'releases') { read = { kind: 'items' }; condition = { kind: 'new-item' }; }
    description = ar ? 'إصدارات GitHub' : 'GitHub releases';
  } else if (number && (requestedNumber || pullTalk.test(body))) {
    target = { kind: head.test(body) ? 'pull-head' : 'pull-request', number };
    if (target.kind === 'pull-request') {
      read = { kind: 'status' };
      const state = merged.test(body) ? 'merged' : closed.test(body) ? 'closed' : opened.test(body) ? 'open' : undefined;
      if (state) condition = { kind: 'equals', value: state };
    }
    description = ar ? 'طلب سحب GitHub' : 'GitHub pull request';
  } else if (branchName && (requestedBranch || branchTalk.test(body))) {
    target = { kind: 'branch-head', branch: branchName };
    description = ar ? 'فرع GitHub' : 'GitHub branch';
  } else return null;
  const source = MonitorSourceSchema.safeParse({ kind: 'github', owner: ref.owner, repo: ref.repo, watch: target });
  if (!source.success || source.data.kind !== 'github' || 'branch' in target && !githubPublicIdentifier(target.branch)) return null;
  const context = 'number' in target ? ` #${target.number}` : 'branch' in target ? ` · ${target.branch}` : '';
  return { source: source.data, read, condition, title: `${ref.owner}/${ref.repo}${context} · ${description}`.slice(0, 180) };
}

export function githubMonitorSpec(need: MonitorNeed, now = new Date()): MonitorSpec | null {
  const details = githubWatch(need.text, need.sourceText, need.language);
  if (!details) return null;
  const timing = monitorTimingForNeed('github', need, now);
  if (!timing) return null;
  const language = need.language;
  const message = language === 'ar' ? `تحقّق شرط المراقبة لـ «${details.title}».` : `The monitoring condition was met for ${details.title}.`;
  const spec = MonitorSpecSchema.safeParse({ ...details, timing, message, language, v2: { freshnessMs: MONITOR_V2_DEFAULT_FRESHNESS_MS } });
  return spec.success ? spec.data : null;
}

const unresolved = /\b(?:may|might|could|possibly|probably|reportedly|if|unless|cannot|can't|was pending|was open|no longer)\b|(?:ربما|قد يكون|قد تكون|اذا كان|اذا كانت|لم يعد|لم تعد|كانت الفحوص)/u;
const openPull = /\b(?:pr|pull request)(?:\s*#?\d+)? (?:is |remains |still |is still )?(?:open|not (?:yet )?merged)\b|^(?:open|مفتوح)$|(?:الطلب|طلب السحب)(?:\s+\d+)? (?:مفتوح|لم يدمج|غير مدموج)/u;
const pendingCI = /\b(?:checks?|ci(?: run)?|workflow(?: run)?)(?:\s+(?:are|is))?(?:\s+still)?\s+(?:pending|queued|in progress|running)\b|^(?:pending|queued|in progress)$|(?:الفحوص|الفحوصات|التكامل المستمر) (?:قيد الانتظار|قيد التشغيل|معلقه)/u;
const unpublished = /\b(?:no (?:published )?releases(?: yet)?|there (?:are not|aren't) any releases(?: here| yet)?)\b|(?:لا توجد اصدارات|لم ينشر اي اصدار|لم يصدر بعد)/u;
const latestVersion = /(?:\blatest (?:published )?release (?:is\s+|:\s*)|(?:[آأا]خر|[أا]حدث) [إا]صدار\s*(?:هو\s+|:\s*))([A-Za-z0-9][-A-Za-z0-9.+_]{0,79})/iu;
const futureRelease = /\b(?:next|upcoming|new|waiting|will)\b|(?:القادم|القادمه|الجديد|الجديده|انتظر|بانتظار|سيصدر)/u;

function fact(text: string, pattern: RegExp, number?: number) {
  return text.match(/[^.!?؟\n؛;]+[.!?؟\n؛;]?/gu)?.find(part => {
    const body = monitorMatchText(part).replace(/[.!]+$/u, '');
    const referenced = pullRef.exec(body)?.[1];
    return !/[?؟]$/u.test(body) && !unresolved.test(body) && pattern.test(body)
      && (!number || !referenced || Number(referenced) === number);
  })?.trim().slice(0, 320);
}

function releaseFact(text: string) {
  const none = fact(text, unpublished);
  if (none) return { value: '', excerpt: none };
  for (const line of text.split(/[\n؛;]/u)) {
    const folded = monitorMatchText(line);
    if (/[?؟]$/u.test(folded) || unresolved.test(folded)) continue;
    const match = latestVersion.exec(line);
    const value = match?.[1].replace(/\.+$/u, '');
    if (match && value && /\d/u.test(value) && githubPublicIdentifier(value)) return { value, excerpt: match[0].trim() };
  }
}

export function detectGithubAnswerOffer(request: string, answer: string, pages: readonly MonitorAnswerPage[]) {
  if (!pages.length || request.length > 800 || answer.length > 2_000 || !safeMonitorRequest(request)) return null;
  const body = bodyOf(request);
  const answerBody = monitorMatchText(answer);
  if (!askLead.test(body) || interactiveOnly.test(body) || refusal.test(answerBody) || /[?؟]$/u.test(answerBody)) return null;
  const ref = parsedReference(request);
  const language = normalizeRequest(request).lang;
  const mode = ci.test(body) ? 'ci' : pullTalk.test(body) && merged.test(body) || ref?.number && merged.test(body) ? 'pull'
    : releaseTopic(body) ? 'release' : undefined;
  if (!mode) return null;
  const pattern = mode === 'ci' ? pendingCI : openPull;
  const releaseAnswer = mode === 'release' ? releaseFact(answer) : undefined;
  if (mode === 'release' && (!releaseAnswer || releaseAnswer.value && !futureRelease.test(body))) return null;
  const matches = new Map<string, { details: NonNullable<ReturnType<typeof githubWatch>>; excerpt: string; before: string; observedAt?: string }>();
  for (const page of pages) {
    if (!page.text || page.documentStatus !== undefined && (page.documentStatus < 200 || page.documentStatus >= 300)
        || Object.values(page.signals ?? {}).some(Boolean)) continue;
    const evidence = publicGithubUrl(page.url);
    if (!evidence || ref && (ref.owner !== evidence.owner || ref.repo !== evidence.repo)
        || mode === 'pull' && !evidence.number || mode === 'ci' && !(evidence.number || evidence.branch)
        || mode === 'release' && evidence.page !== 'release') continue;
    const details = githubWatch(mode === 'release' ? `${request} latest release` : request, page.url, language);
    if (!details) continue;
    const target = details.source.watch;
    if ('number' in target && target.number !== evidence.number || 'branch' in target && target.branch !== evidence.branch) continue;
    const pageText = page.text.slice(0, 12_000);
    const groundedRelease = releaseAnswer && releaseFact(pageText);
    if (releaseAnswer && groundedRelease?.value !== releaseAnswer.value) continue;
    if (!releaseAnswer && !fact(answer, pattern, evidence.number)) continue;
    const before = groundedRelease?.value ?? (mode === 'ci' ? 'pending' : 'open');
    const excerpt = groundedRelease?.excerpt ?? fact(pageText, pattern, evidence.number);
    if (!excerpt || !githubPublicIdentifier(excerpt)) continue;
    matches.set(githubMonitorUrl(details.source), { details, excerpt, before, observedAt: page.observedAt });
  }
  if (matches.size !== 1) return null;
  const [url, { details, excerpt, before, observedAt }] = matches.entries().next().value!;
  const condition = mode === 'pull' ? { kind: 'equals', value: 'merged' } as const
    : mode === 'ci' && details.condition.kind === 'equals' && details.condition.value !== 'pending' ? details.condition
      : { kind: 'change' } as const;
  return { ...details, condition, topic: url.replace(/^https:\/\//u, ''), url, language, before, excerpt, observedAt };
}
