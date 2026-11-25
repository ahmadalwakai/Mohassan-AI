import type { MannersDetail, SpeechAct, SpeechActRule } from './speech-acts.js';

const courtesy = String.raw`(?:please |kindly )?`;
const hedge = String.raw`(?:really |actually |honestly |just )?`;
const appreciation = String.raw`(?:help|assistance|support|patience|time|effort|advice|guidance|input|feedback|explanation|reply|response|answer|work|kindness)`;
const gratitudeObject = String.raw`(?:it|that|you|(?:all )?(?:your|the|this|that) ${appreciation}(?: (?:with|on) (?:this|that|it))?)`;
const help = String.raw`(?:${gratitudeObject}|everything|all you(?:'ve| have) done|(?:helping|assisting|supporting) (?:me|us)(?: out)?|taking the time(?: to (?:help|answer|reply|explain))?|being (?:so )?(?:patient|helpful|kind))`;
const leaving = String.raw`(?:go|leave|run|head (?:off|out)|get going|(?:sign|log) off)`;
const name = String.raw`(?:your (?:full |actual |real |first )?name|(?:what|how) to (?:call|address) you|what (?:your name is|you (?:are called|go by|call yourself|were named)|(?:people|others) call you))`;
const request = String.raw`(?:(?:can|could|would|will) you (?:please )?|${courtesy})`;
const bot = String.raw`(?:ai(?: powered)?(?: (?:assistant|bot|system|model|program))?|chat ?bot|(?:ro)?bot|(?:virtual|automated) assistant|(?:computer|software)(?: program)?|program|artificial intelligence|automated system|machine)`;
const human = String.raw`(?:(?:real |actual )?(?:human(?: being)?|person)|someone real)`;
const article = String.raw`(?:an? )?`;
const speaker = String.raw`(?:are you|aren'?t you|you are|you'?re|you|(?:is|could) (?:this|it)(?: be)?)`;
const talking = String.raw`(?:am i|(?:i am|i'm)) (?:actually |really )?(?:talking|speaking|chatting|interacting|dealing|communicating) (?:to|with)`;
const indirect = String.raw`(?:if|whether) (?:${talking}|you(?: are|'re)|this is)`;
const alternate = String.raw`(?:or (?:are you |is this |${talking} )?${article})`;

// Build complete social clauses from grammatical frames and their allowed
// objects. An unrelated request, literal payload or extra condition stays out.
function english(act: SpeechAct, patterns: string[], detail?: MannersDetail): SpeechActRule {
  return { act, detail, language: 'en', dialect: null, pattern: new RegExp(`^(?:${patterns.join('|')})$`, 'u') };
}

export const everydayEnglishSpeechActs = [
  english('thanks', [
    String.raw`(?:i )?${hedge}appreciate ${gratitudeObject}|(?:i (?:am|feel)|i'm|im) (?:very |so |truly |really )?(?:thankful|grateful)(?: (?:to you|for ${gratitudeObject}))?`,
    String.raw`(?:i (?:just |really )?(?:want|wanted|wish) to|(?:i'd|id|i would) like to|(?:just |really )?(?:want|wanted) to) (?:say )?(?:thank (?:you|u)|thanks)(?: (?:again|so much|very much))?`,
    String.raw`(?:thank (?:you|u)|thanks)(?: again| so much| very much)? for ${help}(?: and (?:for )?${help})?`,
    String.raw`(?:a )?(?:big|huge|sincere|heartfelt) thank(?:s| you)(?: to you)?|(?:many|a thousand) thanks|thank (?:you|u) (?:a million|loads|tons)|thanks (?:loads|tons|a lot|a bunch)`,
    String.raw`(?:you have|please accept) my (?:sincere |heartfelt )?(?:thanks|gratitude)|(?:greatly|truly|really) appreciated`,
    String.raw`i (?:cannot|can't|couldn't) thank (?:you|u) enough|i owe you one|you(?:'ve| have) been (?:a (?:big|great|huge) help|(?:so |really |very )?helpful)`,
    String.raw`(?:it|that) (?:was (?:really |very |so )?helpful|helped (?:me|us)(?: a (?:lot|great deal))?)`,
  ]),
  english('farewell', [
    String.raw`(?:well |okay |ok |alright |all right )?(?:(?:i )?(?:have to|need to|ought to|should|must|gotta)|(?:i've|ive) got to|(?:i'm|im|i am) (?:going|about) to) ${leaving}(?: now| for now)?`,
    String.raw`(?:time to|(?:i'm|im|i am) (?:gonna|off to)) (?:${leaving}|bed)(?: now)?`,
    String.raw`(?:see|catch|talk to) (?:you|ya) (?:again|next time|in a bit|in a while|on the weekend|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))`,
    String.raw`(?:it was |it is |it's )?(?:nice|great|lovely|good|a pleasure) (?:talking|speaking|chatting) (?:to|with) you`,
    String.raw`(?:i )?(?:really )?(?:enjoyed|liked) (?:our (?:chat|conversation)|(?:talking|speaking|chatting) (?:to|with) you)`,
    String.raw`until (?:next time|we (?:meet|talk) again)|so long|farewell|cheerio|peace out|(?:good bye|goodbye|bye) (?:now|then|friend)`,
    String.raw`(?:wish(?:ing)? you|have) (?:a |an )?(?:(?:good|great|nice|lovely|wonderful|pleasant|restful) (?:afternoon|morning|night|week|rest of (?:the|your) day)|safe travels)|(?:be|stay) safe`,
    String.raw`(?:that's|that is) all(?: for now)?|(?:i'll|i will|i should) (?:let you go|be on my way|leave you to it)|(?:best|kind) regards`,
  ]),
  english('identity', [
    String.raw`${courtesy}(?:what (?:name (?:do you (?:go by|use)|should i use for you|would you (?:like|prefer) me to use)|is your (?:full |real |actual |first )?name)|what's your (?:full |real |actual |first )?name)`,
    String.raw`${courtesy}(?:what (?:do (?:you call yourself|(?:people|others) call you)|(?:may|could) i call you|would you (?:like|prefer) (?:me|us) to call you|(?:name )?were you (?:called|named|given))|how (?:should|do|may|can) i (?:address|refer to) you)`,
    String.raw`${request}(?:(?:(?:tell|give) (?:me|us)|share(?: with (?:me|us))?|let (?:me|us) know) ${name}(?: with (?:me|us))?|(?:say|spell|pronounce) your name)(?: please)?`,
    String.raw`(?:may|can|could) i (?:please )?(?:ask|know|have|get) ${name}(?: please)?|would you mind (?:telling|giving) me ${name}`,
    String.raw`(?:do|did) you (?:have|go by) (?:a |any )?name|(?:i (?:want|would like)|i'd like) to know ${name}|your (?:full |real |actual |first )?name please`,
    String.raw`how (?:do|should|can) (?:i|you) (?:pronounce|say|spell) your name|what did (?:they|people|your (?:creators?|developers?)) name you`,
  ], 'name'),
  english('identity', [
    String.raw`${courtesy}(?:${speaker}|${talking}) ${hedge}${article}(?:just |basically )?${bot}(?: ${alternate}${human})?(?: or not| then| please)?`,
    String.raw`(?:do you happen to be|could you be|you must be) ${article}${bot}|${request}(?:tell|confirm)(?: (?:me|us))? ${indirect} ${article}${bot}`,
    String.raw`(?:can|could|may) i (?:ask|check) ${indirect} ${article}${bot}|(?:i (?:want|need) to know|i(?: am|'m) (?:wondering|curious)) ${indirect} ${article}${bot}`,
  ], 'ai'),
  english('identity', [
    String.raw`${courtesy}(?:${speaker}|${talking}) ${hedge}${article}${human}(?: ${alternate}${bot})?(?: or not| then| please)?`,
    String.raw`${request}(?:tell|confirm)(?: (?:me|us))? ${indirect} ${article}${human}`,
    String.raw`(?:can|could|may) i (?:ask|check) ${indirect} ${article}${human}|(?:i (?:want|need) to know|i(?: am|'m) (?:wondering|curious)) ${indirect} ${article}${human}`,
  ], 'human'),
];

export function isEverydayManners(detection: Pick<SpeechActRule, 'act' | 'detail'>): boolean {
  return detection.act === 'thanks' || detection.act === 'farewell'
    || detection.act === 'identity' && (detection.detail === 'name' || detection.detail === 'ai' || detection.detail === 'human');
}
