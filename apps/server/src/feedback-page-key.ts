import { safeResumeUrl } from '@mohassan/browser';

export function redactFeedbackUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s<>«»"'\x60]+/giu, candidate => {
    try {
      const url = new URL(candidate);
      const fragment = url.hash.slice(1);
      url.hash = '';
      const safe = safeResumeUrl(url.href) && (!fragment || safeResumeUrl('https://review.invalid/?' + fragment));
      return safe ? candidate : '[محجوب]';
    } catch {
      return '[محجوب]';
    }
  });
}

/** Web page identity used by both answer selection and feedback capture. */
export function feedbackPageKey(input: string): string | null {
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    // Keep meaningful parameters byte-for-byte, including their order and encoding.
    const parameters = url.search.slice(1).split('&');
    const retained = parameters.filter(parameter => !/^(?:utm_.+|fbclid|gclid|msclkid)$/i.test(
      new URLSearchParams(parameter).keys().next().value ?? '',
    ));
    if (retained.length !== parameters.length) url.search = retained.join('&');
    return safeResumeUrl(url.href);
  } catch {
    return null;
  }
}

/** Replies made before publication snapshots still carry their declared sources. */
export function feedbackSourceUrls(reply: string): string[] {
  const urls = new Set<string>();
  for (const line of reply.split('\n')) {
    const inline = /^\s*«.+»\s+(https?:\/\/[^\s<>]+)(?=\s*$|\s+(?:· (?:Read at|Source date|وقت القراءة|تاريخ المصدر) |\((?:Read at|وقت القراءة) ))/iu.exec(line);
    const inlineUrl = inline && feedbackPageKey(inline[1]);
    if (inlineUrl) urls.add(inlineUrl);
    if (!/^\s*(?:\*\*)?(?:source(?: link)?|a second source (?:agrees|differs)|المصدر|رابط المصدر|مصدر ثان(?:ٍ)? (?:يؤكد|يختلف))\s*[:：]/iu.test(line)) continue;
    for (const match of line.matchAll(/\]\((https?:\/\/[^\s<>]+)\)|(?:^|\s)(https?:\/\/[^\s<>]+)/giu)) {
      const url = feedbackPageKey(match[1] ?? match[2]);
      if (url) urls.add(url);
    }
  }
  return [...urls];
}
