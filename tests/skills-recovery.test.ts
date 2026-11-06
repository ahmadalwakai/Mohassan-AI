import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

let directory:string|undefined;
let server:Server|undefined;
const children=new Set<ChildProcess>();
const browserChildren=new Set<ChildProcess>();
afterEach(async()=>{
  for(const child of children){if(child.exitCode===null&&child.signalCode===null){
    if(browserChildren.has(child)&&child.connected){
      await new Promise<void>((resolveCleanup,reject)=>{const timer=setTimeout(()=>{child.off('message',listener);reject(new Error(`Owned browser worker ${child.pid} did not acknowledge cleanup`));},10000);const listener=(message:any)=>{if(message?.kind==='cleanup-ready'){clearTimeout(timer);child.off('message',listener);resolveCleanup();}};child.on('message',listener);child.send('cleanup');});
    }
    const closed=once(child,'close');child.kill('SIGKILL');await closed;
  }}
  children.clear();
  browserChildren.clear();
  if(server){await new Promise<void>((resolveClose,reject)=>server!.close(error=>error?reject(error):resolveClose()));server=undefined;}
  if(directory){const target=resolve(directory);if(!target.startsWith(resolve(tmpdir())+sep)||!basename(target).startsWith('mohassan-crash-'))throw new Error('Unsafe fixture cleanup');await rm(target,{recursive:true,force:true});directory=undefined;}
});
function worker(mode:string,phase:string,browserOrigin?:string){
  const args=browserOrigin?[resolve('tests/fixtures/skill-browser-crash-worker.ts'),directory!,phase,browserOrigin]:[resolve('tests/fixtures/skill-crash-worker.ts'),directory!,mode,phase];
  const child=spawn(process.execPath,['--import','tsx',...args],{cwd:resolve('.'),windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TEMP:process.env.TEMP,TMP:process.env.TMP,NODE_ENV:'test'}});
  children.add(child);let errors='';child.stderr!.on('data',data=>{errors+=String(data).slice(0,4000);});
  if(browserOrigin)browserChildren.add(child);
  const message=new Promise<any>((resolveMessage,reject)=>{
    child.once('message',resolveMessage);child.once('error',reject);child.once('exit',code=>{if(code!==0)reject(new Error(`Owned fixture exited ${code}: ${errors}`));});
  });
  return {child,message};
}
describe('actual disposable worker crash recovery',()=>{
  it('resumes a real browser-to-file workflow after the owned worker dies between its steps',async()=>{
    directory=await mkdtemp(join(tmpdir(),'mohassan-crash-'));let navigations=0;
    server=createServer((request,response)=>{if(request.url==='/fixture')navigations++;response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end('<html><title>Owned restart fixture</title><main>Verified browser evidence survives restart 73</main></html>');});
    await new Promise<void>(resolveListen=>server!.listen(0,'127.0.0.1',resolveListen));const address=server.address();if(!address||typeof address==='string')throw new Error('Fixture address');const origin=`http://127.0.0.1:${address.port}`;
    const first=worker('browser','start',origin),checkpoint=await first.message;expect(checkpoint).toMatchObject({kind:'checkpoint',browserClosed:true,stage:'browser-completed-before-report'});
    const closed=once(first.child,'close');first.child.kill('SIGKILL');await closed;children.delete(first.child);
    const resumed=worker('browser','resume',origin),result=await resumed.message;
    expect(result.parent.status).toBe('completed');expect(result.parent.attempt).toBe(1);expect(result.content).toContain('Verified browser evidence survives restart 73');expect(result.parent.result.outputs.report.hash).toBe(result.hash);
    expect(result.receipts).toHaveLength(2);expect(result.receipts.every((receipt:any)=>receipt.status==='succeeded'&&receipt.attempt===1)).toBe(true);expect(navigations).toBe(1);expect(result.writes).toBe(1);
    if(resumed.child.exitCode===null)await once(resumed.child,'close');children.delete(resumed.child);
  },60000);
  it.each(['confirmed','unknown'])('never repeats a write after a %s checkpoint crash',async mode=>{
    directory=await mkdtemp(join(tmpdir(),'mohassan-crash-'));
    const first=worker(mode,'start'),checkpoint=await first.message;
    expect(checkpoint.kind).toBe('checkpoint');expect(checkpoint.pid).toBe(first.child.pid);
    const closed=once(first.child,'close');first.child.kill('SIGKILL');await closed;children.delete(first.child);
    const second=worker(mode,'resume'),result=await second.message;
    expect(result.kind).toBe('result');expect(result.dispatches).toBe(1);expect(result.content).toBe('One approved durable write.');
    expect(result.receipts).toHaveLength(1);expect(result.receipts[0].attempt).toBe(1);
    const child=result.tasks.find((task:any)=>task.capability_id==='skill.node'),parent=result.tasks.find((task:any)=>task.capability_id==='skill.run');
    expect(child.attempt).toBe(1);
    if(mode==='confirmed'){
      expect(child.status).toBe('completed');expect(parent.status).toBe('completed');expect(child.verification_only).toBe(true);
      expect(child.verification_source_lease).toBe(result.receipts[0].lease_token);expect(result.receipts[0].status).toBe('succeeded');expect(result.events).toContain('verification_recovered');expect(result.locks).toBe(0);
    }else{
      expect(child.status).toBe('failed');expect(parent.status).toBe('failed');expect(result.receipts[0].status).toBe('unknown');expect(result.locks).toBe(1);expect(result.events).not.toContain('verification_recovered');
    }
    if(second.child.exitCode===null)await once(second.child,'close');children.delete(second.child);
  },60000);

  it('survives a second crash during verification using the original receipt and no new execution attempt',async()=>{
    directory=await mkdtemp(join(tmpdir(),'mohassan-crash-'));
    for(const phase of ['start','resume-pause']){
      const running=worker('confirmed',phase),checkpoint=await running.message;expect(checkpoint.kind).toBe('checkpoint');
      const closed=once(running.child,'close');running.child.kill('SIGKILL');await closed;children.delete(running.child);
    }
    const resumed=worker('confirmed','resume'),result=await resumed.message;
    expect(result.dispatches).toBe(1);expect(result.receipts).toHaveLength(1);
    const child=result.tasks.find((task:any)=>task.capability_id==='skill.node');expect(child).toMatchObject({status:'completed',attempt:1,verification_only:true});
    expect(child.verification_source_lease).toBe(result.receipts[0].lease_token);
    expect(result.events.filter((type:string)=>type==='verification_recovered')).toHaveLength(2);
    if(resumed.child.exitCode===null)await once(resumed.child,'close');children.delete(resumed.child);
  },60000);

  it('rejects a changed file during recovered verification without overwriting it',async()=>{
    directory=await mkdtemp(join(tmpdir(),'mohassan-crash-'));
    const first=worker('confirmed','start');expect((await first.message).kind).toBe('checkpoint');
    const closed=once(first.child,'close');first.child.kill('SIGKILL');await closed;children.delete(first.child);
    await writeFile(join(directory,'files','report.txt'),'A later independently written value.');
    const resumed=worker('confirmed','resume'),result=await resumed.message;
    expect(result.dispatches).toBe(1);expect(result.content).toBe('A later independently written value.');
    expect(result.tasks.find((task:any)=>task.capability_id==='skill.node')).toMatchObject({status:'failed',attempt:1});
    expect(result.receipts).toHaveLength(1);expect(result.receipts[0].status).toBe('succeeded');
    if(resumed.child.exitCode===null)await once(resumed.child,'close');children.delete(resumed.child);
  },60000);
});
