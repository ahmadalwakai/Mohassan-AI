import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { signInAsFixtureOwner } from './helpers';

// Native HttpClient does not emit browser Fetch Metadata. Undici fetch does,
// so this transport fixture uses HTTP directly rather than weakening the API.
function companionPost(path:'/api/windows/companion/pair'|'/api/windows/companion/poll',payload:unknown,authorization?:string):Promise<{status:number;json:()=>Promise<any>}>{
  const body=JSON.stringify(payload);
  return new Promise((accept,reject)=>{
    const request=httpRequest({hostname:'127.0.0.1',port:4100,path,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),...(authorization?{authorization}:{})}},response=>{
      let text='';response.setEncoding('utf8');response.on('data',chunk=>{text+=chunk;if(Buffer.byteLength(text)>400000)request.destroy(new Error('Fixture response limit'));});response.on('end',()=>accept({status:response.statusCode??0,json:async()=>JSON.parse(text)}));response.on('error',reject);
    });request.on('error',reject);request.setTimeout(5000,()=>request.destroy(new Error('Fixture transport timeout')));request.end(body);
  });
}

test('Windows owner UI pairs an explicit transport fixture, enforces view-only scope and revokes consent',async({page,context})=>{
  test.setTimeout(90000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await signInAsFixtureOwner(page);
  await page.getByRole('button',{name:'التحكم بالكمبيوتر',exact:true}).click();
  const windows=page.getByRole('region',{name:'التحكم في Windows',exact:true});await expect(windows).toBeVisible();
  await windows.getByRole('button',{name:'إنشاء رمز ربط',exact:true}).click();
  const pairCode=await windows.getByLabel('رمز ربط Windows',{exact:true}).inputValue();
  // This is a disposable API transport fixture, never the owner's local computer.
  // Native capture+SendInput are independently verified against an owned WinForms fixture.
  const paired=await companionPost('/api/windows/companion/pair',{code:pairCode,name:'جهاز نقل اختباري — ليس جهاز المالك'});expect(paired.status).toBe(200);const device=await paired.json() as {deviceId:string;deviceKey:string};
  const fixturePage=await context.newPage();await fixturePage.setViewportSize({width:640,height:360});await fixturePage.setContent('<html lang="ar" dir="rtl"><body style="background:#edf3e7;color:#31543d;font-family:Arial;padding:50px"><h1>نطاق نقل اختباري</h1><p>هذه صورة مصنوعة لاختبار واجهة النقل؛ ليست شاشة جهاز المالك.</p><button>عنصر اختبار فقط</button></body></html>');const jpeg=(await fixturePage.screenshot({type:'jpeg',quality:45})).toString('base64');await fixturePage.close();
  let localView=false,revoked=false,polling=false,epoch=randomUUID();const targetKey='a'.repeat(64);
  const state=()=>({approvalNonce:epoch,sessionId:1,safeDesktop:true,localView,localControl:false,target:{key:targetKey,mode:'window',title:'نطاق نقل اختباري فقط',width:640,height:360},status:'اختبار نقل مستقل؛ لا توجد صلاحية إدخال محلي'});
  async function poll(){if(polling||revoked)return;polling=true;try{const response=await companionPost('/api/windows/companion/poll',{nonce:randomUUID(),sentAt:new Date().toISOString(),state:state(),frame:localView?{id:randomUUID(),targetKey,capturedAt:new Date().toISOString(),width:640,height:360,jpeg,elements:[{name:'عنصر نقل اختباري',type:'ControlType.Button',x:50,y:150,width:150,height:30,password:false}]}:null,ack:null},`Bearer ${device.deviceId}.${device.deviceKey}`);if(response.status===401){revoked=true;return;}expect(response.status).toBe(200);const result=await response.json();if(result.stop){localView=false;epoch=randomUUID();}}finally{polling=false;}}
  await poll();const timer=setInterval(()=>{void poll().catch(()=>{});},500);
  try{
    await expect(windows.getByText('جهاز نقل اختباري — ليس جهاز المالك',{exact:true})).toBeVisible();
    await expect(windows.getByRole('button',{name:'السماح بالمشاهدة',exact:true})).toBeDisabled();
    localView=true;epoch=randomUUID();await poll();
    await expect(windows.getByRole('button',{name:'السماح بالمشاهدة',exact:true})).toBeEnabled();
    await windows.getByRole('button',{name:'السماح بالمشاهدة',exact:true}).click();
    await expect(windows.getByAltText('صورة النطاق المصرح من جهاز Windows')).toBeVisible();
    await expect(windows.getByRole('button',{name:'السماح بالإدخال مؤقتًا',exact:true})).toBeDisabled();
    await expect(windows.getByLabel('نص الإدخال إلى Windows',{exact:true})).toBeDisabled();
    await windows.getByText('العناصر المقروءة من نطاق الجهاز',{exact:false}).click();
    await expect(windows.getByText('عنصر نقل اختباري',{exact:true})).toBeVisible();
    await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:test.info().outputPath('windows-desktop.png'),fullPage:true,animations:'disabled'});
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:test.info().outputPath('windows-mobile.png'),fullPage:true,animations:'disabled'});
    await windows.getByRole('button',{name:'إيقاف الجلسة الآن',exact:true}).click();
    await expect(windows.getByAltText('صورة النطاق المصرح من جهاز Windows')).toHaveCount(0);
    await windows.getByRole('button',{name:'إلغاء ربط الجهاز',exact:true}).click();
    await expect(windows.getByText('أُلغي الربط',{exact:true})).toBeVisible();
    await windows.getByRole('button',{name:'إنشاء رمز ربط',exact:true}).click();const pendingCode=await windows.getByLabel('رمز ربط Windows',{exact:true}).inputValue();
    await page.setViewportSize({width:1440,height:1000});
    await page.getByRole('button',{name:'تسجيل الخروج',exact:true}).click();await expect(page.getByRole('heading',{name:'تسجيل الدخول',exact:true})).toBeVisible();
    const replay=await companionPost('/api/windows/companion/pair',{code:pendingCode,name:'expired fixture'});expect(replay.status).toBe(401);
    expect(errors).toEqual([]);
  }finally{clearInterval(timer);revoked=true;}
});
