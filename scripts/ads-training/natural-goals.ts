/** Development-only natural sentence families, authored without final-assessment inputs. */
import { createHash } from 'node:crypto';
import { canonicalJson, rng } from './lib.js';
import { checkGoal, type Goal, type Currency } from './goal.js';
import { goalToPointer, pointerToGoal, renderGoalPointerPrompt, GOAL_POINTER_CAPABILITY } from './pointer.js';
import type { BilingualRow, Language } from './bilingual.js';

const PATTERNS = {
  en: {
    train: [
      'Hi, I run a {service} business in {places}. Could you create Google ads for {url}? My budget is {money} {period}, and I want {goal}.',
      'Please advertise {service} on Google. The site is {url}, we serve {places}, and can spend {money} {period}. The aim is {goal}.',
      'Our website is {url}. We offer {service} in {places} and need a search campaign to get {goal}. We have {money} {period} available.',
      'Can you help me get {goal} for my {service}? Set up Google Ads for {url} in {places} with {money} {period}.',
      'I own a {service} business. Launch a Google campaign for {url}, targeting {places}. Spend {money} {period} and focus on {goal}.',
      'For {url}, create a search campaign advertising {service}. Target customers in {places}. Budget: {money} {period}. Goal: {goal}.',
      'Hello! I would like {goal} through Google ads for {service} in {places}. Here is my website: {url}. I can afford {money} {period}.',
      'My business does {service}; the website is {url}. Make Google ads for customers around {places}. I need {goal}, with {money} {period} to spend.',
      'We want to start advertising {service} in {places}. Build a Google search campaign for {url}, using {money} {period}, to get {goal}.',
      'Please put {url} on Google Ads. It is a {service} business serving {places}. The budget is {money} {period} and we want {goal}.',
      'Could you promote {service} for me? Use Google Ads and the website {url}. People in {places} should see it. I want {goal} on a budget of {money} {period}.',
      'Let us launch search ads for {url}. We provide {service} in {places}; {goal} are the priority. Please keep spending to {money} {period}.',
      'I have {money} {period} for a Google campaign. Advertise {service} at {url} in {places}; the goal is {goal}.',
      'I need {goal}, so please make Google ads. My service is {service}, my site is {url}, and my target area is {places}. Budget {money} {period}.',
      'Set up a campaign on Google for our {service} service, {url}. Cover {places}, with {money} {period}. We are looking for {goal}.',
      'The business is {service}, based in {places}. We use {url}. Can you prepare Google search ads? The goal is {goal} and the budget is {money} {period}.',
    ],
    validation: [
      'I am looking for someone to prepare Google advertising for {url}. We sell {service} in {places}. Please aim for {goal} with {money} {period}.',
      'Would you arrange a paid search campaign for my {service} business? The address is {url}; customers are in {places}. I want {goal} and have {money} {period}.',
      'Let us get advertising underway on Google: {service}, {url}, target {places}, budget {money} {period}, objective {goal}.',
      'Please prepare the Google Ads campaign for us. We do {service}, use the site {url}, and cover {places}. Allocate {money} {period} to bring {goal}.',
    ],
  },
  ar: {
    train: [
      'مرحبا، عندي نشاط {service} في {places}. ممكن تعمل إعلانات جوجل لموقع {url}؟ ميزانيتي {money} {period} وهدفي {goal}.',
      'بدي أعلن عن {service} على جوجل. موقعي {url} وأستهدف {places}. معي {money} {period} وأريد {goal}.',
      'موقعنا هو {url}. نقدم {service} في {places} ونحتاج حملة بحث للحصول على {goal}. الميزانية {money} {period}.',
      'أبغى حملة جوجل لخدمة {service}. الرابط {url} والمنطقة {places}. خصص {money} {period} والهدف {goal}.',
      'أنا عندي {service} وأشتغل في {places}. سوي لي إعلانات لموقع {url} بميزانية {money} {period} حتى أحصل على {goal}.',
      'من فضلك أنشئ إعلانات بحث لخدمة {service} على الموقع {url}. استهدف {places} بميزانية {money} {period} للحصول على {goal}.',
      'عايز أعمل حملة جوجل لموقع {url}، نشاطي {service} في {places}. أقدر أدفع {money} {period} والهدف {goal}.',
      'نريد الترويج لنشاط {service} في {places} عبر Google Ads. الموقع {url}، الميزانية {money} {period}، والغاية {goal}.',
      'جهز إعلانات للموقع {url} على جوجل. الخدمة {service} ونغطي {places}. نريد {goal} ولدينا {money} {period}.',
      'عندي ميزانية {money} {period} لحملة إعلانات. روّج لخدمة {service} في {places} على جوجل، الموقع {url}، والهدف {goal}.',
      'ممكن تساعدني بحملة بحث؟ أقدم {service} في {places} وهذا موقعي {url}. أحتاج {goal} والميزانية {money} {period}.',
      'حابب أبدأ إعلان جوجل لنشاط {service}. العملاء في {places} والرابط {url}. أخصص {money} {period} وأرغب في {goal}.',
      'أريد {goal} لموقعي {url}. أنشئ حملة Google لخدمة {service} في {places}، بحد {money} {period}.',
      'لو سمحت اعمل إعلان لموقع {url}. نحن نقدم {service} ونستهدف {places}. ميزانية الإعلان {money} {period} ونريد {goal}.',
      'ساعدنا في إنشاء حملة بحث على جوجل لنشاط {service} في {places}. موقعنا {url} ونخصص {money} {period} لجلب {goal}.',
      'الهدف {goal}. جهز حملة إعلانية لخدمة {service} وموقعها {url}، موجهة إلى {places} بميزانية {money} {period}.',
    ],
    validation: [
      'هل يمكنك ترتيب حملة بحث للموقع {url}؟ النشاط {service} والجمهور في {places}. الميزانية {money} {period} ونرغب في {goal}.',
      'أبحث عن مساعدة لإطلاق إعلانات على Google لخدمة {service}. الموقع {url} ونستهدف {places}. خصصت {money} {period} والهدف {goal}.',
      'نود البدء بإعلانات جوجل لنشاط {service} في {places}. لدينا الموقع {url} وميزانية {money} {period}. نأمل الحصول على {goal}.',
      'من الممكن تجهيز حملة بحث لنا؟ موقعنا {url} والخدمة {service} في {places}. نحتاج {goal} مقابل ميزانية {money} {period}.',
    ],
  },
};
const SERVICES = {
  en: ['mobile tyre fitting', 'house cleaning', 'furniture removals', 'plumbing', 'barber shop', 'car repairs', 'music lessons', 'web development', 'dental care', 'gardening', 'wedding photography', 'window repairs', 'computer support', 'language courses', 'food delivery', 'home care', 'carpet fitting', 'pet grooming', 'personal training', 'kitchen installation', 'phone repairs', 'office cleaning', 'cake delivery', 'pest control', 'accounting services', 'roof maintenance', 'taxi service', 'beauty salon'],
  ar: ['تركيب الإطارات', 'تنظيف المنازل', 'نقل الأثاث', 'خدمات السباكة', 'صالون حلاقة', 'إصلاح السيارات', 'دروس الموسيقى', 'تطوير المواقع', 'العناية بالأسنان', 'تنسيق الحدائق', 'تصوير الزفاف', 'إصلاح النوافذ', 'الدعم التقني', 'دورات اللغات', 'توصيل الطعام', 'الرعاية المنزلية', 'تركيب السجاد', 'رعاية الحيوانات', 'التدريب الشخصي', 'تركيب المطابخ', 'إصلاح الهواتف', 'تنظيف المكاتب', 'توصيل الكعك', 'مكافحة الحشرات', 'خدمات المحاسبة', 'صيانة الأسقف', 'خدمة سيارات الأجرة', 'صالون تجميل'],
};
const PLACES = { en: ['Glasgow', 'Leeds', 'Manchester', 'London', 'Oxford', 'Cambridge', 'Dubai', 'Riyadh', 'Amman', 'Cairo', 'Toronto', 'Sydney'], ar: ['غلاسكو', 'ليدز', 'مانشستر', 'لندن', 'أكسفورد', 'كامبريدج', 'دبي', 'الرياض', 'عمان', 'القاهرة', 'تورونتو', 'سيدني'] };

export function naturalGoals(count: number, split: 'train' | 'validation', seed: number): BilingualRow[] {
  const random = rng(seed), result: BilingualRow[] = [], seen = new Set<string>();
  while (result.length < count) {
    const language: Language = result.length % 2 ? 'ar' : 'en', ar = language === 'ar';
    const service = random.pick(SERVICES[language]), locations = random.sample(PLACES[language], random.next() < 0.3 ? 2 : 1);
    const url = random.pick(['https://', 'www.', '']) + random.pick(['clear', 'bright', 'new', 'local', 'green']) + random.pick(['care', 'works', 'shop', 'team']) + random.int(9999) + random.pick(['.com', '.co.uk', '.ae', '.org']);
    const amount = String(random.int(300) + 10), period = random.pick(['day', 'week', 'month'] as const), goal = random.pick(['calls', 'bookings', 'leads'] as const);
    const currency = random.pick<Currency>(ar ? ['£', '$', 'SAR', 'AED'] : ['£', '$', '€']);
    const printedAmount = ar && random.next() < 0.5 ? amount.replace(/\d/g, d => String.fromCharCode(0x660 + Number(d))) : amount;
    const money = currency === 'SAR' ? `${printedAmount} ريال سعودي` : currency === 'AED' ? `${printedAmount} درهم إماراتي` : `${currency}${printedAmount}`;
    const periodText = ar ? { day: 'يوميا', week: 'أسبوعيا', month: 'شهريا' }[period] : { day: 'per day', week: 'per week', month: 'per month' }[period];
    const goalText = ar ? { calls: 'مكالمات هاتفية', bookings: 'حجوزات', leads: 'طلبات تواصل' }[goal] : { calls: 'phone calls', bookings: 'bookings', leads: 'leads' }[goal];
    const variants = PATTERNS[language][split], patternIndex = random.int(variants.length);
    const values: Record<string, string> = { service, places: locations.join(ar ? ' و ' : ' and '), url, money, period: periodText, goal: goalText };
    const message = variants[patternIndex]!.replace(/\{(\w+)\}/g, (_, key: string) => values[key]!);
    const output: Goal = { intent: 'create_campaign', url, service, locations, budget: { amount, currency, period }, goal };
    const target = goalToPointer(message, output), back = target ? pointerToGoal(message, target) : null;
    const issues = checkGoal(message, output);
    if (!target || !back || canonicalJson(back) !== canonicalJson(output) || issues.length) throw new Error(`Natural label invalid: ${issues.join(',')} ${message}`);
    const id = createHash('sha256').update(message).digest('hex').slice(0, 24); if (seen.has(id)) continue;
    seen.add(id); result.push({ id, capability: GOAL_POINTER_CAPABILITY, language, family: `natural-${split}-${language}-${patternIndex}`, split, source: 'synthetic', input: { message }, output, prompt: renderGoalPointerPrompt(message), target });
  }
  return result;
}
