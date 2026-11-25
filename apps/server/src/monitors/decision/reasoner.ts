import { detectMonitorNeed, type MonitorNeed } from '../detection.js';
import type { MonitorManagement } from '../v2-chat-intents.js';
import type { MonitorContextFrame } from './frame.js';
import { monitorOfferTopic } from './offer-topic.js';
import type { PendingStatus } from './signals.js';

export const MONITOR_CONTEXT_ACTIONS = ['none', 'offer', 'propose', 'manage', 'reminder'] as const;
export type MonitorContextAction = (typeof MONITOR_CONTEXT_ACTIONS)[number];

type Evidence = 'management_command' | 'existing_monitors' | 'scheduled_trigger' | 'unsafe_or_interactive' | 'explicit_detector'
  | 'condition_notification' | 'long_running_policy' | 'public_source' | 'verified_pending_answer' | 'prior_pending_status'
  | 'waiting_for_change' | 'repeated_status_question' | 'live_monitor_for_source' | 'earlier_acceptance' | 'earlier_decline'
  | 'one_off_question' | 'underspecified_target' | 'insufficient_context';

interface Decision {
  // Ordinal confidence in the selected action. These anchors express evidence
  // strength, with verified observations above inferred continuity.
  score: number;
  evidence: readonly Evidence[];
  need?: MonitorNeed;
  management?: MonitorManagement;
  answerOffer?: NonNullable<MonitorContextFrame['answerOffer']>;
}

export type MonitorContextDecision = Decision & (
  | { decision: 'none' | 'reminder' }
  | { decision: 'manage'; management: MonitorManagement }
  | { decision: 'propose'; need: MonitorNeed }
  | { decision: 'offer'; need: MonitorNeed; answerOffer?: never }
  | { decision: 'offer'; answerOffer: NonNullable<MonitorContextFrame['answerOffer']>; need?: never }
);

const CHECK_ONCE = /^(?:check|افحص|تحقق من)(?!\p{L})/u;
// A determiner ("all" / «كل») does not show cadence. Use actual repeated
// units, a condition horizon, or an explicit notification clause.
const RECURRING_CHECK = /\b(?:hourly|daily|periodically|until|every (?:\d+ )?(?:seconds?|minutes?|hours?|days?|weeks?|months?)|for (?:the next )?\d+ (?:minutes?|hours?|days?|weeks?)|(?:and|then) (?:(?:notify|alert|tell) (?:me|us)|let (?:me|us) know))\b|(?<!\p{L})(?:يوميا|دوريا|حتي|لمده|كل (?:\d+ )?(?:ثانيه|دقيقه|دقائق|ساعه|ساعات|يوم|ايام|اسبوع|اسابيع)|و(?:نبهني|اخبرني|بلغني|قل لي))(?!\p{L})/u;
const REMIND_LEAD = /^(?:(?:please|kindly|can you|could you|would you)[,\s]+)*remind (?:me|us)\b\s*/iu;
const GENERIC_CONDITION = /^(?:(?:the )?(?:registration|enrol+l?ment|sign[ -]?ups?|applications?) (?:re)?opens?|(?:the )?(?:page|site|link) (?:opens?|loads?|goes? live)|(?:the )?tickets? (?:become (?:available|unavailable)|go on sale)|(?:يفتح|تفتح|يفتحوا|يفتحون) (?:باب )?(?:التسجيل|التقديم|الالتحاق|الموقع|الرابط|الصفحه)|(?:التسجيل|التقديم|الالتحاق) (?:يفتح|يبدا)|(?:تتوفر|تتاح) التذاكر)[.!?؟\s]*$/u;
const CONDITION_PREFIX = /^(?:.+?)\s+(?:when|if|once|whenever|as soon as|every time|اذا|لما|عندما|حينما|بمجرد(?: ما| ان)?|كلما)\s+/u;

// The language-specific terms map to the existing monitor spec's observation
// labels and conditions. This never copies a prior turn into an instruction.
const STATUS_REQUEST: Record<PendingStatus, { ar: string; en: string }> = {
  registration: { ar: 'راقب فتح التسجيل', en: 'Watch for registration to open' },
  tickets: { ar: 'راقب توفر التذاكر', en: 'Watch for tickets to be available' },
  availability: { ar: 'راقب توفر المنتج', en: 'Watch for the product to be available' },
  publication: { ar: 'راقب النشر عندما يظهر المنشور', en: 'Watch for the publication to be published' },
  page: { ar: 'راقب الصفحة حتى تفتح الصفحة', en: 'Watch this page until it loads' },
};

function pendingNeed(frame: MonitorContextFrame, kind: MonitorNeed['kind']): MonitorNeed | null {
  if (!frame.pending) return null;
  return { kind, language: frame.language, text: STATUS_REQUEST[frame.pending.topic][frame.language],
    ...(frame.sourceUrl && { sourceUrl: frame.sourceUrl }), actionRequested: false };
}

function suppression(frame: MonitorContextFrame, sourceUrl?: string): Evidence | undefined {
  const source = sourceUrl && monitorOfferTopic(sourceUrl);
  if (source && frame.monitors.some(monitor => monitor.spec.source.kind === 'page'
    && monitorOfferTopic(monitor.spec.source.url) === source
    && (monitor.status === 'active' || monitor.status === 'paused' || monitor.status === 'proposed'))) return 'live_monitor_for_source';
  if (source && frame.monitors.some(monitor => monitor.spec.source.kind === 'page'
    && monitorOfferTopic(monitor.spec.source.url) === source && monitor.status === 'stopped' && monitor.offer)) return 'earlier_decline';
  const topic = frame.pending?.topic ?? frame.current.topic;
  const matches = (prior: MonitorContextFrame['priorDecisions'][number]) => {
    if (prior.sourceUrl) return Boolean(source && monitorOfferTopic(prior.sourceUrl) === source);
    return Boolean(prior.topic && (prior.topic === source || prior.topic === topic));
  };
  if (frame.priorDecisions.some(prior => prior.decision === 'declined' && matches(prior))) return 'earlier_decline';
  if (frame.priorDecisions.some(prior => prior.decision === 'accepted' && matches(prior))) return 'earlier_acceptance';
}

function explicitNeed(frame: MonitorContextFrame): MonitorNeed | null {
  // The reminder UI also accepts "remind me". For condition notifications use
  // the same v2 admission and action detection as "notify me".
  const reminderAlias = frame.conditionNotification && REMIND_LEAD.test(frame.current.text)
    ? detectMonitorNeed({ text: frame.current.text.replace(REMIND_LEAD, 'Notify me '), history: frame.history }) : null;
  const candidate = frame.legacyNeed?.kind === 'explicit' ? frame.legacyNeed : reminderAlias;
  if (candidate && (!CHECK_ONCE.test(frame.current.normalized) || RECURRING_CHECK.test(frame.current.normalized))) {
    if (frame.conditionNotification && !candidate.sourceUrl && frame.sourceUrl) return { ...candidate, sourceUrl: frame.sourceUrl };
    if (!frame.conditionNotification || candidate.sourceUrl || !GENERIC_CONDITION.test(frame.current.normalized.replace(CONDITION_PREFIX, ''))) return candidate;
  }
  return frame.referenceCondition ? pendingNeed(frame, 'explicit') : null;
}

export function reasonMonitorContext(frame: MonitorContextFrame): MonitorContextDecision {
  if (frame.management) return { decision: 'manage', score: 1, evidence: frame.monitors.length
    ? ['management_command', 'existing_monitors'] : ['management_command'], management: frame.management };
  if (frame.timeRequest) return { decision: 'reminder', score: 0.98, evidence: ['scheduled_trigger'] };
  if (!frame.eligible) return { decision: 'none', score: 1, evidence: ['unsafe_or_interactive'] };

  const explicit = explicitNeed(frame);
  if (explicit) return { decision: 'propose', score: 0.97, evidence: [
    ...(frame.legacyNeed?.kind === 'explicit' ? ['explicit_detector'] as const : []),
    ...(frame.conditionNotification ? ['condition_notification'] as const : []),
    ...(frame.pending && frame.referenceCondition ? ['prior_pending_status'] as const : []),
    ...(frame.workMode === 'long_running' ? ['long_running_policy'] as const : []),
    ...(explicit.sourceUrl ? ['public_source'] as const : []),
  ], need: explicit };

  const blocked = suppression(frame, frame.answerOffer?.url ?? frame.sourceUrl);
  if (blocked) return { decision: 'none', score: 0.99, evidence: [blocked] };
  if (frame.answerOffer) return { decision: 'offer', score: 0.94, evidence: ['verified_pending_answer', 'public_source'], answerOffer: frame.answerOffer };

  const inferred = pendingNeed(frame, 'implicit');
  if (inferred && frame.waiting && (frame.current.refersBack || frame.current.topic === frame.pending?.topic)) {
    return { decision: 'offer', score: inferred.sourceUrl ? 0.88 : 0.72, evidence: inferred.sourceUrl
      ? ['prior_pending_status', 'waiting_for_change', 'public_source'] : ['prior_pending_status', 'waiting_for_change'], need: inferred };
  }
  if (inferred?.sourceUrl && frame.repeatedStatus) return { decision: 'offer', score: 0.85,
    evidence: ['prior_pending_status', 'repeated_status_question', 'public_source'], need: inferred };
  if (frame.repeatedStatus && frame.current.continuing && frame.legacyNeed?.kind === 'implicit' && frame.legacyNeed.sourceUrl) {
    return { decision: 'offer', score: 0.76, evidence: ['repeated_status_question', 'public_source'], need: frame.legacyNeed };
  }
  return { decision: 'none', score: frame.current.statusQuestion && frame.current.oneOff ? 0.96 : 0.84, evidence:
    frame.current.statusQuestion && frame.current.oneOff ? ['one_off_question'] : frame.conditionNotification ? ['underspecified_target'] : ['insufficient_context'] };
}
