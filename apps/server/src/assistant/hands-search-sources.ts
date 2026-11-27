import { planSources, type SearchEngine, type SearchProvider, type SearchSelection, type SourceDomain, type SourcePlan } from '@mohassan/browser';
import { assessRequestScope } from './request-scope.js';

const domainLabels: Record<SourceDomain, { ar: string; en: string }> = {
  news: { ar: 'الأخبار', en: 'news' },
  health: { ar: 'الصحة', en: 'health' },
  official_statistics: { ar: 'الإحصاءات الرسمية', en: 'official statistics' },
  government: { ar: 'الخدمات الحكومية', en: 'government services' },
  programming: { ar: 'البرمجة', en: 'programming' },
  scholarly: { ar: 'الأبحاث العلمية', en: 'scholarly research' },
  religion: { ar: 'الدين', en: 'religion' },
  language: { ar: 'اللغة', en: 'language' },
  travel: { ar: 'السفر', en: 'travel' },
  encyclopedia: { ar: 'الموسوعات', en: 'encyclopedias' },
  general_web: { ar: 'الويب العام', en: 'the general web' },
};

export function publicSourceTurns(turns: readonly string[] = []): string[] {
  const previous = turns.at(-1);
  return previous && assessRequestScope(previous).publicQueryEligible ? [previous] : [];
}

export function allowsSearchSource(address: string, plan: SourcePlan): boolean {
  const url = URL.parse(address);
  if (!url || !['http:', 'https:'].includes(url.protocol)) return false;
  const host = url.hostname.replace(/\.$/u, '');
  const matches = (site: string) => host === site || host.endsWith(`.${site}`);
  return !plan.excludedSites.some(matches) && (!plan.explicitSites.length || plan.explicitSites.some(matches));
}

export function plannedSearchProgress(plan: SourcePlan, selection: SearchSelection): string | undefined {
  if (!selection.searchedProviders.length) return undefined;
  const ar = plan.language === 'ar';
  const separator = ar ? '، ' : ', ';
  const providers = selection.searchedProviders.join(separator);
  const reason = selection.wikipediaFallback
    ? ar ? 'لم يتوفر مصدر متخصص لهذا السؤال العام' : 'a specialized source was unavailable for this general question'
    : plan.reasons.map(item => item[plan.language]).join(ar ? '، و' : ', and ');
  return ar ? `بحثتُ في: ${providers} لأن ${reason}` : `I searched ${providers} because ${reason}`;
}

export function unavailableSearchSources(plan: SourcePlan, selection: SearchSelection): string | undefined {
  const ar = plan.language === 'ar';
  const separator = ar ? '، ' : ', ';
  const sites = selection.unavailableSites.join(separator);
  const domains = selection.unavailableDomains.map(domain => domainLabels[domain][plan.language]).join(separator);
  const limits = [
    sites && (ar ? `تعذّر البحث تلقائيًا في ${sites} لأنني لا أملك وسيلة بحث آلي متاحة فيها.` : `I cannot search ${sites} automatically with the sources currently available to me.`),
    domains && (ar ? `لا تتوفر حاليًا مصادر بحث آلية لمجال ${domains}.` : `Automatic search sources for ${domains} are currently unavailable.`),
  ].filter(Boolean);
  return limits.join(' ') || undefined;
}

export async function searchCouncilSources(search: SearchProvider, question: string, request: string, ownerId: string, signal: AbortSignal, previous?: string | null) {
  const plan = planSources(request, publicSourceTurns(previous ? [previous] : []));
  const allows = (url: string) => allowsSearchSource(url, plan);
  const engine = search as Partial<Pick<SearchEngine, 'execute'>>;
  const outcome = await engine.execute?.call(search, question, 8, signal, { ownerId, plan });
  const hits = outcome?.hits ?? await search.search(question, 8, signal, { ownerId, plan });
  return { hits: hits.filter(hit => allows(hit.url)), allows, note: outcome?.selection && unavailableSearchSources(plan, outcome.selection) };
}
