import type { Lang } from '../mind/contract.js';
import { arabicHumanIdentity, arabicMachineIdentity, arabicWellbeing } from './arabic.js';
import { englishIdentityInquiries, everydayEnglishSpeechActs } from './everyday.js';

export type SpeechAct = 'greeting' | 'thanks' | 'apology' | 'compliment' | 'farewell' | 'wellbeing'
  | 'identity' | 'capabilities' | 'joke' | 'encouragement' | 'insult';
export type MannersDialect = 'msa' | 'egyptian' | 'gulf' | 'levantine' | 'iraqi' | 'maghrebi' | 'sudanese' | 'yemeni';
export type MannersDetail = 'peace' | 'morning' | 'afternoon' | 'evening' | 'night'
  | 'name' | 'creator' | 'human' | 'ai' | 'encourage-me' | 'quiet' | 'meeting';

export interface SpeechActRule {
  act: SpeechAct;
  language: Lang;
  dialect: MannersDialect | null;
  pattern: RegExp;
  detail?: MannersDetail;
}

// Patterns use the same letter folding as the request matcher. Each rule matches
// a whole candidate, so a word inside a task or quoted payload cannot trigger it.
function forms(act: SpeechAct, pattern: string, dialect: MannersDialect | null, detail?: MannersDetail): SpeechActRule {
  return { act, language: dialect === null ? 'en' : 'ar', dialect, pattern: new RegExp(`^(?:${pattern})$`, 'u'), detail };
}

export const speechActRules = [
  forms('greeting', '(?:hi+|he+y+|hello+|hiya|howdy|yo)(?: there)?|greetings', null),
  forms('greeting', '(?:very )?nice to meet you|pleased to meet you|good to (?:see|meet) you', null, 'meeting'),
  forms('greeting', '(?:i )?(?:just )?(?:wanted to say|stopped by to say|saying) (?:hi|hello)|(?:a )?quick (?:hello|hi|wave)(?: from me)?|just a (?:hello|hi|wave)', null, 'quiet'),
  forms('greeting', '(?:بس|فقط) (?:حبيت|اردت|جيت) (?:اسلم|القي التحيه)|(?:بس|فقط) (?:اسلم عليك|جيت اسلم عليك)|تحيه سريعه', 'msa', 'quiet'),
  forms('greeting', 'good morning|morning', null, 'morning'),
  forms('greeting', 'good afternoon', null, 'afternoon'),
  forms('greeting', 'good evening', null, 'evening'),
  forms('thanks', "(?:thank (?:you|u)|thanks)(?: very much| so much| kindly| again| a (?:lot|ton|million|bunch)| for (?:everything|helping(?: me| us)?|(?:your|the) (?:help|support|time|reply|answer|information|advice|update|explanation))| anyway)?(?: earlier)?|thx|tysm|ty|many thanks|much appreciated|(?:i )?(?:really )?appreciate (?:it|that|your help)|cheers|all sorted", null),
  forms('apology', "(?:(?:i am|i'm|im) )?(?:(?:so|very|really) )?sorry(?: (?:about (?:that|this|earlier)|for (?:that|the (?:delay|confusion|trouble|inconvenience)|bothering you|interrupting|being rude)|i (?:was rude|messed up|got that wrong)))?|i apologiz?e|i apologise|(?:my )?apologies(?: for (?:the delay|that))?|my bad(?: entirely)?|pardon me|forgive me", null),
  forms('compliment', "(?:you are|you're|youre) (?:really |so |pretty )?(?:great|awesome|amazing|brilliant|helpful|kind|smart|the best|doing (?:great|an amazing job))|(?:you )?nailed it|great (?:job|work|answer)|nice (?:job|work|answer|one)|well done|good job|(?:that's|that is|that was) (?:great|brilliant|impressive|really helpful)|(?:i )?(?:really )?(?:like|love) your (?:answer|answers|explanation|style|work)", null),
  forms('farewell', "bye(?: bye| for now)?|goodbye|good bye|see (?:you|ya)(?: later| soon| tomorrow| around)?|catch you later|take care|talk (?:to you )?(?:later|tomorrow|soon)|(?:have )?a (?:good|great|nice|lovely|wonderful) (?:day|evening|weekend|one)|(?:i am|i'm) off(?: now)?|later", null),
  forms('farewell', 'good night|goodnight|nighty night|sleep well', null, 'night'),
  forms('wellbeing', "how (?:are (?:you|u)(?: (?:doing|feeling))?|have you been|do you do|ya doing|r u)(?: today)?|(?:how is|how's|hows) (?:it going|life treating you|everything|your day(?: going)?)|(?:what is|what's|whats) (?:up|new)|wassup|sup|(?:are )?you (?:all right|alright|okay|ok)", null),
  forms('encouragement', "(?:i )?hope (?:you are|you're) (?:doing well|having a (?:good|great|lovely) day)|(?:i )?hope (?:your day(?: is|'s)|everything is) going well", null),
  forms('identity', "who are you(?: exactly| really)?|what are you(?: exactly| really)?|(?:(?:could|can|would) you )?introduce yourself|tell me (?:a bit |a little )?about yourself", null),
  forms('identity', "what (?:is|s) your name|what's your name|whats your name|what (?:are you called|should i call you|do i call you)|tell me your name|your name(?: only)?", null, 'name'),
  forms('identity', "who (?:made|created|developed|built|designed|programmed) you|who (?:made|created|developed|built) this (?:app|application)", null, 'creator'),
  forms('identity', 'are you (?:a real person|a person|a human(?: being)?|human|real)', null, 'human'),
  forms('identity', 'are you (?:an? (?:ai|bot|robot|assistant|ai assistant|ai model|chatbot)|artificial intelligence)', null, 'ai'),
  forms('capabilities', "what (?:can|could) you (?:do|help(?: me)? with)(?: for me| here| exactly)?|(?:how|what) can you help(?: me)?(?: with)?|(?:what are|list|describe|tell me about) your (?:capabilities|abilities|skills|functions)|what (?:do you do|are you able to do)|what (?:are you good at|are you here for)|how can i use you", null),
  forms('joke', "(?:(?:can|could|would|will) you )?(?:(?:tell|give) (?:me|us)|make up|crack) (?:a |another )?(?:(?:clean|short|quick|funny|little) )?joke(?: please)?|(?:tell (?:me|us) )?something funny|(?:can you )?make me laugh|a joke(?: please)?|(?:(?:have|do) you )?(?:got|have) any jokes", null),
  forms('encouragement', 'keep (?:it up|up the (?:good|great) work)|you can do it|you got this|good luck|best of luck', null),
  forms('encouragement', '(?:(?:can|could) you )?(?:encourage|motivate|cheer up) (?:me|us)|wish me luck|(?:i )?(?:need|could use) (?:some )?(?:encouragement|motivation)|give me (?:some encouragement|a pep talk)|cheer me up', null, 'encourage-me'),
  forms('insult', "(?:(?:you are|you're|youre) (?:such |really |so |an? |fucking )*|you )?(?:stupid|dumb|useless|an idiot|idiot|moron|pathetic|garbage|trash)(?: bot| assistant)?|you (?:suck|are the worst)|shut up|fuck (?:you|off)|i hate you", null),

  forms('greeting', '(?:و?عليكم (?:ال)?سلام|(?:ال)?سلام عليكم)(?: ورحمه الله(?: وبركاته)?)?|سلام', 'msa', 'peace'),
  forms('greeting', 'مرحبا(?: بك| بكم| فيك| بيك| الف| مليون)?|اهلا(?: وسهلا)?(?: بك| بكم| فيك| بيك)?|تحياتي|حياك الله|نورت(?: المكان)?|هاي|هلو|هالو|هلا|ياهلا|يا هلا|تشرفنا|تشرفت (?:بك|بمعرفتك|بلقائك)', 'msa'),
  forms('greeting', 'صباح (?:الخير|النور|الورد|الفل|الياسمين|السعاده)|اسعد الله صباحك|صبحك الله بالخير', 'msa', 'morning'),
  forms('greeting', 'مساء? (?:الخير|النور|الورد|الفل|الياسمين|السعاده)|اسعد الله مساءك|مساك الله بالخير|طاب (?:مساؤك|مساوك)', 'msa', 'evening'),
  forms('greeting', 'اهلا بيكم|يا صباح الفل', 'egyptian'),
  forms('greeting', 'هلا (?:والله|وغلا|ومسهلا|بك)|هلا هلا|يا مرحبا(?: الساع)?|يا هلا والله|يا هلا وغلا|حي الله (?:من جانا|الطله)|حياك', 'gulf'),
  forms('greeting', 'اهلين(?: وسهلين| فيك)?|اهلا وسهلين|مرحبتين|صباحو|يسعد صباحك', 'levantine'),
  forms('greeting', 'هله(?: بيك| بيچ| وغله)?|هلا (?:بيك|بيچ|بيكم)|هلو هلو', 'iraqi'),
  forms('greeting', 'سلامو عليكو|اهلا بيك بزاف|عسلامه|اسلمه|صحا صباحك', 'maghrebi'),
  forms('greeting', 'حبابك(?: عشره)?|حبابكم|حباب الزول|يا هلا يا زول|سلامات', 'sudanese'),
  forms('greeting', '(?:ال)?سلام عليكم يا زول', 'sudanese', 'peace'),
  forms('greeting', 'يا هلا بك|مرحبا الف بك|يا مراحب|هيا الله', 'yemeni'),

  forms('thanks', 'ف?شكرا(?:ا)?(?: (?:لك(?:م)?|جزيلا(?: لك)?|كثيرا|علي (?:المساعده|مساعدتك|وقتك|ردك|التوضيح|الاهتمام|كل شي(?:ء)?)))?|(?:الف|كل) (?:شكر|شكرا)|الشكر لك|اشكرك(?: جزيل الشكر| علي (?:مساعدتك|المساعده|وقتك|ردك))?|ممتن(?:ه)?(?: لك)?|لك (?:جزيل الشكر|كل التقدير)|جزاك(?:م)? الله (?:كل )?خير(?:ا)?|بارك الله فيك(?:م)?|تسلم(?:ي|وا)?(?: الايادي| ايدك| ايديك)?|الله يسلمك|لا عدمناك|مشكور(?:ه|ين)?(?: علي (?:ردك|المساعده)| يا غالي)?', 'msa'),
  forms('thanks', 'متشكر(?:ه|ين)?(?: (?:جدا|اوي|ليك))?|الف شكر ليك|ميرسي(?: اوي)?|ربنا يخليك|تسلم(?: يا باشا| ايدك اوي)', 'egyptian'),
  forms('thanks', 'الله يعطيك العافيه|يعطيك العافيه|الله يجزاك خير|بيض الله وجهك|(?:مشكور و)?ما قصرت(?:ي)?|كفيت ووفيت|يعطيك ربي العافيه|تسلم (?:يمينك|لي)|لاهنت|لا هنت', 'gulf'),
  forms('thanks', 'يسلموا?(?: ايديك| كتير| علي (?:المساعده|مساعدتك))?|يسلم تمك|تسلم كتير|شكرا كتير|يعطيك الف عافيه|الله يعافيك|ممنون(?:ك|ه|تك)?', 'levantine'),
  forms('thanks', 'تسلم(?:لي|لي هواي(?:ه)?)|ممنون(?: الك| الج| الچ| منك| منج| منچ| هواي(?:ه)?)?|مشكور (?:هواي(?:ه)?|حيل)|شكرا هواي(?:ه)?|عفيه عليك', 'iraqi'),
  forms('thanks', '(?:الله )?يعطيك الصحه|صحيت(?:ي)?|صحا|شكرا بزاف|يعيشك|بارك فيك|بارك الله فيك بزاف|الله يجازيك (?:بخير|خير)', 'maghrebi'),
  forms('thanks', '(?:تسلم|شكرا) كتير(?: شديد)?|ربنا يديك العافيه|متشكر شديد|بارك الله فيك يا زول', 'sudanese'),
  forms('thanks', 'سلمك الله|الله يحفظك|تسلم وربي يحفظك|كثر الله خيرك|حفظك الله', 'yemeni'),

  forms('apology', '(?:انا )?اسف(?:ه)?(?: (?:جدا|منك|علي (?:الازعاج|التاخير|الخطا|الالتباس|سوء الفهم|ذلك|اللي (?:صار|حصل))|اني (?:ازعجتك|قاطعتك)))?|اعتذر(?: (?:منك|لك|عن (?:الازعاج|التاخير|الخطا)))?|سامحني(?: علي (?:الخطا|التاخير|ما (?:حدث|حصل)))?|اعذرني(?: علي (?:الازعاج|التاخير))?|اعتذاري|عذرا(?: علي (?:الازعاج|التاخير|الخطا))?|حقك علي', 'msa'),
  forms('apology', '(?:انا )?اسف اوي|اسف ع ?(?:التاخير|الازعاج)|معلش(?: (?:يا سيدي|علي التاخير|اني اتاخرت))?|حقك عليا', 'egyptian'),
  forms('apology', 'المعذره(?: منك)?|سمح لي|اعذرنا|(?:العذر و)?السموحه|ما كان قصدي', 'gulf'),
  forms('apology', 'اسف كتير|بعتذر(?: منك)?|سوري(?: كتير| ع ?(?:التاخير|الازعاج))?|ما تواخذني|تؤبرني ما تواخذني', 'levantine'),
  forms('apology', 'اسف (?:هوايه|حيل)|تعذرنه|العذر منك|حقك علينا|مو قصدي|اعتذر منك هوايه', 'iraqi'),
  forms('apology', 'سمح ليا(?: تاخرت)?|سمحلي|سامحني (?:بزاف|برشه)|متاسف بزاف|سمح لي علي التاخير', 'maghrebi'),
  forms('apology', 'معليش(?: علي التاخير| اتاخرت)?|العفو منك|اعف مني', 'sudanese'),
  forms('apology', 'سامحنا|ما عليك زود سامحنا', 'yemeni'),

  forms('compliment', 'احسنت(?: العمل)?|عمل رائع|ردك (?:رائع|جميل|مفيد|ممتاز|مذهل)|اجابتك (?:رائعه|جميله|مفيده|ممتازه)|(?:انت )?(?:رائع|مذهل|مبدع|ممتاز|عبقري|فنان|مذهله|رائعه|مبدعه)|انت (?:مساعد )?(?:ذكي|ذكيه|لطيف|مفيد)(?: جدا)?|يعجبني (?:ردك|اسلوبك|شرحك)|اعجبني (?:ردك|اسلوبك|شرحك)|ما شاء الله عليك|اجدت|اتقنتها', 'msa'),
  forms('compliment', 'انت (?:جامد|جامده|شاطر|شاطر اوي|جامد اوي|زي الفل)|عاش(?: اوي)?|برافو(?: عليك)?|شرحك حلو اوي|حلو اوي', 'egyptian'),
  forms('compliment', 'كفو(?: عليك)?|مبدع والله|وحش يا موحسن|ردك رهيب|صح لسانك|شغلك وايد حلو', 'gulf'),
  forms('compliment', 'انت (?:كتير شاطر|شاطر كتير|رهيب)|شو انك شاطر|حكيك حلو|(?:عنجد )?شغلك حلو|يا سلام عليك|شرحك مرتب', 'levantine'),
  forms('compliment', 'انت (?:خوش مساعد|فد شي|مبدع حيل)|خوش (?:شغل|رد|شرح)|عاشت (?:ايدك|ايدج|ايدچ|ايديكم)(?: خوش شغل)?|شغلك مرتب|شرحك يخبل|شنو هالابداع', 'iraqi'),
  forms('compliment', 'راك (?:واعر|شاطر|قافز)(?: بزاف)?|انت (?:واعر|مزيان بزاف)|(?:جوابك|ردك) (?:واعر|زوين|مليح)|خدمتك (?:زوينه|مليحه)|خدمه مليحه|يعطيك الصحه جواب مزيان', 'maghrebi'),
  forms('compliment', 'انت زول (?:ممتاز|سمح)|انت فنان(?: يا زول)?|(?:كلامك|شرحك|شغلك) سمح(?: شديد)?', 'sudanese'),
  forms('compliment', '(?:شرحك|شغلك) زين|كلامك يشفي|انت ما قصرت ابدا', 'yemeni'),

  forms('farewell', 'مع السلامه|الي اللقاء|وداعا|في امان الله|في حفظ الله|نلتقي (?:لاحقا|قريبا|غدا)|اراك (?:لاحقا|قريبا|غدا)|اتمني لك يوما (?:طيبا|سعيدا)|يومك سعيد', 'msa'),
  forms('farewell', 'تصبح(?:ي|ون)? (?:علي|ع) خير|ليله سعيده|ليلتك سعيده', 'msa', 'night'),
  forms('farewell', 'يلا سلام|سلام بق[اي]|اشوفك بعدين|باي(?: باي)?', 'msa'),
  forms('farewell', 'نشوفك (?:بكره|بعدين|باچر|باجر)|معسلامه|الله وياك|الله معك|بالسلامه', 'msa'),
  forms('farewell', 'اشوفك بكره|سلام يا معلم', 'egyptian'),
  forms('farewell', 'في امانه الله|اشوفك (?:علي خير|عقب)|الله يحفظك مع السلامه', 'gulf'),
  forms('farewell', 'الله معك|(?:يلا )?منشوفك|بشوفك بعدين|الي اللقاء يا غالي', 'levantine'),
  forms('farewell', 'اشوفك (?:باچر|باجر)|الله وياك|في امان الله يالغالي', 'iraqi'),
  forms('farewell', 'بالسلامه|فامان الله|تلاقي على خير|نتهلاو|نتلاقاو (?:غدا|من بعد)|نشوفك من بعد', 'maghrebi'),
  forms('farewell', 'سلام يا زول|نشوفك علي خير|الله معاك', 'sudanese'),

  forms('wellbeing', 'كيف حالك(?: اليوم)?|كيف الحال|ما حالك|كيف (?:امورك|تسير امورك|احوالك|وضعك|صحتك|كان يومك|يومك)|ما اخبارك|اخبارك ايه|اخبارك|هل (?:انت )?بخير|كيفك(?: اليوم)?|كله تمام|امورك تمام|كيف الدنيا معك', 'msa'),
  forms('wellbeing', 'ازيك(?: النهارده| اليوم)?|ازيكم|عامل(?:ه|ين)? ايه(?: النهارده)?|اخبارك ايه|ايه الاخبار|طمني عليك', 'egyptian'),
  forms('wellbeing', 'وش (?:اخبارك|علومك)|وشلونك(?: اليوم)?|شخبارك(?: اليوم)?|شعلومك|علومك|عساك بخير|عساك طيب|بشر عنك', 'gulf'),
  forms('wellbeing', 'كيفك(?: هاليومين)?|كيفكن|شلونك يا غالي|طمني عنك(?:[،,] كيفك)?|شو (?:اخبارك|الاخبار|عامل|عامله|الجديد)|كيف (?:الامور|ماشي الحال)|كيف حالك هاليومين', 'levantine'),
  forms('wellbeing', 'ش(?:لون|لونن)(?:ك|ج|چ|كم)(?: اليوم| هاليوم(?:ين)?)?|شلون (?:الصحه|صحتك)(?: اليوم)?|شون(?:ك|ج|چ|كم)|شنو اخبارك|اشلونك|اشلونج|شكو ماكو|شخبارك هاليومين', 'iraqi'),
  forms('wellbeing', 'لاباس(?: عليك| عليكم)?|لا باس(?: عليك)?|كيداير(?:ه)?|كيف(?:اش)? داير(?:ه)?(?: اليوم)?|كيف (?:راهي|راهو) الحال|واش (?:راك|راكي|راكم|خبارك|لاباس)|اش خبارك|اش حوالك|شنو خبارك|شنوه احوالك|شنوا احوالك|شنيه احوالك|شنحوالك|احوالك', 'maghrebi'),
  forms('wellbeing', 'كيفنك(?: الليله| اليوم)?|كيف (?:انتا|انت|الحاصل)|عامل كيف|اخبارك شنو|كيف الاحوال يا زول|تمام يا زول', 'sudanese'),
  forms('wellbeing', 'كيف هنت|كيف انت اليوم|كيف حالك عساك بخير|كيف اصبحت', 'yemeni'),

  forms('identity', 'م(?:ن|ين) (?:انت|انتا)|(?:انت|انتا) (?:م(?:ن|ين)|منو|شكون|شنو|ايه|ايش|شو|وش)(?: بالضبط)?|(?:منو|شكون) (?:نتا|نتي|انت|انتا)|شكون نتا بالضبط|شو انت|شنو انت|ايش انت|وش انت|ما (?:انت|هويتك)|عرف (?:بنفسك|نفسك)|قدم نفسك|عرفني عليك|حدثني عن نفسك|قل لي عن نفسك', 'msa'),
  forms('identity', 'انت ياتو زول', 'sudanese'),
  forms('identity', '(?:ما|ماذا|وش|ايش|شو|شنو|شنوا) اسمك|اسمك (?:ايه|شنو)|كيف اناديك|شو بينادوك|اذكر اسمك(?: فقط)?|قل لي اسمك', 'msa', 'name'),
  forms('identity', '(?:شنو|اشنو) سميتك', 'maghrebi', 'name'),
  forms('identity', '(?:من|مين|منو|شكون) (?:صنعك|طورك|انشاك|برمجك|عملك|سواك|مبرمجك|صممك|صنع هذا التطبيق|طور هذا التطبيق)', 'msa', 'creator'),
  forms('identity', '(?:هل )?(?:انت )?(?:انسان(?: حقيقي)?|بشر|بشري|شخص حقيقي)|انت انسان ولا (?:روبوت|الي)', 'msa', 'human'),
  forms('identity', '(?:هل )?(?:انت )?(?:ذكاء اصطناعي|مساعد (?:الي|ذكي)|روبوت|بوت|برنامج)|انت (?:بوت|روبوت) ولا (?:انسان|بشر)', 'msa', 'ai'),

  forms('capabilities', 'ماذا (?:تستطيع|يمكنك|تقدر)(?: (?:ان )?(?:تفعله|تفعل|تعمل|تعمله|تقدمه))?(?: (?:لي|هنا))?|ما (?:الذي )?يمكنك (?:فعله|تقديمه)|ما (?:هي )?(?:قدراتك|امكانياتك|مهاراتك|وظيفتك)|كيف (?:يمكنك (?:ان )?|تقدر )?(?:تساعدني|تقدر تساعدني|مساعدتي)|بماذا يمكنك مساعدتي|ماذا تفعل|قل لي ماذا تستطيع ان تفعل|اذكر قدراتك|اعرض قدراتك', 'msa'),
  forms('capabilities', '(?:انت )?(?:ممكن|تقدر|بتقدر) (?:تعمل|تساعدني في) ايه|انت (?:بتعمل|بتعرف تعمل) ايه|ايه (?:امكانياتك|قدراتك|اللي ممكن تعمله)', 'egyptian'),
  forms('capabilities', '(?:وش|ايش) (?:تسوي|(?:تقدر|ممكن) (?:تسوي|تساعدني فيه)|تقدر عليه|خدماتك)|كيف تقدر تفيدني', 'gulf'),
  forms('capabilities', 'شو (?:بتعمل|فيك تعمل|بتقدر (?:تعمل|تساعدني فيه)|ممكن تعمل|بتعرف تعمل)|كيف فيك تساعدني|بشو (?:فيك|بتقدر) تساعدني', 'levantine'),
  forms('capabilities', '(?:شنو |ش)(?:تسوي|ت[كگق]در (?:تسوي|تساعدني(?: بيه)?)|ممكن تسوي)|بشنو تكدر تساعدني|شلون تكدر تساعدني|شگد تكدر تفيدني', 'iraqi'),
  forms('capabilities', '(?:اش|اشنو|شنو|واش) (?:ك?تقدر (?:دير|تدير|تعاونني فيه)|كتدير|تنجم تعمل|تعمل)|شنيه تنجم تعاونني|باش تنجم تعاوني|(?:فاش|باش|كيفاش) تقدر تعاو(?:نني|ني)', 'maghrebi'),
  forms('capabilities', 'بتقدر تعمل شنو|بتعمل شنو|(?:ممكن|بتقدر) تساعدني في شنو|شنو البتقدر تعملو', 'sudanese'),
  forms('capabilities', 'ايش (?:معك تسوي|تقدر تعينني فيه|تعمل لي)|ما الذي تقدر تعمله', 'yemeni'),

  forms('joke', '(?:(?:هل )?(?:يمكنك|تقدر|تكدر|ممكن) )?(?:احك(?:ي)?(?: لي|لي)?|تحك(?:ي)?(?: لي|لي)?|قل(?: لي|لي)?|تقول(?: لي|لي)?|قول(?: لي|لي|ي| ليا| لينا)?|هات(?: لي)?|اعطني|اعطيني|عطني|اخبرني|سمعني|گلي|القي)(?: (?:لي|لنا|شي))? نكته(?: (?:مضحكه|قصيره|خفيفه|نظيفه|حلوه|طريفه|ثانيه|اخري))?|نكته(?: لو سمحت)?|(?:خلني|خليني|خلينا) اضحك|(?:ضحكني|اضحكني)(?: شويه?)?|قول حاجه تضحك', 'msa'),
  forms('joke', '(?:عايز|عاوز|نسمع|ابغ[اي]|ابي|بدي|اريد|بغيت|اشتي)(?: اسمع| شي)? نكته|حكيلي شي نكته|نحب نسمع نكته|حچ(?:ي|يلي) نكته|احچي(?:لي| لي)? نكته|ادينا نكته', 'msa'),
  forms('joke', '(?:هل لديك|عندك|في عندك|اها عندك)(?: شي)? نكته(?: (?:تضحك|حلوه|مضحكه|طريفه|قصيره))?', 'msa'),
  forms('joke', 'قول لي نكته يا زول', 'sudanese'),

  forms('encouragement', '(?:بالتوفيق|موفق(?:ه)?|الله يوفقك|واصل(?: العمل)?|استمر(?: (?:هكذا|على هذا المنوال))?|تقدر عليها|انت قدها|اكمل العمل الجيد)', 'msa'),
  forms('encouragement', 'شجعني(?: (?:قليلا|شويه?))?|هل يمكنك تشجيعي(?: قليلا)?|حفزني|حمسني|(?:اعطني|اعطيني|اديني) (?:بعض التشجيع|دفعه معنويه|كلام يحفزني)|ارفع معنوياتي|احتاج (?:الي )?(?:التشجيع|دفعه معنويه)|ادع(?:ي)? ?لي بالتوفيق|تمن(?:ي)? لي (?:التوفيق|الحظ)|قول لي كلمه تشجيع', 'msa', 'encourage-me'),
  forms('encouragement', 'شجعني شويه? يا زول', 'sudanese', 'encourage-me'),
  forms('encouragement', 'دع(?:ي)? معايا بالتوفيق', 'maghrebi', 'encourage-me'),

  forms('insult', '(?:(?:انت|انتا) (?:مجرد )?|يا )?(?:غبي|غبيه|احمق|ابله|سخيف|تافه|فاشل|حمار|زباله|عديم الفائده)(?: جدا)?|يا غبي يا (?:احمق|حمار)|انت (?:ما تفهم|ما بتفهم|مش فاهم حاجه|مالك فايده)|اخرس|اسكت|انقلع|اغرب عن وجهي|روح انقلع|تب لك', 'msa'),
  forms('insult', 'انت (?:ما فاهم حاجه|غبي اوي|حمار اوي|عبيط|مالكش لازمه)|يا عبيط|يا اهبل|غور', 'egyptian'),
  forms('insult', 'انت (?:غبي حيل|غبي كلش|غبي هوايه|خبل)|يا خبل|انجب', 'iraqi'),
  forms('insult', 'راك (?:غبي|مكلخ|بليد)(?: بزاف)?|راك ما فاهم والو|انت (?:حمار بزاف|غبي بزاف)', 'maghrebi'),
  forms('insult', 'انت (?:غبي|فاشل) (?:يا زول|شديد)', 'sudanese'),

  forms('greeting', 'mar(?:h|7)ab?a(?: bik)?|ahlan(?: wa? ?sahlan)?|ahlein|ahleen|hala(?: walla)?|halla|halla wallah|ya hala|halawalla|hala wallah|halla w ghala|halo|hala beek', 'msa'),
  forms('greeting', "(?:(?:e|a)l ?|as ?)?sala?amu? (?:3a?|a)?l(?:a|e|ay|ei|ai)?(?:k|c)(?:om|um|oum|m)|w(?:a )?3alaykom (?:el)?salam|sala?am(?: 3likom)?", 'msa', 'peace'),
  forms('greeting', 'saba(?:7|h)(?: el| al)? (?:5|kh)air|saba7 el kheir|saba7 el fol', 'msa', 'morning'),
  forms('greeting', 'masa(?:2)?(?: el| al)? (?:5|kh)air|masa2 el kheir|masa el kheir', 'msa', 'evening'),
  forms('thanks', 'sh[ou]kr[ae]n(?: kti?r| kteer| awi| lak| jazeelan)?|choukr[ae]n(?: bzaf)?|thx ya zalameh|jazak allah khair(?:an)?|teslam(?:o| ya akhi)?|tislam|yislamo|mashk(?:oo|ou|u)r|merci bzaf|barak allah fik|ya3teek el 3afyeh', 'msa'),
  forms('thanks', 'y3teek el 3afyeh|yeslamo(?: kteer)?|shukran ktir', 'levantine'),
  forms('thanks', '3ashet (?:eedak|idk|eedich)|mamnoon(?: hawaya)?|mashkoor (?:7eel|hawaya)', 'iraqi'),
  forms('thanks', 'motshaker(?: awi)?|moutashakker|mersy awi', 'egyptian'),
  forms('thanks', 'sa7a|sahit|sahhit|y3aychek|chokran bezaf', 'maghrebi'),
  forms('apology', '(?:ana )?(?:asef|asif|2asef|2asif|asfa|2asfa)(?: gedan| awi| jidan)?|ma3lesh|ma3lich|ma3lish|ma3leesh|ma3lesh ya sidi|sama7ni|same7ni|3ozran', 'msa'),
  forms('apology', 'sme7 liya|sma7 lia|sma7li(?:ya)?|sme7li|smehli|sma7liya bzaf', 'maghrebi'),
  forms('compliment', '(?:enta|inta) (?:ra2e3|momtaaz|mumtaz|zak[yi]|sha?ter|shaater|gamid|gamed(?: awi)?)|ah[s9]ant|a7sant|kaf(?:ou|u)(?: 3al(?:e|ay|ei)k)?|khou?sh shoghol|rak wa3er|bravo 3alek|shar7ak 7elw', 'msa'),
  forms('farewell', "ma(?:3|a)(?:a)?(?: el| al)? sala(?:m|a)ah?|ma3 el salameh|ma3a salama|m3a slama|bslama|ila liqa2|yalla salam|fi aman allah|ashofak ba3dein", 'msa'),
  forms('farewell', 't[eio]sba7 3a(?:la)? (?:5|kh)(?:ai|ei|ay|e)r', 'msa', 'night'),
  forms('wellbeing', 'k(?:e|ee|ay|ai)f(?:ak|ik|ek|kom| 7alak| 7alek| halak| halek| el 7al| al hal)(?: elyom)?', 'msa'),
  forms('wellbeing', '(?:e|i)z+ay(?:ak|ek|ik|oko|yak|yek)|3amel eh|3amla eh|a5barak eh', 'egyptian'),
  forms('wellbeing', 'wesh a5barak|shakhbarak|shakhbark|sh5barak|3asak b5air', 'gulf'),
  forms('wellbeing', 'shu (?:a5barak|akhbarak|akhbarik)|keef el omour', 'levantine'),
  forms('wellbeing', "shl(?:o|oo|u)n(?:ak|ek|ik|ich|kom|k|j)(?: elyom)?|shlon el se77a|sh(?:a|e)?ko mako|shako maako", 'iraqi'),
  forms('wellbeing', "labas(?: 3li(?:k|kom))?|kida(?:yer|ir|yra)|kifach da(?:yer|ir)|kifech 7alek|(?:wach|wash) ra(?:k|ki|kom)|chno khbarek|chna7welek|chnia a7welek", 'maghrebi'),
  forms('wellbeing', 'keifinak|kefnak|3amel keif', 'sudanese'),
  forms('wellbeing', 'keif hent|kaif hint', 'yemeni'),
  forms('identity', '(?:meen|min|meno|mino|minu|shkoun|chkoun|shkun|shkon) (?:enta|inta|enti|nta|nti)|(?:enta|inta) (?:meen|min|meno|mino|minu)', 'msa'),
  forms('identity', '(?:shu|shou|shno|esh|eish) (?:ismak|esmak)|esmak eh|ismak eh', 'msa', 'name'),
  forms('capabilities', 't(?:e|i)2dar te3mel eh|(?:enta )?momken te3mel eh|(?:shu|shou) (?:fi+|fe+)k ta3mel|(?:shu|shou) bte2dar ta3mel|(?:esh|eish|wesh) t(?:e|i)(?:g|q)dar tsaw[ei]|shno (?:t(?:e|i)kdar tsaw[ei]|t9dar tsaw[ei])|sht(?:e|i)(?:2|g|k|9)dar tsaw[ei]|(?:chno|achno) t9der (?:tdir|dir)|chneya tnajem ta3mel', 'msa'),
  forms('joke', '(?:2ol(?:li|i| lee)?|e7ki(?:li| li)?|7kili|gooli|nheb|bghit|3andak) n[ou]ktah?|da7ekni', 'msa'),
  forms('encouragement', '(?:sha(?:gg|jj)[ae]3ni|7ammesni|7afezni)(?: shwa[yi])?|ed3ili bel tawf(?:ee|e|i|ay)2', 'msa', 'encourage-me'),
  forms('insult', '(?:enta |inta |ya )?(?:ghabi|8abi|7mar|a7maq|ahbal|habal|fash[eai]l)|oskot|enkale3|en2ale3', 'msa'),
  ...everydayEnglishSpeechActs,
] as const;

export const extendedSpeechActRules = [
  ...speechActRules,
  forms('identity', arabicHumanIdentity, 'msa', 'human'),
  forms('identity', arabicMachineIdentity, 'msa', 'ai'),
  forms('wellbeing', arabicWellbeing, 'msa'),
  ...englishIdentityInquiries,
];
