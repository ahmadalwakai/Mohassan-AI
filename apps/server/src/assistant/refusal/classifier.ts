import { publicSearchScan, publicSearchText } from '@mohassan/browser';
import { isCurrentComputerReadRequest } from '../computer-request-language.js';
import { documentTask } from '../documents.js';
import { maskRequestLiteralData } from '../request-constraints.js';
import { assessRequestScope, requestScopeActionText, type RequestScopeAssessment } from '../request-scope.js';
import { classifyLearnedRefusal } from './learned-classifier.js';
import * as pattern from './patterns.js';
import { reviewRefusalControl, reviewRefusalDestination } from './permissions.js';
import { classifyUnsupportedAction, isChatDelivery, isShoppingOrder, unsupportedActionHeads } from './unsupported-actions.js';
import type { RefusalAlternative, RefusalCode, RefusalDecision } from './types.js';

export interface RefusalContext {
  readonly fullAccess: boolean;
  readonly scope?: RequestScopeAssessment;
  readonly capabilities?: Readonly<Partial<Record<'computer' | 'desktop' | 'memory' | 'reminders' | 'imageModel' | 'mediaModel', boolean>>>;
}

const {
  normalizeRefusalText, words, head, secretTarget, paymentTarget, humanVerificationTarget, accountTarget,
  accountAction, otherOwner, publicMaterial, privateMaterial, externalDisclosure, disclosureAction,
  secretAction, paymentAction, transferAction, moneyAmount, paymentQualifier, genericAction, riskyInstruction,
  harmfulAction, harmlessTechnicalObject, unsafeCircumvention, ownershipControls, loginAction, personalLogin,
  humanStepAction, humanCommitment, sendAction, ownerCapabilityTarget,
  ownerCapabilityAction, sitePublish, workspaceRoleChange, delayedScheduling, futureAction, futureTime,
  immediateOperand, guaranteedForecast, physicalAction, outsideAccess, genericRequestForOwnMaterial,
} = pattern;

const priority: readonly RefusalCode[] = [
  'unsafe', 'secrets', 'role', 'other_account', 'payment', 'human_step', 'no_access', 'future', 'no_capability',
];

const negativeLead = head("do not|don't|never|avoid|without|no need to|لا|ممنوع|بلاش|بدون|من غير|دون|تجنب|متعملش");
const requestLead = /^(?:(?:i (?:want|need|would like) (?:for )?(?:you )?to|i'd like (?:you )?to|let's|help me(?: to)?|try to|go ahead(?: and)?|(?:and )?then|afterwards|you (?:must|should)|اريد(?:ك| منك)?(?: ان)?|احتاج(?:ك| منك)?(?: ان)?|اب(?:ي|يك|غي|غاك)|بدي(?: منك)?|عا(?:يز|وز)(?:ك|ه)?|محتاجك|خل(?:يك|ينا)|ساعدني(?: (?:في|علي|اني|ان))?|ياريت|يا ريت|جرب|ثم|وبعدها|وبعدين|بعدها|من فضلك|لو سمحت(?:ي)?|رجاء|ارجوك|ارجو(?: منك)?(?: ان)?)[,،:\s]+)+/u;
const delegatedLead = /^(?:(?:i (?:was wondering|wonder) if(?: you (?:can|could|would|will))?|(?:is it|would it be) possible (?:for you )?to|be (?:able|willing) to)[,\s]+)+/u;
const arabicModal = /^(?:(?:هل )?(?:بامكانك|من الممكن|بتقدر(?:ي)?|تقدري|ممكن(?:ك| انك)|فيك|تقدرون)) (?:ان )?/u;
const requestedObject = /^(?:i (?:need|want|would like)|i'd like) (?:my|our|the|a|an|your|their|his|her) /u;
const greeting = /^(?:(?:hello|hey|hi|thanks|good morning|مرحبا|اهلا|هلا|هاي|السلام عليكم)[,،!؟.\s]+)(?=.)/u;
const connectors = /(?<sequence>[؛;\r\n!?؟]+\s*|\s+\b(?:and then|then|afterwards)\b\s+|\s+(?:ثم|وبعدها|وبعدين|بعدها)\s+)|[.،,]\s+(?=\p{L})|\s+\b(?:but|also|and)\b\s+|\s+(?:لكن|ولكن|كمان)\s+|\s+و(?=\p{L})/giu;
const continuation = head("please|kindly|could you|can you|would you|do not|don't|never|avoid|open|click|press|tap|search|look|read|show|tell|ask|write|draft|delete|remove|erase|share|send|forward|give|run|start|find|edit|approve|publish|export|book|pay|purchase|buy|order|transfer|wire|bypass|skip|ignore|reveal|output|store|remember|enter|paste|type|solve|save|check|log|sign|access|make|steal|hack|build|لا|افتح|اضغط|ابحث|دور|اقرا|اعرض|اكتب|احذف|امسح|افش|اعطني|ابعث|ارسل(?:ه|ها|هم)?|ابعت(?:ه|ها|هم)?|انشر|شارك|ادفع|اشتري|اشتر|حول(?:ه|ها)?|احجز|تجاوز|تجاهل|طلع|احفظ|اكشف|ادخل|حط|املا|حل|وافق|سجل|اعمل|شغل|استخدم|اصنع|اخترق|اسرق");
const actionHeads = [continuation, accountAction, harmfulAction, paymentAction, humanStepAction, sendAction,
  delayedScheduling, futureAction, ownerCapabilityAction, unsafeCircumvention, physicalAction, ...unsupportedActionHeads];
const uiTarget = head('click|tap|press|select|choose|tick|confirm|approve|submit|اضغط|انقر|دوس|اختار|اكد|وافق|اعتمد');
const quotedOperand = /^["'«“`](?<label>[^"'»”`\r\n]{1,120})["'»”`]/u;
const uiOperandLead = /^(?:(?:on|the|button(?: labeled| labelled)?|علي|زر|الزر|خيار)\s+)+/u;
const webAddress = /https?:\/\/[^\s,،;؛"'«»“”`]+/giu;
const nonActionTerms = words('publicly listed|publicly available|login (?:page|screen|portal|url)|sign in (?:page|screen|portal)|صفحه تسجيل الدخول|صفحه الدخول|بوابه تسجيل الدخول');
const explainer = head('find out (?:how|why|what)|(?:tell|teach) (?:me|us) about|(?:show|give) (?:me|us) (?:advice|information|tips|examples|resources|sources|instructions) (?:about|on|for|how)|(?:show|tell|teach) (?:me|us) how|(?:read|find|locate|show|summari[sz]e) (?:me |us )?(?:(?:a|an|the|my|our) )?(?:public |company |internal )?(?:guide|guidelines|documentation|article|information|policy|rules|tips|tutorial|handbook|checklist|examples?) (?:about|on|for|of|with|to)|(?:قل لي|قلي|وريني|اعطني|هات|طلع لي) (?:عن|نصائح|شرح|مثال|امثله|معلومات|مقال|مصادر)');
const descriptionOfSecret = words('(?:password|passcode|pin|credit card|debit card|verification code|api key) (?:policy|rules|guidelines|requirements|algorithm|format|manager|strength|tips|protection|security|examples?|theft|scams?|fraud|hygiene|reset page|settings|usage|documentation|standards?)|(?:سياسه|حمايه|ارشادات|شروط|معايير|امثله|نصائح|مدير|طول|قوه|خانات) (?:كلم(?:ه|ات) (?:ال)?(?:مرور|سر)|رمز التحقق|الباسورد)|(?:صفحه|رابط) (?:تغيير|اعاده تعيين) كلمه (?:المرور|السر)');
const secretWritingContent = head('(?:write|draft|compose|اكتب|صغ)(?:لي)?\\s+(?:(?:me|us|a|an|the|my|our|short|brief|formal|polite)\\s+){0,6}(?:note|message|email|letter|article|paragraph|report|guide|checklist|story|template|(?:لي )?(?:رساله|خطاب|مقال|نص|دليل|قصه))');
const credentialLabel = words('password|passwd|passcode|(?:my |the )?pin|otp|one time (?:code|password)|(?:verification|login|security|authentication) code|(?:credit |debit |bank |payment )?card number|cv[cv]|api[ _]?key|(?:access|refresh|auth) token|client secret|private key|(?:كلمه (?:المرور|السر)|باسورد)(?:ي|ك|ه|ها)?|رمز (?:التحقق|الدخول|الامان)|كود (?:التحقق|الدخول|الامان)|(?:رقم|بيانات) (?:البطاقه|البطاقه الائتمانيه|الكارت|بطاقتي)|الرقم السري');
const labelledSecret = /^(?:\s*[:=：]\s*|\s+(?:is|هو|هي)\s+)(?:["'`«“]\s*)?(?<value>[^\s"'`«“»”؛;]{2,})/u;
const labelledPlaceholder = /^(?:a|an|the|one|this|that|my|your|our|their|strong|weak|safe|secure|important|required|available|unknown|unavailable|redacted|removed|hidden|example|sample|placeholder|typed|needed|something|used|not|never|[x*]+|\.\.\.|<[^>]+>|كلمه|شيء|هو|هي|قوي(?:ه)?|ضعيف(?:ه)?|مهم(?:ه)?|مطلوب(?:ه)?|مثال|غير)$/u;
const figurativePayment = head('pay (?:attention|respect|tribute|for itself|it forward)|buy (?:time|the idea|into the idea)|check out (?:this|that|my|our|the) (?:site|website|page|article|report|guide|video|link|repo|repository|lesson|example|document)|اطلب(?:لي)? (?:الموافقه|الاذن|منه|منها|منهم|مساعده|اجابه|توضيح|راي|ان)|اشترك (?:في|مع) (?:نقاش|العمل|مشروع)');
const currencyConversion = head('convert|exchange rate|حول (?:العملات|الوحدات|الدرجات|الحراره)|حول (?:لي )?\\d+(?:[.,]\\d+)? (?:دولار|يورو|ريال|درهم|جنيه|دينار)(?: [\\p{L}]{3,})? (?:الي|الى|ل)\\s*(?:دولار|يورو|ريال|درهم|جنيه|دينار)');
const guideQuestion = head('how (?:to|(?:can|do|could|should) (?:i|we))|(?:tell|show|teach) (?:me|us) how (?:to|(?:i|we) can)|كيف|ازاي|شلون|علمني كيف');
const greetingAddress = /^(?:(?:hey|hello|hi) [\p{L}]{1,32}|(?:يا|هلا يا|مرحبا يا) [\p{L}]{1,32})[,،\s]+/u;
const askForDraft = head('(?:draft|write|compose) (?:me |us )?(?:(?:an?|the|my|our|short|formal|polite|professional) )*(?:e mail|email|message|note|text|letter)|(?:اكتب|صغ)(?:لي)? (?:لي )?(?:رساله|ايميل|خطاب|بريد)');
const imageRequest = head('(?:draw|paint|sketch|illustrate)(?! (?:on|from|the lesson|up|a parallel|a comparison|attention|conclusions?|a conclusion))|(?:generate|create|make|design|render|produce) (?:(?:me|us|an?|the|my|our|some|new|original) )*(?:images?|pictures?|photos?|logos?|posters?|icons?|illustrations?|drawings?|avatars?|wallpapers?|infographics?|artwork)|(?:ارسم|صمم|اصنع|انشئ|ولد|اعمل|سو|سوي|سولي)(?:\\s*لي)? (?:ال)?(?:صوره|صور|رسمه|رسوم|لوجو|لوغو|شعار|بوستر|ملصق|ايقونه)|ارسم');
const mediaRequest = head('(?:play|stream) (?:(?:me|us|an?|the|my|our|some) )*(?:songs?|music|videos?|playlists?|podcasts?|radio|audio|tracks?|movies?|episodes?)|(?:generate|create|make|produce|compose) (?:(?:me|us|an?|the|my|our|some) )*(?:videos?|songs?|music|audio|voice ?overs?|animations?|jingles?)|(?:شغل|اشغل|سمعني|اسمعني|حط لي|حطلي)(?:\\s*لي)? (?:ال)?(?:اغنيه|اغاني|موسيقي|موسيقا|فيديو|مقطع|بودكاست|راديو|اذاعه|سوره|قران|تلاوه|نشيد|اناشيد|فيلم|مسلسل|حلقه)');
const futureLookup = head('(?:check|look up|search for|find|read|show) (?:the )?(?:forecast|weather|schedule|timetable|agenda|opening hours|hours|news|announced dates)|(?:ابحث|دور|شوف|اعرض) (?:لي )?(?:عن )?(?:الطقس|طقس|الجو|جو|الجدول|المواعيد|مواعيد)');
const recallNotReminder = head('remind (?:me|us) (?:of|what|where|who|when|how|about what)|(?:ذكرني|فكرني) (?:من|في) (?:الذاكره|ذاكرتي)|(?:ذكرني|فكرني) (?:وين|اين|كيف|وش|ما|شو|مين)');
const privateAccountInspection = head('(?:(?:log|sign) ?in(?:to)?|authenticate|reset|change|delete|remove|edit|update|publish|post|connect|switch to)|سجل(?:لي)?|ادخل|غير|احذف|عدل|انشر|اربط');
const moneyUnit = words('bank account|recipient|bank|wallet|iban|venmo|paypal|cash app|حساب بنكي|حساب مصرفي|المصرف|البنك|محفظه|الايبان');
const sharedDataOnly = head('translate|summari[sz]e|rewrite|paraphrase|proofread|ترجم|لخص|اعد صياغه|صحح');
const remoteCapture = head('list|show|read|look at|view|inspect|open|take|screenshot|display|run|use|افتح|شوف|اقرا|اعرض|ارني|وريني|اظهر|نفذ|شغل|استخدم');
const pcTarget = words('(?:my|the|this|current|shared) (?:pc|computer|desktop)|pc (?:screen|window)|computer (?:screen|window|session)|local (?:desktop|filesystem)|جهازي|كمبيوتري|حاسوبي|الكمبيوتر|الحاسوب|سطح (?:المكتب|مكتبي|مكتبنا)|(?:كمبيوتر|حاسوب) مساحه العمل|الشاشه المشاركه');
const knownOwnMemory = words('my memory|our memory|my saved (?:notes|records)|ذاكرتي|ذاكرتنا|ملاحظاتي المحفوظه');
const publicSecretExample = words('example|placeholder|redacted|fake|sample|illustrative|synthetic|dummy|مثال|تجريبي|وهمي|افتراضي');
const directSecretField = words('password field|passcode field|verification code field|خانه (?:كلمه المرور|رمز التحقق)');
const locateField = head('(?:show|tell) (?:me|us) where|find the location of|وريني وين|اعرض مكان|دلني علي');
const asksForExplanation = head('explain|describe|اشرح|فسر|وضح');

function requestText(value: string): string {
  const normalized = normalizeRefusalText(value);
  const addressed = normalizeRefusalText(normalized.replace(greetingAddress, ''));
  const text = addressed !== normalized && actionHeads.some(head => head.test(addressed))
    ? addressed : normalizeRefusalText(normalized.replace(greeting, '').replace(delegatedLead, ''));
  const action = normalizeRefusalText(text.replace(requestLead, '').replace(delegatedLead, ''));
  const modal = arabicModal.exec(action);
  // Polite Arabic requests may use the second-person present even when
  // requestOperationText, or a lead above, has already removed the modal.
  const operand = modal ? normalizeRefusalText(action.slice(modal[0].length)) : action;
  if (!operand.startsWith('ت')) return operand;
  // After an explicit modal, the second-person present can carry the same
  // instruction as an imperative. Convert only recognised action heads.
  const stem = operand.slice(1);
  const recognizedHeads = modal ? actionHeads : unsupportedActionHeads;
  return [stem, `ا${stem}`].find(candidate => recognizedHeads.some(head => head.test(candidate))) ?? operand;
}

interface OuterClause {
  text: string;
  controlRefusal: RefusalDecision | null;
  describedAction: boolean;
}

function explicitControlRefusal(raw: string, clause: string): RefusalDecision | null {
  if (!uiTarget.test(clause)) return null;
  const unmasked = requestText(raw);
  const action = uiTarget.exec(unmasked);
  if (!action) return null;
  const operand = unmasked.slice(action[0].length).trim().replace(uiOperandLead, '');
  const label = quotedOperand.exec(operand)?.groups?.label ?? operand.replace(/(?: button| control| الزر)$/u, '');
  return reviewRefusalControl(label);
}

function outerClauses(value: string): OuterClause[] {
  let masked = maskRequestLiteralData(value).replace(webAddress, url => ' '.repeat(url.length));
  // A colon after an explicit draft introduces its body. Commands there are
  // part of the message, just as commands inside a quotation are data.
  const delimiter = masked.search(/[:：]/u);
  if (delimiter >= 0 && askForDraft.test(requestText(masked.slice(0, delimiter)))) masked = masked.slice(0, delimiter);
  const result: OuterClause[] = [];
  let start = 0;
  let describedAction = false;
  const collect = (end: number) => {
    const text = requestText(masked.slice(start, end));
    if (text && !negativeLead.test(text)) result.push({ text, describedAction, controlRefusal: explicitControlRefusal(value.slice(start, end), text) });
  };
  for (const boundary of masked.matchAll(connectors)) {
    const end = boundary.index + boundary[0].length;
    if (!boundary.groups?.sequence) {
      const tail = requestText(masked.slice(end));
      if (!actionHeads.some(action => action.test(tail))) continue;
    }
    collect(boundary.index);
    describedAction = !boundary.groups?.sequence
      && (describedAction || guideQuestion.test(requestText(masked.slice(start, boundary.index))));
    start = end;
  }
  collect(masked.length);
  return result;
}

function hasCredentialMaterial(request: string, scope: RequestScopeAssessment): boolean {
  const decoded = publicSearchScan(request);
  for (const [address] of decoded.matchAll(webAddress)) {
    if (reviewRefusalDestination(address)?.code === 'secrets') return true;
  }
  // Reuse the established scanner for machine credentials and encoded URL values.
  // Its prose "password is ..." rule also matches descriptions, so require its
  // value to look like actual credentials before treating ordinary prose as data.
  if (scope.reasons.includes('credential_material')
    && decoded.replace(/\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|secret|كلمة المرور|رمز التحقق)\s*(?:[:=]|\bis\b|هي|هو)/giu, 'credential label') !== decoded
    && /https?:\/\//iu.test(decoded) && publicSearchText(decoded) !== decoded) return true;
  const text = normalizeRefusalText(decoded);
  if (publicSecretExample.test(text) && !scope.reasons.includes('credential_material')) return false;
  if (/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:Bearer\s+|gsk_|sk-(?:proj-)?|ghp_|github_pat_|xox[baprs]-|AIza|AKIA|eyJ)[A-Za-z0-9_./~+\-=]{10,})/u.test(decoded)
    && publicSearchText(decoded) !== decoded) return true;
  for (const match of text.matchAll(new RegExp(credentialLabel.source, 'gu'))) {
    const after = text.slice(match.index + match[0].length);
    const assigned = labelledSecret.exec(after)?.groups?.value?.replace(/[.!?؟،,]+$/u, '');
    if (!assigned || labelledPlaceholder.test(assigned)) continue;
    const before = text.slice(Math.max(0, match.index - 4), match.index);
    if (/^\s*[:=：]/u.test(after) || /^[^\s]+[\d@!#$%^&*_-][^\s]*$/u.test(assigned)
      || /\b(?:my|our)\s*$/u.test(before) || /بطاقتي|باسوردي|كلمتي/u.test(match[0])) return true;
  }
  return false;
}

function refusal(code: RefusalCode, alternative: RefusalAlternative): RefusalDecision {
  return { code, alternative };
}

function classifyClause(clause: OuterClause, context: RefusalContext, scope: RequestScopeAssessment, isDraft: boolean): RefusalDecision | null {
  const { text, describedAction } = clause;
  const advice = riskyInstruction.exec(text);
  const assistedAction = advice ? text.slice(advice[0].length).trim().replace(/^(?:to|ان)\s+/u, '') : text;
  if (harmfulAction.test(assistedAction) && !harmlessTechnicalObject.test(assistedAction)) return refusal('unsafe', 'protect');

  const followsExplanatoryForm = explainer.test(text) || descriptionOfSecret.test(text) || secretWritingContent.test(text)
    || locateField.test(text) && directSecretField.test(text);
  const asksToHandleSecret = !followsExplanatoryForm && !sharedDataOnly.test(text) && secretTarget.test(text)
    && (secretAction.test(text) || requestedObject.test(text) && secretTarget.exec(text.replace(requestedObject, ''))?.index === 0
      || (genericAction.test(text) || transferAction.test(text)) && !paymentTarget.test(text));
  if (asksToHandleSecret) return refusal('secrets', 'secure_entry');

  const capability = context.capabilities;
  const localComputer = isCurrentComputerReadRequest(text) || scope.destination === 'pc' && remoteCapture.test(text)
    || pcTarget.test(text) && remoteCapture.test(text);
  const roleLimited = ownerCapabilityAction.test(text) && (ownerCapabilityTarget.test(text) || sitePublish.test(text) || workspaceRoleChange.test(text));
  if (!context.fullAccess && (roleLimited || localComputer)) return refusal('role', 'ask_owner');

  const asksOtherAccount = accountAction.test(assistedAction) && otherOwner.test(assistedAction) && accountTarget.test(assistedAction)
    && (!publicMaterial.test(assistedAction) && !nonActionTerms.test(assistedAction)
      || privateAccountInspection.test(assistedAction) || privateMaterial.test(assistedAction));
  if (asksOtherAccount) return refusal('other_account', 'own_account');
  if (disclosureAction.test(text) && externalDisclosure.test(text) && (privateMaterial.test(text)
    || assessRequestScope(text).reasons.includes('prior_conversation_reference'))) {
    return refusal('unsafe', 'private_output');
  }

  const asksToTransfer = transferAction.test(text) && (paymentTarget.test(text) || moneyAmount.test(text)
    || moneyUnit.test(text) && /(?:\d|ريال|درهم|دينار|دولار|جنيه|يورو)/u.test(text));
  const ordersGoods = isShoppingOrder(text);
  if (!describedAction && !figurativePayment.test(text) && !currencyConversion.test(text) && (paymentAction.test(text) && !/^اطلب/u.test(text)
    || ordersGoods || asksToTransfer || genericAction.test(text) && paymentQualifier.test(text))) {
    if (ordersGoods) return refusal('payment', 'place_order');
    return refusal('payment', asksToTransfer || head('pay|ادفع|سدد').test(text) || paymentTarget.test(text)
      ? 'review_payment' : 'compare');
  }

  if (unsafeCircumvention.test(assistedAction)) {
    if (humanVerificationTarget.test(assistedAction)) return refusal('human_step', 'manual_step');
    if (ownershipControls.test(assistedAction)) return refusal('unsafe', 'protect');
  }
  if (humanStepAction.test(text) && (humanVerificationTarget.test(text) || humanCommitment.test(text))) {
    return refusal('human_step', 'manual_step');
  }
  if (loginAction.test(text) && (personalLogin.test(text) || !nonActionTerms.test(text))) {
    return refusal('human_step', 'sign_in');
  }
  // Action requests for signed-in account data without a configured account path
  // are missing access. Public pages and the user's existing browser stay eligible.
  if (accountAction.test(text) && (outsideAccess.test(text) || genericRequestForOwnMaterial.test(text) && /\b(?:unshared|unopened)\b/u.test(text))) {
    return refusal('no_access', 'share_material');
  }
  if (localComputer && capability?.computer === false && capability.desktop !== true) return refusal('no_access', 'share_material');
  if (capability?.memory === false && accountAction.test(text) && knownOwnMemory.test(text)) return refusal('no_access', 'share_material');

  if (guaranteedForecast.test(text)) return refusal('future', 'forecast_sources');
  if (capability?.reminders !== true && (delayedScheduling.test(text) && !recallNotReminder.test(text)
    || futureAction.test(text) && futureTime.test(text) && !immediateOperand.test(text) && !futureLookup.test(text))) {
    return refusal('future', 'plan');
  }
  if (describedAction) return null;
  const unsupported = classifyUnsupportedAction(text, capability?.mediaModel === true, isDraft);
  if (unsupported) return unsupported;
  if (imageRequest.test(text) && capability?.imageModel !== true) return refusal('no_capability', 'describe_image');
  if (mediaRequest.test(text) && capability?.mediaModel !== true) return refusal('no_capability', 'find_media');
  if (physicalAction.test(text)) return refusal('no_capability', 'public_info');
  return null;
}

function classifyUnmatchedClause({ text, describedAction }: OuterClause, scope: RequestScopeAssessment): RefusalDecision | null {
  // A corpus label cannot override a resolved source or a supported operation.
  // Dialect questions may still have an unresolved source, so preserve their
  // informational path too. Explicit policy vetoes have already run.
  if (scope.source !== 'unresolved' || !['act', 'unknown'].includes(scope.operation)
    || scope.reasons.includes('unresolved_reference')
    || asksForExplanation.test(text) || explainer.test(text) || riskyInstruction.test(text) || isChatDelivery(text)) return null;
  const learned = classifyLearnedRefusal(text);
  if (!learned || documentTask(text)) return null;
  if (learned.code === 'unsafe') return refusal('unsafe', 'protect');
  // CLINC's scope is smaller than the assistant's. An unknown operation may
  // still be an information request, so require an action for a scope veto.
  return !describedAction && scope.operation === 'act' ? refusal('no_capability', 'public_info') : null;
}

/** Pure veto over every outer operation, including tails after a valid prefix. */
export function classifyRefusal(request: string, context: RefusalContext): RefusalDecision | null {
  const scope = context.scope ?? assessRequestScope(request);
  if (scope.reasons.includes('invalid_input') || scope.reasons.includes('explicit_prohibition')) return null;
  if (hasCredentialMaterial(request, scope)) return refusal('secrets', 'secure_entry');
  const clauses = outerClauses(scope.constraints?.safeActionText ?? requestScopeActionText(request));
  const isDraft = clauses.some(clause => askForDraft.test(clause.text));
  let found: RefusalDecision | null = null;
  for (const clause of clauses) {
    const decision = clause.controlRefusal ?? classifyClause(clause, context, scope, isDraft);
    if (decision && (!found || priority.indexOf(decision.code) < priority.indexOf(found.code))) found = decision;
  }
  if (found) return found;
  for (const clause of clauses) {
    const decision = classifyUnmatchedClause(clause, clauses.length === 1 ? scope : assessRequestScope(clause.text));
    if (decision && (!found || priority.indexOf(decision.code) < priority.indexOf(found.code))) found = decision;
  }
  return found;
}
