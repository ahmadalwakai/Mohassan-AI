export const ENTITY_CATEGORIES = [
  'people', 'places', 'countries', 'cities', 'organizations', 'events', 'works', 'units',
] as const;

export type EntityCategory = (typeof ENTITY_CATEGORIES)[number];
export type Language = 'ar' | 'en';
export type LocalizedText = Partial<Record<Language, string>>;

export interface WikidataSnak {
  snaktype: 'value' | 'somevalue' | 'novalue';
  property: string;
  datatype?: string;
  datavalue?: { type: string; value: unknown };
}

export interface WikidataReference {
  hash?: string;
  snaks: Record<string, WikidataSnak[]>;
  'snaks-order'?: string[];
}

export interface StoredClaim {
  property: string;
  id: string | null;
  rank: 'preferred' | 'normal' | 'deprecated';
  snak: WikidataSnak;
  qualifiers: Record<string, WikidataSnak[]>;
  references: WikidataReference[];
}

export interface StoredEntity {
  id: string;
  revision: number | null;
  sitelinkCount?: number;
  labels: LocalizedText;
  descriptions: LocalizedText;
  aliases: Partial<Record<Language, string[]>>;
  categories: EntityCategory[];
  claims: StoredClaim[];
}

export interface BuildInput {
  source: string;
  dumpDate: string;
  fingerprint: string;
  categories: readonly EntityCategory[];
}

export interface DataCard extends BuildInput {
  dataset: 'wikidata';
  license: 'CC0-1.0';
  scannedEntities: number;
  entityCount: number;
  claimCount: number;
}
