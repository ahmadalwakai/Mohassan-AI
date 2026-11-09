import { createHash } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase,migrate } from '@mohassan/database';
import { SafeNetwork,SearchEngine,SqlSearchStore,migrateSearch } from '@mohassan/browser';
import { z } from 'zod';

// Public, nonsensitive queries fixed before this collection run. No private config is loaded.
const queries=[
  'استكشاف الفضاء','تاريخ الأندلس','الطاقة الشمسية','اللغة العربية','تعلم الآلة','الذكاء الاصطناعي',
  'دورة الماء','الثورة الصناعية','الشعاب المرجانية','التلسكوب الفضائي',
  'solar energy','water cycle','coral reef','space telescope','industrial revolution','Arabic language',
  'volcanic eruption','ocean currents','photosynthesis','renewable energy',
  'Node.js streams API','Python asyncio documentation','React hooks state','SQL transaction isolation','CSS grid layout',
  'TypeScript generic types','JavaScript promises error','Python dictionary iteration','PostgreSQL index performance','HTTP API caching',
  'شرح Node.js API','تعلم Python programming','أخطاء React hooks','شرح SQL transactions','استخدام CSS grid',
  'TypeScript types شرح','JavaScript promises شرح','Python asyncio كود','شرح Python','استخدام CSS',
  'machine learning research paper','quantum computing research paper','climate change research paper','solar cell research paper','neural network research paper',
  'protein folding research paper','ocean warming research paper','graph theory research paper','language model research paper','renewable energy research paper',
  'دراسة الطاقة الشمسية','بحث علمي الذكاء الاصطناعي','دراسة التغير المناخي','ورقة علمية تعلم الآلة','دراسة تلوث المياه',
  '"machine learning" research paper','"quantum computing" research paper','"Node.js" API','"الذكاء الاصطناعي"','Node API site:nodejs.org',
];
const args=process.argv.slice(2);
const inputIndex=args.indexOf('--review');
if(inputIndex>=0){
  // Judgments must be authored separately; retrieval availability is never a relevance score.
  const filename=args[inputIndex+1];if(!filename)throw new Error('Provide a review JSON file.');
  const schema=z.object({collectionHash:z.string().regex(/^[a-f0-9]{64}$/),reviewer:z.string().trim().min(1).max(200),judgments:z.array(z.object({question:z.string(),relevantUrls:z.array(z.string().url()),comment:z.string().optional()}).strict()).min(1)}).strict();
  const judgment=schema.parse(JSON.parse(await readFile(filename,'utf8')));
  const collection=JSON.parse(await readFile('artifacts/search-benchmark-live.json','utf8'));
  if(collection.complete!==true||collection.sourceStable!==true||collection.checks?.length!==queries.length)throw new Error('SEARCH_REVIEW_COLLECTION_UNVERIFIED');
  if(createHash('sha256').update(JSON.stringify(collection.checks)).digest('hex')!==judgment.collectionHash)throw new Error('SEARCH_REVIEW_COLLECTION_MISMATCH');
  if(new Set(judgment.judgments.map(row=>row.question)).size!==judgment.judgments.length)throw new Error('SEARCH_REVIEW_DUPLICATE');
  const rows=judgment.judgments.map(row=>{
    const found=collection.checks.find((check:any)=>check.question===row.question);if(!found)throw new Error('SEARCH_REVIEW_UNKNOWN_QUERY');
    const urls=found.result?.hits?.map((hit:any)=>hit.url)??[];
    if(row.relevantUrls.some(url=>!urls.includes(url)))throw new Error('SEARCH_REVIEW_URL_NOT_OBSERVED');
    const relevant=new Set(row.relevantUrls),first=urls.findIndex((url:string)=>relevant.has(url));
    return {question:row.question,precisionAt5:urls.slice(0,5).filter((url:string)=>relevant.has(url)).length/5,reciprocalRank:first<0?0:1/(first+1)};
  });
  const report={collectionHash:judgment.collectionHash,reviewer:judgment.reviewer,reviewedQueries:rows.length,totalQueries:collection.checks.length,complete:rows.length===collection.checks.length,precisionAt5:rows.reduce((sum,row)=>sum+row.precisionAt5,0)/rows.length,meanReciprocalRank:rows.reduce((sum,row)=>sum+row.reciprocalRank,0)/rows.length,rows};
  await writeFile('artifacts/search-benchmark-review.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}else{
  if(!args.includes('--live'))throw new Error('Use --live for 60 public queries, or --review FILE for separate relevance judgments.');
  const database=await createDatabase();
  try{
    const sources=['packages/browser/src/search/engine.ts','packages/browser/src/search/ranking.ts','packages/browser/src/search/providers.ts','packages/browser/src/search/extra-providers.ts','packages/browser/src/search/store.ts','packages/browser/src/search/local-index.ts','packages/browser/src/network.ts','scripts/search-benchmark.ts'];
    const fingerprint=async()=>createHash('sha256').update(Buffer.concat(await Promise.all(sources.map(file=>readFile(file))))).digest('hex');
    const sourceHash=await fingerprint();
    await migrate(database.db);await migrateSearch(database.db);
    const store=new SqlSearchStore(database.db),engine=new SearchEngine(new SafeNetwork(),{store,admission:store});
    const checks:unknown[]=[];const startedAt=new Date().toISOString();
    await mkdir('artifacts',{recursive:true});
    for(const question of queries){
      const started=Date.now();let result:unknown,error:string|undefined;
      try{result=await engine.execute(question,5,AbortSignal.timeout(18000),{ownerId:'isolated-public-benchmark'});}catch{error='SEARCH_UNAVAILABLE';}
      checks.push({question,durationMs:Date.now()-started,...(result?{result}:{error})});
      console.error(`${checks.length}/${queries.length}: ${error??'collected'}`);
      const report={startedAt,updatedAt:new Date().toISOString(),complete:checks.length===queries.length,sourceHash,sourceStable:sourceHash===await fingerprint(),scope:'public retrieval collection; relevance requires separate judgments',privateDatabaseUsed:false,queryHash:createHash('sha256').update(JSON.stringify(queries)).digest('hex'),checks};
      await writeFile('artifacts/search-benchmark-live.json',JSON.stringify(report,null,2));
      // At least four seconds after full provider completion; SQL independently enforces all cooldowns.
      if(checks.length<queries.length)await delay(4100);
    }
    console.log(JSON.stringify({collected:checks.length,collectionHash:createHash('sha256').update(JSON.stringify(checks)).digest('hex'),relevanceMeasured:false}));
  }finally{await database.close();}
}
