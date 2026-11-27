import type { DocumentedProvider, SearchProviderContext, SearchQuery } from './providers.js';
import type { PlannedProvider, PlannedProviderInfo, SourceDomain, SourcePlan } from './source-plan.js';

export interface SearchSelection {
  searchedProviders: string[];
  unavailableSites: string[];
  unavailableDomains: SourceDomain[];
  wikipediaFallback?: true;
}

type Coverage = Pick<PlannedProviderInfo, 'domains' | 'languages' | 'hosts'> & { access?: PlannedProviderInfo['access'] };

// Output hosts of the built-in adapters in providers.ts and extra-providers.ts.
// Checked 2026-11-27: https://www.wikipedia.org/, https://api.stackexchange.com/docs/advanced-search,
// https://news.ycombinator.com/, https://www.crossref.org/documentation/retrieve-metadata/rest-api/,
// https://info.arxiv.org/help/api/user-manual.html.
const builtInCoverage: Record<string, Coverage> = {
  Wikipedia: { domains: ['encyclopedia'], languages: ['ar', 'en'], hosts: ['ar.wikipedia.org', 'en.wikipedia.org'] },
  'Stack Exchange': { domains: ['programming'], languages: ['en'], hosts: ['stackoverflow.com'] },
  'Hacker News': { domains: ['programming'], languages: ['en'], hosts: ['news.ycombinator.com'] },
  Crossref: { domains: ['scholarly'], languages: ['ar', 'en'], hosts: ['doi.org'] },
  arXiv: { domains: ['scholarly'], languages: ['en'], hosts: ['arxiv.org'] },
};

const hostName = (value: string) => value.toLowerCase().replace(/\.$/u, '');
function hostInSite(host: string, site: string): boolean {
  const name = hostName(host);
  return name === site || name.endsWith(`.${site}`);
}

function siteCoverage(provider: DocumentedProvider): Coverage | undefined {
  if ('planned' in provider) return (provider as PlannedProvider).planned;
  if (provider.accessBasis !== 'documented_api' || !Object.hasOwn(builtInCoverage, provider.name)) return undefined;
  return builtInCoverage[provider.name];
}

export function selectSources(providers: readonly DocumentedProvider[], query: SearchQuery, plan: SourcePlan, context?: SearchProviderContext) {
  const explicitSites = [...new Set([...query.sites, ...plan.explicitSites].map(hostName))];
  const excludedSites = [...new Set(plan.excludedSites.map(hostName))];
  const siteAllowed = (host: string) => !excludedSites.some(site => hostInSite(host, site));
  const allowedSites = explicitSites.filter(siteAllowed);
  const candidates = providers.flatMap(provider => {
    const details = siteCoverage(provider);
    if (!details) return [];
    const hosts = details.hosts.map(hostName).filter(siteAllowed);
    if (details.hosts.length && !hosts.length) return [];
    const siteDiscovery = details.access === 'opensearch' && !details.hosts.length;
    if (siteDiscovery && !explicitSites.length) return [];
    const sites = siteDiscovery ? allowedSites : allowedSites.filter(site => hosts.some(host => hostInSite(host, site) || hostInSite(site, host)));
    if (explicitSites.length && !sites.length) return [];
    const languages = provider.name === 'Wikipedia'
      ? details.languages.filter(language => hosts.includes(`${language}.wikipedia.org`)
        && (!sites.length || sites.some(site => hostInSite(`${language}.wikipedia.org`, site))))
      : details.languages;
    const preferred = languages.includes(plan.language);
    const language = preferred ? plan.language : languages[0];
    if (!language) return [];
    const coveredSites = provider.name === 'Wikipedia'
      ? sites.filter(site => hostInSite(`${language}.wikipedia.org`, site)) : sites;
    return [{ provider, details, preferred, query: { ...query, sites: coveredSites, language } }];
  });
  const domains: SourceDomain[] = plan.domains.length ? plan.domains : ['general_web'];
  const relevant = explicitSites.length ? candidates : candidates.filter(({ details }) => details.domains.some(domain => domains.includes(domain)));
  const supportsQuery = (entry: typeof candidates[number]) => entry.provider.supports(entry.query, context);
  const matched = relevant.filter(supportsQuery);
  // While a family has no provider available to this account, retain the documented search paths that already support the query.
  const fallback = !relevant.length && !explicitSites.length
    ? candidates.filter(({ provider }) => provider.accessBasis === 'documented_api' && Object.hasOwn(builtInCoverage, provider.name)).filter(supportsQuery) : [];
  const selected = [...matched, ...fallback].sort((a, b) => Number(b.preferred) - Number(a.preferred));
  const wikipediaFallback = fallback.some(entry => entry.provider.name === 'Wikipedia');
  const selection: Pick<SearchSelection, 'unavailableDomains' | 'wikipediaFallback'> = {
    unavailableDomains: explicitSites.length ? [] : plan.domains.filter(domain => !matched.some(entry => entry.details.domains.includes(domain))),
    ...(wikipediaFallback ? { wikipediaFallback: true } : {}),
  };
  const wikipediaAllowed = allowedSites.some(site => hostInSite(site, 'wikipedia.org'))
    || !explicitSites.length && (plan.domains.includes('encyclopedia') || wikipediaFallback);
  const allowsHit = (url: string, scope = allowedSites) => {
    try {
      const host = new URL(url).hostname;
      return siteAllowed(host) && (wikipediaAllowed || !hostInSite(host, 'wikipedia.org'))
        && (!explicitSites.length || scope.some(site => hostInSite(host, site)));
    } catch { return false; }
  };
  const localSites = explicitSites.length ? allowedSites
    : plan.domains.length && !plan.domains.includes('general_web') ? selected.flatMap(entry => entry.details.hosts.map(hostName)) : undefined;

  return {
    eligible: selected.map(({ provider, query }) => ({ provider, query })),
    preferred: new Set(selected.filter(entry => entry.preferred).map(entry => entry.provider.name)),
    sites: allowedSites,
    selection,
    allowsHit,
    searchLocal: !query.timeSensitive && localSites?.length !== 0,
    allowsLocalHit: (url: string) => allowsHit(url) && (!localSites || localSites.some(site => hostInSite(new URL(url).hostname, site))),
  };
}
