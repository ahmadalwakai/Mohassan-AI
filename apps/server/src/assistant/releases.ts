/**
 * «What is the latest version of X?» answered from X's own official release page, read live over HTTP, before any
 * search (docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §7.2: a live fact comes with its source's own time).
 *
 * Measured on 2026-11-22 (artifacts/plan-2026-11-22/3-answers-and-questions.md §2.3): the three Node.js version
 * questions in the frozen real set (rq020, rq021, rq041) all ended in «لم أجد», after the shared search returned
 * years-old Stack Overflow threads that answer the reader with HTTP 403 and were opened in the hidden browser.
 *
 * A source is listed only when its page is allowed by the site's robots.txt and states the version itself. For
 * Node.js, https://nodejs.org/dist/index.json is disallowed (`Disallow: /dist/`), while the folder of the newest
 * release (`Allow: /dist/latest/`) lists its files as «node-v26.13.1-… 11-Nov-2026 16:41». Products are added when
 * real questions ask for them.
 */
export interface ReleaseFact {
  /** As the source writes it: «v26.13.1». */
  version: string;
  /** When the source's own files for that version appeared, ISO 8601 UTC. */
  publishedAt: string;
}

export interface ReleaseSource {
  product: string;
  /** The subject as the owner writes it, folded (lower case, no spaces or dots). */
  names: readonly string[];
  /** The official page that states the version, read over HTTP. */
  page: string;
  title: { ar: string; en: string };
  /** A human page for the rest (support lines, schedules), shown as «للمزيد». */
  more?: { url: string; title: { ar: string; en: string } };
  parse(text: string): ReleaseFact | null;
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/**
 * The Node.js «latest» folder: every release file names one version and its upload time («11-Nov-2026 16:41», in UTC
 * like the folder's Last-Modified header). All files must name the same version; the earliest time is the publication.
 */
export function nodeLatest(text: string): ReleaseFact | null {
  const found = [...text.matchAll(/node-(v\d+\.\d+\.\d+)-[\w.-]+\s+(\d{2})-([A-Z][a-z]{2})-(\d{4})\s+(\d{2}):(\d{2})/gu)];
  if (!found.length) return null;
  const versions = new Set(found.map(match => match[1]));
  if (versions.size !== 1) return null;
  const times = found.flatMap(match => {
    const month = MONTHS[match[3]!];
    if (month === undefined) return [];
    const time = Date.UTC(Number(match[4]), month, Number(match[2]), Number(match[5]), Number(match[6]));
    return Number.isNaN(time) ? [] : [time];
  });
  if (!times.length) return null;
  return { version: found[0]![1]!, publishedAt: new Date(Math.min(...times)).toISOString() };
}

export const RELEASE_SOURCES: readonly ReleaseSource[] = [{
  product: 'Node.js',
  names: ['nodejs', 'node', 'نود', 'نودجياس', 'نودجيإس', 'نودجس'],
  page: 'https://nodejs.org/dist/latest/',
  title: { ar: 'مجلد أحدث إصدار في موقع Node.js الرسمي', en: 'Latest release folder on the official Node.js site' },
  more: { url: 'https://nodejs.org/en/about/previous-releases', title: { ar: 'صفحة إصدارات Node.js وخطوط الدعم', en: 'Node.js releases and support lines' } },
  parse: nodeLatest,
}];

const fold = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\s.]+/gu, '').replace(/[أإآ]/gu, 'ا');
// «آخر إصدار مستقر من Node.js»، «أحدث نسخة من نود»: the subject follows the version words.
const ARABIC_ASK = /(?:^|\s)(?:آخر|اخر|أحدث|احدث)\s+(?:إصدار|اصدار|نسخة|نسخه)(?:\s+(?:مستقر[ةه]?|ثابت[ةه]?|رسمي[ةه]?|lts))?\s+(?:من|في|ل|لـ)\s+(\S+(?:\s+\S+){0,2})/iu;
// "latest stable version of Node.js", "the newest release of node".
const ENGLISH_ASK_OF = /\b(?:latest|newest|most recent|current)\s+(?:stable\s+|lts\s+)?(?:version|release)\s+of\s+(\S+(?:\s+\S+){0,2})/iu;
// "Node.js latest version", "node lts release".
const ENGLISH_ASK_BEFORE = /(?:^|\s)(\S+(?:\s+\S+)?)\s+(?:latest|newest|current)\s+(?:stable\s+|lts\s+)?(?:version|release)\b/iu;

/** The official source for a «latest version» question, or null when the question asks something else or names no listed product. */
export function releaseQuestion(text: string): ReleaseSource | null {
  for (const pattern of [ARABIC_ASK, ENGLISH_ASK_OF, ENGLISH_ASK_BEFORE]) {
    const subject = pattern.exec(text)?.[1];
    if (!subject) continue;
    // The subject is one to three words, cut at punctuation: «Node.js،» and «Node.js?» are «Node.js».
    const words = subject.split(/\s+/u).map(word => word.replace(/^[«"'(]+|[»"')،,؟?!:;]+$|\.$/gu, ''));
    const stop = words.findIndex(word => !word);
    const kept = stop < 0 ? words : words.slice(0, stop);
    for (let length = kept.length; length >= 1; length--) {
      const name = fold(kept.slice(0, length).join(' '));
      // «node-sass» or «node_modules» is not Node.js.
      if (/[-_/]/u.test(name)) continue;
      const source = RELEASE_SOURCES.find(item => item.names.includes(name));
      if (source) return source;
    }
  }
  return null;
}

/** The answer line, framed in the owner's language; the version and time are the source's own. */
export function releaseLines(source: ReleaseSource, fact: ReleaseFact, lang: 'ar' | 'en'): string[] {
  const [day, time] = [fact.publishedAt.slice(0, 10), fact.publishedAt.slice(11, 16)];
  return [lang === 'en'
    ? `The latest stable ${source.product} release is ${fact.version}; its files were published on the official ${source.product} site on ${day} at ${time} UTC.`
    : `آخر إصدار مستقر من ${source.product} هو ${fact.version}، ونُشرت ملفاته في موقع ${source.product} الرسمي يوم ${day} الساعة ${time} UTC.`];
}
