const englishCommand = String.raw`(?:run|work|continue|do)(?: (?:on )?(?:this|it))?`;
const arabicCommand = String.raw`(?:اعمل|اشتغل|نف[ذّ]+|تابع)(?: (?:المهمة|العمل|عليها))?`;
const direction = String.raw`(?:in (?:the )?background|(?:في |ب)الخلفي[ةه])`;
const notifyEnglish = String.raw`notify (?:me|us) when (?:it(?:['’]s| is) (?:done|finished|complete)|you(?:['’]re| are) (?:done|finished))`;
const notifyArabic = String.raw`(?:نبهني|بلغني|أخبرني) (?:عند الانتهاء|عندما تنتهي)`;
const prefix = new RegExp(String.raw`^(?:(?:please|kindly|من فضلك|لو سمحت)[,،\s]+)?(?:(?:${englishCommand}|${arabicCommand}) )?${direction}\s*(?:[:：,.،]|\band\b|ثم|\s)\s*`, 'iu');
const suffix = new RegExp(String.raw`[\s,،.!]+(?:(?:and\s+)?${englishCommand}\s+|و?${arabicCommand}\s+)?${direction}(?:[\s,،]+(?:(?:and )?${notifyEnglish}|و?${notifyArabic}))?[.!؟?\s]*$`, 'iu');

// Scheduling directions do not belong in the concrete task passed to its adapter.
export function backgroundTaskText(text: string): { task: string; requested: boolean } {
  const task = text.replace(prefix, '').replace(suffix, '').trim();
  return { task, requested: task !== text.trim() };
}
