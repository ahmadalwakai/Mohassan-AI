export type BrowserOpenIntent = { url: string; source: 'google_ads' | 'explicit_url' };

/** Known read redirects/assets for the public Ads landing page; no account origins. */
export function browserReadOrigins(value: string): string[] {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'ads.google.com' && !url.port
      ? ['https://ads.google.com', 'https://consent.google.com', 'https://www.gstatic.com', 'https://business.google.com']
      : [url.origin];
  } catch { return []; }
}

const openRequest = /(?:^|\s)(?:افتح|أفتح|افتحي|افتحوا|تفضّل\s+بفتح|تفضل\s+بفتح|انتقل\s+إلى|انتقل\s+الى|اذهب\s+إلى|اذهب\s+الى|open|visit|load|navigate\s+to|go\s+to)(?=\s|https?:|Google|جوجل|غوغل|إعلانات|اعلانات)/iu;
const negatedRequest = /(?:لا\s+(?:تفتح|تفتحي|تفتحوا|تنتقل|تزر)|لا\s+(?:أريد|اريد)[\s\S]{0,80}(?:فتح|تفتح)|بدون\s+فتح|(?:do\s+not|don't|never)\s+(?:open|visit|load|navigate|go))/iu;
const instructionalRequest = /(?:كيف\s+(?:أ|ا)?فتح|كيفية\s+فتح|اشرح\s+(?:لي\s+)?كيف|how\s+(?:do\s+i|to)\s+(?:open|visit)|explain\s+how)/iu;
const googleAds = /(?:\bgoogle\s*ads\b|(?:إعلانات|اعلانات)\s+(?:جوجل|غوغل)|(?:جوجل|غوغل)\s+(?:أدز|ادز|آدز))/iu;

/** A small deterministic route for an explicit page-opening request; never a general intent classifier. */
export function detectBrowserOpenIntent(goal: string): BrowserOpenIntent | null {
  const text = goal.trim().normalize('NFKC');
  if (!openRequest.test(text) || negatedRequest.test(text) || instructionalRequest.test(text)) return null;
  const candidates = text.match(/https?:\/\/[^\s<>"'`]+/giu) ?? [];
  const urls = new Set<string>();
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.replace(/[.,،؛;!؟)\]}>»]+$/u, ''));
      if (url.protocol !== 'https:' || url.username || url.password) return null;
      urls.add(url.href);
    } catch { return null; }
  }
  if (urls.size > 1) return null;
  if (urls.size === 1) return { url: [...urls][0], source: 'explicit_url' };
  return googleAds.test(text) ? { url: 'https://ads.google.com/home/', source: 'google_ads' } : null;
}
