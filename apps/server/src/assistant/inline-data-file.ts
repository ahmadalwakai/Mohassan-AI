import { matchText, stripCourtesyTail } from './mind/normalize.js';
import { requestScopeActionText } from './request-scope.js';

const LEAD = /^(?:(?:please|kindly|من فضلك|لو سمحت)[,،\s]+)?(?:(?:could|can|would) you\s+)?(?:convert|turn|format|write|make|create|generate|produce|return|output|render|provide|give me|show me|i (?:want|need)|حوّ?لي?|نسّ?ق|اكتب|[اأ]نشئ|[اأ]عطني|[أا]ريد|[أا]بغ[ىاي]|[أا]بي|سوّ?ي|بدي)(?!\p{L})\s+/iu;
const HEAD = /^(?:(?:a|an|the|raw|literal|inline|file|table|object|جدول|كائن|ملف|نص|صيغة)\s+)*(?:JSON|CSV)(?![\p{L}\p{N}.])/iu;
const TARGET = /(?:\b(?:as|to|into|in)\s+|(?<!\p{L})(?:[إا]لى|بصيغة|بتنسيق|على شكل)\s+)$/iu;
const FORMAT = /(?<![\p{L}\p{N}.])(?:JSON|CSV)(?![\p{L}\p{N}.])/iu;
const FIELD = /^(?:[\p{L}_][\p{L}\p{M}\p{N}_-]*|"(?:[^"\\]|\\.)+"|“[^”]+”|«[^»]+»)/u;
const EXTRA_ACTION = /(?:[.!?؟;؛\r\n]\s*|\b(?:and|then)\s+)(?:please\s+)?(?:save|download|send|upload|attach|publish|run|execute|delete|rename|search|browse)\b|(?:[.!?؟;؛\r\n]\s*|(?:^|\s)(?:ثم\s+|و))(?:احفظ|ارسل|ارفع|انشر|شغل|نفذ|احذف|ابحث|تصفح)(?!\p{L})/iu;
const FILE_REFERENCE = /(?:^|\s)(?:https?:\/\/|[a-z]:[\\/]|[.~]?[\\/])|(?:[\p{L}\p{N}_-]+\.)+(?:[a-z][a-z0-9]{0,9})(?![\p{L}\p{N}])|\b(?:pdf|saved|attached|uploaded|previous|above|earlier|from my|from (?:the |a )?files?)\b|(?:المحفوظ|المرفق|السابق|اعلاه|من ملف[كي])/iu;
const OUTPUT_NOTE = /[.!؟?]\s+(?:(?:(?:i (?:need|want)|(?:please )?(?:return|give|show)(?: me)?)\s+)?(?:only\s+)?(?:the\s+)?(?:(?:raw|literal)\s+)?(?:JSON(?:\s+object)?|CSV)(?:\s+(?:only|here))?|(?:المطلوب\s+)?(?:JSON|CSV)\s+(?:فقط|بس)|(?:اعطني|عطني)\s+(?:محتوي|نص)\s+(?:الملف\s+)?هنا)[.!؟?]*$/iu;
const QUOTED = /"(?:[^"\\\r\n]|\\.)*"|“[^”\r\n]*”|«[^»\r\n]*»|(?<!\p{L})'[^'\r\n]*'(?!\p{L})/gu;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/iu;

function maskQuotes(text: string): string {
  return text.replace(QUOTED, value => '\u0000'.repeat(value.length));
}

function splitOutsideQuotes(text: string, delimiter: RegExp): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const match of maskQuotes(text).matchAll(delimiter)) {
    parts.push(text.slice(start, match.index).trim());
    start = match.index + match[0].length;
  }
  return [...parts, text.slice(start).trim()];
}

function literal(text: string): string {
  if (/^"(?:[^"\\]|\\.)*"$/u.test(text)) {
    try { return JSON.parse(text) as string; } catch { return text; }
  }
  if (/^(?:“[^”]*”|«[^»]*»|'[^']*')$/u.test(text)) return text.slice(1, -1);
  return text;
}

function jsonValue(text: string): string | number | boolean | null {
  if (text === 'true' || text === 'false' || text === 'null') return JSON.parse(text) as boolean | null;
  const digits = text.replace(/[٠-٩۰-۹]/gu, digit => String(digit.codePointAt(0)! % 16));
  if (NUMBER.test(digits)) {
    const value = Number(digits);
    if (Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  }
  return literal(text);
}

function jsonText(payload: string): string | null {
  // Preserve an explicit JSON object verbatim. Short field lists must have distinct keys.
  if (payload.startsWith('{')) {
    try { JSON.parse(payload); return payload; }
    catch { return null; }
  }
  const fields = new Map<string, string | number | boolean | null>();
  const parts = splitOutsideQuotes(payload, /[,،;؛\r\n]+|[ \t]+and[ \t]+|[ \t]+و[ \t]*(?=\p{Script=Arabic})/giu);
  for (const part of parts) {
    const field = FIELD.exec(part)?.[0];
    if (!field) return null;
    const value = /^(?:\s*[:：=]\s*|\s+(?:is\s+)?)(.+)$/isu.exec(part.slice(field.length))?.[1]?.trim();
    const key = literal(field);
    if (!key || !value || fields.has(key)) return null;
    fields.set(key, jsonValue(value));
  }
  return JSON.stringify(Object.fromEntries(fields), null, 2);
}

function csvText(payload: string, columns: string[]): string | null {
  // Rows may be provided as arrays, separated rows with comma/pipe fields, or short label–value pairs.
  let rows: string[][];
  if (payload.startsWith('[')) {
    try {
      // JSON.parse exposes the original number token in Node 24, preserving exact CSV text even for large numbers.
      const values: unknown = JSON.parse(payload, (_key, value: unknown, context?: { source?: string }) =>
        typeof value === 'number' ? context?.source ?? String(value) : value);
      if (!Array.isArray(values) || !values.every(row => Array.isArray(row) && row.every(cell => cell === null || ['string', 'number', 'boolean'].includes(typeof cell)))) return null;
      rows = values.map(row => row.map((cell: string | number | boolean | null) => cell === null ? '' : String(cell)));
    } catch { return null; }
  } else {
    const lines = splitOutsideQuotes(payload, /[;؛\r\n]+/gu);
    const pairs = lines.length === 1 ? splitOutsideQuotes(payload, /[,،]/gu) : lines;
    rows = pairs.map(row => {
      if (lines.length > 1 && /[,،|\t]/u.test(maskQuotes(row))) return splitOutsideQuotes(row, /[,،|\t]/gu).map(literal);
      const pair = /^(\S[\s\S]*?)(?:\s*[:：=]\s*|\s+)(-?\p{Nd}+(?:[.٫]\p{Nd}+)?)$/u.exec(row);
      return pair ? [literal(pair[1]!.trim()), pair[2]!] : [];
    });
  }
  const width = columns.length || rows[0]?.length;
  if (!width || !rows.length || rows.some(row => row.length !== width)) return null;
  const cell = (text: string) => /[",\r\n]|^\s|\s$/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  const data = columns.length ? [columns, ...rows] : rows;
  return data.map(row => row.map(cell).join(',')).join('\n');
}

/** Serialize inline data from the current request. No lookup, file access or model is needed. */
export function evaluateInlineDataFile(request: string): string | null {
  if (!request || request.length > 4000) return null;
  const action = requestScopeActionText(request).trim();
  const lead = LEAD.exec(action);
  if (!lead) return null;
  const rest = action.slice(lead[0].length);
  const format = FORMAT.exec(maskQuotes(rest));
  if (!format || format.index > 120) return null;
  const before = rest.slice(0, format.index);
  if (!HEAD.test(rest) && !TARGET.test(before)) return null;
  // File or conversation references in the source position need their own reader.
  if (FILE_REFERENCE.test(matchText(before))) return null;
  const tail = rest.slice(format.index + format[0].length).trimStart();
  const colon = /^([^:\r\n]{0,120})[:：\r\n]\s*/u.exec(tail);
  const withData = /^(?:(?:an?\s+)?(?:object|table|file|كائن|جدول|ملف)\s+)?(?:with|containing|بالمحتوى|يحتوي على)\s+/iu.exec(tail);
  const csv = format[0].toUpperCase() === 'CSV';
  const columnLabel = /^(?:(?:with\s+)?columns?|(?:ب)?[اأ]عمدة|بالأعمدة)\s+/iu;
  const meta = colon?.[1]?.trim() ?? '';
  const metaIsData = withData && !columnLabel.test(meta) && !/^(?:with\s+)?(?:the\s+)?(?:following\s+)?(?:data|values|fields|content)$/iu.test(meta);
  const delimiter = metaIsData ? withData : colon ?? withData;
  if (!delimiter || !withData && (FILE_REFERENCE.test(matchText(meta)) || /\b(?:named|called|save|send|download|upload|attach)\b|(?:باسم|اسم الملف)/iu.test(matchText(meta)))) return null;
  let payload = stripCourtesyTail(tail.slice(delimiter[0].length).trim());
  // Locate the boundary in the original text so matching normalization stays out of the file data.
  const boundary = [...payload.matchAll(/[.!؟?]\s+/gu)].findLast(item => OUTPUT_NOTE.test(matchText(payload.slice(item.index))));
  if (boundary) {
    const noteFormat = FORMAT.exec(payload.slice(boundary.index))?.[0];
    if (noteFormat && noteFormat.toLowerCase() !== format[0].toLowerCase()) return null;
    payload = payload.slice(0, boundary.index);
  }
  if (EXTRA_ACTION.test(matchText(maskQuotes(payload))) || !payload) return null;
  if (!csv) return jsonText(payload.replace(/(?<=[\p{L}\p{N}"”»])\.$/u, ''));
  const columns = columnLabel.test(meta) ? splitOutsideQuotes(meta.replace(columnLabel, ''), /[,،]|\s+and\s+|\s+و\s*/giu).map(literal) : [];
  return columns.some(column => !column) ? null : csvText(payload.replace(/(?<=\p{Nd})\.$/u, ''), columns);
}

export async function finishInlineDataFile(request: string, publish: (text: string) => Promise<void>): Promise<boolean> {
  const text = evaluateInlineDataFile(request);
  if (text === null) return false;
  await publish(text);
  return true;
}
