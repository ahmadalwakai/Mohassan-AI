import { describe, expect, it } from 'vitest';
import {
  MAX_PUBLIC_QUERY_LENGTH, MAX_PUBLIC_QUERY_TERMS, MAX_PUBLIC_QUERY_SOURCE_LENGTH,
  describeSearchDestination, extractPublicSearchQueries, isSearchEntryElement, mergePublicQueryTerms, reviewGeneratedPublicQuery,
} from '../apps/server/src/assistant/public-query-provenance.js';

describe('host-observed public query vocabulary', () => {
  it('merges canonical public words without mutating source inputs', () => {
    const existing = ['harbour', 'library'];
    const texts = ['Harbour LIBRARY opening hours', 'أوقات مكتبة الإسكندرية ٢٥'];
    const result = mergePublicQueryTerms(existing, texts);
    expect(result).toEqual(expect.arrayContaining(['harbour', 'library', 'opening', 'hours', 'اوقات', 'مكتبه', 'الاسكندريه', '25']));
    expect(result.filter(term => term === 'harbour')).toHaveLength(1);
    expect(existing).toEqual(['harbour', 'library']);
    expect(texts[0]).toBe('Harbour LIBRARY opening hours');
  });

  it('retains only a bounded recent set and refreshes repeated words', () => {
    const initial = Array.from({ length: MAX_PUBLIC_QUERY_TERMS }, (_, index) => `word${index}`);
    const result = mergePublicQueryTerms(initial, ['word0 newest secondnewest']);
    expect(result).toHaveLength(MAX_PUBLIC_QUERY_TERMS);
    expect(result).toContain('word0');
    expect(result).not.toContain('word1');
    expect(result.slice(-3)).toEqual(['word0', 'newest', 'secondnewest']);
  });

  it('does not let malformed previous state grant vocabulary', () => {
    expect(mergePublicQueryTerms(['hidden value'], ['Public museum'])).toEqual(['public', 'museum']);
    expect(mergePublicQueryTerms({ hidden: 'secret' }, ['Public museum'])).toEqual(['public', 'museum']);
    expect(mergePublicQueryTerms(Array(MAX_PUBLIC_QUERY_TERMS + 1).fill('secret'), [])).toEqual([]);
  });

  it('omits oversized or credential-bearing source items whole', () => {
    const fakeToken = 'sk-' + 'x'.repeat(24);
    const result = mergePublicQueryTerms([], [`Public text ${fakeToken} must not be ingested`, 'ordinary source', 'a'.repeat(MAX_PUBLIC_QUERY_SOURCE_LENGTH + 1)]);
    expect(result).toEqual(['ordinary', 'source']);
    expect(JSON.stringify(result)).not.toContain(fakeToken);
  });

  it('does not assume that arbitrary persisted words prove a source was public', () => {
    // The caller owns ingestion authority. The shape check cannot determine
    // whether this canonical word came from a real public search or private data.
    expect(reviewGeneratedPublicQuery('Search for a library.', 'library lumagrove', ['lumagrove']).eligible).toBe(true);
    expect(reviewGeneratedPublicQuery('Search for a library.', 'library lumagrove', []).eligible).toBe(false);
  });
});

describe('generated public query provenance', () => {
  it('allows current words in a different order with bounded harmless syntax', () => {
    expect(reviewGeneratedPublicQuery('Find opening hours for Harbour Community Library.', 'official Harbour Community Library website opening hours')).toMatchObject({ eligible: true, reason: 'eligible', unattributedCount: 0 });
    expect(reviewGeneratedPublicQuery('ما مواعيد مكتبة الإسكندرية؟', 'مواعيد مكتبه الاسكندريه الموقع الرسمي')).toMatchObject({ eligible: true, unattributedCount: 0 });
  });

  it('allows expansion only from actual host-provided public context or result words', () => {
    const known = mergePublicQueryTerms([], ['Harbour Library opening hours. Managed by Cedar Borough Council.']);
    expect(reviewGeneratedPublicQuery('Find the library opening hours.', 'Cedar Borough Council library opening hours', known)).toMatchObject({ eligible: true });
    expect(reviewGeneratedPublicQuery('Find the library opening hours.', 'Maple Private Customer Register library opening hours', known)).toMatchObject({ eligible: false, reason: 'unattributed_terms' });
  });

  it('does not infer safety from an intervening public turn', () => {
    const publicOnly = mergePublicQueryTerms([], ['Harbour Library opening hours and return policy']);
    const result = reviewGeneratedPublicQuery('Find the library return policy.', 'library return policy PRIVATE-DELIVERY-QX-482', publicOnly);
    expect(result).toMatchObject({ eligible: false, reason: 'unattributed_terms', unattributedCount: 4 });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(result)).not.toContain('482');
  });

  it('does not grant arbitrary synonyms supplied by the model', () => {
    expect(reviewGeneratedPublicQuery('Find the library opening hours.', 'library beautiful expansive facility timetable')).toMatchObject({ eligible: false, reason: 'unattributed_terms' });
  });

  it('normalises case, Arabic digits, formatting controls and encoded values before checking', () => {
    expect(reviewGeneratedPublicQuery('Find Hall 25 opening hours.', 'HALL ٢٥ opening hours')).toMatchObject({ eligible: true });
    expect(reviewGeneratedPublicQuery('Find Hall opening hours.', 'hall opening hours %2550RIVATE%2DVALUE')).toMatchObject({ eligible: false, reason: 'unattributed_terms' });
    expect(reviewGeneratedPublicQuery('Find Hall opening hours.', 'hall opening hours PRI\u200bVATE')).toMatchObject({ eligible: false, reason: 'unattributed_terms' });
  });

  it('rejects overlong queries rather than dropping the unreviewed tail', () => {
    const query = 'library '.repeat(70) + 'PRIVATE-TAIL';
    expect(query.length).toBeGreaterThan(MAX_PUBLIC_QUERY_LENGTH);
    expect(reviewGeneratedPublicQuery('library', query)).toMatchObject({ eligible: false, reason: 'invalid_query' });
  });

  it('rejects invalid state and reports only count/code metadata', () => {
    expect(reviewGeneratedPublicQuery('library', 'library', ['not canonical'])).toMatchObject({ eligible: false, reason: 'invalid_public_terms' });
    expect(reviewGeneratedPublicQuery('', 'library')).toMatchObject({ eligible: false, reason: 'invalid_request' });
    expect(reviewGeneratedPublicQuery('library', '---')).toMatchObject({ eligible: false, reason: 'invalid_query' });
    expect(reviewGeneratedPublicQuery('library', 'library', Array(MAX_PUBLIC_QUERY_TERMS + 1).fill('library'))).toMatchObject({ eligible: false, reason: 'invalid_public_terms' });
    const result = reviewGeneratedPublicQuery('library', 'library MY-HIDDEN-VALUE');
    expect(Object.keys(result).sort()).toEqual(['eligible', 'reason', 'termCount', 'unattributedCount']);
    expect(JSON.stringify(result)).not.toContain('HIDDEN');
  });

  it('does not waive known credential checks even when words were supplied by the current request', () => {
    const fakeToken = 'sk-' + 'a'.repeat(24);
    expect(reviewGeneratedPublicQuery(`Search for ${fakeToken}`, fakeToken)).toMatchObject({ eligible: false, reason: 'sensitive_query' });
    expect(reviewGeneratedPublicQuery('What is an API key?', 'API key')).toMatchObject({ eligible: true });
  });
});

describe('search-bearing URL operands', () => {
  it('extracts known engine queries and generic search-like routes without network access', () => {
    expect(extractPublicSearchQueries('https://www.google.co.uk/search?q=harbour+library')).toEqual(['harbour library']);
    expect(extractPublicSearchQueries('https://www.bing.com/?q=harbour%20hours')).toEqual(['harbour hours']);
    expect(extractPublicSearchQueries('https://catalogue.example/search?query=maps')).toEqual(['maps']);
    expect(extractPublicSearchQueries('https://catalogue.example/search-results.php?q=maps')).toEqual(['maps']);
    expect(extractPublicSearchQueries('https://catalogue.example/w/index.php?search=maps')).toEqual(['maps']);
    expect(extractPublicSearchQueries('https://video.example/results?search_query=maps')).toEqual(['maps']);
    expect(extractPublicSearchQueries('https://search.yahoo.com/search?p=maps')).toEqual(['maps']);
    expect(extractPublicSearchQueries('https://yandex.com/search/?text=maps')).toEqual(['maps']);
    expect(extractPublicSearchQueries('https://www.baidu.com/s?wd=maps')).toEqual(['maps']);
  });

  it('reviews every duplicate search operand, including encoded keys and paths', () => {
    expect(extractPublicSearchQueries('https://gateway.example/%2573earch?%71=public&q=PRIVATE%252DREFERENCE')).toEqual(['public', 'PRIVATE-REFERENCE']);
    expect(extractPublicSearchQueries('https://www.google.com/search?q=public&query=private&search=other')).toEqual(['public', 'private', 'other']);
  });

  it('extracts search query state carried in a client-side fragment', () => {
    expect(extractPublicSearchQueries('https://www.google.com/#q=harbour+library')).toEqual(['harbour library']);
    expect(extractPublicSearchQueries('https://catalogue.example/search#/results?query=maps')).toEqual(['maps']);
    expect(extractPublicSearchQueries('https://catalogue.example/#/search?q=maps')).toEqual(['maps']);
  });

  it('does not truncate a long search operand or silently bless an unknown URL shape', () => {
    const query = 'x'.repeat(600);
    expect(extractPublicSearchQueries(`https://catalogue.example/search?q=${query}`)).toEqual([query]);
    expect(reviewGeneratedPublicQuery('x', extractPublicSearchQueries(`https://catalogue.example/search?q=${query}`)[0]!)).toMatchObject({ eligible: false, reason: 'invalid_query' });
    expect(extractPublicSearchQueries('https://notgoogle.example/article?q=unknown')).toEqual([]);
    expect(extractPublicSearchQueries('https://www.google.com.evil.example/article?q=unknown')).toEqual([]);
    expect(extractPublicSearchQueries('not a URL')).toEqual([]);
    expect(() => extractPublicSearchQueries('https://example.test/search?q=' + 'a'.repeat(2501))).toThrow('PUBLIC_SEARCH_URL_LIMIT');
  });
});

describe('search entry metadata', () => {
  it('distinguishes public engines, structural endpoints and private same-origin applications', () => {
    expect(describeSearchDestination('https://www.google.com/')).toEqual({ knownPublicEngine: true, searchEndpoint: false });
    expect(describeSearchDestination('https://www.bing.com/search?q=maps')).toEqual({ knownPublicEngine: true, searchEndpoint: true });
    expect(describeSearchDestination('https://portal.example/search?q=customer')).toEqual({ knownPublicEngine: false, searchEndpoint: true });
    expect(describeSearchDestination('https://mail.google.com/mail/u/0/')).toEqual({ knownPublicEngine: false, searchEndpoint: false });
    expect(describeSearchDestination('https://docs.google.com/document/d/fixture/edit')).toEqual({ knownPublicEngine: false, searchEndpoint: false });
    expect(describeSearchDestination('https://accounts.google.com/')).toEqual({ knownPublicEngine: false, searchEndpoint: false });
    expect(describeSearchDestination('https://private.portal.example/dashboard')).toEqual({ knownPublicEngine: false, searchEndpoint: false });
    expect(describeSearchDestination('not a URL')).toEqual({ knownPublicEngine: false, searchEndpoint: false });
  });

  it('recognises a searchbox or search-labelled text field without authorizing its destination', () => {
    expect(isSearchEntryElement({ role: 'searchbox', label: '' })).toBe(true);
    expect(isSearchEntryElement({ role: 'textbox', field: 'text', label: 'Search the catalogue' })).toBe(true);
    expect(isSearchEntryElement({ role: 'searchbox', field: 'identifier', label: 'Search by email' })).toBe(true);
    expect(isSearchEntryElement({ role: 'combobox', label: 'بحث في الموقع' })).toBe(true);
    expect(isSearchEntryElement({ role: 'button', label: 'Search' })).toBe(false);
    expect(isSearchEntryElement({ role: 'textbox', label: 'Research assistant name' })).toBe(false);
    expect(isSearchEntryElement({ role: 'textbox', field: 'password', label: 'Search' })).toBe(false);
    expect(isSearchEntryElement({ role: 'textbox', field: 'identifier', label: 'Email address' })).toBe(false);
    expect(isSearchEntryElement({ role: 'searchbox', disabled: true })).toBe(false);
    expect(isSearchEntryElement(null)).toBe(false);
  });
});
