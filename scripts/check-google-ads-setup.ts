import { readFile,mkdir,writeFile } from 'node:fs/promises';
import dotenv from 'dotenv';
import { googleAdsSetupReport } from './lib/google-ads-setup.ts';

let local:Record<string,string>={};
try{local=dotenv.parse(await readFile('.env'));}catch(error:any){if(error?.code!=='ENOENT')throw new Error('تعذرت قراءة ملف الإعداد المحلي.');}
const report={checkedAt:new Date().toISOString(),scope:'configuration_only',...googleAdsSetupReport({...local,...process.env})};
await mkdir('artifacts',{recursive:true});
await writeFile('artifacts/google-ads-setup-check.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(!report.configured)process.exitCode=1;
