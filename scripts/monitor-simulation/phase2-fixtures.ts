import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SafeNetwork } from '@mohassan/browser';
import type { MonitorSpec } from '@mohassan/contracts';
import { decodeImage, describeImage, type ImageReading } from '@mohassan/vision';
import type { Kysely } from 'kysely';
import sharp from 'sharp';
import { githubFixtureOwner, githubFixtureRepo, githubFixtureResponse, githubPullNumber } from './phase2-github-fixtures.js';
import { nextMonitorBudgetDay } from '../../apps/server/src/monitors/schedule.js';
import { MONITOR_VISUAL_DAILY_LIMIT } from '../../apps/server/src/monitors/sources/visual-budget.js';
import type { VisualRenderRequest } from '../../apps/server/src/monitors/sources/visual.js';
import { writeMonitorPdfFixture } from '../../tests/fixtures/monitors/pdf.js';
import { chance, hour, iso, minute, parameters, pick, random, week, type Phase2SourceClass, type Scenario, type SeedBank, type TruthEvent } from './fixtures.js';

const site = 'https://publisher.example.test';
const epoch = Date.UTC(2026, 10, 9);
const pdfUrl = `${site}/report.pdf`;
const visualUrl = `${site}/score`;
const label = 'Score';
const initialScore = 28;
const qualifiedScore = 74;
const crossing = { kind: 'crossing', direction: 'above', value: 50, hysteresis: 1 } as const;
const flags = { github: true, pdf: true, visual: true } as const;
const scoreFont = fileURLToPath(new URL('../../packages/pdf/fonts/NotoNaskhArabic-Bold.ttf', import.meta.url));
const pdfs = new Map<string, Promise<Buffer>>();

export const phase2Parameters = {
  positiveTrialProbability: 1 - parameters.noSustainedChangeProbability,
  publicationMarginHours: 18,
  ciTransientSuccessMinutes: 75,
  weakReadWindowMinutes: 90,
  negativeWeakReadWindowHours: 16,
  weakReadConfidence: 0.55,
  strongReadConfidence: 0.97,
} as const;

type Clock = () => number;
type Reply = { body: Buffer; type: string };
const html = (value: string): Reply => ({ body: Buffer.from(value), type: 'text/html; charset=utf-8' });
const png = (body: Buffer): Reply => ({ body, type: 'image/png' });
const pdf = (body: Buffer): Reply => ({ body, type: 'application/pdf' });
type Dispatch = (url: URL, at: number, options: Parameters<SafeNetwork['request']>[1]) => Reply | undefined;

export class Phase2FixtureNetwork extends SafeNetwork {
  constructor(private readonly clock: Clock, private readonly fixture: Dispatch) {
    super({ testOrigins: [site] });
  }

  override async request(target: string, options?: Parameters<SafeNetwork['request']>[1]) {
    options?.signal?.throwIfAborted();
    await options?.beforeDispatch?.();
    const url = new URL(target);
    const response = url.hostname === new URL(site).hostname && url.pathname === '/robots.txt'
      ? { body: Buffer.from('User-agent: *\nAllow: /\n'), type: 'text/plain' }
      : this.fixture(url, this.clock(), options);
    if (!response) throw new Error(`Unexpected phase 2 fixture target ${url.host}${url.pathname}`);
    const etag = `"${createHash('sha256').update(response.body).digest('base64url')}"`;
    const headers = { etag, 'content-type': response.type };
    if (options?.headers?.['if-none-match'] === etag) return { url: target, status: 304, headers, body: Buffer.alloc(0) };
    return { url: target, status: 200, headers, body: response.body };
  }
}

function when(at: number, until: number, expected: TruthEvent['expected']): TruthEvent[] {
  return Number.isFinite(at) && at < until ? [{ at, until, expected }] : [];
}

type FixtureParts = Pick<Scenario, 'source' | 'read' | 'condition' | 'truth' | 'lowConfidenceAt'> & {
  dispatch: Dispatch;
  visual?: ReturnType<Scenario['ports']>['visual'];
};

function githubFixture(sourceClass: Phase2SourceClass, trial: number, rand: () => number, start: number, end: number, changedAt: number): FixtureParts {
  const source = { kind: 'github', owner: githubFixtureOwner, repo: githubFixtureRepo } as const;
  if (sourceClass === 'pull-request') {
    const terminal = trial % 3 === 0 ? 'open' : trial % 3 === 1 ? 'closed' : 'merged';
    const initial = terminal === 'open' ? 'closed' : 'open';
    return {
      source: { ...source, watch: { kind: 'pull-request', number: githubPullNumber } },
      read: { kind: 'status' }, condition: { kind: 'equals', value: terminal }, truth: when(changedAt, end, terminal),
      dispatch: (url, at) => githubFixtureResponse(url, at, Infinity, at >= changedAt ? terminal : initial),
    };
  }
  if (sourceClass === 'github-release') {
    return {
      source: { ...source, watch: { kind: 'releases' } }, read: { kind: 'items' }, condition: { kind: 'new-item' },
      truth: when(changedAt, end, 'v2.0.0'),
      dispatch: (url, at) => githubFixtureResponse(url, at, changedAt),
    };
  }
  const firstFlap = start + pick(rand, 4 * hour / minute, 6 * hour / minute) * minute;
  const earlySuccess = Number.isFinite(changedAt) ? firstFlap + hour : Infinity;
  const earlySuccessEnd = earlySuccess + phase2Parameters.ciTransientSuccessMinutes * minute;
  const stateAt = (at: number) => {
    if (at >= changedAt || at >= earlySuccess && at < earlySuccessEnd) return 'success';
    if (at >= firstFlap) return Math.floor((at - firstFlap) / (2 * hour)) % 2 ? 'pending' : 'failure';
    return 'pending';
  };
  return {
    source: { ...source, watch: { kind: 'pull-ci', number: githubPullNumber } },
    read: { kind: 'status' }, condition: { kind: 'equals', value: 'success' },
    truth: [...when(earlySuccess, earlySuccessEnd, 'success'), ...when(changedAt, end, 'success')],
    dispatch: (url, at) => githubFixtureResponse(url, at, Infinity, 'open', stateAt(at)),
  };
}

async function pdfFixture(trial: number, end: number, changedAt: number): Promise<FixtureParts> {
  const mode = trial % 4;
  const source = { kind: 'pdf', url: pdfUrl } as const;
  let initial: string;
  let revised: string;
  let read: MonitorSpec['read'];
  let condition: MonitorSpec['condition'];
  let expected: TruthEvent['expected'];
  if (mode === 0) {
    initial = 'Public report\nThe proposal is pending.';
    expected = 'The proposal was approved.';
    revised = `Public report\n${expected}`;
    read = { kind: 'main' };
    condition = { kind: 'change' };
  } else if (mode === 1) {
    initial = `Public report\n${label}: ${initialScore}`;
    revised = `Public report\n${label}: ${qualifiedScore}`;
    expected = qualifiedScore;
    read = { kind: 'number', label };
    condition = crossing;
  } else if (mode === 2) {
    initial = 'Public report\nفي انتظار الجلسة';
    revised = 'Public report\nوافق المجلس';
    expected = true;
    read = { kind: 'phrase', phrase: 'وافق المجلس' };
    condition = { kind: 'appears' };
  } else {
    initial = 'Public report\n- First decision';
    expected = 'Second decision';
    revised = `${initial}\n- ${expected}`;
    read = { kind: 'items' };
    condition = { kind: 'new-item' };
  }
  const baseline = await pdfFor(initial);
  const revision = Number.isFinite(changedAt) ? await pdfFor(revised) : baseline;
  return { source, read, condition, truth: when(changedAt, end, expected),
    dispatch: (url, at) => url.href === pdfUrl ? pdf(at >= changedAt ? revision : baseline) : undefined };
}

function pdfFor(content: string) {
  let result = pdfs.get(content);
  if (!result) {
    result = writeMonitorPdfFixture([content]);
    pdfs.set(content, result);
  }
  return result;
}

async function visualFixture(rand: () => number, start: number, end: number, changedAt: number): Promise<FixtureParts> {
  const positive = Number.isFinite(changedAt);
  const weakAt = positive ? start + pick(rand, 4 * hour / minute, 16 * hour / minute) * minute
    : start + pick(rand, hour / minute, 3 * hour / minute) * minute;
  const weakUntil = weakAt + (positive ? phase2Parameters.weakReadWindowMinutes * minute : phase2Parameters.negativeWeakReadWindowHours * hour);
  const lowConfidenceAt = (at: number) => at >= weakAt && at < weakUntil;
  const width = 140, height = 58;
  async function crop(score: number, dots: number, confidence: number, reportedScore = score) {
    const noise = Array.from({ length: dots }, () => `<circle cx="${pick(rand, 0, width)}" cy="${pick(rand, 0, height)}" r="1" fill="gray" opacity=".45"/>`).join('');
    const { data: glyphs, info } = await sharp({ text: { text: String(score), font: 'Noto Naskh Arabic Bold 33', fontfile: scoreFont, rgba: true } })
      .png().toBuffer({ resolveWithObject: true });
    const x = 22, y = Math.floor((height - info.height) / 2);
    const speckle = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${noise}</svg>`);
    const image = await sharp({ create: { width, height, channels: 3, background: 'white' } })
      .composite([{ input: glyphs, left: x, top: y }, { input: speckle }]).png().toBuffer();
    const decoded = await decodeImage(image);
    if (!decoded.gray.some(pixel => pixel < 50)) throw new Error('Seeded score image has no dark glyphs.');
    const text = String(reportedScore);
    const reading: ImageReading = {
      facts: describeImage(decoded), candidates: 1, dropped: 0, durationMs: 0, kind: 'screenshot', modelId: 'seeded-double',
      direction: 'ltr', text, blocks: [text], lines: [{ text, visual: text, confidence, direction: 'ltr',
        block: 0, row: 0, box: { x, y, w: info.width, h: info.height } }],
    };
    return { image, reading };
  }
  const [normal, changed, weak] = [
    await crop(initialScore, 28, phase2Parameters.strongReadConfidence),
    await crop(qualifiedScore, 41, phase2Parameters.strongReadConfidence),
    await crop(initialScore, 93, phase2Parameters.weakReadConfidence, qualifiedScore),
  ];
  const imageAt = (at: number) => at >= changedAt ? changed : lowConfidenceAt(at) ? weak : normal;
  const page = html('<main><h1>Published metrics</h1><section id="score"><h2>Score</h2><img src="/score.png" alt=""></section></main>');
  let nextDay = start;
  let attempts = 0;
  return {
    source: { kind: 'visual', url: visualUrl, anchor: label }, read: { kind: 'number', label }, condition: crossing,
    truth: when(changedAt, end, qualifiedScore), lowConfidenceAt,
    dispatch: (url, at) => url.href === visualUrl ? page : url.href === `${site}/score.png` ? png(imageAt(at).image) : undefined,
    visual: {
      reserveDaily: async at => {
        if (at >= nextDay) {
          nextDay = nextMonitorBudgetDay(new Date(at)).getTime();
          attempts = 0;
        }
        return attempts++ < MONITOR_VISUAL_DAILY_LIMIT ? null : nextDay;
      },
      render: async ({ network, url, signal }: VisualRenderRequest) => {
        const rendered = await network.request(new URL('/score.png', url).href, { signal });
        return { kind: 'regions', regions: [{ key: 'id:score', label, image: rendered.body }] };
      },
      imageReader: { available: true, async read(image: Uint8Array) {
        const known = [normal, changed, weak].find(fixture => fixture.image.equals(image));
        if (!known) throw new Error('Unknown seeded image crop.');
        return known.reading;
      } },
    },
  };
}

export async function createPhase2Scenario(bank: SeedBank, trial: number, sourceClass: Phase2SourceClass): Promise<Scenario> {
  const rand = random(bank, trial, sourceClass);
  const start = epoch + pick(rand, 0, week / minute - 1) * minute;
  const end = start + week;
  const margin = phase2Parameters.publicationMarginHours * hour / minute;
  const changedAt = chance(rand, phase2Parameters.positiveTrialProbability)
    ? start + pick(rand, margin, week / minute - margin) * minute : Infinity;
  const fixture = sourceClass === 'pdf-revision' ? await pdfFixture(trial, end, changedAt)
    : sourceClass === 'visual-noise' ? await visualFixture(rand, start, end, changedAt)
      : githubFixture(sourceClass, trial, rand, start, end, changedAt);
  return { ...fixture, sourceClass, start, end, language: 'en',
    ports: clock => ({ db: {} as Kysely<any>, network: new Phase2FixtureNetwork(clock, fixture.dispatch),
      clock, flags, ...(fixture.visual && { visual: fixture.visual }) }) };
}
