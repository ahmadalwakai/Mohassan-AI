import { describe,expect,it } from 'vitest';
import { createHmac } from 'node:crypto';
// JavaScript function entry is deployed independently from the local server.
// @ts-ignore Native ESM artifact has no declaration file.
import {createGatewayHandler,validateInput} from '../apps/sandbox-gateway/control.mjs';
const secret='gateway-unit-secret-not-for-real-use-0001',stamp=1793836800000,name='mohassan-studio-'+'a'.repeat(32);
function request(input:unknown,key=secret){const body=JSON.stringify(input),timestamp=String(stamp);return new Request('https://gateway.example/api/control',{method:'POST',body,headers:{'x-studio-time':timestamp,'x-studio-signature':createHmac('sha256',key).update(timestamp+'\n'+body).digest('hex')}});}
describe('isolated Next gateway authorization and bounded program inputs',()=>{
  it('does not contact the platform before HMAC authentication',async()=>{
    const Sandbox={get:async()=>{throw new Error('must not call');}},handler=createGatewayHandler({Sandbox,secret:()=>secret,now:()=>stamp});
    expect((await handler(request({op:'status',name},'wrong-secret'))).status).toBe(401);
    expect((await handler(new Request('https://gateway.example/api/control',{method:'POST',body:'untrusted'}))).status).toBe(401);
    const stale=createGatewayHandler({Sandbox,secret:()=>secret,now:()=>stamp+31000});
    expect((await stale(request({op:'status',name}))).status).toBe(401);
  });
  it('rejects credentials, outside paths, duplicate paths and unrelated sandbox names',()=>{
    const good={op:'create',name,cap:'b'.repeat(48),framework:'react',entryPath:'src/App.tsx',files:[{path:'src/App.tsx',content:'export default()=> <p>hello</p>'}]};
    expect(validateInput(good)).toEqual(good);
    for(const input of [{...good,name:'unrelated-production'},{...good,files:[{path:'../escape.tsx',content:'x'}]},{...good,files:[{path:'.env.json',content:'x'}]},{...good,files:[...good.files,...good.files]},{...good,entryPath:'missing.tsx'}])expect(()=>validateInput(input)).toThrow();
    expect(()=>validateInput({op:'proxy',name,path:'https://private.example',method:'GET'})).toThrow();
  });
  it('pins follow-up commands to an existing running project sandbox',async()=>{
    const lookedUp:any[]=[];
    const Sandbox={get:async(input:any)=>{lookedUp.push(input);return {status:'stopped'};}};
    const handler=createGatewayHandler({Sandbox,secret:()=>secret,now:()=>stamp});
    expect((await handler(request({op:'proxy',name,path:'/p/token',method:'GET'}))).status).toBe(410);
    expect(lookedUp).toEqual([{name,resume:false}]);
  });
  it('closes a failed build and denies egress before writing any project source',async()=>{
    const order:string[]=[];let stopped=false;
    const sandbox={name,status:'running',mkDir:async()=>{},writeFiles:async(files:any[])=>{order.push(files.some(x=>x.path.endsWith('/src/App.tsx'))?'project':'trusted-package');},runCommand:async(input:any)=>{if(input.cmd==='npm'){order.push('registry-install');return {exitCode:0};}if(input.args.includes('build'))return {exitCode:1};return {exitCode:0};},update:async(input:any)=>{expect(input.networkPolicy).toBe('deny-all');order.push('egress-denied');},stop:async()=>{stopped=true;}};
    const Sandbox={create:async(input:any)=>{expect(input.persistent).toBe(false);expect(input.ports).toEqual([]);expect(input.networkPolicy).toEqual({allow:['registry.npmjs.org']});return sandbox;}};
    const handler=createGatewayHandler({Sandbox,secret:()=>secret,now:()=>stamp});
    const response=await handler(request({op:'create',name,cap:'b'.repeat(48),framework:'react',entryPath:'src/App.tsx',files:[{path:'src/App.tsx',content:'export default()=> <p>hello</p>'}]}));
    expect(response.status).toBe(422);expect(stopped).toBe(true);expect(order.indexOf('egress-denied')).toBeLessThan(order.indexOf('project'));
  });
});
