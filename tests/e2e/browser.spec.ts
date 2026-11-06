import {test,expect} from '@playwright/test';
import {createServer,type Server} from 'node:http';
import {signInAsFixtureOwner} from './helpers';

let fixture:Server,writes=0;
test.beforeAll(async()=>{fixture=createServer((request,response)=>{
  response.setHeader('content-type','text/html; charset=utf-8');
  if(request.url==='/submit'&&request.method==='POST'){writes++;response.end('<title>Submitted once</title><h1>Receipt from fixture</h1><p>This local form was accepted exactly once.</p>');return;}
  if(request.url==='/a'||request.url==='/b'){const amount=request.url==='/a'?10:20;response.end(`<title>Project capacity source ${amount}</title><h1>Project capacity evidence</h1><p>The project capacity is ${amount} units. This is an explicit isolated test source with enough factual text for comparison.</p>`);return;}
  if(request.url==='/next'){response.end('<title>Next browser fixture</title><h1>Read another controlled page</h1>');return;}
  response.end('<title>Phase six browser fixture</title><h1>Owned browser observation</h1><a href="/next">Open next fixture</a><form method="post" action="/submit"><label>Your name<input name="name"></label></form>');
});await new Promise<void>((resolve,reject)=>{fixture.once('error',reject);fixture.listen({port:4201,host:'127.0.0.1',exclusive:true},resolve);});});
test.afterAll(async()=>{fixture.closeAllConnections();await new Promise<void>(resolve=>fixture.close(()=>resolve()));});

test('browser sessions, consent, persistent cited research and mobile recovery',async({page,context})=>{
  test.setTimeout(120000);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await signInAsFixtureOwner(page);await page.getByRole('button',{name:'المتصفح والبحث',exact:true}).click();const browser=page.getByRole('region',{name:'المتصفح والبحث',exact:true});
  await browser.getByLabel('عنوان البداية',{exact:true}).fill('http://127.0.0.1:4201/');
  await browser.getByRole('button',{name:'إنشاء جلسة وفتح الصفحة',exact:true}).click();
  await expect(browser.getByRole('heading',{name:'Phase six browser fixture',exact:true})).toBeVisible();
  await expect(browser.getByAltText('لقطة الصفحة من جلسة المتصفح المستقلة')).toBeVisible();
  await browser.getByRole('button',{name:'Open next fixture',exact:true}).click();await expect(browser.getByRole('heading',{name:'Next browser fixture',exact:true})).toBeVisible();
  await browser.getByRole('button',{name:'فتح عنوان البداية في الجلسة',exact:true}).click();await expect(browser.getByRole('heading',{name:'Phase six browser fixture',exact:true})).toBeVisible();
  await browser.getByText('نموذج 1 — POST',{exact:true}).click();
  await browser.getByLabel('حقل النموذج: Your name',{exact:true}).fill('Fixture owner');
  await browser.getByRole('button',{name:'طلب موافقة الإرسال',exact:true}).click();await expect(browser.getByText('مراجعة الإرسال قبل الموافقة',{exact:true})).toBeVisible();expect(writes).toBe(0);
  await browser.getByRole('button',{name:'موافقة وإرسال مرة واحدة',exact:true}).click();await expect(browser.getByRole('heading',{name:'Submitted once',exact:true})).toBeVisible();expect(writes).toBe(1);
  await page.reload();await page.getByRole('button',{name:'المتصفح والبحث',exact:true}).click();await expect(browser.getByRole('heading',{name:'Submitted once',exact:true})).toBeVisible();
  await context.setOffline(true);await expect(browser.getByRole('button',{name:'إنشاء جلسة وفتح الصفحة',exact:true})).toBeDisabled();await context.setOffline(false);await expect(page.getByText('النظام متصل',{exact:true})).toBeVisible();
  await browser.getByRole('button',{name:'البحث بالمصادر',exact:true}).click();await browser.getByLabel('سؤال البحث',{exact:true}).fill('What is the project capacity?');
  await browser.getByLabel('عدد المصادر').selectOption('2');await browser.getByText('تحديد المصادر أو نطاق المواقع',{exact:true}).click();
  await browser.getByLabel('روابط مصادر مباشرة',{exact:true}).fill('http://127.0.0.1:4201/a\nhttp://127.0.0.1:4201/b');
  await browser.getByRole('button',{name:'ابدأ البحث الموثق',exact:true}).click();
  const report=browser.getByRole('region',{name:'تقرير البحث الموثق',exact:true});await expect(report).toBeVisible({timeout:30000});
  await expect(report.locator('article')).toHaveCount(2);await expect(report.locator('blockquote').first()).toContainText('10');await expect(report.locator('blockquote').nth(1)).toContainText('20');await expect(report).toContainText('اختلاف محتمل');
  await expect(report.locator('a[href="http://127.0.0.1:4201/a"]')).toBeVisible();
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:test.info().outputPath('browser-research-desktop.png'),fullPage:true,animations:'disabled'});
  await page.reload();await page.getByRole('button',{name:'المتصفح والبحث',exact:true}).click();await browser.getByRole('button',{name:'البحث بالمصادر',exact:true}).click();await expect(report.locator('article')).toHaveCount(2);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:test.info().outputPath('browser-research-mobile.png'),fullPage:true,animations:'disabled'});
  await browser.getByRole('button',{name:'المتصفح',exact:true}).click();await browser.getByRole('button',{name:'إغلاق وإلغاء الصلاحية',exact:true}).click();await expect(browser.getByRole('button',{name:'إغلاق وإلغاء الصلاحية',exact:true})).toBeDisabled();expect(errors).toEqual([]);
});
