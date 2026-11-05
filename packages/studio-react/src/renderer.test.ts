import { describe, expect, it } from 'vitest';
import { WindowsAppContainerSandbox, snapshotHash, type SandboxRunner, type SandboxRunInput, type SandboxTestResult } from '@mohassan/sandbox';
import { buildReactStudio, renderReactStudioArtifact } from './renderer.ts';
import { reactSourceHash, type ReactStudioSnapshot } from './source.ts';

function project(code = 'export default function App(){return <h1>React preview</h1>}'): ReactStudioSnapshot {
  return {framework:'react',entryPath:'src/App.tsx',files:[{path:'src/App.tsx',content:code},{path:'src/style.css',content:'h1{color:#123456}'}]};
}
function fixture(options: {html?:string;receipt?:(receipt:SandboxTestResult)=>SandboxTestResult;mutate?:(input:SandboxRunInput)=>void;duplicate?:boolean} = {}): SandboxRunner {
  return {
    available:async()=>({available:true,provider:'injected-renderer-fixture',message:'No source execution in unit fixture'}),
    run:async input=>{
      options.mutate?.(input);
      const marker = input.files.find(file=>file.path==='render.test.cjs')!.content.match(/MOHASSAN_REACT_[a-f0-9]+=/)![0];
      const line = '# ' + marker + Buffer.from(options.html ?? '<h1 data-mohassan-source-id="n1">React preview</h1>','utf8').toString('base64');
      const receipt: SandboxTestResult = {exitCode:0,stdout:line+(options.duplicate?'\n'+line:''),stderr:'',timedOut:false,durationMs:1,provider:'injected-renderer-fixture',network:'denied',isolation:'appcontainer',isolationVerified:true,snapshotHash:snapshotHash(input.files)};
      return options.receipt?.(receipt) ?? receipt;
    },
  };
}

describe('trusted compilation and isolated React rendering',()=>{
  it('compiles the virtual graph without evaluating source in the host process',async()=>{
    const snapshot = project('globalThis.__mohassanReactHostSentinel=true;export default function App(){return <h1>React preview</h1>}');
    delete (globalThis as Record<string,unknown>).__mohassanReactHostSentinel;
    const artifact = await buildReactStudio(snapshot,fixture({mutate:input=>{
      expect(input.files.map(file=>file.path)).toEqual(['package.json','render.cjs','render.test.cjs']);
      expect(input.files.reduce((sum,file)=>sum+Buffer.byteLength(file.content),0)).toBeLessThan(512*1024);
      expect(input.files.find(file=>file.path==='render.cjs')!.content).toContain('__mohassanReactHostSentinel');
    }}));
    expect((globalThis as Record<string,unknown>).__mohassanReactHostSentinel).toBeUndefined();
    expect(artifact.sourceHash).toBe(reactSourceHash(snapshot));
    expect(artifact.verification).toMatchObject({network:'denied',isolation:'appcontainer',isolationVerified:true,sourceHash:artifact.sourceHash});
    const rendered = renderReactStudioArtifact(artifact,'react-test-nonce-0000001',artifact.sourceHash);
    expect(rendered.document).toContain('React preview');
    expect(rendered.elements.find(element=>element.tag==='h1')).toMatchObject({id:'n1',file:'src/App.tsx',line:1,editableText:true});
    expect(rendered.document).not.toContain('mohassanReactHostSentinel');
  });

  it('resolves only virtual local files and the trusted React runtime',async()=>{
    const source: ReactStudioSnapshot = {framework:'react',entryPath:'src/App.tsx',files:[
      {path:'src/App.tsx',content:"import Hero from './Hero.js';import './style.css';export default function App(){return <Hero/>}"},
      {path:'src/Hero.tsx',content:'export default function Hero(){return <h1>React preview</h1>}'},
      {path:'src/style.css',content:'h1{color:#123456}'},
    ]};
    expect((await buildReactStudio(source,fixture())).css).toContain('color:#123456');
    for (const specifier of ['node:fs','fs','react-dom/client','next/headers','https://external.test/module.js','C:/private.tsx','../../outside.tsx']) {
      await expect(buildReactStudio(project(`import thing from ${JSON.stringify(specifier)};export default function App(){return <h1>{String(thing)}</h1>}`),fixture())).rejects.toBeInstanceOf(Error);
    }
    await expect(buildReactStudio(project("import Missing from './missing';export default function App(){return <Missing/>}"),fixture())).rejects.toMatchObject({code:'REACT_LOCAL_IMPORT_MISSING'});
  });

  it('requires OS availability and rejects unverified or unsuccessful receipts',async()=>{
    const unavailable: SandboxRunner = {available:async()=>({available:false,provider:'missing',message:'fixture unavailable'}),run:async()=>{throw new Error('must not run');}};
    await expect(buildReactStudio(project(),unavailable)).rejects.toMatchObject({code:'REACT_SANDBOX_UNAVAILABLE',statusCode:503});
    for (const receipt of [
      (value:SandboxTestResult)=>({...value,snapshotHash:'0'.repeat(64)}),
      (value:SandboxTestResult)=>({...value,isolationVerified:false}),
      (value:SandboxTestResult)=>({...value,provider:'unexpected-runtime'}),
    ]) await expect(buildReactStudio(project(),fixture({receipt}))).rejects.toMatchObject({code:'REACT_RENDER_UNVERIFIED'});
    await expect(buildReactStudio(project(),fixture({receipt:value=>({...value,exitCode:1,stderr:'private implementation details'})}))).rejects.toMatchObject({code:'REACT_RENDER_FAILED'});
    await expect(buildReactStudio(project(),fixture({receipt:value=>({...value,timedOut:true})}))).rejects.toMatchObject({code:'REACT_RENDER_FAILED'});
  });

  it('accepts exactly one bounded output record, then sanitizes it and preserves source authority',async()=>{
    await expect(buildReactStudio(project(),fixture({duplicate:true}))).rejects.toMatchObject({code:'REACT_RENDER_OUTPUT_INVALID'});
    await expect(buildReactStudio(project(),fixture({html:'a'.repeat(44_001)}))).rejects.toMatchObject({code:'REACT_RENDER_OUTPUT_INVALID'});
    const html = '<h1 data-mohassan-source-id="n1" onclick="alert(1)">React preview</h1><script>parent.pwned=true</script><p data-mohassan-source-id="n999">unmapped</p>';
    const artifact = await buildReactStudio(project(),fixture({html}));
    const rendered = renderReactStudioArtifact(artifact,'react-test-nonce-0000001',artifact.sourceHash);
    expect(rendered.document).not.toContain('parent.pwned');
    expect(rendered.document).not.toContain('onclick=');
    expect(rendered.elements.map(element=>element.id)).toEqual(['n1']);
    expect(()=>renderReactStudioArtifact({...artifact,verification:{...artifact.verification,sourceHash:'0'.repeat(64)}},'react-test-nonce-0000001',artifact.sourceHash)).toThrow();
  });

  it.skipIf(process.platform!=='win32')('renders real React with hooks and static Next layout inside actual AppContainer',async()=>{
    const sandbox = new WindowsAppContainerSandbox();
    expect((await sandbox.available()).available).toBe(true);
    const snapshot: ReactStudioSnapshot = {framework:'next',entryPath:'app/page.tsx',files:[
      {path:'app/page.tsx',content:"import {useState} from 'react';import Hero from '../src/Hero';export default function Page(){const [count]=useState(7);return <main><Hero/><p>{count}</p></main>}"},
      {path:'src/Hero.tsx',content:'export default function Hero(){return <h1>Actual isolated React</h1>}'},
      {path:'app/layout.tsx',content:'export default function Layout({children}){return <html lang="ar" dir="rtl"><body>{children}</body></html>}'},
      {path:'app/globals.css',content:'h1{color:#173f31}'},
    ]};
    const artifact = await buildReactStudio(snapshot,sandbox);
    expect(artifact.html).toContain('Actual isolated React');
    expect(artifact.html).toContain('>7</p>');
    expect(artifact.verification).toMatchObject({provider:'windows-appcontainer',network:'denied',isolation:'appcontainer',isolationVerified:true});
    const rendered = renderReactStudioArtifact(artifact,'react-test-nonce-0000001',artifact.sourceHash);
    expect(rendered.document).toContain('Actual isolated React');
    expect(rendered.elements.find(element=>element.tag==='h1')).toMatchObject({file:'src/Hero.tsx',editableText:true});
    expect(rendered.elements.find(element=>element.tag==='p')).toMatchObject({editableText:false});
  },90_000);
});
