import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createDatabase,migrate } from '@mohassan/database';
import { Runtime } from '@mohassan/runtime';
import { migrateAuth } from '../../../apps/server/src/auth.ts';
import { createMemoryControl,exampleSkill,memoryMigration,type DeclarativeSkill } from './index.ts';

describe('evidence-backed memory and measured declarative skill lifecycle',()=>{
  let store:Awaited<ReturnType<typeof createDatabase>>,memory:ReturnType<typeof createMemoryControl>;
  let clock=new Date('2026-11-04T12:00:00Z');
  const owner='memory-owner-fixture',other='memory-other-fixture';
  beforeAll(async()=>{store=await createDatabase();await migrateAuth(store.db);await migrate(store.db);await memoryMigration(store.db);await memoryMigration(store.db);for(const id of [owner,other])await store.db.insertInto('user').values({id,name:id,email:`${id}@example.test`}).execute();memory=createMemoryControl(store.db,{now:()=>clock});});
  afterAll(async()=>{await store?.close();});
  async function task(id:string,failed=false){const runtime=new Runtime(store.db,{maxAttempts:1,...(failed?{executeDiagnostic:async()=>{throw new Error('Explicit diagnostic failure fixture');}}:{})});const created=await runtime.createTask(id,{title:failed?'تشخيص متعثر للاختبار':'تشخيص موثق للذاكرة',goal:'تحقق من اتصال التخزين وسجل القدرات ووثق النتيجة.',autonomy:'scoped',capabilityId:'system.diagnostic'},randomUUID());await runtime.tick();const result=await runtime.detail(id,created.id);expect(result.task.status).toBe(failed?'failed':'completed');return result.task;}
  const manual=(title:string,layer:'working'|'episodic'|'semantic'|'procedural'|'failure'|'preference'='semantic')=>({title,content:`ملاحظة صريحة تخص ${title}`,layer,evidenceIds:[]});
  it('persists all six layers with explicit manual provenance and enforces ownership',async()=>{
    for(const layer of ['working','episodic','semantic','procedural','failure','preference'] as const){const item=await memory.create(owner,manual(`طبقة ${layer}`,layer));expect(item.layer).toBe(layer);expect(item.confidenceKind).toBe('user_asserted');expect(item.confidence).toBe(0.5);expect(item.provenance).toHaveLength(1);expect(item.provenance[0]).toMatchObject({kind:'manual',trust:'manual'});await expect(memory.detail(other,item.id)).rejects.toMatchObject({code:'MEMORY_NOT_FOUND',statusCode:404});}
    expect((await memory.search(other,{query:'طبقة'})).items).toEqual([]);
    await expect(memory.create(owner,{...manual('أسرار مرفوضة'),content:'api_key="gsk_syntheticcredential1234567890"'})).rejects.toMatchObject({code:'MEMORY_SECRET_REJECTED'});
  });
  it('excludes expiry immediately, creates immutable correction versions and blocks stale deletion',async()=>{
    const item=await memory.create(owner,{...manual('ذكرى تنتهي تلقائيًا'),content:'محتوى انتهاء فريد',expiresAt:new Date(clock.getTime()+86400000).toISOString()});
    expect((await memory.search(owner,{query:'انتهاء فريد'})).items.map(row=>row.id)).toContain(item.id);
    clock=new Date(clock.getTime()+2*86400000);
    const expired=await memory.search(owner,{query:'انتهاء فريد'});expect(expired.items).toEqual([]);expect(expired.expiredExcluded).toBeGreaterThan(0);
    expect((await memory.detail(owner,item.id)).item.status).toBe('expired');
    const corrected=await memory.correct(owner,item.id,{...manual('ذكرى مجددة'),content:'محتوى مجدد فريد',expectedVersion:1,reason:'تصحيح موثق من المالك'});
    expect(corrected.rootId).toBe(item.rootId);expect(corrected.version).toBe(2);expect(corrected.id).not.toBe(item.id);
    expect((await memory.detail(owner,corrected.id)).versions.map(row=>row.status)).toEqual(['active','superseded']);
    await expect(memory.correct(owner,item.id,{...manual('تصحيح قديم'),expectedVersion:1,reason:'طلب قديم مرفوض'})).rejects.toMatchObject({code:'MEMORY_VERSION_CONFLICT'});
    await expect(memory.remove(owner,item.id,{expectedVersion:1,reason:'حذف قديم مرفوض'})).rejects.toMatchObject({code:'MEMORY_VERSION_CONFLICT'});
    await memory.revoke(owner,corrected.id,{expectedVersion:2,reason:'لم تعد هذه الملاحظة صالحة'});
    expect((await memory.search(owner,{query:'مجدد فريد'})).items).toEqual([]);
    await memory.remove(owner,corrected.id,{expectedVersion:2,reason:'حذف صريح لاختبار البيانات المؤقتة'});
    await expect(memory.detail(owner,item.id)).rejects.toMatchObject({code:'MEMORY_NOT_FOUND'});
    await expect(memory.detail(owner,corrected.id)).rejects.toMatchObject({code:'MEMORY_NOT_FOUND'});
  });
  it('records actual task/event outcomes idempotently and keeps failure evidence separate',async()=>{
    const completed=await task(owner),failed=await task(owner,true),foreign=await task(other);
    const first=await memory.sync(owner);expect(first.created).toBe(2);expect((await memory.sync(owner)).created).toBe(0);
    const workspace=await memory.workspace(owner);
    expect(workspace.items.find(item=>item.taskId===completed.id)).toMatchObject({layer:'episodic',confidenceKind:'task_observed'});
    const failure=workspace.items.find(item=>item.taskId===failed.id)!;expect(failure.layer).toBe('failure');expect(failure.content).toContain('failed');expect(failure.provenance[0]).toMatchObject({kind:'task_error',trust:'observed',taskId:failed.id});expect(failure.provenance[0].eventId).toBeTruthy();
    expect(workspace.items.some(item=>item.taskId===foreign.id)).toBe(false);
    await expect(memory.create(owner,{...manual('مصدر غير مملوك'),taskId:foreign.id})).rejects.toMatchObject({code:'TASK_NOT_FOUND'});
    const manualWithTask=await memory.create(owner,{...manual('ادعاء يحتاج مراجعة'),taskId:completed.id});
    expect(manualWithTask.confidenceKind).toBe('user_asserted');expect(manualWithTask.provenance.some(ref=>ref.taskId===completed.id)).toBe(true);
    await store.db.insertInto('model_runs').values({id:randomUUID(),task_id:completed.id,attempt:1,lease_token:randomUUID(),provider:'fixture',model:'fixture',status:'succeeded',input_tokens:11,output_tokens:7,usage_known:true,result_committed:true}).execute();
    const metrics=await memory.metrics(owner);expect(metrics).toMatchObject({knownInputTokens:11,knownOutputTokens:7,failed:1});
  });
  it('requires explicit preference consent and bounds provenance-tagged retrieval context',async()=>{
    const completed=await task(owner);
    const correction={taskId:completed.id,kind:'task_correction',comment:'تصحيح خاص بهذه المهمة فقط',submissionKey:randomUUID()};
    const saved=await memory.feedback(owner,correction);expect(saved.persistedPreference).toBe(false);expect((await memory.feedback(owner,correction)).id).toBe(saved.id);
    expect((await memory.search(owner,{query:'تصحيح خاص بهذه المهمة فقط',layers:['preference']})).items).toEqual([]);
    await expect(memory.feedback(owner,{...correction,persistPreference:true,submissionKey:randomUUID()})).rejects.toBeDefined();
    await memory.feedback(owner,{taskId:completed.id,kind:'preference',comment:'أفضّل ملخصًا عربيًا واضحًا',persistPreference:false,submissionKey:randomUUID()});
    expect((await memory.search(owner,{query:'ملخص',layers:['preference']})).items).toEqual([]);
    await memory.feedback(owner,{taskId:completed.id,kind:'preference',comment:'أفضّل ملخصًا عربيًا واضحًا',persistPreference:true,submissionKey:randomUUID()});
    const context=await memory.context(owner,'ملخص عربي',completed.id);const preference=context.items.filter(item=>item.layer==='preference');expect(preference).toHaveLength(1);expect(preference[0].confidenceKind).toBe('user_asserted');expect(context.citations.some(ref=>ref.taskId===completed.id)).toBe(true);expect(JSON.stringify(context).length).toBeLessThanOrEqual(9000);
  });
  it('scopes working memory to its task and rejects forged provenance',async()=>{
    const first=await task(owner),second=await task(owner);
    const scoped=await memory.create(owner,{...manual('نطاق عمل فريد','working'),taskId:first.id});
    expect((await memory.search(owner,{query:'نطاق عمل فريد',layers:['working'],taskId:second.id})).items).toEqual([]);
    expect((await memory.search(owner,{query:'نطاق عمل فريد',layers:['working'],taskId:first.id})).items.map(item=>item.id)).toContain(scoped.id);
    await expect(memory.create(other,{...manual('إسناد مزور'),evidenceIds:[scoped.provenance[0].id]})).rejects.toMatchObject({code:'MEMORY_EVIDENCE_UNAVAILABLE'});
  });
  it('measures declarative skill improvement on heldout fixtures and requires explicit activation',async()=>{
    let skill=await memory.createSkill(owner,{name:'مهارة قوائم فحص مقاسة',description:'اختبار قواعد ثابتة دون كود أو شبكة.',manifest:exampleSkill});
    await expect(memory.runSkill(owner,skill.id,{input:'إصلاح كود'})).rejects.toMatchObject({code:'SKILL_NOT_ACTIVE'});
    await expect(memory.evaluateSkill(owner,skill.id,{expectedRevision:skill.revision},'benchmark')).rejects.toMatchObject({code:'SKILL_LIFECYCLE_DENIED'});
    skill=await memory.evaluateSkill(owner,skill.id,{expectedRevision:skill.revision},'sandbox');expect(skill.status).toBe('sandbox_tested');
    skill=await memory.evaluateSkill(owner,skill.id,{expectedRevision:skill.revision},'benchmark');expect(skill.status).toBe('benchmarked');
    const evaluation=skill.evaluations.find(item=>item.kind==='benchmark')!;expect(evaluation).toMatchObject({passed:true,candidateScore:1,holdoutScore:1,safetyScore:1,regressions:0,caseCount:8});expect(evaluation.candidateScore).toBeGreaterThan(evaluation.baselineScore);
    await expect(memory.activateSkill(owner,skill.id,{expectedRevision:skill.revision,evaluationId:evaluation.id,approve:false})).rejects.toBeDefined();
    skill=await memory.activateSkill(owner,skill.id,{expectedRevision:skill.revision,evaluationId:evaluation.id,approve:true});expect(skill.status).toBe('active');
    expect(await memory.runSkill(owner,skill.id,{input:'راجع كود المشروع'})).toMatchObject({category:'coding',checks:['scope','approval','verification','rollback'],executionAllowed:false,scope:'proposal_only'});
    expect((await memory.context(owner,'راجع كود المشروع')).skillProposals).toContainEqual(expect.objectContaining({skillId:skill.id,category:'coding',executionAllowed:false,scope:'proposal_only'}));
    await expect(memory.runSkill(other,skill.id,{input:'راجع كود المشروع'})).rejects.toMatchObject({code:'SKILL_NOT_FOUND'});
  });
  it('rejects a weak candidate on the independent benchmark without auto-promotion',async()=>{
    const weak:DeclarativeSkill={kind:'checklist-router',rules:[{terms:['حالة مصطنعة'],category:'plan',checks:['scope','evidence','approval','verification','rollback']}],fallback:{category:'plan',checks:['scope','evidence','approval','verification','rollback']}};
    let skill=await memory.createSkill(owner,{name:'مرشح ضعيف للاختبار',description:'قواعد آمنة لكنها لا تصنف المهام بدقة.',manifest:weak});
    skill=await memory.evaluateSkill(owner,skill.id,{expectedRevision:skill.revision},'sandbox');expect(skill.status).toBe('sandbox_tested');
    skill=await memory.evaluateSkill(owner,skill.id,{expectedRevision:skill.revision},'benchmark');
    const evaluation=skill.evaluations.find(item=>item.kind==='benchmark')!;expect(evaluation.passed).toBe(false);expect(evaluation.holdoutScore).toBe(0.25);expect(skill.status).not.toBe('active');
    await expect(memory.activateSkill(owner,skill.id,{expectedRevision:skill.revision,evaluationId:evaluation.id,approve:true})).rejects.toMatchObject({code:'SKILL_LIFECYCLE_DENIED'});
    await expect(memory.createSkill(owner,{name:'كود تنفيذي مرفوض',description:'لا يسمح بتسجيل برنامج اعتباطي.',manifest:{kind:'javascript',code:'process.exit()'}})).rejects.toBeDefined();
  });
  it('versions manifests immutably, rejects old approval evidence and supports explicit rollback/revoke',async()=>{
    let original=await memory.createSkill(owner,{name:'سلسلة مهارة قابلة للاستعادة',description:'نسخة أولى موثقة.',manifest:exampleSkill});
    original=await memory.evaluateSkill(owner,original.id,{expectedRevision:original.revision},'sandbox');original=await memory.evaluateSkill(owner,original.id,{expectedRevision:original.revision},'benchmark');const originalEval=original.evaluations.find(item=>item.kind==='benchmark')!;original=await memory.activateSkill(owner,original.id,{expectedRevision:original.revision,evaluationId:originalEval.id,approve:true});
    let next=await memory.createSkill(owner,{name:original.name,description:'نسخة ثانية مستقلة.',manifest:{...exampleSkill,rules:exampleSkill.rules.map((rule,index)=>index===0?{...rule,terms:[...rule.terms,'فحص']}:rule)},parentSkillId:original.id});
    expect(next.familyId).toBe(original.familyId);expect(next.version).toBe(2);expect(next.manifestHash).not.toBe(original.manifestHash);
    next=await memory.evaluateSkill(owner,next.id,{expectedRevision:next.revision},'sandbox');next=await memory.evaluateSkill(owner,next.id,{expectedRevision:next.revision},'benchmark');
    await expect(memory.activateSkill(owner,next.id,{expectedRevision:next.revision,evaluationId:originalEval.id,approve:true})).rejects.toMatchObject({code:'SKILL_EVALUATION_FAILED'});
    const nextEval=next.evaluations.find(item=>item.kind==='benchmark')!;next=await memory.activateSkill(owner,next.id,{expectedRevision:next.revision,evaluationId:nextEval.id,approve:true});
    await expect(memory.runSkill(owner,original.id,{input:'إصلاح كود'})).rejects.toMatchObject({code:'SKILL_NOT_ACTIVE'});
    original=(await memory.workspace(owner)).skills.find(item=>item.id===original.id)!;
    original=await memory.activateSkill(owner,original.id,{expectedRevision:original.revision,evaluationId:originalEval.id,approve:true});expect(original.status).toBe('active');
    original=await memory.revokeSkill(owner,original.id,{expectedRevision:original.revision,reason:'إلغاء صريح لاختبار السلسلة.'});
    await expect(memory.runSkill(owner,original.id,{input:'إصلاح كود'})).rejects.toMatchObject({code:'SKILL_NOT_ACTIVE'});
  });
});
