import type { SearchHit } from '../research.js';
import { webFreshnessText } from './freshness.js';
export { webFreshnessText } from './freshness.js';

const normalizeWord = (word:string) => word.normalize('NFKC').toLowerCase().replace(/[أإآٱ]/gu,'ا').replace(/[\u0640\p{M}\p{Cf}]/gu,'').replace(/^ال(?=\p{L}{3})/u,'');
const noise = new Set('the a an of for to in on and or is are what how which who where when why does do latest newest current now today official find search please ما ماذا هو هي هل من في على عن الى إلى كيف كم متى اين أين لماذا ابحث البحث أحدث اخر آخر اليوم الآن الان حاليا'.split(' ').map(normalizeWord));
const wikipediaHost = (host: string) => host === 'wikipedia.org' || host.endsWith('.wikipedia.org');
const wikipediaExclusion = /(?:\b(?:not\s+(?:from\s+)?|without\s+|exclud(?:e|ing)\s+|except\s+|avoid\s+|don['’]t\s+use\s+)|(?:بدون|عدا|غير|باستثناء|تجنب|لا\s+(?:تستخدم|تستعمل|تعتمد\s+على))\s+)(?:wikipedia|ويكيبيديا|ويكبيديا)|(?:^|\s)-(?:site:(?:[a-z0-9-]+\.)*wikipedia\.org\b|wikipedia\b|ويكيبيديا|ويكبيديا)/iu;
type SourceSelectionQuery = { question: string; sites: readonly string[] };
/** An explicit site scope wins over a contradictory natural-language source preference. */
export function excludesWikipedia(query: SourceSelectionQuery): boolean {
  return !query.sites.some(site => wikipediaHost(site)) && wikipediaExclusion.test(query.question);
}
export function requestsWikipedia(query: SourceSelectionQuery): boolean {
  return query.sites.some(site => wikipediaHost(site))
    || !excludesWikipedia(query) && /\bwikipedia\b|ويكيبيديا|ويكبيديا/iu.test(query.question);
}
// Request intent is not evidence of the academic subject. Explicitly quoted terms remain mandatory.
const academicRequestWords = new Set('research paper papers study studies journal journals doi دراسة دراسات بحث علمي ورقة علمية'.split(' ').map(normalizeWord));
// These describe the requested fact, but cannot replace its subject: a visa fee
// page is not about a passport merely because both mention UK renewal fees.
const requestDetailWords = new Set('price prices fee fees fare fares cost costs renewal renew version versions release releases opening hours سعر اسعار أسعار رسوم تكلفة تكاليف مواعيد تجديد اصدار إصدار اصدارات إصدارات'.split(' ').map(normalizeWord));
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
  const scaffolding:Record<string,string>={شرح:'',تعلم:'',استخدام:'',ما:'',هو:'',من:'',اخر:'latest',احدث:'latest',اصدار:'version',مستقر:'stable',مستقرة:'stable',مستقرا:'stable',برمجة:'programming',كود:'code',اخطاء:'error'};
  const translatedQuestion=intent==='technical'&&/\b(?:javascript|typescript|node|react|python|postgresql|api|css|sql)\b/i.test(question)
    ? question.replace(/"[^"]*"|\p{Script=Arabic}[\p{Script=Arabic}\p{M}]*/gu,(word,offset:number)=>{
      if(word.startsWith('"'))return word;
      const normalized=normalizeWord(word);
      // «تعلم Python» is an instruction; «Python تعلم الآلة» names a subject.
      if(normalized==='تعلم'&&(question.slice(0,offset).trim()||!/^\s+"?(?:javascript|typescript|node|react|python|postgresql|api|css|sql)\b/i.test(question.slice(offset+word.length))))return word;
      return scaffolding[normalized]??word;
    }).replace(/\s+/g,' ').trim()
    : question;
  // Search engines may over-weight a leading "latest". Canonicalize only this
  // known translated release-request template; additional Arabic subject text
  // and quoted phrases do not match it and remain in their original order.
  const retrievalQuestion=/\p{Script=Arabic}/u.test(question)
    ? translatedQuestion.replace(/^(latest\s+)?version(?:\s+(stable))?\s+([a-z][a-z0-9.+#_-]*(?:\s+[a-z0-9.+#_-]+)*)$/i,(_,latest:string|undefined,stable:string|undefined,subject:string)=>`${subject} ${latest?'latest ':''}${stable?'stable ':''}version`)
    : translatedQuestion;
  const quotedTokens = new Set(phrases.flatMap(phrase=>searchTokens(phrase)));
  const rankingQuestion = retrievalQuestion.replace(new RegExp(wikipediaExclusion.source, 'giu'), ' ');
  // Version qualifiers describe the requested release, not its subject. Limit
  // removal to version-request phrases so a name such as Stable Diffusion stays intact.
  const rankingText=phraseText(rankingQuestion)
    .replace(/\b(?:latest|newest|current)\s+stable\b|\bstable\s+(?:versions?|releases?)\b|\b(?:versions?|releases?)\s+stable\b/gu,phrase=>phrase.replace(/\bstable\b/u,''))
    .replace(/(?:^|\s)(?:اصدار|نسخة)\s+(?:ال)?مستقر(?:ة|ه|ا)?(?=\s|$)/gu,phrase=>phrase.replace(/(?:ال)?مستقر(?:ة|ه|ا)?/u,''));
  const tokens = [...new Set([...searchTokens(rankingText),...quotedTokens])]
    .filter(term=>intent!=='scholarly'||!academicRequestWords.has(term)||quotedTokens.has(term));
  if (!question || !tokens.length) throw new Error('SEARCH_QUERY_EMPTY');
  return { question, retrievalQuestion, sites: [...new Set(sites)], tokens, phrases,
    language: /\p{Script=Arabic}/u.test(retrievalQuestion) ? 'ar' as const : 'en' as const,
    intent,
    timeSensitive: /\b(?:today|weather|prices?|fees?|fares?|costs?|opening\s+hours|renew(?:al)?|latest|current|now|train|flight)\b|اليوم|طقس|سعر|[أا]سعار|تكلف[ةه]|تكاليف|رسوم|مواعيد|ال[آا]ن|حاليا|قطار|طيران/i.test(webFreshnessText(question))
      || /(?:^|\s)(?:اخر|احدث)(?:\s|$)/u.test(phraseText(question)) };
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
export function rankResults(query: ReturnType<typeof compileQuery>, results: readonly { provider: string; hits: SearchHit[] }[], limit: number,
  preferredProviders?: ReadonlySet<string>): RankedHit[] {
  const docs = new Map<string, { hit: SearchHit; providers: Set<string>; rrf: number }>();
  const descriptionScore = (hit:SearchHit) => { const title=new Set(searchTokens(hit.title)),snippet=new Set(searchTokens(hit.snippet));return query.tokens.reduce((score,term)=>score+(title.has(term)?2:snippet.has(term)?1:0),0); };
  for (const result of [...results].sort((a, b) => a.provider.localeCompare(b.provider))) {
    const seen = new Set<string>();
    result.hits.slice(0, 40).forEach((hit, rank) => {
      try {
        const url = canonicalUrl(hit.url), host = new URL(url).hostname;
        if(!matchesSearchPhrases(query,hit.title,hit.snippet) || excludesWikipedia(query) && wikipediaHost(host.replace(/\.$/u, '')))return;
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
  // A general encyclopedia is a fallback for a related site's own pages, unless the
  // owner specifically requested Wikipedia. This is source selection, not a trust score.
  const requestedWikipedia = requestsWikipedia(query);
  const sourcePriority = (url: string) => Number(wikipediaHost(new URL(url).hostname.replace(/\.$/u, '')) === requestedWikipedia);
  // For current facts and technical tasks, general web retrieval supplies the
  // destination pages; forum/API metadata is supplementary. Scholarly requests
  // retain their separate academic-purpose ordering.
  const webPriority = (providers: readonly string[]) => query.intent !== 'scholarly' && (query.intent === 'technical' || query.timeSensitive)
    && providers.some(provider => provider === 'Bing RSS' || provider === 'DuckDuckGo HTML') ? 1 : 0;
  // A requested source name is not part of the topic a destination page must
  // repeat. Keep it only when it is the entire query; quoted phrases still use
  // the separate mandatory phrase gate above.
  const subjectTokens = query.tokens.filter(term => !(requestedWikipedia && ['wikipedia', 'ويكيبيديا', 'ويكبيديا'].includes(term)));
  const rankingTokens = subjectTokens.length ? subjectTokens : query.tokens;
  const topicTokens = rankingTokens.filter(term => !requestDetailWords.has(term));
  const anchors = topicTokens.length ? topicTokens : rankingTokens;
  const neededAnchors = Math.min(4, anchors.length <= 3 ? anchors.length : Math.ceil(anchors.length * 0.6));
  const hostSubjects = new Set<string>();
  anchors.forEach((_, index) => {
    for (let length = 1; length <= 3 && index + length <= anchors.length; length++) {
      const subject = anchors.slice(index, index + length).join('');
      if (/^[a-z0-9]{4,}$/u.test(subject)) hostSubjects.add(subject);
    }
  });
  // A whole domain label matching the named subject helps retain its destination
  // page (Node.js → nodejs.org). This is a bounded lexical hint, not an authority
  // claim. Use the label immediately before the final suffix: nodejs.org.example
  // must not receive the nodejs.org hint, nor may tiny terms match arbitrary hosts.
  const topicHostPriority = (hit: RankedHit) => webPriority(hit.providers)
    && hostSubjects.has(new URL(hit.url).hostname.replace(/\.$/u, '').split('.').at(-2) ?? '') ? 1 : 0;
  const languagePriority = (hit: RankedHit) => Number(preferredProviders !== undefined && hit.providers.some(provider => preferredProviders.has(provider)));
  const ranked = entries.flatMap(row => {
    let score = 0, matched = 0;
    for (const term of rankingTokens) {
      const frequency = row.terms.filter(word => word === term).length;
      if (!frequency) continue;
      matched++;
      const documents = entries.filter(entry => entry.terms.includes(term)).length;
      score += Math.log(1 + (entries.length - documents + 0.5) / (documents + 0.5)) * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * row.terms.length / Math.max(1, average)));
    }
    if (rankingTokens.length && matched < Math.min(4, Math.ceil(rankingTokens.length * 0.6))) return [];
    if (anchors.filter(term => row.terms.includes(term)).length < neededAnchors) return [];
    return [{ ...row.hit, providers: [...row.providers].sort(), relevance: 'lexical' as const, score: Math.round((score + row.rrf * 10) * 1e6) / 1e6 }];
  }).sort((a, b) => languagePriority(b) - languagePriority(a) || sourcePriority(b.url) - sourcePriority(a.url) || academicPriority(b.providers) - academicPriority(a.providers) || webPriority(b.providers) - webPriority(a.providers) || topicHostPriority(b) - topicHostPriority(a) || b.score - a.score || a.url.localeCompare(b.url));
  const counts = new Map<string, number>(), selected: RankedHit[] = [];
  for (const row of ranked) {
    const hostname = new URL(row.url).hostname.replace(/\.$/u, ''), host = wikipediaHost(hostname) ? 'wikipedia.org' : hostname, count = counts.get(host) ?? 0;
    if (count >= 3) continue;
    selected.push(row); counts.set(host, count + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}
