import {createServer} from 'node:http';
import {test,expect} from '@playwright/test';
import {signInAsFixtureOwner} from './helpers';

test('owner explicitly indexes a source, searches the dated snapshot and removes it',async({page})=>{
  test.setTimeout(90000);let documentsRead=0;
  const fixture=createServer((request,response)=>{
    if(request.url==='/robots.txt'){response.writeHead(200,{'content-type':'text/plain'});response.end('User-agent: *\nAllow: /\n');return;}
    documentsRead++;response.writeHead(200,{'content-type':'text/html; charset=utf-8'});
    response.end('<html><head><title>Quantum calibration guide</title></head><body><main><h1>Quantum calibration guide</h1><p>The quantum calibration procedure uses a reference clock and documented measurements. This isolated test source explains how technicians compare measured readings before calibrating the instrument.</p></main></body></html>');
  });
  await new Promise<void>((resolve,reject)=>{fixture.once('error',reject);fixture.listen({port:4201,host:'127.0.0.1',exclusive:true},resolve);});
  try{
    await signInAsFixtureOwner(page);
    await page.getByRole('button',{name:'المتصفح والبحث',exact:true}).click();
    await page.getByText('فهرسي المحلي للمصادر العامة',{exact:true}).click();
    const panel=page.locator('details').filter({has:page.locator('summary').filter({hasText:'فهرسي المحلي للمصادر العامة'})});
    await expect(panel.getByText('لم تضف مصدرًا بعد.',{exact:true})).toBeVisible();expect(documentsRead).toBe(0);
    await panel.getByLabel('رابط المصدر للفهرس',{exact:true}).fill('http://127.0.0.1:4201/guide');
    await panel.getByRole('button',{name:'قراءة الرابط وحفظه في فهرسي',exact:true}).click();
    await expect(panel.getByRole('heading',{name:'المصادر المحفوظة (1)',exact:true})).toBeVisible();expect(documentsRead).toBe(1);
    await panel.getByLabel('ابحث في فهرسي',{exact:true}).fill('quantum calibration');
    await panel.getByRole('button',{name:'بحث في النسخ المحفوظة',exact:true}).click();
    await expect(panel.getByText(/نسخة محفوظة · قُرئت/)).toBeVisible();expect(documentsRead).toBe(1);
    await panel.getByRole('button',{name:'تحديث قراءة المصدر',exact:true}).click();
    await expect(panel.getByText('أُعيدت قراءة المصدر وفحصه وتحديث نسخته.',{exact:true})).toBeVisible();expect(documentsRead).toBe(2);
    await panel.getByRole('button',{name:'بحث في النسخ المحفوظة',exact:true}).click();
    await expect(panel.getByText(/نسخة محفوظة · قُرئت/)).toBeVisible();expect(documentsRead).toBe(2);
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await panel.screenshot({path:'artifacts/search-index-mobile.png',animations:'disabled'});
    await panel.getByRole('button',{name:'حذف المصدر من فهرسي',exact:true}).click();
    await expect(panel.getByText('لم تضف مصدرًا بعد.',{exact:true})).toBeVisible();
    await panel.getByRole('button',{name:'بحث في النسخ المحفوظة',exact:true}).click();
    await expect(panel.getByText('لا توجد نتيجة مطابقة في فهرسك.',{exact:true})).toBeVisible();expect(documentsRead).toBe(2);
  }finally{fixture.closeAllConnections();await new Promise<void>(resolve=>fixture.close(()=>resolve()));}
});
