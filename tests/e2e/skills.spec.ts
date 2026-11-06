import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SkillContractSchema, SkillDetailSchema, SkillRegistryResultSchema, type SkillContract } from '@mohassan/contracts';
import { signInAsFixtureOwner } from './helpers';
test.use({actionTimeout:15000});

async function sourceFixture(suffix: string, contract: SkillContract, text = 'M13_SOURCE_EVIDENCE: احتفظ بالمعنى واذكر الدليل وحدود الثقة.') {
  const root=process.env.MOHASSAN_E2E_ROOT;
  if(!root||!path.basename(root).startsWith('mohassan-e2e-owned-')||await realpath(root)!==root)throw new Error('E2E_ROOT_REQUIRED');
  const approved=path.join(root,'approved-root'), directory=path.join(approved,suffix);
  await mkdir(directory,{recursive:false});
  await writeFile(path.join(directory,'SKILL.md'),`---\nname: ${contract.slug}\ndescription: ${contract.description}\nversion: ${contract.version}\n---\n${text}\n`);
  await writeFile(path.join(directory,'skill.contract.json'),JSON.stringify(contract));
  return {directory,approved};
}
async function openLibrary(page:Page) {
  await signInAsFixtureOwner(page,'overview');
  await page.getByRole('button',{name:'مكتبة المهارات',exact:true}).click();
  await expect(page.getByRole('region',{name:'مكتبة المهارات',exact:true})).toBeVisible();
}
async function importUI(page:Page,directory:string) {
  const toggle=page.locator('summary').filter({hasText:'استيراد مهارة محلية'});
  if(!await page.getByLabel('مسار مجلد المهارة',{exact:true}).isVisible())await toggle.click();
  await page.getByLabel('مسار مجلد المهارة',{exact:true}).fill(directory);
  const response=page.waitForResponse(r=>r.url().endsWith('/api/skills/import')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'استيراد للمراجعة',exact:true}).click();
  const result=await response;expect(result.status(),await result.text()).toBe(200);
  const skill=(await result.json()).skill;
  await expect(page.getByRole('region',{name:'تفاصيل المهارة',exact:true})).toContainText(skill.name);
  await expect(page.getByRole('region',{name:'تفاصيل المهارة',exact:true})).toContainText(skill.contentHash);
  return skill as {id:string;revision:number;contentHash:string;version:string};
}
async function inspectUI(page:Page,id:string) {
  const response=page.waitForResponse(r=>r.url().endsWith(`/api/skills/${id}/inspect`)&&r.request().method()==='POST');
  await page.getByRole('button',{name:'فحص المهارة',exact:true}).click();
  const result=await response;expect(result.status(),await result.text()).toBe(200);
  return SkillDetailSchema.parse(await result.json());
}
async function confirm(page:Page,title:string,endpoint:string) {
  const dialog=page.getByRole('dialog',{name:title,exact:true});await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button',{name:'تأكيد العملية',exact:true})).toBeDisabled();
  await dialog.getByRole('checkbox',{name:'راجعت النطاق وأوافق على هذه العملية'}).check();
  const response=page.waitForResponse(r=>r.url().endsWith(endpoint)&&r.request().method()==='POST');
  await dialog.getByRole('button',{name:'تأكيد العملية',exact:true}).click();
  const result=await response;expect(result.status(),await result.text()).toBe(200);
  await expect(dialog).not.toBeVisible();return result.json();
}
async function activateUI(page:Page,id:string) {
  await expect(page.getByRole('button',{name:'مراجعة التفعيل',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'مراجعة التفعيل',exact:true}).click();
  return confirm(page,'مراجعة تفعيل المهارة',`/api/skills/${id}/activate`);
}
async function detail(page:Page,id:string) { const response=await page.request.get(`/api/skills/${id}`);expect(response.ok()).toBe(true);return SkillDetailSchema.parse(await response.json()); }
async function search(page:Page,text:string) {await page.getByLabel('البحث في المهارات',{exact:true}).fill(text);await page.getByRole('button',{name:'بحث',exact:true}).click();}
async function measuredContrast(page:Page,info:TestInfo,name:string) {
  const samples=await page.getByRole('region',{name:'مكتبة المهارات',exact:true}).evaluate(root=>{
    const rgba=(value:string)=>{const numbers=value.match(/[\d.]+/g)?.map(Number);return numbers&&numbers.length>=3?[numbers[0],numbers[1],numbers[2],numbers[3]??1]:null;};
    const luminance=(channels:number[])=>channels.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    return [...root.querySelectorAll('small,p,label')].flatMap(element=>{
      if(!element.getClientRects().length||!(element.textContent??'').trim())return[];
      const style=getComputedStyle(element),foreground=rgba(style.color);if(!foreground||foreground[3]!==1)return[];
      if(Number(style.opacity)!==1||element.closest('[aria-disabled="true"]'))return[];
      let ancestor:Element|null=element,background:number[]|null=null;
      while(ancestor){const ancestorStyle=getComputedStyle(ancestor);if(ancestorStyle.backgroundImage!=='none')return[];const value=rgba(ancestorStyle.backgroundColor);if(value&&value[3]===1){background=value;break;}ancestor=ancestor.parentElement;}
      background??=[255,255,255,1];const a=luminance(foreground),b=luminance(background);
      const ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05),size=parseFloat(style.fontSize),weight=Number(style.fontWeight);
      const minimum=size>=24||size>=18.66&&weight>=700?3:4.5;
      return[{tag:element.tagName,className:element.className,text:element.textContent!.trim().slice(0,120),foreground:style.color,background:background.slice(0,3),ratio:Math.round(ratio*100)/100,minimum}];
    });
  });
  const report=info.outputPath(`${name}.json`);await writeFile(report,JSON.stringify(samples,null,2));
  await info.attach(name,{path:report,contentType:'application/json'});
  return samples.filter(sample=>sample.ratio<sample.minimum);
}
async function checkEvolution(page:Page,info:TestInfo,options:{evaluationId?:string;runId?:string}) {
  await page.locator('summary').filter({hasText:/^تطور القدرات والمحفظة$/}).click();
  const evolution=page.getByRole('region',{name:'تطور القدرات والأدلة',exact:true});await expect(evolution).toBeVisible();
  await evolution.getByRole('button',{name:'تحديث الأدلة',exact:true}).click();
  await expect(evolution).toHaveAttribute('aria-busy','false');
  const portfolio=await (await page.request.get('/api/skills/portfolio?limit=10&offset=0')).json();
  if(options.evaluationId){
    const evaluation=portfolio.items.flatMap((item:any)=>item.quality.evaluations).find((item:any)=>item.evaluationId===options.evaluationId);
    expect(evaluation).toBeDefined();await expect(evolution).toContainText(evaluation.measuredScope);
    await expect(evolution).toContainText('تجربة محلية معزولة. الجودة الدلالية والتكلفة المالية غير مقاستين.');
  }
  if(options.runId){expect(portfolio.recentRuns.some((run:any)=>run.id===options.runId&&run.evidenceIds.length===1)).toBe(true);await expect(evolution).toContainText(options.runId);}
  await evolution.locator('summary').filter({hasText:/^علاقات المهارات والتركيب$/}).click();
  const graph=await (await page.request.get('/api/skills/graph')).json();
  await expect(evolution).toContainText(`${graph.nodes.length} عقدة، ${graph.edges.length} علاقة، حد التوسع ${graph.limits.depth}.`);
  if(options.runId)expect(graph.edges.length).toBeGreaterThan(0);
  if(!graph.edges.length)await expect(evolution).toContainText('لا توجد علاقات موثقة بعد.');
  await expect(evolution).toContainText('هذه العلاقات لا تمنح إذن التنفيذ.');
  await evolution.locator('summary').filter({hasText:/^ضمانات العزل الفعلية$/}).click();
  const sandbox=await (await page.request.get('/api/skills/sandbox')).json();expect(sandbox.executionAllowed).toBe(false);
  await expect(evolution).toContainText('المهارات التنفيذية غير متاحة. جميع بوابات العزل إلزامية.');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await evolution.getByRole('heading',{name:'تطور القدرات والأدلة',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath(options.runId?'skills-evolution-mobile.png':'skills-evolution-desktop.png'),animations:'disabled'});
}

test('desktop library reviews actual source, versions, explicit activation and rollback, then measures a real isolated comparison',async({page},info)=>{
  test.setTimeout(180000);await page.setViewportSize({width:1440,height:1000});
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const base=SkillContractSchema.parse({slug:'m13-review-guide',name:'دليل مراجعة M13',description:'تعليمات مراجعة واضحة بأدلة محفوظة ضمن اختبار واجهة معزول.',version:'1.0.0',category:'documents',level:'instruction'});
  const first=await sourceFixture('m13-guide-v1',base), second=await sourceFixture('m13-guide-v2',{...base,version:'1.0.1'},'M13_SOURCE_CANDIDATE: احتفظ بالمعنى واذكر الدليل، ثم راجع عدم اليقين.');
  await openLibrary(page);
  const v1=await importUI(page,first.directory);
  await expect(page.getByRole('button',{name:'مراجعة التفعيل',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'قراءة SKILL.md',exact:true}).click();
  await expect(page.getByRole('region',{name:'نص مصدر المهارة'})).toContainText('M13_SOURCE_EVIDENCE');
  await expect(page.getByRole('region',{name:'نص مصدر المهارة'})).toContainText('بصمة مطابقة');
  const contrastFailures=await measuredContrast(page,info,'desktop-small-text-contrast');
  await inspectUI(page,v1.id);await activateUI(page,v1.id);
  await expect.poll(async()=>(await detail(page,v1.id)).skill.active).toBe(true);
  const v2=await importUI(page,second.directory);await inspectUI(page,v2.id);await activateUI(page,v2.id);
  expect((await detail(page,v1.id)).skill.status).toBe('deprecated');
  await expect(page.getByRole('button',{name:'استعادة 1.0.0',exact:true})).toBeVisible();
  await page.getByLabel('سبب الإلغاء أو استعادة الإصدار',{exact:true}).fill('استعادة النسخة المقروءة بعد مراجعة التغيير.');
  await page.getByRole('button',{name:'استعادة 1.0.0',exact:true}).click();
  await confirm(page,'مراجعة استعادة الإصدار',`/api/skills/${v1.id}/rollback`);
  expect((await detail(page,v1.id)).skill.active).toBe(true);expect((await detail(page,v2.id)).skill.active).toBe(false);
  await search(page,'m13-review-guide');
  await expect(page.locator('[data-testid^="skill-card-"]')).toHaveCount(2);
  await page.screenshot({path:info.outputPath('skills-desktop.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'التجارب وForge',exact:true}).click();
  await page.getByLabel('نسخة الأساس',{exact:true}).selectOption(v1.id);
  await page.getByLabel('النسخة المرشحة',{exact:true}).selectOption(v2.id);
  await page.getByLabel('مجموعة القياس',{exact:true}).selectOption('instruction-delivery-v1');
  await expect(page.getByRole('button',{name:'بدء المقارنة المعزولة',exact:true})).toBeDisabled();
  await page.getByRole('checkbox',{name:'أوافق على تشغيل المجموعة المحددة على نسختي الأساس والمرشح في البيئة المعزولة.'}).check();
  const measured=page.waitForResponse(r=>r.url().endsWith('/api/skills/benchmarks')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'بدء المقارنة المعزولة',exact:true}).click();
  const response=await measured;expect(response.ok(),await response.text()).toBe(true);const evaluation=await response.json();
  await expect.poll(async()=>{const r=await page.request.get(`/api/skills/benchmarks/${evaluation.id}`);return (await r.json()).status;},{timeout:60000}).toBe('completed');
  await page.getByRole('button',{name:'تحديث السجلات',exact:true}).click();
  await expect(page.getByText('حالة التجربة المحددة: مكتمل',{exact:true})).toBeVisible();
  await expect(page.getByText('التكلفة المالية: غير معلومة. جودة المحتوى الدلالية: غير مقاسة. القياس يخص هذه المجموعة وحدها.',{exact:true})).toBeVisible();
  const saved=await (await page.request.get(`/api/skills/benchmarks/${evaluation.id}`)).json();
  expect(saved.cases).toHaveLength(8);expect(saved.cases.every((item:any)=>item.status==='passed'&&item.evidence.length>0&&item.metrics.costUsd===null)).toBe(true);
  expect((await detail(page,v2.id)).skill.active).toBe(false);
  await page.screenshot({path:info.outputPath('skills-measured-evidence.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'المكتبة والمراجعة',exact:true}).click();
  await page.getByLabel('سبب الإلغاء أو استعادة الإصدار',{exact:true}).fill('إيقاف تعليمات الاختبار بعد مراجعتها.');
  await page.getByRole('button',{name:'إلغاء التفعيل',exact:true}).click();
  await confirm(page,'مراجعة إلغاء التفعيل',`/api/skills/${v1.id}/revoke`);
  expect((await detail(page,v1.id)).skill.status).toBe('revoked');
  await checkEvolution(page,info,{evaluationId:evaluation.id});
  expect(errors).toEqual([]);
  expect(contrastFailures).toEqual([]);
});

test('360px library runs an approved file-read composition with persisted evidence, grants, incompatible scripts and recovery states',async({page,context},info)=>{
  test.setTimeout(180000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await signInAsFixtureOwner(page,'overview');await page.setViewportSize({width:360,height:800});await page.getByRole('button',{name:'فتح القائمة'}).click();
  await page.getByRole('button',{name:'مكتبة المهارات',exact:true}).click();
  const contract=SkillContractSchema.parse({slug:'m13-file-reader',name:'قارئ ملفات M13',description:'قراءة ملف اختبار ضمن جذر مؤقت بإذن محدد ومخرجات متحققة.',version:'1.0.0',category:'documents',level:'tool',sideEffects:'read',idempotent:true,
    inputs:[{name:'root',type:'string',description:'الجذر المحدد'},{name:'path',type:'string',description:'الملف النسبي'}],outputs:[{name:'content',type:'string',description:'النص المقروء'}],requires:{tools:['file.read'],scopes:['file:read'],paths:['fixture.txt']},
    steps:[{id:'read',kind:'tool',title:'اقرأ الملف المحدد',tool:'file.read',inputs:{root:'input.root',path:'input.path'},outputs:[{name:'content',type:'string',description:'النص المقروء'}]}],verification:'طابق محتوى الملف مع دليل القراءة المستقل.'});
  const folder=await sourceFixture('m13-reader',contract);await writeFile(path.join(folder.approved,'fixture.txt'),'M13_FILE_EVIDENCE');
  const skill=await importUI(page,folder.directory);await inspectUI(page,skill.id);await activateUI(page,skill.id);
  const form=page.getByRole('form',{name:'منح صلاحيات محددة'});
  await form.getByRole('checkbox',{name:'file.read',exact:true}).check();await form.getByRole('checkbox',{name:'file:read',exact:true}).check();
  await form.getByLabel('جذور الملفات المسموح بها',{exact:true}).fill(folder.approved);
  await form.getByRole('button',{name:'مراجعة منح الصلاحيات',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'مراجعة منح الصلاحيات',exact:true});await expect(dialog).toContainText(folder.approved);await expect(dialog).toContainText('file.read');
  expect((await detail(page,skill.id)).grants).toHaveLength(0);
  expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
  await page.screenshot({path:info.outputPath('skills-mobile-grant-review.png'),animations:'disabled'});
  await confirm(page,'مراجعة منح الصلاحيات',`/api/skills/${skill.id}/grants`);
  const granted=await detail(page,skill.id);expect(granted.grants).toHaveLength(1);expect(granted.grants[0].tools).toEqual(['file.read']);expect(granted.grants[0].roots).toEqual([folder.approved]);
  await page.getByRole('button',{name:'إضافة إلى التركيب',exact:true}).click();
  await page.getByRole('button',{name:'التحقق من التركيب',exact:true}).click();
  await expect(page.getByRole('region',{name:'نتيجة تحقق التركيب'})).toContainText('التركيب صالح وفق الحالة المقروءة');
  await page.getByLabel('ربط node1.path',{exact:true}).fill('missing.output');
  await page.getByRole('button',{name:'التحقق من التركيب',exact:true}).click();
  await expect(page.getByRole('region',{name:'نتيجة تحقق التركيب'})).toContainText('التركيب يحتاج تصحيحًا');
  await page.getByLabel('ربط node1.path',{exact:true}).fill('input.path');
  await page.getByRole('button',{name:'التحقق من التركيب',exact:true}).click();
  await expect(page.getByRole('region',{name:'نتيجة تحقق التركيب'})).toContainText('التركيب صالح وفق الحالة المقروءة');
  await page.locator('summary').filter({hasText:'طلب تشغيل مدخلات محددة'}).click();
  await page.getByLabel('مدخلات التشغيل JSON',{exact:true}).fill(JSON.stringify({root:folder.approved,path:'fixture.txt'}));
  await page.getByRole('button',{name:'مراجعة طلب التشغيل',exact:true}).click();
  const created=await confirm(page,'مراجعة طلب تشغيل المهارة',`/api/skills/${skill.id}/run`);
  expect(created.task.status).toBe('waiting_approval');
  const taskDialog=page.locator('dialog.detail-dialog');await expect(taskDialog.getByText('هذه المهمة تنتظر قرارك',{exact:true})).toBeVisible();
  await taskDialog.getByRole('button',{name:'موافقة وتنفيذ',exact:true}).click();
  let child:any;
  await expect.poll(async()=>{const workspace=await (await page.request.get('/api/workspace')).json();child=workspace.tasks.find((task:any)=>task.skillBinding?.parentTaskId===created.task.id);return child?.status;},{timeout:30000}).toBe('waiting_approval');
  expect(child.skillNodeInput).toEqual({root:folder.approved,path:'fixture.txt'});
  // Explicit isolated fixture approval; this is not automatic production approval.
  const approval=await page.request.post(`/api/tasks/${child.id}/approve`,{headers:{origin:'http://127.0.0.1:3100'},data:{}});expect(approval.ok(),await approval.text()).toBe(true);
  await expect.poll(async()=>(await (await page.request.get(`/api/tasks/${created.task.id}`)).json()).task.status,{timeout:30000}).toBe('completed');
  await taskDialog.getByRole('button',{name:'إغلاق التفاصيل',exact:true}).click();
  await page.locator('summary').filter({hasText:'سجل التشغيل والأدلة'}).click();
  await page.getByLabel('معرف التشغيل',{exact:true}).fill(child.skillBinding.runId);await page.getByRole('button',{name:'قراءة السجل',exact:true}).click();
  const receipts=await (await page.request.get(`/api/skills/runs/${child.skillBinding.runId}/evidence`)).json();expect(receipts.items).toHaveLength(1);expect(receipts.items[0].status).toBe('succeeded');
  const evidence=page.getByRole('region',{name:'أدلة التشغيل'});await expect(evidence).toBeVisible();await evidence.locator('summary').first().click();await expect(evidence).toContainText(receipts.items[0].id);await expect(evidence).toContainText('M13_FILE_EVIDENCE');
  await page.screenshot({path:info.outputPath('skills-mobile-runtime-evidence.png'),fullPage:true,animations:'disabled'});
  await checkEvolution(page,info,{runId:child.skillBinding.runId});
  await page.getByRole('button',{name:'المكتبة والمراجعة',exact:true}).click();
  await page.getByRole('button',{name:'إلغاء هذه المنحة',exact:true}).click();
  await confirm(page,'مراجعة إلغاء المنحة',`/api/skills/${skill.id}/grants/${granted.grants[0].id}/revoke`);
  expect((await detail(page,skill.id)).grants[0].revokedAt).not.toBeNull();
  const executable=SkillContractSchema.parse({slug:'m13-blocked-script',name:'سكربت محجوب M13',description:'مصدر اختبار فقط لا يشغل أي ملف على المضيف.',version:'1.0.0',category:'coding',level:'executable',steps:[{id:'fixed',kind:'script',entry:'main.py',title:'مصدر غير منفذ'}],execution:{timeoutMs:1000,memoryMb:32,outputMaxBytes:1024},verification:'لا يسمح التشغيل قبل بوابات العزل المطلوبة.'});
  const blocked=await sourceFixture('m13-blocked',executable);await writeFile(path.join(blocked.directory,'main.py'),'# Never executed. Unsupported source review fixture only.\n');
  const blockedSkill=await importUI(page,blocked.directory);const inspected=await inspectUI(page,blockedSkill.id);
  expect(inspected.skill.status).toBe('incompatible');await expect(page.getByRole('button',{name:'مراجعة التفعيل',exact:true})).toBeDisabled();
  await expect(page.getByText('بوابات العزل الإلزامية غير مكتملة. هذه النسخة غير متاحة للتشغيل أو الترقية التنفيذية.',{exact:true})).toBeVisible();
  await search(page,'missing-m13-never-exists');await expect(page.getByRole('heading',{name:'لا توجد مهارات مطابقة',exact:true})).toBeVisible();
  const contrastFailures=await measuredContrast(page,info,'mobile-empty-hint-small-text-contrast');
  await search(page,'m13');
  await page.route('**/api/skills?**',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'ISOLATED_READ_FAILURE',message:'تعثر قراءة اختباري دون تعديل البيانات.'}})}));
  await page.getByRole('button',{name:'تحديث المكتبة',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'ISOLATED_READ_FAILURE'})).toBeVisible();
  await page.unroute('**/api/skills?**');await page.getByRole('button',{name:'تحديث المكتبة',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'ISOLATED_READ_FAILURE'})).toHaveCount(0);
  // Wait for the fresh detail read before testing the stable offline presentation.
  await expect(page.getByRole('button',{name:'فحص المهارة',exact:true})).toBeEnabled();
  await context.setOffline(true);await expect(page.getByText('غير متصل. البيانات المعروضة من آخر قراءة، والعمليات متوقفة حتى عودة الاتصال.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'فحص المهارة',exact:true})).toBeDisabled();
  await context.setOffline(false);await expect(page.getByRole('button',{name:'فحص المهارة',exact:true})).toBeEnabled();
  await page.getByLabel('البحث في المهارات',{exact:true}).focus();await page.keyboard.press('Tab');
  expect(await page.evaluate(()=>{const element=document.activeElement;if(!element||element===document.body)return false;const style=getComputedStyle(element);return style.outlineStyle!=='none'||style.boxShadow!=='none';})).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('skills-mobile-360.png'),fullPage:true,animations:'disabled'});
  expect(contrastFailures).toEqual([]);
  expect(errors).toEqual([]);
});

test('Forge UI preserves quarantine until source inspection, actual isolated benchmark and explicit promotion',async({page},info)=>{
  test.setTimeout(180000);await page.setViewportSize({width:1440,height:1000});
  const contract=SkillContractSchema.parse({slug:'m13-forge-guide',name:'دليل توليد M13',description:'مصدر تعليمات مضبوط لاختبار توليد مرشح ومقارنته قبل التفعيل.',version:'1.0.0',category:'documents',level:'instruction'});
  const source=await sourceFixture('m13-forge-baseline',contract,'M13_FORGE_BASELINE: احتفظ بالمصادر وصرح بحدود الاستنتاج.');
  await openLibrary(page);const baseline=await importUI(page,source.directory);await inspectUI(page,baseline.id);await activateUI(page,baseline.id);
  await page.getByRole('button',{name:'التجارب وForge',exact:true}).click();
  await page.getByLabel('نسخة الأساس',{exact:true}).selectOption(baseline.id);
  await page.getByLabel('هدف التحسين',{exact:true}).fill('حسّن وضوح توثيق المصادر وحدود الاستنتاج دون إضافة أدوات أو أذونات.');
  await expect(page.getByRole('button',{name:'توليد مرشح محفوظ في الحجر',exact:true})).toBeDisabled();
  await page.getByRole('checkbox',{name:'أوافق على إرسال هذا الهدف ومصدر نسخة الأساس المحددة إلى النموذج واستهلاك التوكنات.'}).check();
  const generated=page.waitForResponse(r=>r.url().endsWith('/api/skills/forge/generations')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'توليد مرشح محفوظ في الحجر',exact:true}).click();
  const result=await generated;expect(result.ok(),await result.text()).toBe(true);let generation=await result.json();
  await expect.poll(async()=>{generation=await (await page.request.get(`/api/skills/forge/generations/${generation.id}`)).json();return generation.status;},{timeout:30000}).toBe('succeeded');
  const candidateId=generation.candidateId as string;expect((await detail(page,candidateId)).skill.status).toBe('quarantined');
  await page.getByRole('button',{name:'تحديث السجلات',exact:true}).click();await page.getByRole('button',{name:'فتح المرشح لفحص المصدر',exact:true}).click();
  await page.getByRole('button',{name:'قراءة SKILL.md',exact:true}).click();await expect(page.getByRole('region',{name:'نص مصدر المهارة'})).toContainText('M13_FORGE_CANDIDATE');
  await inspectUI(page,candidateId);expect((await detail(page,candidateId)).skill.active).toBe(false);
  await page.getByRole('button',{name:'التجارب وForge',exact:true}).click();
  await page.getByRole('button',{name:/^m13-forge-guide · 1\.0\.1 · حُفظ المرشح/}).click();
  await page.getByLabel('مجموعة القياس',{exact:true}).selectOption('instruction-delivery-v1');
  await page.getByRole('checkbox',{name:'أوافق على تشغيل المجموعة المحددة على نسختي الأساس والمرشح في البيئة المعزولة.'}).check();
  const benchmark=page.waitForResponse(r=>r.url().endsWith('/api/skills/benchmarks')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'بدء المقارنة المعزولة',exact:true}).click();const measured=await benchmark;expect(measured.ok(),await measured.text()).toBe(true);const evaluation=await measured.json();
  await expect.poll(async()=>(await (await page.request.get(`/api/skills/benchmarks/${evaluation.id}`)).json()).status,{timeout:60000}).toBe('completed');
  await page.getByRole('button',{name:'تحديث السجلات',exact:true}).click();
  const approval=page.getByRole('checkbox',{name:'راجعت مصدر المرشح والفحص ونطاق القياس، وأوافق صراحة على تفعيل هذه النسخة.'});await expect(approval).toBeEnabled();
  await expect(page.getByRole('button',{name:'تفعيل المرشح بعد المراجعة',exact:true})).toBeDisabled();expect((await detail(page,candidateId)).skill.active).toBe(false);
  await page.screenshot({path:info.outputPath('skills-forge-desktop-review.png'),fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:360,height:800});await approval.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('skills-forge-mobile-review.png'),animations:'disabled'});
  await approval.check();const findings=page.getByRole('checkbox',{name:'قرأت ملاحظات الفحص وأقبلها لهذه النسخة.'});if(await findings.isVisible())await findings.check();
  const promoted=page.waitForResponse(r=>r.url().endsWith(`/api/skills/forge/generations/${generation.id}/promote`)&&r.request().method()==='POST');
  await page.getByRole('button',{name:'تفعيل المرشح بعد المراجعة',exact:true}).click();const promotedResponse=await promoted;expect(promotedResponse.ok(),await promotedResponse.text()).toBe(true);
  const candidate=await detail(page,candidateId);expect(candidate.skill.active).toBe(true);expect(candidate.grants).toEqual([]);expect((await detail(page,baseline.id)).skill.status).toBe('deprecated');
  expect(candidate.audit.some(event=>event.event==='skill.forge_promoted')).toBe(true);
});
