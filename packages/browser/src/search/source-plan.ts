import type { DocumentedProvider } from './providers.js';

export type SourceDomain = 'news' | 'health' | 'official_statistics' | 'government' | 'programming' | 'scholarly' | 'religion' | 'language' | 'travel' | 'encyclopedia' | 'general_web';

export interface SourcePlan {
  explicitSites: string[];
  excludedSites: string[];
  domains: SourceDomain[];
  language: 'ar' | 'en';
  fresh: boolean;
  reasons: { ar: string; en: string }[];
}

export interface PlannedProviderInfo {
  domains: SourceDomain[];
  languages: ('ar' | 'en')[];
  access: 'documented_api' | 'feed' | 'opensearch' | 'sitemap';
  contract: { url: string; checked: string };
  hosts: string[];
}

export type PlannedProvider = DocumentedProvider & { planned: PlannedProviderInfo };
