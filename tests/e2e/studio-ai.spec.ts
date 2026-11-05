import { test,expect } from '@playwright/test';
import sharp from 'sharp';
import { signInAsFixtureOwner } from './helpers';
import { StudioChangeResultSchema,StudioSessionSchema,TaskSchema } from '@mohassan/contracts';

test('image and text changes use task approval, actual visual review and explicit versioned apply',async({page})=>{
  test.setTimeout(120000);page.setDefaultTimeout(10000);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await signInAsFixtureOwner(page);await page.getByRole('button',{name:'الاستوديو البصري',exact:true}).click();
  const studio=page.getByRole('region',{name:'الاستوديو البصري',exact:true}),created=page.waitForResponse(response=>response.url().endsWith('/api/studio/sessions/demo')&&response.request().method()==='POST');
  await studio.getByRole('button',{name:'إنشاء تجربة بصرية',exact:true}).click();const session=StudioSessionSchema.parse(await (await created).json());
  const frame=page.frameLocator('iframe[title="معاينة المشروع"]');const original=await frame.locator('h1').first().innerText();await frame.locator('h1').first().click();
  const ai=studio.getByRole('region',{name:'تعديل الاستوديو بالذكاء',exact:true});
  const imageBytes=await sharp({create:{width:64,height:64,channels:3,background:'#386f4e'}}).png().toBuffer();
  const imageStored=page.waitForResponse(response=>response.url().endsWith('/api/studio/images')&&response.request().method()==='POST');
  await ai.getByLabel('الصورة المرجعية للتصميم',{exact:true}).setInputFiles({name:'isolated-reference.png',mimeType:'image/png',buffer:imageBytes});const imageResponse=await imageStored;expect(imageResponse.ok()).toBe(true);const image=await imageResponse.json();
  await expect(ai.getByAltText('التصميم المرجعي المرفق')).toBeVisible();await ai.getByLabel('ما التغيير البصري المطلوب؟',{exact:true}).fill('استلهم لون الصورة، واجعل عنوان الصفحة أوضح مع الحفاظ على بقية الملفات.');
  const taskCreated=page.waitForResponse(response=>response.url().endsWith('/api/tasks')&&response.request().method()==='POST');await ai.getByRole('button',{name:'إنشاء مهمة التعديل',exact:true}).click();const task=TaskSchema.parse(await (await taskCreated).json());expect(task).toMatchObject({capabilityId:'studio.change',status:'waiting_approval',studioInput:{sessionId:session.id,revision:session.revision,imageId:image.id}});
  const initialTask=await page.request.get(`/api/tasks/${task.id}`);expect((await initialTask.json()).modelRuns).toEqual([]);
  const detail=page.locator('dialog.detail-dialog');await expect(detail.getByText('هذه المهمة تنتظر قرارك',{exact:true})).toBeVisible();await expect(detail.locator('.approval-box')).toContainText('الصورة المرفقة');await expect(detail.locator('.approval-box')).toContainText('قرارًا منفصلًا');
  await detail.getByRole('button',{name:'موافقة وتنفيذ',exact:true}).click();
  const review=detail.getByRole('region',{name:'مقترح الاستوديو المتحقق',exact:true});await expect(review).toBeVisible({timeout:60000});await expect(review.getByRole('heading',{name:'التعديل البصري جاهز للمراجعة',exact:true})).toBeVisible();await expect(review).toContainText('مقترح الاستوديو الاختباري');
  const completedResponse=await page.request.get(`/api/tasks/${task.id}`),completed=await completedResponse.json(),result=StudioChangeResultSchema.parse(completed.task.result);expect(completed.task.status).toBe('completed');expect(result).toMatchObject({applied:false,outcome:'ready_for_review'});expect(result.visualDiff?.changedPixels).toBeGreaterThan(0);expect(result.checkpoint).toMatch(/^[a-f0-9]{40,64}$/);expect(completed.modelRuns[0]).toMatchObject({usageKnown:true,resultCommitted:true});
  const beforeApply=await page.request.get(`/api/studio/sessions/${session.id}`);expect(StudioSessionSchema.parse(await beforeApply.json()).revision).toBe(session.revision);
  for(const id of [result.baselineImageId,result.candidateImageId]){const response=await page.request.get(`/api/studio/reviews/artifacts/${id}`);expect(response.ok()).toBe(true);expect(response.headers()['content-type']).toContain('image/png');}
  await expect(review.getByAltText('المعاينة قبل التعديل')).toBeVisible();await expect(review.getByAltText('معاينة المقترح بعد الاختبار')).toBeVisible();
  await review.getByRole('heading').scrollIntoViewIfNeeded();await detail.screenshot({path:'artifacts/studio-ai-review-desktop.png',animations:'disabled'});
  const applied=page.waitForResponse(response=>response.url().endsWith(`/api/studio/proposals/${result.proposalId}/apply`)&&response.request().method()==='POST');await review.getByRole('button',{name:'تطبيق المقترح على نسخة المراجعة',exact:true}).click();expect((await applied).ok()).toBe(true);await expect(review.getByText('طُبق المقترح على نسخة المراجعة.',{exact:true})).toBeVisible();
  await detail.getByRole('button',{name:'إغلاق التفاصيل',exact:true}).click();await expect(frame.locator('h1').first()).toHaveText('مقترح الاستوديو الاختباري');
  await studio.getByRole('button',{name:'التراجع عن آخر تعديل',exact:true}).click();await expect(frame.locator('h1').first()).toHaveText(original);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'artifacts/studio-ai-mobile.png',fullPage:true,animations:'disabled'});
  expect(errors).toEqual([]);
});
