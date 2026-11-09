import type { SearchHit } from '../research.js';

const normalizeWord = (word:string) => word.normalize('NFKC').toLowerCase().replace(/[أإآٱ]/gu,'ا').replace(/[\u0640\p{M}\p{Cf}]/gu,'').replace(/^ال(?=\p{L}{3})/u,'');
const noise = new Set('the a an of for to in on and or is are what how latest official find search please ما ماذا هو هي من في على عن الى إلى كيف ابحث البحث أحدث اخر آخر'.split(' ').map(normalizeWord));
// Request intent is not evidence of the academic subject. Explicitly quoted terms remain mandatory.
const academicRequestWords = new Set('research paper papers study studies journal journals doi دراسة دراسات بحث علمي ورقة علمية'.split(' ').map(normalizeWord));
const phraseText = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[أإآٱ]/gu,'ا').replace(/[\u0640\p{M}\p{Cf}]/gu,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function matchesSearchPhrases(query: { phrases: string[] }, ...texts: string[]): boolean {
  const normalized=texts.map(text=>` ${phraseText(text)} `);
  return query.phrases.every(phrase=>normalized.some(text=>text.includes(` ${phrase} `)));
}
export function searchTokens(text: string): string[] {
  return (text.normalize('NFKC').toLowerCase().replace(/[\u0640\p{M}\p{Cf}]/gu, '').match(/[\p{L}\p{N}]+/gu) ?? [])
    .map(normalizeWord).filter(word => (word.length > 1 || ['c','r'].includes(word)) && !noise.has(word));
}
export function canonicalUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('SEARCH_URL_DENIED');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(?:utm_.+|fbclid|gclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
  // Preserve the order of meaningful parameters (some sites sign them).
  return url.href;
}
export function compileQuery(input: string) {
  const text = input.normalize('NFKC').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, 500);
  if((text.match(/"/g)??[]).length%2)throw new Error('SEARCH_PHRASE_UNCLOSED');
  const phrases=[...new Set([...text.matchAll(/"([^"]*)"/g)].map(match=>phraseText(match[1]!)))];
  if(phrases.length>4||phrases.some(phrase=>!phrase||phrase.length>160))throw new Error('SEARCH_PHRASE_INVALID');
  const sites: string[] = [];
  const question = text.replace(/"[^"]*"|(?:^|\s)site:([^\s]+)/gi, (matched, domain?: string) => {
    if(domain===undefined)return matched;
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.?$/i.test(domain)) throw new Error('SEARCH_SITE_INVALID');
    sites.push(domain.toLowerCase().replace(/\.$/,''));
    return ' ';
  }).trim();
  const intent=/\b(?:paper|doi|research|study|journal)\b|دراسة|دراسات|بحث علمي|ورقة علمية/i.test(question) ? 'scholarly' as const
    : /\b(?:javascript|typescript|node|react|python|postgresql|api|code|error|programming|css|sql)\b|برمج|كود/i.test(question) ? 'technical' as const : 'general' as const;
  // Only known request scaffolding is translated, and only beside an English technical subject.
  // Preserve quoted phrases and all other Arabic subject words instead of guessing a translation.
  const scaffolding:Record<string,string>={شرح:'',تعلم:'',استخدام:'',برمجة:'programming',كود:'code',اخطاء:'error'};
  const retrievalQuestion=intent==='technical'&&/\b(?:javascript|typescript|node|react|python|postgresql|api|css|sql)\b/i.test(question)
    ? question.replace(/"[^"]*"|\p{Script=Arabic}[\p{Script=Arabic}\p{M}]*/gu,word=>word.startsWith('"')?word:scaffolding[normalizeWord(word)]??word).replace(/\s+/g,' ').trim()
    : question;
  const quotedTokens = new Set(phrases.flatMap(phrase=>searchTokens(phrase)));
  const tokens = [...new Set([...searchTokens(retrievalQuestion),...quotedTokens])]
    .filter(term=>intent!=='scholarly'||!academicRequestWords.has(term)||quotedTokens.has(term));
  if (!question || !tokens.length) throw new Error('SEARCH_QUERY_EMPTY');
  return { question, retrievalQuestion, sites: [...new Set(sites)], tokens, phrases,
    language: /\p{Script=Arabic}/u.test(retrievalQuestion) ? 'ar' as const : 'en' as const,
    intent,
    timeSensitive: /\b(?:today|weather|price|latest|now|train|flight)\b|اليوم|طقس|سعر|اسعار|الآن|قطار|طيران/i.test(question) };
}
/** Bounded excerpts copied from the local document; quoted evidence is never synthesized. */
export function localSearchSnippet(query: ReturnType<typeof compileQuery>, title: string, content: string): string | null {
  const maximum=1400, missing=query.phrases.filter(phrase=>!matchesSearchPhrases({phrases:[phrase]},title));
  if(!missing.length){
    const passages=content.match(/.{1,650}(?:\s|$)/gu)??[];
    return passages.map((text,index)=>({text,index,score:query.tokens.filter(term=>searchTokens(text).includes(term)).length}))
      .sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,2).sort((a,b)=>a.index-b.index).map(item=>item.text.trim()).join(' … ').slice(0,maximum);
  }
  // Keep source offsets while applying precisely the same word/mark normalization as phrase matching.
  // A compatibility glyph can expand to several words; all retain its original source span.
  const words=[...content.matchAll(/\S+/gu)].flatMap(match=>phraseText(match[0]).split(' ').filter(Boolean).map(word=>({word,start:match.index,end:match.index+match[0].length})));
  const spans:{start:number;end:number}[]=[];
  for(const phrase of missing){
    const terms=phrase.split(' ');
    const index=words.findIndex((_,index)=>terms.every((term,offset)=>words[index+offset]?.word===term));
    if(index<0)return null;
    spans.push({start:words[index]!.start,end:words[index+terms.length-1]!.end});
  }
  const merge=(values:typeof spans)=>values.sort((a,b)=>a.start-b.start).reduce<typeof spans>((result,span)=>{
    const previous=result.at(-1);if(previous&&span.start<=previous.end)previous.end=Math.max(previous.end,span.end);else result.push({...span});return result;
  },[]);
  const required=merge(spans),used=required.reduce((sum,span)=>sum+span.end-span.start,0)+Math.max(0,required.length-1)*3;
  if(used>maximum)return null; // Never truncate away a required phrase to fit the excerpt budget.
  const context=Math.min(90,Math.floor((maximum-used)/(2*required.length)));
  const expanded=merge(required.map(span=>({start:Math.max(0,span.start-context),end:Math.min(content.length,span.end+context)})));
  const snippet=expanded.map(span=>content.slice(span.start,span.end).trim()).join(' … ');
  return snippet.length<=maximum&&matchesSearchPhrases(query,title,snippet)?snippet:null;
}
export type RankedHit = SearchHit & { providers: string[]; relevance: 'lexical'; score: number };
/** Intent-specific source ordering, then BM25 + reciprocal rank fusion; never arrival time. */
export function rankResults(query: ReturnType<typeof compileQuery>, results: readonly { provider: string; hits: SearchHit[] }[], limit: number): RankedHit[] {
  const docs = new Map<string, { hit: SearchHit; providers: Set<string>; rrf: number }>();
  const descriptionScore = (hit:SearchHit) => { const title=new Set(searchTokens(hit.title)),snippet=new Set(searchTokens(hit.snippet));return query.tokens.reduce((score,term)=>score+(title.has(term)?2:snippet.has(term)?1:0),0); };
  for (const result of [...results].sort((a, b) => a.provider.localeCompare(b.provider))) {
    const seen = new Set<string>();
    result.hits.slice(0, 40).forEach((hit, rank) => {
      try {
        const url = canonicalUrl(hit.url), host = new URL(url).hostname;
        if(!matchesSearchPhrases(query,hit.title,hit.snippet))return;
        if (seen.has(url) || query.sites.length && !query.sites.some(site => host === site || host.endsWith(`.${site}`))) return;
        seen.add(url);
        const row = docs.get(url) ?? { hit: { ...hit, url }, providers: new Set<string>(), rrf: 0 };
        // A duplicate's richer description must not be discarded solely because its provider sorts later.
        if(descriptionScore(hit)>descriptionScore(row.hit))row.hit={...hit,url};
        row.providers.add(result.provider); row.rrf += 1 / (60 + rank + 1); docs.set(url, row);
      } catch { /* malformed or nonpublic source cannot be ranked */ }
    });
  }
  const entries = [...docs.values()].map(row => ({ ...row, terms: searchTokens(`${row.hit.title} ${row.hit.title} ${row.hit.snippet} ${new URL(row.hit.url).hostname}`) }));
  const average = entries.reduce((total, row) => total + row.terms.length, 0) / Math.max(1, entries.length);
  // This is a request-purpose prior, not a claim that DOI metadata proves a paper or its accuracy.
  // Apply it only after the same subject/phrase gates; generic research words never admit a hit.
  const academicPriority = (providers: readonly string[]) => query.intent === 'scholarly' && providers.some(provider => provider === 'Crossref' || provider === 'arXiv') ? 1 : 0;
  const ranked = entries.flatMap(row => {
    let score = 0, matched = 0;
    for (const term of query.tokens) {
      const frequency = row.terms.filter(word => word === term).length;
      if (!frequency) continue;
      matched++;
      const documents = entries.filter(entry => entry.terms.includes(term)).length;
      score += Math.log(1 + (entries.length - documents + 0.5) / (documents + 0.5)) * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * row.terms.length / Math.max(1, average)));
    }
    if (query.tokens.length && matched < Math.min(2, query.tokens.length)) return [];
    return [{ ...row.hit, providers: [...row.providers].sort(), relevance: 'lexical' as const, score: Math.round((score + row.rrf * 10) * 1e6) / 1e6 }];
  }).sort((a, b) => academicPriority(b.providers) - academicPriority(a.providers) || b.score - a.score || a.url.localeCompare(b.url));
  const counts = new Map<string, number>(), selected: RankedHit[] = [];
  for (const row of ranked) {
    const host = new URL(row.url).hostname, count = counts.get(host) ?? 0;
    if (count >= 3) continue;
    selected.push(row); counts.set(host, count + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}
