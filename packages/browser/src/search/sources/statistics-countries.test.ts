import { describe, expect, it } from 'vitest';
import { matchStatisticsCountry } from './statistics-countries.js';

// Expected country codes and aliases were checked 2026-11-27 against:
// https://api.worldbank.org/v2/country?format=json&per_page=400
// https://api.worldbank.org/v2/ar/country?format=json&per_page=400
// https://raw.githubusercontent.com/unicode-org/cldr-json/49.0.0/cldr-json/cldr-localenames-full/main/en/territories.json
// https://raw.githubusercontent.com/unicode-org/cldr-json/49.0.0/cldr-json/cldr-localenames-full/main/ar/territories.json
// The World Bank's Arabic Human Capital Index table lists السعودية:
// https://openknowledge.worldbank.org/server/api/core/bitstreams/c9c779fe-4868-5d89-9179-4451fc775eef/content
describe('official statistics country aliases', () => {
  it.each([
    ['كم عدد سكان أُستراليا؟', 'AU', 'AUS', 'أُستراليا'],
    ['ما الناتج المحلي لمصر؟', 'EG', 'EGY', 'لمصر'],
    ['ما الناتج المحلي للبنان؟', 'LB', 'LBN', 'للبنان'],
    ['ما الناتج المحلي بالسعودية؟', 'SA', 'SAU', 'بالسعودية'],
    ['ما الناتج المحلي للسعودية؟', 'SA', 'SAU', 'للسعودية'],
    ['inflation in Turkey', 'TR', 'TUR', 'Turkey'],
    ['inflation in Türkiye', 'TR', 'TUR', 'Türkiye'],
    ['GDP of Egypt, Arab Rep.', 'EG', 'EGY', 'Egypt, Arab Rep'],
    ['GDP of Guinea-Bissau', 'GW', 'GNB', 'Guinea-Bissau'],
    ['GDP of the US', 'US', 'USA', 'US'],
  ])('matches %s', (text, iso2, iso3, matched) => {
    expect(matchStatisticsCountry(text)).toMatchObject({ iso2, iso3, matched });
  });

  it.each([
    'population of Atlantis',
    'tell us the GDP',
    'how does GDP in Guinea compare with Papua New Guinea?',
  ])('leaves %s unresolved', text => {
    expect(matchStatisticsCountry(text)).toBeUndefined();
  });
});
