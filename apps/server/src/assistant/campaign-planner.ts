import type { ChatQuestionField } from '@mohassan/contracts';
import { parseCampaignPlanRequest } from './campaign-request.js';
import { maskRequestLiteralData } from './request-constraints.js';
import { numberedAnswers, type Lang } from './writer.js';

const REQUIRED = ['offer', 'audience', 'goal'] as const;
const FIELDS = [...REQUIRED, 'budget'] as const;
type CampaignPlanField = typeof FIELDS[number];
type CampaignBrief = Partial<Record<CampaignPlanField, string>>;
interface PendingCampaignSteps { requiresResearch?: true; requiresLaunch?: true }
export interface CampaignPlanningTask extends PendingCampaignSteps { lang: Lang; brief: CampaignBrief }

const RESEARCH_REQUIREMENT = /\b(?:after|based on|using)\s+(?:(?:you|your|the|an?)\s+)?(?:research(?:ing)?|analy[sz](?:e|ing)|analys[ie]s|review(?:ing)?|read(?:ing)?)\b|(?:^|\s)(?:بعد|بناء على|استنادا إلى)\s+(?:أن\s+)?(?:البحث|بحث|تبحث|تحليل|تحلل|قراءة|تقرأ|مراجعة|تراجع|فحص)(?=\s|$)/iu;
const STEP_START = String.raw`(?:(?:^|[\n.!?؟;؛,،])\s*|\s+(?:(?:and(?: then)?|then|و?ثم)\s+|و\s*))(?:(?:please|kindly|من فضلك)\s+)?`;
const RESEARCH_STEP = new RegExp(STEP_START + String.raw`(?:search(?: online| the web)? for|look up|research|analy[sz]e|[اأإ]بحث (?:عن|في|على)|حلل|افحص)(?=\s|$)`, 'iu');
const LAUNCH_STEP = new RegExp(STEP_START + String.raw`(?:(?:launch|publish|run|create) (?:it|(?:the|this) (?:campaign|ads?))\b|(?:[اأإ]طلق|انشر|[اأإ]نش[ئأ])(?:ها|\s+(?:ال)?حمل[ةه])(?=\s|[\p{P}]|$))`, 'iu');

function splitCampaignSteps(text: string): { briefText: string; pending: PendingCampaignSteps } {
  const matching = maskRequestLiteralData(text);
  const research = Math.min(RESEARCH_REQUIREMENT.exec(matching)?.index ?? text.length, RESEARCH_STEP.exec(matching)?.index ?? text.length);
  const launch = LAUNCH_STEP.exec(matching)?.index ?? text.length;
  return { briefText: text.slice(0, Math.min(research, launch)), pending: {
    ...(research < text.length ? { requiresResearch: true } : {}),
    ...(launch < text.length ? { requiresLaunch: true } : {}),
  } };
}

const BRIEF_MARKER = new RegExp(String.raw`(?:^|[\s,،;؛])(?:` + [
  String.raw`(?<offer>(?:المنتج|الخدمة|العرض|product|service|offer)\s*[:：]\s*)`,
  String.raw`(?<audience>(?:الجمهور|الفئة المستهدفة|المنطقة|audience|market|location)\s*[:：]\s*|(?:تستهدف|الموجهة إلى|targeting|aimed at)\s+)`,
  String.raw`(?<goal>(?:الهدف|goal|objective)\s*[:：]\s*|بهدف\s+|ل(?=زيادة|جذب|بيع|الحصول|التعريف)|to\s+(?=(?:increase|attract|sell|get|drive|generate|raise)\b))`,
  String.raw`(?<budget>(?:بميزانية|الميزانية|(?:with (?:a )?)?budget)(?=\s|[:：]|$)\s*[:：]?\s*)`,
].join('|') + ')', 'giu');
const QUESTIONS: Record<Lang, Record<typeof REQUIRED[number], string>> = {
  ar: {
    offer: 'ما المنتج أو الخدمة التي تريد الإعلان عنها؟',
    audience: 'من تريد أن يصل إليه الإعلان، وفي أي منطقة إذا كانت مهمة؟',
    goal: 'ما النتيجة التي تريدها من الحملة، مثل الطلبات أو الحجوزات أو زيادة الوعي؟',
  },
  en: {
    offer: 'What product or service do you want to advertise?',
    audience: 'Who should the ad reach, and in which area if location matters?',
    goal: 'What outcome should the campaign drive, such as sales, bookings, or awareness?',
  },
};

function briefValue(value: string): string {
  return value.replace(/^[\s,،;؛:：]+|[\s,،;؛:：.!?؟]+$/gu, '').replace(/\s+/gu, ' ');
}

function readBrief(text: string, lang: Lang): CampaignBrief {
  const markers = [...text.matchAll(BRIEF_MARKER)];
  const details: CampaignBrief = {};
  const introduction = briefValue(text.slice(0, markers[0]?.index ?? text.length));
  const namedOffer = (lang === 'ar' ? /^ل(?:لترويج\s+ل)?\s*(.+)$/u : /^for\s+(.+)$/iu).exec(introduction)?.[1];
  if (namedOffer) {
    const localOffer = /^(.*?)\s+(?:في|in)\s+(.+)$/iu.exec(namedOffer);
    details.offer = localOffer?.[1] ?? namedOffer;
    if (localOffer) details.audience = localOffer[2];
  }
  for (const [index, marker] of markers.entries()) {
    const field = FIELDS.find(key => marker.groups?.[key] !== undefined)!;
    const value = briefValue(text.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? text.length));
    if (value) details[field] = value;
  }
  return details;
}

export function campaignPlanningTask(request: string): CampaignPlanningTask | null {
  const parsed = parseCampaignPlanRequest(request);
  if (!parsed) return null;
  const { briefText, pending } = splitCampaignSteps(parsed.brief);
  return { lang: parsed.lang, brief: readBrief(briefText, parsed.lang), ...pending };
}

const missingFields = (task: CampaignPlanningTask) => REQUIRED.filter(field => !task.brief[field]);

export function answerCampaignPlan(task: CampaignPlanningTask, reply: string | Readonly<Record<string, string>>): CampaignPlanningTask {
  const missing = missingFields(task);
  let answers: Readonly<Record<string, string>>;
  let pending: PendingCampaignSteps = {};
  if (typeof reply === 'string') {
    const fullRequest = campaignPlanningTask(reply);
    if (fullRequest) {
      const { lang: _lang, brief, ...steps } = fullRequest;
      answers = brief;
      pending = steps;
    } else {
      const { briefText, pending: steps } = splitCampaignSteps(reply);
      pending = steps;
      const explicit = readBrief(briefText, task.lang);
      const numbered = numberedAnswers(briefText.replace(/(^|\s)([١-٣])(?=\.\s)/gu,
        (_marker, gap: string, digit: string) => `${gap}${digit.charCodeAt(0) - 0x660}`), missing.length);
      if (numbered.some(Boolean)) answers = Object.fromEntries(missing.map((field, index) => [field, numbered[index]]));
      else if (Object.keys(explicit).length) answers = explicit;
      else answers = missing.length === 1 ? { [missing[0]]: briefText } : {};
    }
  } else answers = reply;
  const brief = { ...task.brief };
  for (const field of FIELDS) {
    const value = briefValue(answers[field] ?? '');
    if (/[\p{L}\p{N}]/u.test(value)) brief[field] = value;
  }
  return { ...task, brief, ...pending };
}

export function campaignPlanQuestion(task: CampaignPlanningTask): { prompt: string; fields: ChatQuestionField[] } | null {
  const missing = missingFields(task);
  if (!missing.length) return null;
  const questions = QUESTIONS[task.lang];
  return {
    prompt: missing.map((field, index) => `${index + 1}. ${questions[field]}`).join('\n'),
    fields: missing.map(id => ({ id, prompt: questions[id], suggestions: [] })),
  };
}

/** The supplied facts set the plan. Channel selection and spending remain recommendations. */
export function composeCampaignPlan(task: CampaignPlanningTask): { text: string; status: 'partial' | 'completed' } {
  const { offer, audience, goal, budget } = task.brief;
  const sections = task.lang === 'ar' ? [
    `**خطة حملة إعلانية — ${offer}**`,
    ...(task.requiresResearch ? ['هذه مسودة من المعلومات التي قدمتها. البحث المطلوب لم يُنفّذ بعد، لذلك تحتاج الخطة إلى مراجعته قبل اعتمادها.'] : []),
    ...(task.requiresLaunch ? ['لم تُنفّذ الخطوة المطلوبة لإنشاء الحملة أو إطلاقها.'] : []),
    `- **الهدف** — ${goal}. **الجمهور** — ${audience}.`,
    `- **القناة** — ابدأ بإعلانات البحث إذا كان الجمهور يبحث عن «${offer}» بالفعل. إذا كان الهدف تعريفه بالعرض، اختبر إعلانًا مرئيًا على المنصة التي يستخدمها هذا الجمهور.`,
    `- **الرسالة** — جهّز نسختين للعرض «${offer}». ابدأ في الأولى بفائدة مؤكدة من المنتج، وفي الثانية بالمشكلة التي يحلّها. ضع دعوة واحدة للإجراء تناسب «${goal}»، وتأكد أن وجهة الإعلان تتيح تنفيذها.`,
    `- **الاختبار والميزانية** — ${budget ? `استخدم ${budget} سقفًا للإنفاق.` : 'حدّد سقف الإنفاق قبل الإطلاق.'} خصّص جزءًا لاختبار النسختين على الجمهور نفسه، وغيّر عنصرًا واحدًا بينهما.`,
    `- **القياس** — جهّز التتبّع قبل الإطلاق. راجع عدد النتائج المرتبطة بهدف «${goal}» وتكلفتها؛ وإذا كان الهدف الوعي فراجع الوصول والتكرار. أوقف النسخة الأضعف بعد تجمّع بيانات قابلة للمقارنة، ووسّع الإنفاق على الأفضل تدريجيًا.`,
  ] : [
    `**Advertising campaign plan — ${offer}**`,
    ...(task.requiresResearch ? ['This draft uses the details you supplied. The requested research is pending and should inform the plan before you finalise it.'] : []),
    ...(task.requiresLaunch ? ['The requested campaign setup or launch is pending.'] : []),
    `- **Goal and audience** — ${goal}, for ${audience}.`,
    `- **Channel** — Start with search ads if people already look for “${offer}.” To introduce the offer, test a visual ad on a platform the audience uses.`,
    `- **Creative** — Write two variants for “${offer}.” Lead with a verified benefit in one and the problem it solves in the other. Use one call to action aligned with “${goal}” and verify people can take it at the destination.`,
    `- **Test and budget** — ${budget ? `Use ${budget} as your spending cap.` : 'Set a spending cap before launch.'} Reserve part of it to test both variants with the same audience, changing one element at a time.`,
    `- **Measurement** — Set up tracking before launch. Track the results and cost for “${goal},” or reach and frequency for an awareness goal. Once the results are comparable, pause the weaker variant and scale the stronger one gradually.`,
  ];
  return { text: sections.join('\n\n'), status: task.requiresResearch || task.requiresLaunch ? 'partial' : 'completed' };
}
