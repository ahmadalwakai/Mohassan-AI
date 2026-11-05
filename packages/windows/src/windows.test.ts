import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createDatabase } from '@mohassan/database';
import { migrateAuth } from '../../../apps/server/src/auth.js';
import { registerWindowsRoutes, revokeWindowsSession, windowsMigration } from './index.ts';
import { z } from 'zod';

describe('Windows device permissions with synthetic transport fixtures',()=>{
  let database:Awaited<ReturnType<typeof createDatabase>>,app:ReturnType<typeof Fastify>,deviceId='',deviceKey='',grant:any;
  const owner='windows-fixture-owner',other='windows-fixture-other',cookie='owner-session-a',key='a'.repeat(64);let epoch=randomUUID();
  const headers=(ownerId=owner,session=cookie)=>({'x-fixture-owner':ownerId,cookie:session});
  const deviceHeaders=()=>({authorization:`Bearer ${deviceId}.${deviceKey}`});
  const state=()=>({approvalNonce:epoch,sessionId:1,safeDesktop:true,localView:true,localControl:true,target:{key,mode:'window',title:'Synthetic fixture target',width:400,height:200},status:'test transport fixture'});
  const frame=()=>({id:randomUUID(),targetKey:key,capturedAt:new Date().toISOString(),width:400,height:200,jpeg:Buffer.concat([Buffer.from([255,216,255]),Buffer.alloc(150),Buffer.from([255,217])]).toString('base64'),elements:[]});
  async function poll(extra:Record<string,unknown>={}){return app.inject({method:'POST',url:'/api/windows/companion/poll',headers:deviceHeaders(),payload:{nonce:randomUUID(),sentAt:new Date().toISOString(),state:state(),frame:null,ack:null,...extra}});}
  async function allow(scope='control',session=cookie){const response=await app.inject({method:'POST',url:`/api/windows/devices/${deviceId}/grants`,headers:headers(owner,session),payload:{scope,durationSeconds:30,targetKey:key,approvalNonce:epoch}});expect(response.statusCode).toBe(200);grant=response.json();return grant;}
  beforeAll(async()=>{
    database=await createDatabase();await migrateAuth(database.db);await windowsMigration(database.db);
    for(const id of [owner,other])await database.db.insertInto('user').values({id,name:id,email:id+'@example.test'}).execute();
    app=Fastify({logger:false});app.setErrorHandler((error:any,_request:any,reply:any)=>{reply.code(error instanceof z.ZodError?400:error.statusCode??500).send({error:{code:error.code??'ERROR',message:error.message}});});
    await registerWindowsRoutes(app,{db:database.db,owner:async request=>{const id=request.headers['x-fixture-owner'];if(id!==owner&&id!==other)throw Object.assign(new Error('unauthorized'),{statusCode:401});return {id};},config:{webOrigin:'http://127.0.0.1:3000',production:false}});await app.ready();
  });
  afterAll(async()=>{await app?.close();await database?.close();});

  it('requires owner authorization, short one-use pairing code and non-browser companion transport',async()=>{
    expect((await app.inject({url:'/api/windows'})).statusCode).toBe(401);
    const pair=await app.inject({method:'POST',url:'/api/windows/pairing',headers:headers(),payload:{}});expect(pair.statusCode).toBe(200);const input={code:pair.json().code,name:'Transport fixture'};
    expect((await app.inject({method:'POST',url:'/api/windows/companion/pair',headers:{origin:'null'},payload:input})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/api/windows/companion/pair',headers:{'sec-fetch-site':'same-origin'},payload:input})).statusCode).toBe(403);
    const paired=await app.inject({method:'POST',url:'/api/windows/companion/pair',payload:input});expect(paired.statusCode).toBe(200);deviceId=paired.json().deviceId;deviceKey=paired.json().deviceKey;
    expect((await app.inject({method:'POST',url:'/api/windows/companion/pair',payload:input})).statusCode).toBe(401);
    const summary=await app.inject({url:'/api/windows',headers:headers()});expect(summary.body).not.toContain(deviceKey);expect(summary.json().devices).toHaveLength(1);
    expect((await app.inject({url:'/api/windows',headers:headers(other)})).json().devices).toEqual([]);
  });
  it('blocks missing local consent, stale polls and replayed nonces',async()=>{
    const noConsent=await app.inject({method:'POST',url:`/api/windows/devices/${deviceId}/grants`,headers:headers(),payload:{scope:'control',durationSeconds:30,targetKey:key,approvalNonce:epoch}});expect(noConsent.statusCode).toBe(409);
    expect((await poll({sentAt:new Date(Date.now()-10000).toISOString()})).statusCode).toBe(409);
    const nonce=randomUUID();expect((await poll({nonce})).statusCode).toBe(200);expect((await poll({nonce})).statusCode).toBe(409);
  });
  it('separates view/control and binds grants to the authenticated browser session',async()=>{
    await allow('view');const image=frame();await poll({frame:image});
    expect((await app.inject({url:`/api/windows/devices/${deviceId}/frame`,headers:headers()})).statusCode).toBe(200);
    expect((await app.inject({url:`/api/windows/devices/${deviceId}/frame`,headers:headers(owner,'different-session')})).statusCode).toBe(409);
    expect((await app.inject({url:`/api/windows/devices/${deviceId}/frame`,headers:headers(other)})).statusCode).toBe(404);
    const response=await app.inject({method:'POST',url:`/api/windows/devices/${deviceId}/actions`,headers:headers(),payload:{grantId:grant.id,nonce:randomUUID(),frameId:image.id,action:{type:'text',text:'must not execute'}}});expect(response.statusCode).toBe(403);
    await revokeWindowsSession(database.db,cookie);
    expect((await app.inject({url:`/api/windows/devices/${deviceId}/frame`,headers:headers()})).statusCode).toBe(409);
    expect((await database.db.selectFrom('windows_grants').select('revoked_at').where('id','=',grant.id).executeTakeFirstOrThrow()).revoked_at).toBeTruthy();
  });
  it('delivers one sequence once, audits results and removes typed content after acknowledgment',async()=>{
    await allow('control');const image=frame();await poll({frame:image});const payload={grantId:grant.id,nonce:randomUUID(),frameId:image.id,action:{type:'text',text:'ephemeral fixture text'}};
    const created=await app.inject({method:'POST',url:`/api/windows/devices/${deviceId}/actions`,headers:headers(),payload});expect(created.statusCode).toBe(200);const id=created.json().id;
    expect((await app.inject({method:'POST',url:`/api/windows/devices/${deviceId}/actions`,headers:headers(),payload})).json().id).toBe(id);
    expect((await app.inject({method:'POST',url:`/api/windows/devices/${deviceId}/actions`,headers:headers(),payload:{...payload,action:{type:'text',text:'different request'}}})).statusCode).toBe(409);
    const delivered=await poll({frame:image});expect(delivered.json().command).toMatchObject({id,grantId:grant.id,sequence:1,frameId:image.id});expect((await poll({frame:image})).json().command).toBeNull();
    await poll({frame:image,ack:{id,status:'applied',code:'APPLIED'}});
    const command=await database.db.selectFrom('windows_commands').selectAll().where('id','=',id).executeTakeFirstOrThrow();expect(command.status).toBe('applied');expect(command.payload).toEqual({});
    const audit=await app.inject({url:'/api/windows',headers:headers()});expect(audit.body).not.toContain('ephemeral fixture text');expect(audit.json().events.some((event:any)=>event.type==='input_applied')).toBe(true);
    expect((await app.inject({method:'POST',url:`/api/windows/devices/${deviceId}/actions`,headers:headers(),payload:{...payload,nonce:randomUUID(),frameId:randomUUID()}})).statusCode).toBe(409);
  });
  it('revokes locally and remotely, preserves unresolved delivery as unknown, and never resumes old consent',async()=>{
    const image=frame();await poll({frame:image});const action=await app.inject({method:'POST',url:`/api/windows/devices/${deviceId}/actions`,headers:headers(),payload:{grantId:grant.id,nonce:randomUUID(),frameId:image.id,action:{type:'key',key:'Enter'}}});expect(action.statusCode).toBe(200);await poll({frame:image});
    expect((await app.inject({method:'POST',url:`/api/windows/devices/${deviceId}/stop`,headers:headers(),payload:{}})).statusCode).toBe(200);
    expect((await poll()).json().stop).toBe(true);const command=await database.db.selectFrom('windows_commands').select('status').where('id','=',action.json().id).executeTakeFirstOrThrow();expect(command.status).toBe('unknown');
    expect((await app.inject({method:'POST',url:`/api/windows/devices/${deviceId}/grants`,headers:headers(),payload:{scope:'control',durationSeconds:30,targetKey:key,approvalNonce:epoch}})).statusCode).toBe(409);
    epoch=randomUUID();await poll();await allow();await poll({state:{...state(),safeDesktop:false,localView:false,localControl:false}});
    expect((await app.inject({url:`/api/windows/devices/${deviceId}/frame`,headers:headers()})).statusCode).toBe(409);
    expect((await app.inject({method:'POST',url:`/api/windows/devices/${deviceId}/revoke`,headers:headers(),payload:{}})).statusCode).toBe(200);expect((await poll()).statusCode).toBe(401);
  });
});

it.skipIf(process.platform!=='win32')('captures UIA and JPEG and sends actual mouse/keyboard only to its own native fixture',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mohassan-windows-native-')),report=join(directory,'report.json');
  try{
    const where=await promisify(execFile)('C:\\Windows\\System32\\where.exe',['pwsh.exe'],{windowsHide:true});const executable=where.stdout.split(/\r?\n/).map(value=>value.trim()).find(value=>isAbsolute(value)&&value.toLowerCase().endsWith('pwsh.exe'));
    if(!executable)throw new Error('Trusted PowerShell is unavailable');
    await promisify(execFile)(executable,['-NoLogo','-NoProfile','-NonInteractive','-File',resolve('scripts/windows-companion.ps1'),'-FixtureSelfTest','-ResultPath',report],{windowsHide:true,timeout:45000});
    const result=JSON.parse(await readFile(report,'utf8'));expect(result).toMatchObject({ok:true,fixtureOnly:true,safeDesktop:true,viewOnlyDenied:true,replayDenied:true,localStopDenied:true,expiredDenied:true,staleFrameDenied:true,wrongGrantDenied:true,screenChangedDenied:true,fixtureScopeDenied:true,mouseResult:'APPLIED',keyboardResult:'APPLIED',clicks:1,typedText:'fixture typed'});expect(result.captureBytes).toBeGreaterThan(1000);expect(result.accessibleElements).toBeGreaterThan(0);
  }finally{const base=await realpath(tmpdir()),target=await realpath(directory),inside=relative(base,target);if(!inside.startsWith('mohassan-windows-native-')||inside.startsWith('..')||isAbsolute(inside))throw new Error('Unsafe fixture cleanup target');await rm(target,{recursive:true,force:true});}
},60000);
