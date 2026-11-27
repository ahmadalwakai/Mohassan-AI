export const PIPELINE = 'pipeline';
export const WEB_SEARCH = 'web-search';

// Names used in production by the council at 29448ae, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/model-council.ts
const LABELS = new Map([
  [PIPELINE, 'المحرك (القواعد والصفحات)'],
  [WEB_SEARCH, 'البحث في الويب'],
  ['chat-v5', 'نموذج المحادثة v5'],
  ['chat-v4', 'نموذج المحادثة v4'],
  ['reading-v3-last', 'نموذج القراءة v3'],
  ['reading-v4-hn-last', 'نموذج القراءة v4'],
  ['arithmetic', 'نموذج الحساب'],
  ['refusal', 'مصنّف الرفض'],
  ['scratch-refusal', 'مصنّف الرفض الصغير'],
  ['scratch-speech-act', 'مصنّف نوع الكلام'],
  ['scratch-route', 'الموجّه الصغير'],
  ['scratch-follow-up', 'مصنّف المتابعة'],
  ['router-b0', 'الموجّه B0'],
  ['router-b2', 'الموجّه B2'],
  ['question-edit', 'رأس إعادة صياغة السؤال'],
  ['head-sufficiency', 'رأس كفاية الأدلة'],
  ['head-answer-sentence', 'رأس جملة الجواب'],
  ['ocr', 'قارئ الصور'],
]);

export function councilMemberLabel(id: string): string {
  return LABELS.get(id) ?? id;
}
