import { isPageInstruction } from '../../mind/extract.js';
import { matchText } from '../../mind/normalize.js';
import { sentenceSpans, type EvidenceSpan, type WritingSource } from '../evidence.js';
import type { Claim } from './types.js';

const MAX_SENTENCE_CHARS = 1_200;
const MAX_CLAIMS = 192;
const QUESTION = /[?؟][»”"')\]]*$/u;
const WORD = '[\\p{L}\\p{M}\\p{N}]';
const marker = (pattern: string) => new RegExp(`(?<!${WORD})(?:${pattern})(?!${WORD})`, 'u');

// Match in a folded view, and project every capture back into the original UTF-16 string.
function project(span: EvidenceSpan) {
  const offsets: number[] = [];
  let text = '';
  for (const cluster of span.text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const folded = matchText(cluster[0]).replace(/\s/gu, ' ');
    for (let i = 0; i < folded.length; i++) offsets.push(cluster.index);
    text += folded;
  }
  function range(start = 0, end = text.length): EvidenceSpan {
    const offset = offsets[start] ?? span.text.length;
    const literal = span.text.slice(offset, offsets[end] ?? span.text.length);
    const prefix = /^[\s,،;؛:–—]+/u.exec(literal)?.[0].length ?? 0;
    const value = literal.slice(prefix).replace(/[\s,،;؛:.!?؟–—]+$/u, '');
    const from = span.start + offset + prefix;
    return { source: span.source, start: from, end: from + value.length, text: value };
  }
  const part = (start?: number, end?: number) => range(start, end).text;
  const capture = (match: RegExpExecArray, name: string, keepPunctuation = false) => {
    const bounds = match.indices?.groups?.[name];
    if (!bounds) return '';
    return keepPunctuation ? span.text.slice(offsets[bounds[0]], offsets[bounds[1]] ?? span.text.length).trim() : part(...bounds);
  };
  return { text, range, part, capture };
}

type Projection = ReturnType<typeof project>;

const BACKWARD = marker(String.raw`because(?: +of)?|due +to(?! +(?:be|start|arrive|begin|end|leave|open|close)(?!\p{L}))|(?:as +a +result|in +consequence) +of|owing +to|on +account +of|(?:caused|powered|driven) +by|result(?:s|ed|ing)? +from|stem(?:s|med|ming)? +from|attribut(?:able|ed) +to|[وف]?(?:لان(?:ه|ها|هم|هما|نا|ك)?|بسبب|(?:ك)?نتيجه(?: +عن)?(?! +لذلك)|جراء|بفعل|نظرا +ل|[يت](?:عود|رجع|عزي) +الي)`);
const FORWARD = marker(String.raw`lead(?:s|ing)? +to|led +to|result(?:s|ed|ing)? +in|caus(?:e|es|ed|ing)(?! +(?:of|is|are|was|were|by)(?!\p{L}))|trigger(?:s|ed|ing)?|giv(?:e|es|ing) +rise +to|gave +rise +to|[وف]?(?:[يت]ؤدي +الي|ادي(?:ت)? +الي|[يت]سبب +في|[يت]نتج +عنه(?:ا)?|مما +[يت](?:ؤدي +الي|سبب +في))`);
const RESULT = marker(String.raw`as +a +result(?! +of)|therefore|consequently|(?<=[,;] )so(?! +that)|[وف]?(?:نتيجه +لذلك|لذلك|ولهذا|ومن +ثم|وبالتالي|بالتالي)`);
const PURPOSE = marker(String.raw`so +that|in +order +to|[وف]?(?:لكي|كي|بهدف|بغرض|وذلك +ل(?=\p{L}))`);
const ARABIC_FORWARD = /^(?<predicate>(?<negation>[وف]?(?:لا|لم|لن) +)?[وف]?(?:[يت]ؤدي?|ادي(?:ت)?)) +(?<cause>[^,،;؛]{2,100}?) +الي +(?<effect>.+)$/du;
const ANAPHORA = /^(?:that(?:['’]s| +is)|this +is|it +is|وذلك|ذلك|وهذا|هذا)$/u;
const PREFIX_CAUSE = /[,،;؛]|(?<!\p{L})ف(?=(?:ان |قد ))/u;
const NEGATIVE_AUX = /(?: +(?:does|do|did|is|are|was|were|can|could|would|will|may|might|has|have|had))? +(?:not|never) *$| +(?:doesn|don|didn|isn|aren|wasn|weren|can|couldn|wouldn|won|hasn|haven|hadn)['’]t *$|(?:^| +)[وف]?(?:لا|لم|لن|ليس|ليست|ما) *$/u;
const COPULA = / +(?:is|are|was|were|be) *$/u;
const EMPTY_CLAUSE = /^(?:a|an|the|this|that|it|they|هو|هي|هذا|ذلك)$/u;
const QUALIFIER = /(?:^| +)(?:(?:can|could|might|may|sometimes|usually|often|only|unless|if|when|provided +that)|(?:[وف]?(?:قد|يمكن|ربما|غالبا|احيانا|فقط|الا|اذا|عندما|حينما)))(?!\p{L})/u;

function preceding(previous: EvidenceSpan | undefined, current: EvidenceSpan): EvidenceSpan | undefined {
  if (!previous || current.end - previous.start > MAX_SENTENCE_CHARS) return;
  const gap = current.source.text.slice(previous.end, current.start);
  if (!/^\s*$/u.test(gap) || /[\r\n]\s*[\r\n]/u.test(gap.replace(/\r\n/gu, '\n'))) return;
  return { ...current, start: previous.start, text: current.source.text.slice(previous.start, current.end) };
}

function causalClaim(span: EvidenceSpan, projected: Projection, previous?: EvidenceSpan): Claim | undefined {
  const { text, part, capture } = projected;
  const leading = ARABIC_FORWARD.exec(text);
  if (leading) {
    const cause = capture(leading, 'cause');
    const effect = capture(leading, 'effect');
    if (meaningful(cause) && meaningful(effect)) return {
      kind: 'causal', span, cause, effect, predicate: capture(leading, 'predicate'), negated: Boolean(capture(leading, 'negation')),
      ...(QUALIFIER.test(text) ? { conditioned: true } : {}),
    };
  }
  const markers = [[BACKWARD, 'backward'], [FORWARD, 'forward'], [RESULT, 'result'], [PURPOSE, 'purpose']] as const;
  const options = markers.flatMap(([cue, direction]) => {
    const marker = cue.exec(text);
    return marker ? [{ marker, direction }] : [];
  }).sort((a, b) => a.marker.index - b.marker.index);
  for (const { marker, direction } of options) {
    const start = marker.index;
    const end = start + marker[0].length;
    const before = text.slice(0, start).trim().replace(/[,،;؛]$/u, '').trim();
    const negative = NEGATIVE_AUX.exec(text.slice(0, start));
    const copula = direction === 'backward' && /^(?:caused|powered|driven|attribut)/u.test(marker[0]) ? COPULA.exec(text.slice(0, start)) : null;
    const subjectEnd = negative?.index ?? copula?.index ?? start;
    const predicate = part(subjectEnd, end);
    let cause = part(0, subjectEnd);
    let effect = part(end);
    let evidence = span;
    if (direction === 'backward') {
      [cause, effect] = [effect, cause];
      if (!before) {
        const split = PREFIX_CAUSE.exec(text.slice(end));
        if (!split) continue;
        cause = part(end, end + split.index);
        effect = part(end + split.index + split[0].length);
      } else if (ANAPHORA.test(before)) {
        const joint = preceding(previous, span);
        if (!joint || !previous) continue;
        evidence = joint;
        effect = project(previous).part();
      }
    } else if (direction === 'result' && !before) {
      const joint = preceding(previous, span);
      if (!joint || !previous) continue;
      evidence = joint;
      cause = project(previous).part();
    }
    if (![cause, effect].every(clause => meaningful(clause) && !EMPTY_CLAUSE.test(matchText(clause)))) continue;
    return {
      kind: 'causal', span: evidence, cause, effect, predicate,
      negated: Boolean(negative),
      ...(direction === 'purpose' || QUALIFIER.test(text) ? { conditioned: true } : {}),
    };
  }
  return undefined;
}

function meaningful(text: string): boolean {
  return /[\p{L}\p{N}]{2}|\p{N}/u.test(text);
}

const EXAMPLE = marker(String.raw`for +example|for +instance|such +as|an +example +of|[وف]?(?:علي +سبيل +المثال|مثلا|من +امثله|مثال +علي)`);
const LIMIT = marker(String.raw`limitations?|drawbacks?|cannot|can['’]t|(?:does|do) +not +(?:support|work)|(?:works?|operates?) +only|restricted +to|limited +to|[وف]?(?:قيود|محدود(?:ه)?|لا +يمكن|لا +يدعم|لا +تدعم|لا +يعمل|لا +تعمل|[يت]قتصر)`);
const DEFINITION = /^(?<subject>[^:,،;؛]{1,100}?) +(?<predicate>(?:is|are|was|were) +(?:a|an|the)(?!\p{L})|(?:is|are) +(?!not +)(?:defined|known) +as|refer(?:s)? +to|mean(?:s)?|stands? +for|هو|هي|هما|عباره +عن|[يت]عرف +بان(?:ه|ها)|[يت]عني|يشير +الي) +(?<value>.+)$/du;
const DEFINITION_AR = /^(?<predicate>يقصد +ب|[يت]عرف) *(?<subject>[^:,،;؛]{2,90}?) +(?:بان(?:ه|ها)|هو|هي) +(?<value>.+)$/du;
const HEADING_DEFINITION = /^(?<subject>[^:,،;؛]{2,70}?) *(?<predicate>:) +(?<value>.+)$/du;
const DEFINITION_ARTICLE = /^(?:is|are|was|were) +(a|an|the)$/u;
const MECHANISM = marker(String.raw`(?:work(?:s|ed)?|operat(?:e|es|ed)) +(?:by|through)|rel(?:y|ies|ied) +on|by +(?:means +of|[a-z]{3,}ing)|consist(?:s|ed)? +of|involv(?:e|es|ed)|uses|use(?! +of)|passes? +through|convert(?:s|ed)?|transform(?:s|ed)?|transfer(?:s|red)?|transmit(?:s|ted)?|absorbs?|releases?|enters?|flows?|forms?|rises?|falls?|casts?|obscures?|(?:turns?|changes?|condenses?) +into|occurs? +when|happens? +when|[وف]?(?:من +خلال|عن +طريق|بواسطه|[يت]ستخدم|[يت]عتمد +علي|[يت]كون +من|[يت]حول|[يت]مر|[يت]نقل|[يت]متص|[يت]طلق|[يت]دخل|[يت]دفق|[يت]شكل|[يت]كاثف|[يت]بخر|[يت]جمد|[يت]ذوب|[يت]خفض|[يت]حدث +عندما)`);
const MECHANISM_SCOPE = /^(?<predicate>during|خلال|اثناء) +(?<subject>[^,،;؛]{2,85}) *[,،;؛] +(?<value>.+)$/du;
const MECHANISM_EN = /^(?<subject>[^:,،;؛]{2,100}?) +(?:(?:can|could|may|might) +)?(?<predicate>rises?|falls?|flows?|forms?|moves?|turns?|changes?|condenses?|travels?|passes?|occurs?|happens?) +(?<value>(?:[a-z]{3,}ly +){0,2}(?:above|across|as|at|below|by|from|in|into|over|through|to|toward|under|when) +.+)$/du;
const MECHANISM_AR = /^(?<predicate>[وف]?[يت]ت?(?:حدث|غير|شكل|حول|كون|كاثف|بخر|جمد|ذوب|دفق|مر|رتفع|نخفض)) +(?<subject>[^:,،;؛]{2,85}?) +(?<value>(?:الي|عند|عندما|حيث|حينما|في|علي|خلال|عبر|من +خلال|عن +طريق) +.+)$/du;
const IMPERATIVE = /^(?:[-*•▪◦] +)?(?:(?:please|من +فضلك) +)?(?:add|adjust|apply|attach|check|choose|clean|close|combine|connect|cool|cover|cut|disconnect|dry|fill|fold|hold|insert|keep|label|leave|let|lift|lower|mix|open|place|pour|press|pull|push|raise|remove|replace|rinse|rotate|select|separate|set|shake|slide|soak|stir|store|take|tighten|turn|unplug|wait|warm|wash|wrap|[وف]?(?:اضف|اضبط|اضغط|اغلق|اطفئ|افتح|افصل|ازل|ارفع|اربط|اسحب|اشحن|اشطف|ادخل|اخلط|اترك|انتظر|املا|امسك|ابق|اعمل|اختر|انقع|اقطع|احفظ|ثبت|ضع|صب|نظف|فك|شد|حرك|بدل|ركب|لف))(?= +\S)/u;
const STEP_NUMBER = /^(?:(?:step|الخطوه) +)?(\d{1,2})(?:[.)] +| *[:：-] +)(?=\S)/u;
const STEP_WORD = /^(?:[-*•▪◦] +)?(first(?:ly)?|second(?:ly)?|third(?:ly)?|fourth|fifth|next|then|finally|اولا|ثانيا|ثالثا|رابعا|خامسا|ثم|وبعدها|اخيرا)(?: *[,،:：-] *| +(?=(?:the|a|an|you|it|we|[وف]?[يت]\p{L}{2,}) +))/u;
const STEP_SEQUENCE = marker(String.raw`then|after +that|subsequently|finally|اولا|ثانيا|ثالثا|ثم|فبعد|بعد +ذلك|بعدها|اخيرا`);
const ORDINAL_PREFIX = /^(first(?:ly)?|second(?:ly)?|third(?:ly)?|fourth|fifth|اولا|ثانيا|ثالثا|رابعا|خامسا) +/u;
const ORDINALS = ['first firstly اولا', 'second secondly ثانيا', 'third thirdly ثالثا', 'fourth رابعا', 'fifth خامسا'];

function namedMechanism(span: EvidenceSpan, input: Projection): Claim | undefined {
  const match = MECHANISM_EN.exec(input.text) ?? MECHANISM_AR.exec(input.text);
  if (!match) return;
  const subject = input.capture(match, 'subject');
  const subjectText = matchText(subject);
  const value = input.capture(match, 'value');
  if (!usableSubject(subject) || EMPTY_CLAUSE.test(subjectText) || !meaningful(value)
    || [BACKWARD, FORWARD, RESULT, PURPOSE].some(cue => cue.test(subjectText))) return;
  return { kind: 'mechanism', span, subject, attribute: 'mechanism', value, predicate: input.capture(match, 'predicate'),
    ...(QUALIFIER.test(input.text) ? { conditioned: true } : {}) };
}

function mechanismClaim(span: EvidenceSpan, input: Projection): Claim | undefined {
  const { text, part, capture } = input;
  const named = namedMechanism(span, input);
  if (named) return named;
  const number = STEP_NUMBER.exec(text);
  const prefix = ORDINAL_PREFIX.exec(text);
  const order = STEP_WORD.exec(text) ?? (prefix && IMPERATIVE.test(text.slice(prefix[0].length)) ? prefix : null);
  const cue = MECHANISM.exec(text) ?? IMPERATIVE.exec(text) ?? STEP_SEQUENCE.exec(text);
  if (!number && !order && !cue) return;
  const ordinal = order && ORDINALS.findIndex(group => group.split(' ').includes(order[1]));
  const step = number ? +number[1] : typeof ordinal === 'number' && ordinal >= 0 ? ordinal + 1 : undefined;
  const signal = number ?? order ?? cue;
  const scope = MECHANISM_SCOPE.exec(text);
  if (scope && MECHANISM.test(scope.groups?.value ?? '') && usableSubject(capture(scope, 'subject'))) return {
    kind: 'mechanism', span, subject: capture(scope, 'subject'), attribute: 'mechanism', value: capture(scope, 'value'),
    predicate: capture(scope, 'predicate'), conditioned: true,
  };
  return { kind: 'mechanism', span, ...(signal ? { predicate: part(signal.index, signal.index + signal[0].length) } : {}),
    ...(step !== undefined ? { step } : {}) };
}

const ATTRIBUTE_LABELS: readonly (readonly [string, RegExp])[] = [
  ['cost', marker(String.raw`costs?|prices?|charges?|fares?|fees?|[تث]من|سعر|رسوم|تكلفه|اشتراك|اجره`) ],
  ['composition', marker(String.raw`composition|material|ingredients?|constituents?|مكونات|ماده|تركيب`) ],
  ['capacity', marker(String.raw`capacity|storage|payload|سعه|حموله|استيعاب`) ],
  ['power', marker(String.raw`power|wattage|قدره|استطاعه`) ],
  ['size', marker(String.raw`size|حجم`) ],
  ['area', marker(String.raw`area|مساحه`) ],
  ['width', marker(String.raw`width|عرض`) ],
  ['height', marker(String.raw`height|ارتفاع`) ],
  ['length', marker(String.raw`length|طول`) ],
  ['distance', marker(String.raw`distance|مسافه`) ],
  ['duration', marker(String.raw`duration|delivery time|مده|زمن|مواعيد +التوصيل`) ],
  ['speed', marker(String.raw`speed|velocity|سرعه`) ],
  ['schedule', marker(String.raw`hours|opening +days|schedule|ساعات +العمل|مواعيد|ايام +العمل`) ],
  ['location', marker(String.raw`location|position|موقع|مكان`) ],
  ['input', marker(String.raw`inputs?|مدخلات`) ],
  ['output', marker(String.raw`outputs?|مخرجات|نواتج`) ],
  ['function', marker(String.raw`function|purpose|وظيفه|غرض`) ],
  ['mechanism', marker(String.raw`mechanism|process|اليه|طريقه`) ],
];

// First classify predicates with a concrete attribute, then recognize a plain copular property.
const ATTRIBUTE_PREDICATES: readonly (readonly [string, string])[] = [
  ['composition', String.raw`(?:is|are|was|were) +made +(?:of|from)|consists? +of|made +up +of|contains?|(?:[يت]تكون +من|مصنوع(?:ه)? +من|[يت]حتوي +علي)`],
  ['function', String.raw`(?:is|are|was|were) +used +(?:to|for)|(?:[يت]ستخدم +(?:ل|في))`],
  ['mechanism', String.raw`(?:works?|operates?) +(?:by|through)|(?:occurs?|happens?) +when|[يت]عمل +عن +طريق|[يت]حدث +عندما`],
  ['input', String.raw`(?:runs?|relies) +on|requires?|[يت]عتمد +علي|[يت]تطلب`],
  ['output', String.raw`produces?|emits?|generates?|[يت]نتج|[يت]صدر`],
  ['location', String.raw`(?:is|are|was|were) +(located|found|situated) +(in|on|at)|[يت](?:قع|وجد) +(?:في|علي)`],
  ['length', String.raw`extends? +for|is +long|[يت]متد`],
  ['capacity', String.raw`holds?|stores?|carr(?:y|ies)|accommodates?|[يت]تسع +ل|[يت]سع +ل|[يت]حمل|[يت]خزن`],
  ['cost', String.raw`costs?|charges?|[يت]كلف|[يت]بلغ +سعر`],
  ['duration', String.raw`(?:lasts?|takes?)|(?:arrives?|is +delivered) +(?:in|within)|[يت]صل +خلال|[يت]ستغرق|[يت]دوم`],
  ['speed', String.raw`travels? +at|moves? +at|[يت]تحرك +بسرعه`],
  ['schedule', String.raw`(?:is|are) +open|opens? +on|[يت]فتح`],
  ['property', String.raw`(?:is|are|was|were)(?! +(?!not\b)\w+(?:ed|ing)\b)|هو|هي|هما|ليس|ليست`],
];
const SUBJECT = String.raw`(?<subject>[^:,،;؛]{1,100}?)`;
const ATTRIBUTE_AUX = String.raw`(?:(?<negation>(?:does|do|did) +not +|doesn['’]t +|don['’]t +|didn['’]t +|can['’]t +|cannot +|(?:[وف]?(?:لا|لم|لن) +))|(?:can|could|may|might) +)?`;
const SUBJECT_VALUE = ATTRIBUTE_PREDICATES.map(([kind, predicate]) => [kind, new RegExp(
  `^${SUBJECT} +${ATTRIBUTE_AUX}(?<predicate>${predicate})(?!${WORD}) *(?<value>\\S.*)$`, 'du',
)] as const);
const LEADING_VALUE = ATTRIBUTE_PREDICATES.filter(([kind]) => kind !== 'property').map(([kind, predicate]) => [kind, new RegExp(
  `^${ATTRIBUTE_AUX}(?<predicate>${predicate})(?!${WORD}) +${SUBJECT} +(?<value>\\d.*)$`, 'du',
)] as const);
const LABELED_EN = /^(?<label>[^:,،;؛]{2,65}?) +(?:of|on|for|to) +(?<subject>[^:,،;؛]{1,85}?) +(?<predicate>is|are|was|were|equals?) +(?<value>.+)$/du;
const LABELED_AR = /^(?<label>(?:[وف]?(?:ال)?)(?:تكلفه|سعر|رسوم|طول|مسافه|مساحه|ارتفاع|عرض|وزن|حجم|قدره|سعه|اشتراك|مده|سرعه|لون|اجره|ثمن)) +(?<subject>[^:,،;؛]{1,85}?) +(?:(?<predicate>[يت]بلغ|هو|هي) +)?(?<value>\d.*)$/du;
const BAD_SUBJECT = /^(?:of|for|in|on|with|there|as|ان|في|من)(?: +|$)|(?:^| +)(?:when|because|if|while|whereas|although|whose|which|who|عندما|بينما|اذا|لان|بسبب)(?: +|$)|[()؟?]/u;
const PARTITIVE_LABEL = /^(?:(?:a|an|the|some) +)?(?:portion|part|side|section|subset|fraction|segment|group|some|majority|minority)$/u;

function usableSubject(subject: string): boolean {
  const name = matchText(subject).replace(/ +\([\p{L}\p{N} &'’-]{1,35}\)$/u, '');
  return meaningful(subject) && subject.split(/\s+/u).length <= 12 && !BAD_SUBJECT.test(name);
}

function definitionClaim(span: EvidenceSpan, input: Projection): Claim | undefined {
  const heading = HEADING_DEFINITION.exec(input.text);
  const headingValue = heading?.groups?.value ?? '';
  const match = DEFINITION.exec(input.text) ?? DEFINITION_AR.exec(input.text)
    ?? (heading && (MECHANISM.test(headingValue) || MECHANISM_EN.test(headingValue) || MECHANISM_AR.test(headingValue)) ? heading : null);
  if (!match) return;
  const subject = input.capture(match, 'subject');
  const predicate = input.capture(match, 'predicate', match === heading);
  const value = input.capture(match, 'value');
  if (!usableSubject(subject) || !meaningful(value) || /^(?:same|way|reason|first|last)\b/u.test(matchText(value))) return;
  if (DEFINITION_ARTICLE.test(matchText(predicate)) && /^(?:very|quite|so|also)\b/u.test(matchText(value))) return;
  return { kind: 'definition', span, subject, predicate, value, attribute: 'definition' };
}

function attributeClaim(span: EvidenceSpan, input: Projection): Claim | undefined {
  const { text, capture } = input;
  const labeled = LABELED_EN.exec(text) ?? LABELED_AR.exec(text);
  if (labeled) {
    const label = capture(labeled, 'label');
    const matchLabel = matchText(label).replace(/^[وف]?ال(?=\p{L}{3})/u, '');
    const attribute = ATTRIBUTE_LABELS.find(([, pattern]) => pattern.test(matchLabel))?.[0] ?? label;
    const subject = capture(labeled, 'subject');
    const value = capture(labeled, 'value');
    if (!PARTITIVE_LABEL.test(matchLabel) && !BAD_SUBJECT.test(matchLabel) && usableSubject(subject) && meaningful(value)) return { kind: 'attribute', span, subject, attribute, value,
      predicate: capture(labeled, 'predicate') || label, negated: false, ...(QUALIFIER.test(text) ? { conditioned: true } : {}) };
  }
  for (const [attribute, pattern] of [...SUBJECT_VALUE, ...LEADING_VALUE]) {
    const match = pattern.exec(text);
    if (!match) continue;
    const subject = capture(match, 'subject');
    const valueStart = match.indices?.groups?.value?.[0];
    const propertyNegative = attribute === 'property' && /^(?:not(?! +only)|never|غير) +/u.exec(match.groups?.value ?? '');
    const value = propertyNegative && valueStart !== undefined ? input.part(valueStart + propertyNegative[0].length) : capture(match, 'value');
    const predicate = capture(match, 'predicate');
    if (!usableSubject(subject) || !meaningful(value)) continue;
    const negated = Boolean(capture(match, 'negation') || propertyNegative) || /^(?:ليس|ليست)$/u.test(predicate);
    return { kind: 'attribute', span, subject, attribute, value, predicate,
      negated, ...(QUALIFIER.test(text) ? { conditioned: true } : {}) };
  }
  return undefined;
}

const CONTRAST = marker(String.raw`whereas|unlike|(?<=[,;] )(?:while|but|in +contrast)|[وف]?(?:بينما|علي +عكس|في +حين|ولكن)`);
const UNLIKE = /^(?:unlike|[وف]?علي +عكس)(?!\p{L})/u;
const JOINED_VALUES = /[,،;؛] *(?=(?:and +|و?\p{Script=Arabic}))/u;
const JOIN_PREFIX = /^(?:and +|و(?=\s|\p{Script=Arabic}))/u;
const TEMPORAL_CONTRAST = /^(?:while|[وف]?بينما|[وف]?في +حين)$/u;

function contrastClaim(span: EvidenceSpan, subject?: string, contrasted?: string, predicate?: string, attribute?: string): Claim {
  return { kind: 'contrast', span, subject, contrasted, predicate, attribute };
}

function attributes(span: EvidenceSpan, input: Projection): Claim[] {
  const { text, range, part } = input;
  const contrast = CONTRAST.exec(text);
  const unlike = contrast && UNLIKE.test(contrast[0]) ? contrast : undefined;
  if (unlike && unlike.index === 0) {
    const separator = /[,،;؛]/u.exec(text);
    if (separator) {
      const contrasted = part(unlike[0].length, separator.index);
      const statement = range(separator.index + 1);
      const statementInput = project(statement);
      const claim = definitionClaim(statement, statementInput) ?? attributeClaim(statement, statementInput);
      if (usableSubject(contrasted) && claim) return [claim, contrastClaim(span, claim.subject, contrasted, part(0, unlike[0].length), claim.attribute)];
    }
  }
  const join = contrast ?? JOINED_VALUES.exec(text);
  if (join && join.index > 0) {
    const leftSpan = range(0, join.index);
    const end = join.index + join[0].length;
    const rightOffset = contrast ? end : end + (JOIN_PREFIX.exec(text.slice(end))?.[0].length ?? 0);
    const rightSpan = range(rightOffset);
    const leftInput = project(leftSpan), rightInput = project(rightSpan);
    const left = (contrast ? definitionClaim(leftSpan, leftInput) : undefined) ?? attributeClaim(leftSpan, leftInput);
    const right = (contrast ? definitionClaim(rightSpan, rightInput) : undefined) ?? attributeClaim(rightSpan, rightInput);
    const statement = part(join.index, end);
    const mayBeTemporal = contrast && TEMPORAL_CONTRAST.test(contrast[0]);
    if (left && right) return contrast && (!mayBeTemporal || left.attribute === right.attribute)
      ? [left, right, contrastClaim(span, left.subject, right.subject, statement, left.attribute === right.attribute ? left.attribute : undefined)]
      : [left, right];
    if (unlike && left && usableSubject(rightSpan.text)) return [left, contrastClaim(span, left.subject, rightSpan.text, statement, left.attribute)];
    // A contrast is still evidence when one of its clauses lacks a recognized attribute.
    if (contrast && !mayBeTemporal && meaningful(leftSpan.text) && meaningful(rightSpan.text)) return [
      ...[left, right].filter((claim): claim is Claim => claim !== undefined),
      contrastClaim(span, left?.subject, right?.subject, statement),
    ];
  }
  const attribute = attributeClaim(span, input);
  return attribute ? [attribute] : [];
}

/** Extract typed claims from exact sentences, with separate literal spans for paired comparison cells. */
export function extractClaims(source: WritingSource): Claim[] {
  const claims: Claim[] = [];
  let previous: EvidenceSpan | undefined;
  for (const span of sentenceSpans(source)) {
    if (claims.length >= MAX_CLAIMS) break;
    if (span.text.length > MAX_SENTENCE_CHARS || /^#{1,6}\s/u.test(span.text) || QUESTION.test(span.text) || isPageInstruction(span.text)) {
      previous = undefined;
      continue;
    }
    const input = project(span);
    const causal = causalClaim(span, input, previous);
    const mechanism = mechanismClaim(span, input);
    const example = EXAMPLE.test(input.text);
    if (causal) claims.push(causal);
    if (mechanism) claims.push(mechanism);
    if (example) claims.push({ kind: 'example', span });
    if (LIMIT.test(input.text)) claims.push({ kind: 'limit', span });
    const comparisons = attributes(span, input);
    const definition = !example && !comparisons.some(claim => claim.span !== span || claim.kind === 'contrast') && definitionClaim(span, input);
    if (definition) claims.push(definition);
    claims.push(...comparisons.filter(claim => !definition || claim.attribute !== 'property'));
    previous = span;
  }
  return claims.slice(0, MAX_CLAIMS);
}
