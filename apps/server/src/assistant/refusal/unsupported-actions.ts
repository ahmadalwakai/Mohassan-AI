import { draftReference, head, outreach, sendAction, words } from './patterns.js';
import type { RefusalDecision } from './types.js';

const recipient = '(?:me |us )?';
const article = '(?:(?:a|an|the|my|our|this|that|some) )?';

const deviceNouns = 'lights?|lighting|lamps?|bulbs?|dimmer|(?:robot )?vacuum(?: cleaner)?|roomba|smart (?:plug|socket|outlet|switch|speaker|thermostat)|coffee (?:maker|machine)|(?:air )?conditioner|thermostat|heater|fan|television|tv|(?:ال)?(?:نور|انوار|ضوء|اضواء|اضاءه|لمبه|لمبات|مصباح|مصابيح|مكنسه|مقبس|قابس|فيش|افياش|مكيف|تكييف|مروحه|دفايه|تلفزيون|تلفاز)|(?:اله|ماكينه|جهاز) (?:صنع )?القهوه';
const deviceNoun = words(deviceNouns);
const deviceOperand = head(
  `${article}(?:(?:main|smart|robotic|ceiling|hallway|kitchen|bedroom|bathroom|living room|dining room|office|porch|outdoor) )*(?:${deviceNouns})`,
);
const devicePower = head(
  '(?:turn|switch|power|shut) (?:on|off|down|up)|(?:start|stop|run|activate|deactivate|enable|disable|unplug|plug in)|(?:قم |قومي )?ب(?:تشغيل|ايقاف|اطفاء)|(?:شغل|اشغل|طف|طفي|اطفي|اطفئ|اغلق|اقفل|افصل|وصل|ابدا|اوقف)(?:ي|لي)?',
);
const deviceAdjust = head('dim|brighten|raise|lower|increase|reduce|set|adjust|change|(?:وطي|خفف|اعلي|علي|اخفت|ارفع|اخفض|خفض|اضبط|غير|بدل)(?:ي|لي)?');
const splitDevicePower = head('turn|switch|power|shut');
const deviceParticle = words('on|off|up|down');
const deviceSetting = head('(?:the )?(?:brightness|temperature|intensity|color|colour|level) (?:of|on|in)|(?:ال)?(?:سطوع|حراره|شده|لون)');
const descriptiveDevice = words('icons?|diagrams?|photos?|illustrations?|simulat(?:ion|or)|effects?|in (?:the|this) (?:app|editor|image|game|drawing|simulation)|رمز|رسمه|صوره|محاكاه|تاثير');

const mediaNoun = words(
  'music|songs?|tracks?|playlists?|podcasts?|radio|stations?|audio(?:books?)?|recordings?|albums?|videos?|films?|movies?|episodes?|channels?|recitations?|(?:ال)?(?:موسيقي|موسيقا|اغنيه|اغاني|البوم|فيديو|مقطع|بودكاست|اذاعه|راديو|تسجيل|تلاوه|قران|سوره|نشيد|اناشيد|فيلم|مسلسل|حلقه|قناه)',
);
const directPlayback = head('play|stream|listen to|tune(?: in)?(?: to)?|shuffle|(?:شغل|اشغل|تشغيل|سمعني|اسمعني|ولف|استمع (?:الي|ل))(?:ي|لي)?');
const playbackControl = head('put on|turn on|start|stop|pause|resume|restart|continue|(?:read|say) aloud|read out|(?:ابدا|كمل|واصل|استانف|تابع|وقف|اوقف|اسمع|اقرا لي)(?:ي|لي)?');
const ordinaryPlay = head(
  '(?:play|stream) (?:the role|a role|a part|the part|devil\'s advocate|along|with|against|framework|it safe|a trick|a prank|chess|checkers|tic tac toe|(?:a |the )?word game|(?:a |the )?game|data|logs|events|records|bytes|responses)|(?:شغل|اشغل|تشغيل) (?:ال)?(?:تطبيق|برنامج|محاكي|موقع|كود|سكريبت|نص برمجي|ملف تنفيذي|لعبه|مؤقت)',
);
const mediaContext = words('spotify|youtube|soundcloud|apple music|في منصه الموسيقي|سبوتيفاي|يوتيوب|ساوند كلاود');
const namedPlayback = head('play (?!(?:it|this|that|them|anything|something|more|next|previous)(?:$|[ .!?]))\\p{L}[\\p{L}\\p{N}\'’ .,:-]{1,100}$');

const booking = head(
  `(?:book|reserve|make a reservation for|arrange) ${recipient}${article}(?:flights?|tickets?|tables?|rooms?|hotels?|taxis?|cabs?|ride shares?|uber|cars?|appointments?|seats?|trips?|stays?|rentals?|reservations?|rides?|accommodation)|(?:make|set up|schedule) ${recipient}${article}(?:appointments?|reservations?)|(?:احجز|احجزي|حجز|رتب|حدد)(?:لي)? (?:لي )?(?:ال)?(?:طيران|رحله|تذكره|تذكرت(?:ان|ين)|تذاكر|فندق|غرفه|طاوله|موعد|سياره|تاكسي|مقعد|مكان|مطعم|حجز)`,
);
const bookingLookup = words('(?:without|before) booking|to compare|options for|details about|(?:من دون|بدون|قبل) الحجز');

const commerceNoun = words(
  'meals?|food|groceries|pizza|takeout|delivery|medicine|medications?|prescriptions?|drinks?|coffee|dinner|lunch|breakfast|products?|supplies|merchandise|sandwich(?:es)?|snacks?|desserts?|soups?|salads?|pastries|(?:ال)?(?:طعام|اكل|وجبات?|وجبه|عشاء|غداء|فطور|قهوه|بيتزا|مشتريات|بقاله|دواء|ادويه|منتجات?|طلب شراء|حلويات)',
);
const shoppingOrder = head('order (?:me |us )?(?:(?:an?|the|this|that|some|my|our) )?(?!these|those|by|in|from least|numbers|list|rows|items alphabetically|results|tasks|books by)(?:food|pizza|takeout|groceries|medication|products?|tickets?|supplies|coffee|tea|dinner|lunch|breakfast|a refill|a replacement|[a-z]+ from)\\b|اطلب(?:لي)? (?:لي )?(?:اكل|وجبه|طعام|قهوه|بيتزا|دواء|منتج|تذاكر?|طلب شراء|من (?:المطعم|المتجر|الصيدليه))');
const orderSubmission = head('place (?:a|an|the|my|our|this|that) (?:new )?order');
const ordering = head('order|(?:اطلب|طلبي|طلب)(?:لي)?|(?:قدم|اعمل|سو|سوي)(?:لي)? (?:ال)?طلب');
const sortOrder = words('alphabetical(?:ly)?|chronological(?:ly)?|(?:ascending|descending|reverse) order|sort(?:ed)?|(?:order|رتب).{0,50}(?:by date|by name|by price|بالترتيب|ابجديا|تصاعديا|تنازليا)');

const callCommand = head('call|phone|dial|ring|give .{1,70} a call|place a call to|(?:اتصل|اتصلي|اتصال|كلم|دق|رن|اكلم)(?:لي|ي)?');
const indirectCall = head('give .{1,70} a call');
const nonTelephone = head(
  'call (?:.+ (?:a function|a method|a variable)|(?:out|off|on|for|it)(?: |$)|(?:me|us) (?!back(?: |$)|on (?:my|our|the) (?:phone|number))|(?:a|an|the|this) (?:[\\w.]+ )?(?:function|method|callback|endpoint|api|subroutine|command|object))|phone (?:number|model|battery|screen)|ring (?:tone|size|buffer|topology|a bell)|(?:اتصل|كلم)(?:ي)? (?:الداله|داله|الواجهه|الطريقه|الاجراء)',
);

const chatFollowUp = head('message (?:me|us) (?:if|when|once|here)|(?:راسلني|كلمني) (?:اذا|لو|هنا)');
const directMessaging = head('email|e mail|text|sms|whatsapp|dm|message|راسل(?:ي|ه|ها|هم)?');
const messagingVerb = head('send|forward|deliver|share|pass along|(?:ارسل|ابعث|ابعت|رسل|حول|شارك)(?:ي|ه|ها|هم|لي)?');
const externalRecipient = words('to (?:a |the |my |our |your |his |her |their )?(?:contact|team|group|manager|colleague|client|customer|friend|family|mailing list|phone|mobile|inbox|email address)|(?:to|at) [\\w.+-]+@[\\w.-]+|(?:الي|الى|ل) ?(?:جهه الاتصال|المجموعه|الفريق|المدير|مديري|زميلي|صديقي|عميل|العميل|بريد|ايميل)');
const messagingChannel = words('via (?:text|sms|email|e mail|whatsapp|telegram|messenger)|(?:on|through|over) (?:whatsapp|telegram|messenger)|(?:عبر|علي|عن طريق) (?:ال)?(?:واتساب|واتس اب|تليجرام|تلغرام|البريد|ايميل|رساله نصيه)');
const inChatDelivery = words('(?:to me |me )?(?:here|in (?:this|the|our) chat|in (?:this|your) repl(?:y|ies))|هنا|(?:في|داخل) (?:هذه |هذي )?(?:المحادثه|الدردشه|الرد)');
const transportJargon = head('(?:send|forward) (?:a |an |the |this )?(?:http|https|post|webhook|network|dns|tcp|udp|api|browser) (?:request|packet|traffic|message|response)|(?:email|message|text) (?:address|format|template|examples?|alignment|to speech|colors?|encoding|size|editor)');

const publishVerb = head('post|publish|share|upload|broadcast|announce|tweet|retweet|repost|انشر(?:ي|ه|ها)?|نشر|غرد(?:ي)?|اعد تغريد|شارك(?:ي|ه|ها)?|ارفع(?:ي|ه|ها)?');
const publishDirect = head('tweet|retweet|repost|غرد(?:ي)?|اعد تغريد');
const publishingDestination = words('publicly|online|(?:on|to|via) (?:my |our |the )?(?:social media|timeline|feed|blog|forum|channel|wall|facebook|instagram|twitter|tiktok|linkedin|mastodon|reddit)|(?:علي|في|عبر) (?:ال)?(?:فيسبوك|تويتر|انستغرام|تيك توك|لينكدان|مدونه|منتدي|صفحه|حساب|القناه)|للعلن|للعموم');
const publication = words('post|status|announcement|press release|public statement|(?:ال)?(?:منشور|تغريده|بيان صحفي|اعلان عام)');
const explicitPublishing = head('publish|انشر(?:ي|ه|ها)?|نشر');

export const unsupportedActionHeads = [
  devicePower, deviceAdjust, splitDevicePower, directPlayback, playbackControl, booking, ordering, orderSubmission, callCommand, directMessaging, messagingVerb, publishVerb,
];

export function isChatDelivery(text: string): boolean {
  return (sendAction.test(text) || messagingVerb.test(text))
    && inChatDelivery.test(text) && !externalRecipient.test(text) && !messagingChannel.test(text);
}

export function isShoppingOrder(text: string): boolean {
  if (sortOrder.test(text)) return false;
  return orderSubmission.test(text) || shoppingOrder.test(text)
    || Boolean(operand(ordering, text) && commerceNoun.test(text));
}

function externalSend(text: string, hasDraft: boolean): boolean {
  if (transportJargon.test(text) || chatFollowUp.test(text)) return false;
  if (operand(messagingVerb, text) && (externalRecipient.test(text) || messagingChannel.test(text))) return true;
  if (inChatDelivery.test(text)) return false;
  return Boolean(operand(directMessaging, text))
    || sendAction.test(text) && (outreach.test(text) || hasDraft && draftReference.test(text));
}

function operand(action: RegExp, text: string): string {
  const match = action.exec(text);
  return match ? text.slice(match[0].length).replace(/^[\s:]+/u, '') : '';
}

function changesDevice(text: string): boolean {
  if (descriptiveDevice.test(text)) return false;
  const switched = operand(devicePower, text);
  const split = operand(splitDevicePower, text);
  const adjusted = operand(deviceAdjust, text);
  return deviceOperand.test(switched)
    || deviceOperand.test(split) && deviceParticle.test(split)
    || deviceOperand.test(adjusted)
    || deviceSetting.test(adjusted) && deviceNoun.test(adjusted);
}

/** Matches the requested effect at the head, using the rest of the clause only as its operand. */
export function classifyUnsupportedAction(text: string, mediaAvailable: boolean, hasDraft: boolean): RefusalDecision | null {
  if (changesDevice(text)) return { code: 'no_capability', alternative: 'device_control' };
  if (!mediaAvailable && !ordinaryPlay.test(text) && (
    (operand(directPlayback, text) || operand(playbackControl, text)) && (mediaNoun.test(text) || mediaContext.test(text))
    || namedPlayback.test(text)
  )) return { code: 'no_capability', alternative: 'find_media' };
  if (booking.test(text) && !bookingLookup.test(text)) return { code: 'human_step', alternative: 'make_booking' };
  if ((operand(callCommand, text) || indirectCall.test(text)) && !nonTelephone.test(text)) {
    return { code: 'human_step', alternative: 'place_call' };
  }
  if (operand(publishVerb, text) && !inChatDelivery.test(text)
    && (publishDirect.test(text) || publishingDestination.test(text) || explicitPublishing.test(text) && publication.test(text))) {
    return { code: 'human_step', alternative: 'publish_content' };
  }
  if (externalSend(text, hasDraft)) {
    return { code: 'human_step', alternative: 'draft' };
  }
  return null;
}
