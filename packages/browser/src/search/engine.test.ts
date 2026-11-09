import { describe, expect, it, vi } from 'vitest';
import { SafeNetwork } from '../network.js';
import { SearchEngine } from './engine.js';
import { canonicalUrl, compileQuery, localSearchSnippet, matchesSearchPhrases, rankResults } from './ranking.js';
import { documentedProviders, SearchProviderFailure, type DocumentedProvider } from './providers.js';

const hit = (title:string,url='https://nodejs.org/docs',snippet='Node API documentation') => ({title,url,snippet});
const provider=(name:string,search:DocumentedProvider['search']):DocumentedProvider=>({name,search,coverage:'programming',accessBasis:'documented_api',supports:()=>true});
describe('documented deterministic search',()=>{
  it('treats PostgreSQL as a technical subject, including mixed Arabic instructions',()=>{
    expect(compileQuery('PostgreSQL index performance')).toMatchObject({intent:'technical',tokens:['postgresql','index','performance']});
    expect(compileQuery('شرح PostgreSQL')).toMatchObject({intent:'technical',retrievalQuestion:'PostgreSQL',tokens:['postgresql']});
    const providers=documentedProviders(new SafeNetwork());
    expect(providers.filter(provider=>provider.supports(compileQuery('PostgreSQL index performance'))).map(provider=>provider.name)).toContain('Stack Exchange');
    expect(providers.filter(provider=>provider.supports(compileQuery('PostgreSQL index performance'))).map(provider=>provider.name)).toContain('Hacker News');
  });
  it('requires academic subject words instead of matching generic research requests alone',()=>{
    const query=compileQuery('quantum computing research paper');
    expect(query.tokens).toEqual(['quantum','computing']);
    const rows=[{provider:'fixture',hits:[hit('Cloud computing research paper','https://example.org/wrong','Cloud and edge computing'),hit('Quantum computing systems','https://example.org/right','')]}];
    expect(rankResults(query,rows,5).map(row=>row.url)).toEqual(['https://example.org/right']);
    expect(compileQuery('بحث علمي الذكاء الاصطناعي').tokens).toEqual(['ذكاء','اصطناعي']);
    expect(compileQuery('ورقة علمية تعلم الآلة').tokens).toEqual(['تعلم','الة']);
    expect(()=>compileQuery('research paper study')).toThrow('SEARCH_QUERY_EMPTY');
    expect(compileQuery('"research paper" language model').tokens).toEqual(['research','paper','language','model']);
    expect(rankResults(compileQuery('دراسة الطاقة الشمسية'),[{provider:'fixture',hits:[hit('دراسة الطاقة النووية','https://example.org/ar-wrong','بحث علمي'),hit('الطاقة الشمسية','https://example.org/ar-right','')]}],5).map(row=>row.url)).toEqual(['https://example.org/ar-right']);
  });
  it('orders subject-matching scholarly sources before encyclopedias only for scholarly requests',()=>{
    const encyclopedia=hit('Antibiotic resistance','https://en.wikipedia.org/wiki/Antibiotic_resistance','Antibiotic resistance antibiotic resistance overview');
    const rows=[
      {provider:'Wikipedia',hits:[encyclopedia]},
      {provider:'Crossref',hits:[hit('Antibiotic discovery research paper','https://doi.org/10.1/unrelated','Research paper study'),hit('Antibiotic resistance in freshwater ecosystems','https://doi.org/10.1/matching','Experimental measurements of bacterial adaptation.')]},
      {provider:'arXiv',hits:[hit('Urban drainage research paper','https://arxiv.org/abs/unrelated','Research paper study'),hit('Antibiotic resistance transmission models','https://arxiv.org/abs/matching','Numerical evaluation of transmission dynamics.')]},
    ];
    const query=compileQuery('antibiotic resistance research paper'),ranked=rankResults(query,rows,5);
    expect(ranked).toHaveLength(3);
    expect(ranked.slice(0,2).map(row=>row.url).sort()).toEqual(['https://arxiv.org/abs/matching','https://doi.org/10.1/matching']);
    expect(ranked.at(-1)?.url).toBe(encyclopedia.url);
    expect(rankResults(query,[...rows].reverse(),5)).toEqual(ranked);
    expect(rankResults(compileQuery('antibiotic resistance'),rows,5)[0]?.url).toBe(encyclopedia.url);
    expect(rankResults(compileQuery('"antibiotic resistance" research paper'),[{provider:'Crossref',hits:[hit('Antibiotic reduced resistance','https://doi.org/10.1/wrong-phrase','Research paper study')]}],5)).toEqual([]);
  });
  it('applies academic purpose ordering to Arabic subjects without accepting generic study terms',()=>{
    const rows=[
      {provider:'Wikipedia',hits:[hit('مقاومة المضادات','https://ar.wikipedia.org/wiki/مقاومة','مقاومة المضادات مقاومة المضادات') ]},
      {provider:'Crossref',hits:[hit('دراسة مقاومة الفيضانات','https://doi.org/10.1/ar-unrelated','بحث علمي'),hit('مقاومة المضادات في الأنهار','https://doi.org/10.1/ar-matching','قياس تطور البكتيريا') ]},
    ];
    expect(rankResults(compileQuery('دراسة مقاومة المضادات'),rows,5).map(row=>row.url)).toEqual(['https://doi.org/10.1/ar-matching','https://ar.wikipedia.org/wiki/%D9%85%D9%82%D8%A7%D9%88%D9%85%D8%A9']);
  });
  it('copies evidence for each quoted phrase across distant passages and a passage boundary',()=>{
    const query=compileQuery('"machine learning" "quantum computing" "الذكاء الاصطناعي" "solar energy"');
    const content='machine unrelated learning padding '.repeat(120)+'machine learning '+'between '.repeat(90)+'quantum computing '+'between '.repeat(90)+'الذَّكاء الاصْطناعي '+'between '.repeat(90)+'solar energy';
    const snippet=localSearchSnippet(query,'reference',content);
    expect(snippet).not.toBeNull();expect(snippet!.length).toBeLessThanOrEqual(1400);
    expect(matchesSearchPhrases(query,'reference',snippet!)).toBe(true);
    expect(snippet).toContain('الذَّكاء الاصْطناعي');
    expect(rankResults(query,[{provider:'local',hits:[hit('reference','https://example.org/long',snippet!)]}],5)).toHaveLength(1);
    expect(localSearchSnippet(compileQuery('"machine learning"'),'reference','machine unrelated learning')).toBeNull();
    const boundary='padding '.repeat(80)+'machine learning after the previous 650-character window';
    expect(localSearchSnippet(compileQuery('"machine learning"'),'reference',boundary)).toContain('machine learning');
  });
  it('enforces quoted phrases in Arabic and English and rejects incomplete quotes',()=>{
    const query=compileQuery('"machine learning" site:example.org');
    expect(rankResults(query,[{provider:'fixture',hits:[hit('machine deep learning','https://example.org/wrong',''),hit('machine learning guide','https://example.org/right','')]}],5).map(row=>row.url)).toEqual(['https://example.org/right']);
    expect(rankResults(compileQuery('"الذكاء الاصطناعي"'),[{provider:'fixture',hits:[hit('الذَّكاء الاصْطناعي','https://example.org/ar',''),hit('الذكاء البشري الاصطناعي','https://example.org/ar-wrong','')]}],5).map(row=>row.url)).toEqual(['https://example.org/ar']);
    expect(()=>compileQuery('"machine learning')).toThrow('SEARCH_PHRASE_UNCLOSED');
    expect(()=>compileQuery('"" Node')).toThrow('SEARCH_PHRASE_INVALID');
    expect(compileQuery('"site:example.org" Node').sites).toEqual([]);
  });
  it('preserves the original mixed-language question while removing only known request scaffolding from provider queries',()=>{
    expect(compileQuery('TypeScript types شرح')).toMatchObject({question:'TypeScript types شرح',retrievalQuestion:'TypeScript types',language:'en',intent:'technical'});
    expect(compileQuery('أخطاء React hooks')).toMatchObject({retrievalQuestion:'error React hooks'});
    expect(compileQuery('شرح أمان SQL')).toMatchObject({retrievalQuestion:'أمان SQL',language:'ar'});
    expect(compileQuery('"شرح" Node API')).toMatchObject({retrievalQuestion:'"شرح" Node API',phrases:['شرح']});
    expect(compileQuery('شرح تاريخ الأندلس').retrievalQuestion).toBe('شرح تاريخ الأندلس');
    expect(rankResults(compileQuery('شرح Python'),[{provider:'fixture',hits:[hit('Python documentation','https://example.org/python','')] }],5)).toHaveLength(1);
    expect(rankResults(compileQuery('استخدام CSS'),[{provider:'fixture',hits:[hit('CSS documentation','https://example.org/css','')] }],5)).toHaveLength(1);
  });
  it('canonicalizes only known tracking fields and obeys site restrictions',()=>{
    expect(canonicalUrl('https://nodejs.org/docs?version=24&utm_source=x#top')).toBe('https://nodejs.org/docs?version=24');
    const query=compileQuery('Node API site:nodejs.org');
    expect(rankResults(query,[{provider:'one',hits:[hit('Node API','https://notnodejs.org/'),hit('Node API')]}],5)).toHaveLength(1);
  });
  it('fuses duplicated results deterministically regardless of completion order',()=>{
    const rows=[{provider:'a',hits:[hit('Node API')]},{provider:'b',hits:[hit('Node API','https://nodejs.org/docs?utm_campaign=x')]}];
    const query=compileQuery('Node API');
    expect(rankResults(query,rows,5)).toEqual(rankResults(query,[...rows].reverse(),5));
    expect(rankResults(query,rows,5)[0].providers).toEqual(['a','b']);
  });
  it('does not rank unrelated results or infer a publication date',()=>{
    expect(rankResults(compileQuery('React hooks'),[{provider:'a',hits:[hit('UK News','https://example.org/','Latest official news')]}],5)).toEqual([]);
  });
  it('partitions cache by owner, preserves timestamp, and does not cache without an owner',async()=>{
    let now=1_000_000;
    const search=vi.fn(async()=>[hit('Node API')]);
    const engine=new SearchEngine(new SafeNetwork(),{now:()=>now,providers:[provider('fixture',search)]});
    const first=await engine.execute('Node API',5,undefined,{ownerId:'one'});
    now+=2000;
    const same=await engine.execute('Node API',5,undefined,{ownerId:'one'});
    expect(same.freshness).toBe('cached');expect(same.fetchedAt).toBe(first.fetchedAt);expect(search).toHaveBeenCalledTimes(1);
    await engine.execute('Node API',5,undefined,{ownerId:'two'});expect(search).toHaveBeenCalledTimes(2);
    now+=2000;await engine.execute('Node API',5);now+=2000;await engine.execute('Node API',5);expect(search).toHaveBeenCalledTimes(4);
  });
  it('contains provider failure and rejects private or credentialed results',async()=>{
    const engine=new SearchEngine(new SafeNetwork(),{providers:[provider('broken',async()=>{throw new Error('secret-token');}),provider('good',async()=>[hit('Node API'),hit('Node API','https://127.0.0.1/private'),hit('Node API','https://user:pass@example.org/')])]});
    const result=await engine.execute('Node API',5);
    expect(result.hits).toHaveLength(1);expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(result.failures).toEqual([{provider:'broken',kind:'unavailable'}]);
  });
  it('honours rate backoff without retrying or fabricating an answer',async()=>{
    const search=vi.fn(async()=>{throw new SearchProviderFailure('rate_limited',60000);});
    const engine=new SearchEngine(new SafeNetwork(),{providers:[provider('fixture',search)]});
    expect((await engine.execute('Node API',5)).hits).toEqual([]);
    await expect(engine.search('Node API',5)).rejects.toMatchObject({code:'RESEARCH_SEARCH_UNAVAILABLE'});
    expect(search).toHaveBeenCalledTimes(1);
  });
  it('cancels before calling any provider',async()=>{
    const search=vi.fn(async()=>[hit('Node API')]);const controller=new AbortController();controller.abort();
    await expect(new SearchEngine(new SafeNetwork(),{providers:[provider('fixture',search)]}).execute('Node API',5,controller.signal)).rejects.toThrow();
    expect(search).not.toHaveBeenCalled();
  });
  it('parses the documented contracts and enforces Stack Exchange backoff',async()=>{
    let calls=0;
    const network={request:async(url:string)=>{calls++;return {status:200,headers:{},body:Buffer.from(JSON.stringify(url.includes('stackexchange')?{backoff:30,items:[{title:'Node &amp; API',link:'https://stackoverflow.com/q/1',tags:['node','api']}]}:url.includes('crossref')?{message:{items:[{title:['research paper'],URL:'https://doi.org/10.1/test',abstract:'<p>study</p>'}]}}:{query:{search:[{title:'Node.js',snippet:'<b>Node</b> API'}]}}))};}} as unknown as SafeNetwork;
    const providers=documentedProviders(network,()=>1000), signal=new AbortController().signal;
    expect((await providers[0].search(compileQuery('Node API'),5,signal))[0].snippet).toBe('Node API');
    expect((await providers[1].search(compileQuery('Node API'),5,signal))[0].title).toBe('Node & API');
    await expect(providers[1].search(compileQuery('Node API'),5,signal)).rejects.toMatchObject({kind:'rate_limited'});
    expect((await providers[2].search(compileQuery('quantum research paper'),5,signal))[0].snippet).toBe('study');expect(calls).toBe(3);
  });
});
