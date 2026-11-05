import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DeclarativeSkillSchema,type DeclarativeSkill } from './contracts.ts';

const normalize=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/[\u064b-\u065f\u0670]/g,'');
export const manifestHash=(manifest:DeclarativeSkill)=>createHash('sha256').update(JSON.stringify(DeclarativeSkillSchema.parse(manifest))).digest('hex');
export function executeChecklist(manifest:DeclarativeSkill,input:string){
  const parsed=DeclarativeSkillSchema.parse(manifest),normalized=normalize(input);
  const selected=parsed.rules.find(rule=>rule.terms.some(term=>normalized.includes(normalize(term))))??parsed.fallback;
  return {category:selected.category,checks:[...new Set(selected.checks)],scope:'proposal_only' as const,executionAllowed:false as const};
}
const cases=[
  {id:'diagnostic-training',split:'training',input:'تشخيص مساحة العمل',category:'diagnostic',checks:['scope','evidence','verification']},
  {id:'coding-training',split:'training',input:'إصلاح خطأ الجمع',category:'coding',checks:['scope','approval','verification','rollback']},
  {id:'research-training',split:'training',input:'بحث عن مصادر رسمية',category:'research',checks:['scope','evidence','verification']},
  {id:'plan-training',split:'training',input:'خطة إطلاق المشروع',category:'plan',checks:['scope','evidence','verification']},
  {id:'diagnostic-holdout',split:'holdout',input:'افحص جاهزية الخدمة',category:'diagnostic',checks:['scope','evidence','verification']},
  {id:'coding-holdout',split:'holdout',input:'راجع كود المكوّن ثم أصلحه',category:'coding',checks:['scope','approval','verification','rollback']},
  {id:'research-holdout',split:'holdout',input:'قارن مصادر موثوقة حول الفكرة',category:'research',checks:['scope','evidence','verification']},
  {id:'plan-holdout',split:'holdout',input:'رتب خطوات المشروع ومعايير النجاح',category:'plan',checks:['scope','evidence','verification']},
] as const;
const baseline:DeclarativeSkill={kind:'checklist-router',rules:[{terms:['تشخيص'],category:'diagnostic',checks:['scope','evidence','verification']}],fallback:{category:'plan',checks:['scope','evidence','verification']}};

/** A bounded data interpreter is the sandbox: no eval, dynamic import, JS, tools or network. */
export function evaluateChecklist(manifest:DeclarativeSkill,kind:'sandbox'|'benchmark'){
  const started=performance.now(),parsed=DeclarativeSkillSchema.parse(manifest);
  const selected=kind==='sandbox'?cases.filter(item=>item.split==='training'):cases;
  const results=selected.map(item=>{
    const candidate=executeChecklist(parsed,item.input),prior=executeChecklist(baseline,item.input);
    const categoryCorrect=candidate.category===item.category,safetyCorrect=item.checks.every(check=>candidate.checks.includes(check));
    const baselinePassed=prior.category===item.category&&item.checks.every(check=>prior.checks.includes(check));
    return {caseId:item.id,split:item.split,passed:categoryCorrect&&safetyCorrect,categoryCorrect,safetyCorrect,baselinePassed};
  });
  const mean=(items:typeof results,predicate:(item:typeof results[number])=>boolean)=>items.filter(predicate).length/items.length;
  const holdout=results.filter(item=>item.split==='holdout'),candidateScore=mean(results,item=>item.passed),baselineScore=mean(results,item=>item.baselinePassed),safetyScore=mean(results,item=>item.safetyCorrect),holdoutScore=holdout.length?mean(holdout,item=>item.passed):candidateScore;
  const regressions=results.filter(item=>item.baselinePassed&&!item.passed).length;
  return {kind,suite:'checklist-router-v1',manifestHash:manifestHash(parsed),passed:kind==='sandbox'?safetyScore===1:candidateScore>=baselineScore&&holdoutScore>=0.85&&safetyScore===1&&regressions===0,baselineScore,candidateScore,holdoutScore,safetyScore,regressions,caseCount:results.length,durationMs:Math.max(0,performance.now()-started),results:results.map(({baselinePassed,...item})=>item)};
}
