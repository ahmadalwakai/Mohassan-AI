export interface InventoryProject {
  id: string;
  name: string;
}

type InventoryField = { key: string; source: keyof InventoryProject };

export type ProjectInventoryFormat =
  | { kind: 'names' }
  | { kind: 'json'; shape: 'names' | 'array' | 'object'; fields: readonly InventoryField[] };

const LIST_REQUEST = /^(?:(?:please|من فضلك|لو سمحت|رجاء)[\s،,]+)?(?:list\b|show\b|display\b|give me\b|provide\b|what are\b|(?:a |the )?(?:read[- ]only )?inventory\b|(?:اعرض|استعرض|اسرد|اذكر|اعدد|اعطني|ارني|قدم|اكتب|اطبع|اجر\s+جردا?|جردا?|قائمة|ما)(?=\s|[،:]))/iu;
const CODING_PROJECT = /\b(?:coding|programming|software|code)\s+projects?\b|(?:المشاريع|مشاريع|المشروعات|مشروعات|المشروع|مشروع)\s+(?:البرمجية|البرمجي|البرمجة|برمجية|برمجي|برمجة)/iu;
const NEGATIVE_TAIL = /(?:[,،;؛.!]\s*|\s+)(?:without\b|do not\b|don['’]t\b|no\b|من دون\s|بدون\s|دون\s|بلا\s|لا\s)(?=[^.!?؟;؛\r\n]*?(?:\b(?:chang\w*|edit\w*|modif\w*|creat\w*|open\w*|run\w*|writ\w*|updat\w*|action\w*)\b|تعديل|تعدل|تغيير|تغير|انشاء|تنشئ|فتح|تفتح|تنفيذ|تنفذ|تشغيل|تشغل))[^.!?؟;؛\r\n]*(?=[.!?؟;؛\r\n]|$)/giu;
const MIXED_ACTION = /\b(?:change|edit|modify|create|open|run|write|update|delete|archive|commit|push|deploy|clone|summarize|search|find|build|fix|rename|implement|approve|review|check|analy[sz]e|explain)\b|(?:^|[\s،,])(?:و\s*)?(?:عدل|تعديل|غير|تغيير|انشئ|انشاء|افتح|فتح|نفذ|تنفيذ|شغل|تشغيل|احذف|حذف|انشر|لخص|ابحث|اصلح|اصلاح|احفظ|اشرح|راجع|افحص|حلل|اختبر)(?=[\s،,.؛;!?؟:]|$)/iu;
const ADDITIONAL_REQUEST = /(?:\b(?:and|then|but)\s+(?:also\s+|please\s+)?|[,،]\s*)(?:\b(?:change|edit|modify|create|open|run|write|update|delete|build|fix|tell me|show|list|give me|what|where|when)\b)|(?:\s+و\s*|ثم\s+|لكن\s+|[،,]\s*)(?:عدل|غير|انشئ|افتح|نفذ|شغل|احذف|انشر|لخص|ابحث|اصلح|احفظ|اشرح|راجع|افحص|حلل|اختبر|اعرض|اخبرني)(?=\s|[،:])/iu;
const OUTPUT_CLAUSE = /^(?:(?:return|output|respond with|answer with|format as|use|give|as)\b|(?:اعد|اعرض|ارجع|اخرج|اكتب|اجب|بصيغة|بهيئة|فقط)(?=\s|[،:])|json\b|(?:كائن|مصفوفة|الاسماء|الاسم|اسماء)(?=\s|[،:]))/iu;
const NAMES_ONLY = /\b(?:project\s+)?names?\s+(?:only|alone)\b|\bonly\s+(?:the\s+)?(?:project\s+)?names?\b|(?:الاسماء|الاسم|اسماءها|اسماء|اسمها|اسم)(?:\s+(?:المشاريع|مشاريع|المشروعات|مشروعات|المشروع|مشروع|البرمجية|البرمجي|البرمجة|المسجلة|المسجل))*\s+(?:فقط|وحدها|وحده)(?=\s|[،,.:!?؟]|$)|فقط\s+(?:الاسماء|الاسم|اسماء|اسم)(?=\s|[،.:!?؟]|$)/iu;
const OBJECT = /\bjson\s+object\b|\bobject\s+json\b|كائن\s+(?:بصيغة\s+)?json\b|\bjson\s+كائن/u;
const ARRAY = /\bjson\s+array\b|\barray\s+(?:in\s+)?json\b|مصفوفة\s+(?:بصيغة\s+)?json\b|\bjson\s+مصفوفة/u;
const NAME_ARRAY = /\barray\s+of\s+(?:the\s+)?(?:project\s+)?names\b|مصفوفة\s+(?:json\s+)?(?:من\s+)?(?:الاسماء|اسماء)(?=\s|[،.:!?؟]|$)/u;
const FIELD_DECLARATION = /\b(?:keys?|fields?|properties)\b|(?:بمفتاح(?:ين|ي)?|بالمفتاحين|المفاتيح|مفتاح(?:ين|ي)?|بحق(?:ل|لين|ول)|الحقول)(?=\s|[:،,])/iu;
const FIELD_NAME = /(?:project[\s_-]*(?:name|id|identifier)|name|title|id|identifier)\b|(?:الاسم|اسم|المعر[ّ]?ف|معر[ّ]?ف)(?:[\s_-]+(?:المشروع|مشروع))?/giu;
const QUOTED_FIELD = /["'`«“‘]([^"'`»”’]+)["'`»”’]/gu;
const LIST_QUALIFIER = /\b(?:as shown in the list|as listed|for each project)\b|كما\s+(?:يظهر|تظهر|ورد|يرد|ترد|هي)\s+في\s+(?:القائمة|القائمه)|لكل مشروع/giu;

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '').replace(/[أإآٱ]/gu, 'ا').toLowerCase();
}

function fieldsAfter(declaration: string): InventoryField[] | null {
  const quoted = [...declaration.matchAll(QUOTED_FIELD)].map(match => match[1]!.trim());
  const fields = quoted.length ? quoted : [...declaration.matchAll(FIELD_NAME)].map(match => match[0]);
  const remainder = normalize(declaration.replace(quoted.length ? QUOTED_FIELD : FIELD_NAME, ''))
    .replace(LIST_QUALIFIER, '').replace(/\b(?:and|only|exactly|respectively)\b|فقط|بالترتيب/giu, '')
    .replace(/[\sو.,،:;؛!?؟(){}\[\]]/gu, '');
  if (remainder || !fields.length || fields.length > 2) return null;

  const mapped: InventoryField[] = [];
  for (const key of fields) {
    const alias = normalize(key).replace(/[\s_-]/gu, '');
    const source = /^(?:project)?(?:name|title)$|^(?:الاسم|اسم)(?:المشروع|مشروع)?$/u.test(alias) ? 'name'
      : /^(?:project)?(?:id|identifier)$|^(?:المعرف|معرف)(?:المشروع|مشروع)?$/u.test(alias) ? 'id' : null;
    if (!source || mapped.some(field => field.source === source)) return null;
    mapped.push({ key, source });
  }
  return mapped;
}

/** Only take over a standalone, explicitly formatted request for coding-project metadata. */
export function projectInventoryFormat(request: string): ProjectInventoryFormat | null {
  const source = request.trim().replace(NEGATIVE_TAIL, clause => ADDITIONAL_REQUEST.test(normalize(clause)) ? clause : '');
  const normalized = normalize(source);
  const [first, ...rest] = normalized.split(/(?<=[.!?؟;؛])\s+|[\r\n]+/u).map(clause => clause.trim()).filter(clause => /[\p{L}\p{N}]/u.test(clause));
  if (!first || !LIST_REQUEST.test(first) || !CODING_PROJECT.test(first)
      || MIXED_ACTION.test(normalized) || ADDITIONAL_REQUEST.test(normalized)
      || rest.some(clause => !OUTPUT_CLAUSE.test(clause) || !(/\bjson\b/u.test(clause) || NAMES_ONLY.test(clause) || FIELD_DECLARATION.test(clause)))) return null;
  const namesOnly = NAMES_ONLY.test(normalized);
  const json = /\bjson\b/u.test(normalized);
  if (!json) return namesOnly ? { kind: 'names' } : null;

  const shape = ARRAY.test(normalized) ? 'array' : OBJECT.test(normalized) ? 'object' : 'array';
  const declaration = FIELD_DECLARATION.exec(source) ?? /\bjson\s+(?:object|array)\s+with\b/iu.exec(source);
  const fields = declaration ? fieldsAfter(source.slice(declaration.index + declaration[0].length))
    : namesOnly ? [{ key: 'name', source: 'name' as const }] : [{ key: 'name', source: 'name' as const }, { key: 'id', source: 'id' as const }];
  if (!fields) return null;
  if (shape === 'array' && (NAME_ARRAY.test(normalized) || namesOnly && !declaration)) return { kind: 'json', shape: 'names', fields: [] };
  return { kind: 'json', shape, fields };
}

export function renderProjectInventory(projects: readonly InventoryProject[], format: ProjectInventoryFormat): string {
  if (format.kind === 'names') return projects.length ? projects.map(project => project.name).join('\n') : 'لا توجد مشاريع برمجية مسجلة.';
  if (format.shape === 'names') return JSON.stringify(projects.map(project => project.name));
  if (format.shape === 'object' && projects.length !== 1) throw new RangeError('Project inventory object requires exactly one project.');
  const entries = projects.map(project => Object.fromEntries(format.fields.map(({ key, source }) => [key, project[source]])));
  return JSON.stringify(format.shape === 'object' ? entries[0] : entries);
}
