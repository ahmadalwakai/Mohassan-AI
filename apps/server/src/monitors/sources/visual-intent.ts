import type { MonitorSpec } from '@mohassan/contracts';
import { monitorMatchText, type MonitorNeed } from '../detection.js';
import { generateMonitorSpec, monitorTimingForNeed } from '../spec.js';

export function visualMonitorSpec(need: MonitorNeed, now: Date): MonitorSpec | null {
  const body = monitorMatchText(need.text.replace(/https?:\/\/[^\s<>"'`«»“”]+/giu, ' '));
  if (!need.sourceUrl || !/\b(?:canvas|rendered as (?:an? )?image|drawn (?:as|in)|number in (?:an? |the )?image)\b|لوحه الرسم|داخل الصوره|مرسوم/u.test(body)) return null;
  const spec = generateMonitorSpec(need, now, true);
  const timing = monitorTimingForNeed('visual', need, now);
  if (!spec || !timing || spec.source.kind !== 'page') return null;
  const source = { ...spec.source, kind: 'visual' } as const;
  if (spec.read.kind === 'number') return { ...spec, source, timing };
  if (spec.read.kind !== 'main' || !/\b(?:number|value|reading)\b|الرقم|القيمه|القراءه/u.test(body)) return null;
  const ar = need.language === 'ar';
  const title = `${new URL(source.url).hostname} · ${source.anchor ?? (ar ? 'القيمة في الصورة' : 'Rendered value')}`;
  return { ...spec, source, read: { kind: 'number' }, timing, title,
    message: ar ? `تحقّق شرط المراقبة لـ «${title}».` : `The monitoring condition was met for ${title}.` };
}
