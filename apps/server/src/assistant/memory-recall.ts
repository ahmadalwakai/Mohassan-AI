type FieldType = 'number' | 'string';
export type MemoryRecallFormat = { kind: 'value' } | {
  kind: 'json';
  keys?: readonly string[];
  fieldTypes?: Readonly<Record<string, FieldType>>;
};

const MAX_REPLY = 4096;
const MAX_SCALAR = 120;
const MAX_FIELDS = 8;
const MAX_LEADING_TEXT = 600;
const KEY = /^[\p{L}\p{N}_][\p{L}\p{M}\p{N} _-]{0,63}$/u;
const QUOTED = /"[^"\r\n]*"|“[^”\r\n]*”|«[^»\r\n]*»|‘[^’\r\n]*’|\x60[^\x60\r\n]*\x60|(?<![\p{L}\p{N}])'[^'\r\n]*'(?![\p{L}\p{N}])/gu;
const ARABIC_RECALL = /^(?:(?:من فضلك|لو سمحت|رجاء)[،,\s]+)?(?:(?:ابحث|فتش|استرجع|استخرج|راجع|ذكرني)\s+(?:لي\s+)?(?:في|من)\s+(?:ذاكرتي|الذاكرة المحفوظة)|(?:ارجع|عد)\s+الى\s+ذاكرتي|(?:من|في)\s+ذاكرتي|(?:ما|ماذا)\s+[^.!?؟؛\r\n]{1,120}\s+(?:في|من)\s+ذاكرتي)(?![\p{L}\p{M}])/u;
const ENGLISH_RECALL = /^(?:please[,\s]+)?(?:(?:search|look up|look in)\s+(?:(?:in|through)\s+)?my (?:saved )?memor(?:y|ies)|(?:recall )?from my (?:saved )?memor(?:y|ies)|(?:what|which)\b[^.!?\r\n]{1,120}\bin my (?:saved )?memor(?:y|ies))\b/i;
const ARABIC_MIXED = /(?:^|[.!?؟؛،,\r\n]\s*|\s+(?:ثم\s+|[وف]\s*))(?:(?:احفظ|خزن|سجل|اضف|عدل|غير|احذف|امسح|حدث|انشر|نفذ|افتح|اغلق|انقر|اضغط|اشرح|لخص)(?![\p{L}\p{M}])|ارسل[^.!?؟؛،\r\n]{0,80}\s+الى|ابحث\s+(?:في|على)\s+(?:الويب|الانترنت))/u;
const ENGLISH_MIXED = /(?:^|[.!?;,\r\n]\s*|\b(?:and|then|also)\s+)(?:(?:save|store|remember|update|change|add|delete|remove|email|post|publish|open|click|execute|run|explain|summarize)\b|send[^.!?;\r\n]{0,80}\bto\b|search (?:the web|the internet))/i;
const JSON_REQUEST = /(?:\b(?:return|reply|respond|output|give|write)\b[^.!?؟؛\r\n]{0,80}\bjson\b|\bjson\s+only\b|(?<!\p{L})(?:و?(?:اجب|اعد|اكتب|ارجع|اعطني|اطبع|قدم|اريد|بصيغة|بتنسيق)|على شكل|كائن)\s+[^.!?؟؛\r\n]{0,80}\bjson\b|\bjson\s+فقط(?!\p{L}))/iu;
const ARABIC_VALUE = /(?<!\p{L})(?:و?(?:اجب|اعد|اكتب|ارجع|اذكر|اعطني|اطبع|قدم|قل|انسخ|اريد)\s+[^.!?؟؛،\r\n]{0,100}(?:فقط|وحدها?|لا غير|كما (?:هو|هي)|دون (?:شرح|اضافة|مقدمة)|بلا شرح)|(?:الاسم|الرقم|الرمز|اللون|القيمة|الوقت)\s+فقط)(?![\p{L}\p{M}])/u;
const ENGLISH_VALUE = /\b(?:return|reply|respond|output|give|write|tell me|copy)\b[^.!?;\r\n]{0,100}\b(?:only|just|verbatim|nothing else)\b|\b(?:name|number|code|color|colour|value|time) only\b/i;

/** Keep the decision envelope while making a JSON recall use structured fields. */
export function structuredMemoryDecisionSchema(base: Record<string, unknown>): Record<string, unknown> {
  return {
    ...base,
    properties: {
      ...base.properties as Record<string, unknown>,
      tool: { type: 'string', enum: ['answer'] },
      text: {
        type: 'array', minItems: 1, maxItems: MAX_FIELDS,
        items: {
          type: 'object', additionalProperties: false, required: ['key', 'value'],
          properties: {
            key: { type: 'string', minLength: 1, maxLength: 64 },
            value: { anyOf: [{ type: 'string', minLength: 1, maxLength: MAX_SCALAR }, { type: 'number' }] },
          },
        },
      },
    },
  };
}

/** Translate provider-constrained fields into the ordinary decision's answer text. */
export function decodeStructuredMemoryDecision(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('tool' in value) || value.tool !== 'answer'
    || !('text' in value) || !Array.isArray(value.text) || !value.text.length || value.text.length > MAX_FIELDS) return null;

  const fields = new Map<string, string | number>();
  for (const field of value.text as unknown[]) {
    if (!field || typeof field !== 'object' || Array.isArray(field) || Object.keys(field).length !== 2
      || !('key' in field) || typeof field.key !== 'string' || !KEY.test(field.key) || fields.has(field.key)
      || !('value' in field)) return null;
    const scalar = memoryScalar(field.value);
    if (scalar === null) return null;
    fields.set(field.key, scalar);
  }
  return { ...value, text: JSON.stringify(Object.fromEntries(fields)) };
}

function quotedFields(request: string): Pick<Extract<MemoryRecallFormat, { kind: 'json' }>, 'keys' | 'fieldTypes'> | undefined {
  const json = [...request.matchAll(/\bjson\b/gi)].at(-1);
  if (!json) return undefined;
  const afterJson = request.slice(json.index + json[0].length);
  const label = /\b(?:keys?|fields?|properties)\b|(?<!\p{L})ب?(?:ال)?(?:مفاتيح|مفتاح(?:ين|ان)?|حقول|حقل(?:ين|ان)?|خصائص)(?!\p{L})/iu.exec(afterJson);
  if (!label) return undefined;

  const clause = afterJson.slice(label.index + label[0].length).split(/[.!?؟؛\r\n]/u, 1)[0]!;
  const matches = [...clause.matchAll(QUOTED)];
  const keys = matches.map(match => match[0].slice(1, -1));
  if (!keys.length || keys.length > MAX_FIELDS || keys.some(key => !KEY.test(key))) return undefined;
  const fieldTypes = new Map<string, FieldType>();
  for (const [index, match] of matches.entries()) {
    const hint = clause.slice(match.index + match[0].length, matches[index + 1]?.index);
    if (/\b(?:as (?:a )?(?:number|integer)|numeric)\b|(?:عددي|رقمي|رقمًا|عدد صحيح)(?!\p{L})/iu.test(hint)) {
      fieldTypes.set(keys[index]!, 'number');
    } else if (/\b(?:as (?:a )?(?:string|text)|textual)\b|(?:نصي|نصًا|كنص)(?!\p{L})/iu.test(hint)) {
      fieldTypes.set(keys[index]!, 'string');
    }
  }
  return { keys, ...(fieldTypes.size ? { fieldTypes: Object.fromEntries(fieldTypes) } : {}) };
}

/** Opt in only for an explicit lookup and an explicit output format. */
export function memoryRecallFormat(request: string): MemoryRecallFormat | null {
  const intent = request.replace(QUOTED, ' ').normalize('NFKC')
    .replace(/[\u0640\u064b-\u065f\u0670]/gu, '').replace(/[أإآٱ]/gu, 'ا').trim();
  if ((!ARABIC_RECALL.test(intent) && !ENGLISH_RECALL.test(intent))
    || ARABIC_MIXED.test(intent) || ENGLISH_MIXED.test(intent)) return null;
  if (JSON_REQUEST.test(intent)) {
    return { kind: 'json', ...quotedFields(request) };
  }
  return ARABIC_VALUE.test(intent) || ENGLISH_VALUE.test(intent) ? { kind: 'value' } : null;
}

function normalizeValue(value: string): string {
  return value.normalize('NFC').replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) % 16));
}

function leadingText(note: string): string {
  // Later sentences and lines cannot support a reply. Keep decimal points intact.
  const bounded = normalizeValue(note.trimStart().slice(0, MAX_LEADING_TEXT + 1));
  const leading = bounded.split(/[\r\n\u0085\u2028\u2029!?؟。؛;]|(?<!\d)\.|\.(?!\d)/u, 1)[0]!.trim();
  return leading.length <= MAX_LEADING_TEXT ? leading : '';
}

const WORD = String.raw`[\p{L}\p{M}\p{N}]+(?:[.'’_@+#/-][\p{L}\p{M}\p{N}]+)*`;
const SCALAR = new RegExp(String.raw`^(?:${WORD}(?: ${WORD}){0,7}|[+-]?\d+(?:\.\d+)?[%٪]?|\d{1,2}:\d{2}(?::\d{2})?)$`, 'u');
const TOKEN = String.raw`[\p{L}\p{M}\p{N}._@#'’/+%٪\-]`;

function hasSpan(source: string, value: string): boolean {
  const literal = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = new RegExp(String.raw`(?<!${TOKEN})(?<!\d:)${literal}(?!${TOKEN}|:\d)`, 'u');
  return boundary.test(source);
}

function scalarText(value: string): string | null {
  const scalar = normalizeValue(value.trim());
  return !/[\r\n\u0085\u2028\u2029]/u.test(value) && scalar.length <= MAX_SCALAR && SCALAR.test(scalar) ? scalar : null;
}

function memoryScalar(value: unknown): string | number | null {
  if (typeof value === 'string') return scalarText(value);
  if (typeof value !== 'number' || !Number.isFinite(value)
    || (Number.isInteger(value) && !Number.isSafeInteger(value))) return null;
  return scalarText(String(value)) ? value : null;
}

function jsonFields(text: string): [string, unknown][] | null {
  const trimmed = text.trim();
  const fence = /^\x60{3}(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n\x60{3}$/iu.exec(trimmed);
  const body = fence?.[1] ?? trimmed;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const fields = Object.entries(parsed);
  if (!fields.length || fields.length > MAX_FIELDS) return null;
  // JSON.parse discards duplicate keys. Count the original key tokens so they cannot be hidden.
  const keyCount = [...body.matchAll(/"(?:[^"\\]|\\.)*"\s*(:)?/gs)].filter(token => token[1]).length;
  return keyCount === fields.length ? fields : null;
}

/** Verify bounded textual support, without inferring which free-form claims are true. */
export function verifyMemoryRecall(text: string, format: MemoryRecallFormat, evidence: readonly string[]): string | null {
  if (text.length > MAX_REPLY) return null;
  const sources = evidence.map(leadingText).filter(Boolean);
  if (format.kind === 'value') {
    const scalar = scalarText(text);
    return scalar && sources.some(source => hasSpan(source, scalar)) ? scalar : null;
  }
  const fields = jsonFields(text);
  if (!fields) return null;
  const { keys } = format;
  if (keys && (new Set(keys).size !== fields.length
    || keys.length !== fields.length || fields.some(([key]) => !keys.includes(key)))) return null;

  const verified = new Map<string, string | number>();
  for (const [key, value] of fields) {
    if (!KEY.test(key)) return null;
    const scalar = memoryScalar(value);
    // Unspecified keys must be supported by the same source as their values.
    if (scalar === null || !sources.some(source => hasSpan(source, String(scalar))
      && (keys !== undefined || hasSpan(source, normalizeValue(key))))) return null;
    const explicitType = Object.hasOwn(format.fieldTypes ?? {}, key) ? format.fieldTypes?.[key] : undefined;
    const quantityField = /^(?:count|quantity|total_count|العدد|عدد|الكمية|كمية)$/iu.test(key);
    const numeric = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(String(scalar));
    if (explicitType === 'string') {
      verified.set(key, String(scalar));
    } else if (explicitType === 'number' || quantityField && numeric) {
      if (!numeric) return null;
      const number = memoryScalar(Number(scalar));
      if (typeof number !== 'number') return null;
      verified.set(key, number);
    } else {
      verified.set(key, scalar);
    }
  }
  const outputKeys = keys ?? [...verified.keys()].sort();
  return JSON.stringify(Object.fromEntries(outputKeys.map(key => [key, verified.get(key)])));
}
