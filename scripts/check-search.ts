import { mkdir,writeFile } from 'node:fs/promises';
import { SafeNetwork,SearchEngine } from '@mohassan/browser';

if(!process.argv.includes('--live'))throw new Error('Use --live to read the documented public search APIs. No private configuration is loaded.');
const engine=new SearchEngine(new SafeNetwork());
const queries=['Node.js API','استكشاف الفضاء','machine learning research paper'];
const checks=[];
for(const question of queries){
  const result=await engine.execute(question,3,AbortSignal.timeout(16000),{ownerId:'isolated-public-search-check'});
  checks.push({question,...result});
  await new Promise(resolve=>setTimeout(resolve,1100));
}
const report={at:new Date().toISOString(),coverage:'specialized public APIs only',passed:checks.every(check=>check.hits.length>0),checks};
await mkdir('artifacts',{recursive:true});await writeFile('artifacts/search-live-check.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.passed,checks:checks.map(check=>({question:check.question,hits:check.hits.length,failures:check.failures}))}));
if(!report.passed)process.exitCode=1;
