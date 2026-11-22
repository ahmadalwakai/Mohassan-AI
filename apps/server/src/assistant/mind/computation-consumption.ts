/** Original UTF-16 offsets; normalisation never replaces the owner's stored text. */
export interface ComputationSpan { start: number; end: number }
export interface ConsumedComputationSpan extends ComputationSpan { role: 'request' | 'courtesy' | 'output_format' | 'punctuation' }
export type ComputationKind = 'arithmetic' | 'conversion' | 'date_range' | 'date_shift' | 'weekday' | 'date_distance' | 'clock_now' | 'clock_conversion' | 'unsupported';
export interface ComputationConsumption {
  version: 1;
  kind: ComputationKind;
  complete: boolean;
  sourceLength: number;
  consumed: ConsumedComputationSpan[];
  remainder: ComputationSpan[];
  reason?: 'unrecognised_request' | 'unconsumed_content' | 'literal_content' | 'invalid_input';
}

export interface PreparedComputationSource {
  original: string;
  input: string;
  valueOnly: boolean;
  valid: boolean;
  literal: boolean;
  wrappers: ConsumedComputationSpan[];
  /** Maps a range of matching input back to the unchanged original argument. */
  span(start: number, end: number): ComputationSpan;
}

const PREFIX_COURTESY = /^(?:please|kindly|من فضلك|لو سمحت|اذا سمحت|رجاء(?:ا)?|ارجوك)[,،:\s]+/iu;
const SUFFIX_COURTESY = /[\s,،;؛]+(?:please|kindly|thanks|thank you|لو سمحت|اذا سمحت|من فضلك|ارجوك|رجاء(?:ا)?|شكرا)$/iu;
const THOUSANDS = /(?<![\d.,٬٫])\d{1,3}(?:(?:,\d{3})+|(?:٬\d{3})+)(?!\d|[,٬]\d)/gu;

function mappedText(original: string) {
  let text = '', offset = 0;
  const starts: number[] = [], ends: number[] = [];
  for (const char of original) {
    const normalized = char.normalize('NFKC').replace(/[\u0610-\u061a\u0640\u064b-\u065f\u0670\u06d6-\u06ed]|\p{Cf}/gu, '')
      .replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) % 16))
      .replace(/[أإآٱ]/gu, 'ا').replace(/[ىی]/gu, 'ي').replace(/٫/gu, '.')
      .replace(/[−–]/gu, '-').replace(/٪/gu, '%');
    for (let unit = 0; unit < normalized.length; unit++) { starts.push(offset); ends.push(offset + char.length); }
    text += normalized;
    offset += char.length;
  }
  const omit = new Set<number>();
  for (const match of text.matchAll(THOUSANDS)) for (let at = match.index; at < match.index + match[0].length; at++) if (/[,٬]/u.test(text[at]!)) omit.add(at);
  if (omit.size) {
    let compact = ''; const keptStarts: number[] = [], keptEnds: number[] = [];
    for (let at = 0; at < text.length; at++) if (!omit.has(at)) { compact += text[at]; keptStarts.push(starts[at]!); keptEnds.push(ends[at]!); }
    return { text: compact, starts: keptStarts, ends: keptEnds };
  }
  return { text, starts, ends };
}

function containsLiteral(text: string): boolean {
  if (/["`«»“”]/u.test(text)) return true;
  return /(?<![\p{L}\p{N}])['‘][\s\S]*?['’](?![\p{L}\p{N}])/u.test(text);
}

/** Only known harmless wrappers are removed. Unknown formatting stays in input. */
export function prepareComputationSource(original: string, shortTail: RegExp): PreparedComputationSource {
  // This public inspection seam may be called outside the bounded chat host.
  // Reject before normalisation, offset arrays, regex scans or literal parsing.
  if (typeof original !== 'string' || original.length > 8000 || !original.trim()) {
    return { original: typeof original === 'string' ? original : '', input: '', valueOnly: false, valid: false,
      literal: false, wrappers: [], span: () => ({ start: 0, end: 0 }) };
  }
  const source = mappedText(original);
  let start = 0, end = source.text.length, valueOnly = false;
  const wrappers: ConsumedComputationSpan[] = [];
  const toOriginal = (from: number, to: number): ComputationSpan => {
    let finish = to === source.text.length ? original.length : to > from ? source.ends[to - 1] ?? original.length : source.starts[from] ?? original.length;
    while (finish < original.length && /[\u0610-\u061a\u0640\u064b-\u065f\u0670\u06d6-\u06ed]|\p{Cf}/u.test(original[finish]!)) finish++;
    return { start: from === 0 ? 0 : source.starts[from] ?? original.length, end: finish };
  };
  const consume = (from: number, to: number, role: ConsumedComputationSpan['role']) => {
    if (to > from) wrappers.push({ ...toOriginal(from, to), role });
  };
  const leadingWhitespace = /^\s*/u.exec(source.text)![0].length;
  consume(0, leadingWhitespace, 'punctuation'); start = leadingWhitespace;
  for (let count = 0; count < 8; count++) {
    const courtesy = PREFIX_COURTESY.exec(source.text.slice(start, end));
    if (!courtesy) break;
    consume(start, start + courtesy[0].length, 'courtesy'); start += courtesy[0].length;
  }
  // A short-answer tail may itself have a courtesy/punctuation tail. Peel from
  // the outside in, with an explicit bound and exact original source spans.
  for (let count = 0; count < 16; count++) {
    const current = source.text.slice(start, end);
    const punctuation = /[\s,.!?؟،؛;:]+$/u.exec(current);
    if (punctuation) { consume(start + punctuation.index, end, 'punctuation'); end = start + punctuation.index; continue; }
    const courtesy = SUFFIX_COURTESY.exec(current);
    if (courtesy) { consume(start + courtesy.index, end, 'courtesy'); end = start + courtesy.index; continue; }
    const short = shortTail.exec(current);
    if (short) { consume(start + short.index, end, 'output_format'); end = start + short.index; valueOnly = true; continue; }
    break;
  }
  return { original, input: source.text.slice(start, end), valueOnly, valid: original.length > 0 && original.length <= 8000 && start < end,
    literal: containsLiteral(original), wrappers, span: (from, to) => toOriginal(start + from, start + to) };
}

export function finishComputationConsumption(source: PreparedComputationSource, kind: ComputationKind,
  match?: ComputationSpan): ComputationConsumption {
  const consumed = [...source.wrappers];
  const remainder: ComputationSpan[] = [];
  if (match) {
    consumed.push({ ...source.span(match.start, match.end), role: 'request' });
    if (source.input.slice(0, match.start).trim()) remainder.push(source.span(0, match.start));
    if (source.input.slice(match.end).trim()) remainder.push(source.span(match.end, source.input.length));
  } else if (source.input) remainder.push(source.span(0, source.input.length));
  consumed.sort((a, b) => a.start - b.start || a.end - b.end);
  const complete = source.valid && !source.literal && Boolean(match) && !remainder.length;
  return { version: 1, kind, complete, sourceLength: source.original.length, consumed, remainder,
    ...(!source.valid ? { reason: 'invalid_input' as const } : source.literal ? { reason: 'literal_content' as const }
      : !match ? { reason: 'unrecognised_request' as const } : remainder.length ? { reason: 'unconsumed_content' as const } : {}) };
}
