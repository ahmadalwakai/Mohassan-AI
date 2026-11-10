import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createE2EFixture, isolatedE2EEnvironment, requireFreePort, spawnOwned, stopOwnedChildren } from './e2e/isolation';

const run = promisify(execFile);
async function syntheticWeb() {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(parent, 'mohassan-e2e-source-test-'));
  await mkdir(path.join(directory, 'app'));
  await writeFile(path.join(directory, 'app', 'page.tsx'), 'export default function Page(){return null}');
  await writeFile(path.join(directory, '.env'), 'SYNTHETIC_SECRET=do-not-copy');
  await writeFile(path.join(directory, 'app', '.env.local'), 'SYNTHETIC_SECRET=do-not-copy-nested');
  await writeFile(path.join(directory, 'private-key.txt'), 'synthetic-only');
  return { directory, async cleanup() {
    if(path.dirname(directory)!==parent||!path.basename(directory).startsWith('mohassan-e2e-source-test-')||await realpath(directory)!==directory)throw new Error('UNOWNED_FIXTURE');
    await rm(directory,{recursive:true,force:false});
  } };
}

describe('owned E2E infrastructure isolation', () => {
  it('drops inherited providers, database, proxies, NODE_OPTIONS and arbitrary flags', () => {
    const directory=path.join(tmpdir(),'synthetic-e2e-root');
    const env=isolatedE2EEnvironment(directory,{SystemRoot:process.env.SystemRoot,DATABASE_URL:'synthetic-remote-db',GROQ_API_KEY:'synthetic-secret',OPENAI_API_KEY:'synthetic-secret',MOHASSAN_LIVE_GROQ_KEY:'synthetic-secret',LOCAL_MODEL_NAME:'synthetic-model',LOCAL_MODEL_URL:'http://127.0.0.1:1',CODING_ALLOWED_ROOTS:'C:\\',NODE_OPTIONS:'--import synthetic-hook',HTTPS_PROXY:'synthetic-proxy',SKILL_ENGINE_ENABLED:'false',RUN_WORKER:'false',DOTENV_CONFIG_PATH:'synthetic.env'});
    expect(env.DATABASE_URL).toBe('');expect(env.LOCAL_MODEL_NAME).toBe('');expect(env.LOCAL_MODEL_URL).toBe('');expect(env.GROQ_API_KEY).toBeUndefined();expect(env.MOHASSAN_LIVE_GROQ_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();expect(env.HTTPS_PROXY).toBeUndefined();expect(env.DOTENV_CONFIG_PATH).toBeUndefined();expect(env.NODE_OPTIONS).toBe('');
    expect(env.CODING_ALLOWED_ROOTS).toBe(path.join(directory,'approved-root'));expect(env.SKILL_ENGINE_ENABLED).toBe('true');expect(env.RUN_WORKER).toBe('true');
  });

  it('copies only source without .env and cleans the owned junction without deleting dependencies', async () => {
    const source=await syntheticWeb();let fixture:Awaited<ReturnType<typeof createE2EFixture>>|undefined;
    try {
      fixture=await createE2EFixture(source.directory);
      expect(await readFile(path.join(fixture.webDirectory,'app','page.tsx'),'utf8')).toContain('function Page');
      await expect(access(path.join(fixture.webDirectory,'.env'))).rejects.toMatchObject({code:'ENOENT'});
      await expect(access(path.join(fixture.webDirectory,'app','.env.local'))).rejects.toMatchObject({code:'ENOENT'});
      await expect(access(path.join(fixture.webDirectory,'private-key.txt'))).rejects.toMatchObject({code:'ENOENT'});
      expect(await realpath(path.join(fixture.webDirectory,'node_modules'))).toBe(await realpath('node_modules'));
      await fixture.cleanup();await fixture.cleanup();
      await expect(access(fixture.directory)).rejects.toMatchObject({code:'ENOENT'});
      await access('node_modules/typescript/package.json');
    } finally { await fixture?.cleanup();await source.cleanup(); }
  });

  it('does not load a synthetic cwd .env through isolated getConfig', async () => {
    const source=await syntheticWeb();const fixture=await createE2EFixture(source.directory);
    try {
      await writeFile(path.join(fixture.directory,'.env'),'SYNTHETIC_UNDECLARED_SECRET=must-not-load\nOPENAI_API_KEY=must-not-load');
      const config=pathToFileURL(path.resolve('apps/server/src/config.ts')).href;
      const script=`await import(${JSON.stringify(config)}); if(process.env.SYNTHETIC_UNDECLARED_SECRET||process.env.OPENAI_API_KEY)process.exit(77); console.log('isolated-config-ok')`;
      const result=await run(process.execPath,['--import',pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href,'--input-type=module','--eval',script],{cwd:fixture.directory,env:fixture.environment,windowsHide:true});
      expect(result.stdout.trim()).toBe('isolated-config-ok');
    } finally {await fixture.cleanup();await source.cleanup();}
  });

  it('refuses an occupied fixture port without contacting or stopping its server', async () => {
    const listener=createServer();await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
    try {const address=listener.address();if(!address||typeof address==='string')throw new Error('NO_PORT');await expect(requireFreePort(address.port)).rejects.toThrow('E2E_PORT_IN_USE');expect(listener.listening).toBe(true);}
    finally {await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));}
  });

  it('rejects a direct non-isolated entry before any dotenv file read', async () => {
    const source=await syntheticWeb();const fixture=await createE2EFixture(source.directory);
    try {
      const entry=pathToFileURL(path.resolve('tests/e2e/server-entry.ts')).href;
      const script=`import fs from 'node:fs';const read=fs.readFileSync;let dotenvRead=false;fs.readFileSync=function(file,...args){if(String(file).includes('.env'))dotenvRead=true;return read.call(this,file,...args)};let denied=false;try{await import(${JSON.stringify(entry)})}catch(error){denied=String(error.message).includes('only for isolated browser tests')};if(!denied||dotenvRead)process.exit(78);console.log('early-refusal-ok')`;
      const result=await run(process.execPath,['--import',pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href,'--input-type=module','--eval',script],{cwd:source.directory,env:{...fixture.environment,MOHASSAN_ISOLATED_TEST:'false'},windowsHide:true});
      expect(result.stdout.trim()).toBe('early-refusal-ok');
    } finally {await fixture.cleanup();await source.cleanup();}
  });

  it('awaits a trusted child shutdown receipt and process close before removing its directory', async () => {
    const source=await syntheticWeb();const fixture=await createE2EFixture(source.directory);
    const marker=path.join(fixture.directory,'closed.txt');
    const script=`const fs=require('node:fs');process.on('message',m=>{if(m.type==='e2e.shutdown')setTimeout(()=>{fs.writeFileSync(${JSON.stringify(marker)},'flushed');process.disconnect()},75)});process.send('ready')`;
    const owned=spawnOwned(['--eval',script],fixture.directory,fixture.environment,true);
    try {
      await new Promise<void>((resolve,reject)=>{owned.child.once('message',()=>resolve());owned.child.once('error',reject);});
      await stopOwnedChildren([owned]);expect(owned.hasClosed()).toBe(true);expect(await readFile(marker,'utf8')).toBe('flushed');
      await fixture.cleanup();await expect(access(fixture.directory)).rejects.toMatchObject({code:'ENOENT'});
    } finally {await stopOwnedChildren([owned]);await fixture.cleanup();await source.cleanup();}
  });
});
