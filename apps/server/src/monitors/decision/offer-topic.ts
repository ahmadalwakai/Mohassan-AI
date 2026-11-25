export function monitorOfferTopic(url: string): string {
  const canonical = new URL(url);
  for (const key of [...canonical.searchParams.keys()]) {
    if (/^(?:utm_.+|gclid|fbclid)$/iu.test(key)) canonical.searchParams.delete(key);
  }
  canonical.searchParams.sort();
  return `${canonical.hostname}${canonical.pathname.replace(/\/$/u, '')}${canonical.search}`;
}
