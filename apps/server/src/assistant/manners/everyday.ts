import type { MannersDetail, SpeechAct, SpeechActRule } from './speech-acts.js';

const courtesy = String.raw`(?:please |kindly )?`;
const hedge = String.raw`(?:really |actually |honestly |just )?`;
export const englishAssistantAddress = String.raw`(?:(?:ai |digital |virtual )?assistant|ai|(?:chat)?bot)`;
const appreciation = String.raw`(?:help|assistance|support|patience|time|effort|advice|guidance|input|feedback|explanation|information|reply|response|answer|work|kindness)`;
const gratitudeObject = String.raw`(?:it|that|you|(?:all )?(?:your|the|this|that) ${appreciation}(?: (?:with|on) (?:this|that|it)| from you)?)`;
const helpAction = String.raw`(?:help|assist|support|answer|reply|explain)`;
const help = String.raw`(?:${gratitudeObject}|(?:everything|all)(?: (?:that )?you (?:do|did))?|all you(?:'ve| have) done|(?:trying to ${helpAction}|(?:helping|assisting|supporting) (?:me|us)(?: out)?)|taking the time(?: to ${helpAction})?|being (?:so )?(?:patient|helpful|kind))`;
const addressed = String.raw`(?: ${englishAssistantAddress})?`;
const leaving = String.raw`(?:go|leave|run|head (?:off|out)|get going|(?:sign|log) off)`;
const nameQualifier = String.raw`(?:full |actual |real |first |given |preferred )?`;
const call = String.raw`(?:call|address|refer to)`;
const name = String.raw`(?:your ${nameQualifier}name|(?:what|how) to ${call} you|what (?:your ${nameQualifier}name is|you (?:are called|go by|call yourself|were named)|(?:people|others) call you))`;
const request = String.raw`(?:(?:can|could|would|will) you (?:please )?|${courtesy})`;
const bot = String.raw`(?:ai(?: powered)?(?: (?:assistant|bot|system|model|program))?|chat ?bot|(?:ro)?bot|(?:virtual|automated) assistant|(?:computer|software)(?: program)?|program|artificial intelligence|automated system|machine)`;
const human = String.raw`(?:real|(?:real |actual )?(?:live )?(?:human(?: being)?|person)(?: (?:who|that)(?: is|'s) (?:real|live))?|someone real)`;
const article = String.raw`(?:an? )?`;
const youAre = String.raw`(?:you (?:are|were)|you'?re|your)`;
const speaker = String.raw`(?:are you|aren'?t you|${youAre}|you|is (?:this|it)|could (?:you|this|it) be|do you happen to be|you must be)`;
const talking = String.raw`(?:am i|(?:i am|i'm)) (?:actually |really )?(?:talking|speaking|chatting|interacting|dealing|communicating) (?:to|with)`;
const indirect = String.raw`(?:if|whether) (?:${talking}|${youAre}|(?:this|it) is)`;
const ask = String.raw`(?:${request}(?:tell(?: me| us)?|confirm(?: (?:for )?(?:me|us))?|let (?:me|us) know|explain(?: to (?:me|us))?|clarify)|(?:can|could|may) i (?:ask|check)|(?:i (?:want|need|would like)|i'd like) to (?:know|find out)|i(?: am|'m) (?:wondering|curious)(?: about)?)`;
const alternate = String.raw`(?:or (?:${speaker} |${talking} |are |is )?${article})`;
const identityTag = String.raw`(?: or not| then| please| right| (?:are|aren'?t) you)?`;
const selfDescription = String.raw`(?:how (?:do|would) you (?:describe|identify|classify) yourself|(?:do|would) you (?:describe|identify|classify) yourself) as`;
const APPRECIATION_SPELLING = new RegExp(String.raw`^((?:i )?${hedge})([a-z]{9,11})(?= )`, 'u');

// Build complete social clauses from grammatical frames and their allowed
// objects. An unrelated request, literal payload or extra condition stays out.
function english(act: SpeechAct, patterns: string[], detail?: MannersDetail): SpeechActRule {
  return { act, detail, language: 'en', dialect: null, pattern: new RegExp(`^(?:${patterns.join('|')})$`, 'u') };
}

function identityKind(kind: string, other: string, detail: 'ai' | 'human'): SpeechActRule {
  const choice = String.raw`${article}${kind}(?: ${alternate}${other})?`;
  return english('identity', [
    String.raw`${courtesy}(?:${speaker}|${talking}) ${hedge}(?:just |basically )?${choice}${identityTag}`,
    String.raw`${ask} ${indirect} ${choice}${identityTag}`,
    String.raw`i (?:think|guess|assume|suspect) (?:that )?${youAre} ${choice}${identityTag}`,
    String.raw`${selfDescription} ${choice}${identityTag}`,
  ], detail);
}

// The two words carry strong evidence only inside an otherwise complete
// grammatical frame. Allow one transposition, substitution or missed keystroke
// without applying edit distance to task operands.
function spellingVariant(word: string, target: string): boolean {
  if (Math.abs(word.length - target.length) > 1 || word === target) return false;
  let index = 0;
  while (word[index] === target[index]) index++;
  const rest = word.slice(index);
  const suffix = target.slice(index);
  if (word.length > target.length) return rest.slice(1) === suffix;
  if (word.length < target.length) return rest === suffix.slice(1);
  return rest.slice(1) === suffix.slice(1)
    || rest[0] === suffix[1] && rest[1] === suffix[0] && rest.slice(2) === suffix.slice(2);
}

export function normalizeEnglishThanks(phrase: string): string {
  return phrase.replace(APPRECIATION_SPELLING,
    (whole, lead, word) => spellingVariant(word, 'appreciate') ? lead + 'appreciate' : whole)
    .replace(/^(thank (?:you|u) for (?:the|your) )([a-z]{3,5})$/u,
      (whole, lead, word) => spellingVariant(word, 'help') ? lead + 'help' : whole);
}

export const everydayEnglishSpeechActs = [
  english('thanks', [
    String.raw`(?:i )?${hedge}appreciate ${gratitudeObject}|(?:i (?:am|feel)|i'm|im) (?:very |so |truly |really )?(?:thankful|grateful)(?: (?:to you|for ${gratitudeObject}))?`,
    String.raw`(?:i (?:just |really )?(?:want|wanted|wish) to|(?:i'd|id|i would) like to|(?:just |really )?(?:want|wanted) to) (?:say )?(?:thank (?:you|u)|thanks)(?: (?:again|so much|very much))?`,
    String.raw`(?:thank (?:you|u)|thanks)${addressed}(?: again| so much| very much)? for ${help}(?: and (?:for )?${help})?`,
    String.raw`(?:a )?(?:big|huge|sincere|heartfelt) thank(?:s| you)(?: to you)?|(?:many|a thousand) thanks?|thank (?:you|u) (?:a million|loads|tons)|thanks (?:loads|tons|a lot|a bunch)`,
    String.raw`(?:you have|please accept) my (?:sincere |heartfelt )?(?:thanks|gratitude)|(?:greatly|truly|really) appreciated`,
    String.raw`i (?:cannot|can't|couldn't) thank (?:you|u) enough|i owe you one|you(?:'ve| have) been (?:a (?:big|great|huge) help|(?:so |really |very )?helpful)`,
    String.raw`(?:it|that) (?:was (?:really |very |so )?helpful|helped (?:me|us)(?: a (?:lot|great deal))?)`,
  ]),
  english('compliment', [
    String.raw`(?:you|you have|you've) (?:given|provided|offered|shared) (?:me|us) (?:so much |a lot of |such (?:good|useful) )?${appreciation}`,
  ]),
  english('farewell', [
    String.raw`(?:well |okay |ok |alright |all right )?(?:(?:i )?(?:have to|need to|ought to|should|must|gotta)|(?:i've|ive) got to|(?:i'm|im|i am) (?:going|about) to) ${leaving}(?: now| for now)?`,
    String.raw`(?:time to|(?:i'm|im|i am) (?:gonna|off to)) (?:${leaving}|bed)(?: now)?|(?:i'm|im|i am) (?:going|leaving|heading out)(?: now| for now)`,
    String.raw`(?:see|catch|talk to) (?:you|ya) (?:again|next time|in a bit|in a while|on the weekend|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))`,
    String.raw`(?:it was |it is |it's )?(?:really |very |so )?(?:nice|great|lovely|good|awesome|a pleasure) (?:(?:talking|speaking|chatting)|to (?:talk|speak|chat))(?: (?:to|with) you)?`,
    String.raw`(?:i )?(?:really )?(?:enjoyed|liked) (?:our (?:chat|conversation)|(?:talking|speaking|chatting) (?:to|with) you)`,
    String.raw`until (?:next time|we (?:meet|talk) again)|so long|farewell|cheerio|peace out|(?:good bye|goodbye|bye(?: bye)?) (?:now|then|friend)`,
    String.raw`(?:wish(?:ing)? you|have) (?:a |an )?(?:(?:good|great|nice|lovely|wonderful|pleasant|restful) (?:afternoon|morning|night|week|rest of (?:the|your) day)|safe travels)|(?:be|stay) safe`,
    String.raw`(?:that's|that is) all(?: for (?:now|today)| i (?:need|needed|wanted))?|(?:i'll|i will|i should) (?:let you go|be on my way|leave you to it)|(?:(?:best|kind|warm) )?regards`,
  ]),
  english('identity', [
    String.raw`${courtesy}(?:(?:what is|what's) your ${nameQualifier}name|what name (?:do you (?:go by|use|want (?:me|us) to use)|should i use for you|would you (?:like|prefer) (?:me|us) to use))`,
    String.raw`${courtesy}(?:what (?:do (?:you call yourself|(?:people|others) call you)|(?:may|could) i call you|(?:do|would) you (?:like|prefer) (?:(?:me|us) to call you|to be called)|(?:name )?were you (?:called|named|given))|how (?:should|do|may|can) i ${call} you)`,
    String.raw`${request}(?:(?:(?:tell|give) (?:me|us)|share(?: with (?:me|us))?|let (?:me|us) know) ${name}(?: with (?:me|us))?|(?:say|spell|pronounce) your name)(?: please)?`,
    String.raw`(?:may|can|could) i (?:please )?(?:ask|know|have|get) ${name}(?: please)?|would you mind (?:telling|giving) me ${name}`,
    String.raw`(?:do|did) you (?:have|go by) (?:a |any )?name|(?:i (?:want|would like)|i'd like) to know ${name}|your ${nameQualifier}name please`,
    String.raw`how (?:do|should|can) (?:i|you) (?:pronounce|say|spell) your name|what did (?:they|people|your (?:creators?|developers?)) name you`,
  ], 'name'),
  identityKind(bot, human, 'ai'),
  identityKind(human, bot, 'human'),
];

export function isEverydayManners(detection: Pick<SpeechActRule, 'act' | 'detail'>): boolean {
  return detection.act === 'thanks' || detection.act === 'farewell'
    || detection.act === 'identity' && (detection.detail === 'name' || detection.detail === 'ai' || detection.detail === 'human');
}
