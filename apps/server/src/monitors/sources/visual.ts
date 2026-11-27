import { createHash } from 'node:crypto';
import type { SafeNetwork } from '@mohassan/browser';
import type { MonitorSpec } from '@mohassan/contracts';
import type { ImageReader } from '../../image-reader.js';
import { normalizeCurrency, normalizeUnit, pageNumbers } from '../page-values-v2.js';
import type { MonitorPageAnchor, MonitorPageCandidate } from '../page-v2.js';
import { display, matchMonitorText } from '../page.js';
import type { MonitorReadOptions, MonitorReadResult } from '../sources.js';
import { MONITOR_LIMITS } from '../schedule.js';
import { renderMonitorRegions, type VisualRenderRequest, type VisualRenderResult, type VisualRegion } from './visual-browser.js';

export type { VisualRenderRequest, VisualRenderResult, VisualRegion } from './visual-browser.js';
export { reserveMonitorVisualRead } from './visual-budget.js';

// The own reader uses 0.90 to identify legible lines. Unattended alerts use
// at least this floor for the entire line supplying the value.
export const MONITOR_VISUAL_MIN_CONFIDENCE = 0.90;
const VISUAL_READ_TIMEOUT_MS = 20_000;

function unreadable(url: string, confidence = 0): MonitorReadResult {
  return { kind: 'unsafe-target', url, confidence, reason: 'visual-unreadable' };
}

async function readRegion(reader: Pick<ImageReader, 'read'>, region: VisualRegion, request: VisualRenderRequest):
Promise<{ candidate?: MonitorPageCandidate; confidence: number }> {
  const reading = await reader.read(region.image, request.signal);
  request.signal.throwIfAborted();
  const numeric = reading.lines.filter(line => /\d/u.test(matchMonitorText(line.text)));
  if (numeric.length !== 1) return { confidence: 0 };
  const [line] = numeric;
  const confidence = Number.isFinite(line.confidence) ? line.confidence : 0;
  if (confidence < MONITOR_VISUAL_MIN_CONFIDENCE || confidence > 1) return { confidence: Math.min(1, confidence) };
  const digitGroups = matchMonitorText(line.text).match(/\d+(?:[.,٫٬]\d+)*/gu);
  if (digitGroups?.length !== 1) return { confidence };
  const parsed = pageNumbers(line.text);
  if (parsed.length !== 1) return { confidence };
  const [number] = parsed;
  const target = request.spec.v2?.target;
  const previous = request.previous?.origin === 'visual' ? request.previous.pattern : undefined;
  if (number.conflicting || Math.abs(number.value) > Number.MAX_SAFE_INTEGER ||
      target?.currency && number.currency !== normalizeCurrency(target.currency) ||
      target?.unit && number.unit !== normalizeUnit(target.unit) ||
      previous && (number.currency !== previous.currency || number.unit !== previous.unit)) return { confidence };

  const label = display(region.label).slice(0, 180);
  const id = createHash('sha256').update(region.key).digest('hex').slice(0, 24);
  return { confidence, candidate: {
    id, label: label || String(number.value),
    anchor: { key: region.key, label, pattern: { kind: 'number', currency: number.currency, unit: number.unit },
      context: matchMonitorText(label), origin: 'visual' },
    observation: { value: number.value, excerpt: display(line.text), url: request.url, observedAt: request.at },
  } };
}

export function createVisualMonitorReader({ network, imageReader, reserveDaily, clock = Date.now, render = renderMonitorRegions }: {
  network: SafeNetwork;
  imageReader?: Pick<ImageReader, 'available' | 'read'>;
  reserveDaily: (at: number) => Promise<number | null>;
  clock?: () => number;
  render?: (request: VisualRenderRequest) => Promise<VisualRenderResult>;
}) {
  let activeReads = 0;
  return async (spec: MonitorSpec, url: string, options: MonitorReadOptions): Promise<MonitorReadResult> => {
    options.signal?.throwIfAborted();
    if (spec.read.kind !== 'number' || !imageReader?.available) return unreadable(url);
    const now = clock();
    // A burst of previews and scheduled reads shares the same process capacity.
    if (activeReads >= MONITOR_LIMITS.concurrentReads) return { kind: 'deferred', at: now + MONITOR_LIMITS.pollMs };
    activeReads++;
    try {
      const deferred = await reserveDaily(now);
      if (deferred !== null) return { kind: 'deferred', at: deferred };
      options.signal?.throwIfAborted();
      const deadline = AbortSignal.timeout(VISUAL_READ_TIMEOUT_MS);
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      const request = { network, spec, url, at: new Date(now).toISOString(), signal, previous: options.cache?.anchor };
      try {
        const result = await render(request);
        signal.throwIfAborted();
        if (result.kind === 'page') return result.result;
        if (result.kind === 'missing') return unreadable(url);
        const reads = [];
        // Sequential work also bounds the own OCR pool queue per monitor check.
        for (const region of result.regions.slice(0, 4)) reads.push(await readRegion(imageReader, region, request));
        const reliable = reads.flatMap(({ candidate }) => candidate ? [candidate] : []);
        const confidence = Math.max(0, ...reads.map(read => read.confidence));
        if (reliable.length >= 2) return { kind: 'clarify', url, candidates: reliable, confidence, cache: { url } };
        if (reliable.length !== 1 || result.regions.length !== 1 || result.ambiguous) return unreadable(url, confidence);
        const [{ observation, anchor }] = reliable;
        return { kind: 'value', observation, cache: { url, anchor } };
      } catch {
        options.signal?.throwIfAborted();
        return unreadable(url);
      }
    } finally {
      activeReads--;
    }
  };
}
