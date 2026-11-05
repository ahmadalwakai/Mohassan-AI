import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { applyReactStudioEdit, checkReactSnapshot, createReactDemo, inspectReactProject, instrumentReactSnapshot, reactSourceHash, type ReactStudioSnapshot } from './source.ts';

const snapshot = (content:string):ReactStudioSnapshot => ({framework:'react',entryPath:'src/App.tsx',files:[{path:'src/App.tsx',content}]});

describe('exact JSX source mapping without executing project modules', () => {
  it('maps real React and Next demo components deterministically to original source', () => {
    for (const framework of ['react','next'] as const) {
      const source = createReactDemo(framework), compiled = instrumentReactSnapshot(source);
      const heading = compiled.elements.find(element=>element.tag==='h1')!;
      expect(heading).toMatchObject({file:'src/components/Hero.tsx',line:5,editableText:true,editableStyles:true});
      expect(heading.text).toBe('واجهة React لفكرتك القادمة.');
      const counter = compiled.elements.find(element=>element.file===source.entryPath&&element.tag==='p')!;
      expect(counter.editableText).toBe(false);
      expect(compiled.files.find(file=>file.path===heading.file)?.content).toContain(`data-mohassan-source-id="${heading.id}"`);
      expect(source.files.some(file=>file.content.includes('data-mohassan-source-id'))).toBe(false);
      expect(instrumentReactSnapshot({...source,files:[...source.files].reverse()}).elements).toEqual(compiled.elements);
      expect(reactSourceHash({...source,files:[...source.files].reverse()})).toBe(reactSourceHash(source));
      expect(compiled.css).toContain('.hero');
    }
  });

  it('patches only exact JSX text and style ranges and preserves unrelated bytes', () => {
    const input = `// kept verbatim\nexport default function App(){return <main><h1  className='hero' style={{ color : 'red', /*keep*/ padding: 7, }}>Old &amp; new</h1><p>unrelated</p></main>}\n`;
    const original=snapshot(input), heading=instrumentReactSnapshot(original).elements.find(element=>element.tag==='h1')!;
    expect(heading.text).toBe('Old & new');
    const next=applyReactStudioEdit(original,{elementId:heading.id,text:'<safe> {value} & "quoted"',styles:{color:'#123456',fontSize:42}});
    expect(next.files[0].content).toContain(`// kept verbatim\nexport default function App(){return <main><h1  className='hero' style={{ color : "#123456", /*keep*/ padding: 7,fontSize:42, }}>`);
    expect(next.files[0].content).toContain('{"<safe> {value} & \\"quoted\\""}'.replaceAll('\\\\','\\'));
    expect(next.files[0].content).toContain('<p>unrelated</p></main>}\n');
    expect(original.files[0].content).toBe(input);
    expect(instrumentReactSnapshot(next).elements.find(element=>element.id===heading.id)).toMatchObject({text:'<safe> {value} & "quoted"',styles:{color:'#123456',fontSize:'42px'}});
  });

  it('adds a literal JSX style object while preserving self-closing syntax', () => {
    const original=snapshot(`export default ()=><main><hr /><h1>Title</h1></main>`);
    const elements=instrumentReactSnapshot(original).elements;
    const next=applyReactStudioEdit(original,{elementId:elements.find(item=>item.tag==='hr')!.id,styles:{backgroundColor:'#abcdef'}});
    expect(next.files[0].content).toContain('<hr  style={{backgroundColor:"#abcdef"}}/>');
    expect(()=>instrumentReactSnapshot(next)).not.toThrow();
  });

  it('refuses dynamic text and styles, spreads, duplicate style keys and mixed children', () => {
    for (const [jsx,kind] of [
      ['<p>{value}</p>','text'],['<p>Hello <strong>child</strong></p>','text'],
      ['<p style={theme}>hello</p>','style'],['<p {...props}>hello</p>','style'],
      ['<p style={{color:theme.color}}>hello</p>','style'],['<p style={{color:"red",color:"blue"}}>hello</p>','style'],
    ] as const) {
      const original=snapshot(`export default ()=>${jsx}`), element=instrumentReactSnapshot(original).elements[0];
      expect(()=>applyReactStudioEdit(original,{elementId:element.id,...(kind==='text'?{text:'new'}:{styles:{color:'#123456'}})})).toThrow(/ديناميكي|فرعية/);
    }
  });

  it('normalizes multiline JSX text and supports a single string literal expression', () => {
    const original=snapshot('export default ()=> <main><p>\n  Hello\n  world &amp; more\n</p><span>{"static literal"}</span></main>');
    const result=instrumentReactSnapshot(original);
    expect(result.elements.find(item=>item.tag==='p')?.text).toBe('Hello world & more');
    expect(result.elements.find(item=>item.tag==='span')?.text).toBe('static literal');
  });

  it('disables direct formatting when imported priority rules could override the saved React style', () => {
    const source=snapshot('export default ()=> <h1>Hello</h1>');
    for (const css of ['h1{color:red!important}', 'h1{font-size:12px ! /**/ IMPORTANT}']) {
      const original={...source,files:[...source.files,{path:'styles.css',content:css}]};
      const mapped=instrumentReactSnapshot(original);
      expect(mapped.elements[0]).toMatchObject({editableStyles:false,editableText:true});
      expect(mapped.warnings.join(' ')).toContain('!important');
      expect(()=>applyReactStudioEdit(original,{elementId:'n1',styles:{color:'#123456'}})).toThrow(/تنسيق/);
      expect(instrumentReactSnapshot(applyReactStudioEdit(original,{elementId:'n1',text:'still editable'})).elements[0].text).toBe('still editable');
    }
    expect(instrumentReactSnapshot(snapshot('export default ()=> <h1 style={{color:"red!important"}}>Hello</h1>')).elements[0].editableStyles).toBe(false);
  });

  it('rejects unknown ids, malformed values, reserved mapping and dynamic imports', () => {
    const original=snapshot('export default ()=> <h1>Hello</h1>');
    expect(()=>applyReactStudioEdit(original,{elementId:'n999',text:'bad'})).toThrow(/غير موجود/);
    for(const edit of [{elementId:'n1',styles:{color:'url(https://x.test)'}},{elementId:'n1',styles:{fontSize:999}},{elementId:'n1',text:'x'.repeat(4001)},{elementId:'n1',text:'x',path:'../secret'}]) expect(()=>applyReactStudioEdit(original,edit as never)).toThrow();
    expect(()=>instrumentReactSnapshot(snapshot('export default ()=> <h1 data-mohassan-source-id="n123">x</h1>'))).toThrow(/محجوزة/);
    for (const content of ['const x=import(path);export default ()=> <p>x</p>','const x=require(path);export default ()=> <p>x</p>','const x=require.resolve("react");export default ()=> <p>x</p>']) expect(()=>instrumentReactSnapshot(snapshot(content))).toThrow(/استيراد|require.resolve/);
    expect(()=>instrumentReactSnapshot(snapshot('const x=import("./part");export default ()=> <p>x</p>'))).not.toThrow();
  });

  it('preserves text limit and rejects source secrets, duplicate paths and excessive source', () => {
    const original=snapshot('export default ()=> <p>text</p>');
    expect(instrumentReactSnapshot(applyReactStudioEdit(original,{elementId:'n1',text:'x'.repeat(4000)})).elements[0].text).toHaveLength(4000);
    expect(()=>checkReactSnapshot({...original,files:[...original.files,{path:'SRC/app.tsx',content:'x'}]})).toThrow(/مكرر/);
    expect(()=>checkReactSnapshot({...original,files:[{path:'.env',content:'not-read'}]})).toThrow();
    expect(()=>checkReactSnapshot(snapshot('x'.repeat(64001)))).toThrow();
    expect(()=>instrumentReactSnapshot(snapshot('export default ()=> <p>broken</h1>'))).toThrow(/صياغة/);
  });

  it('never evaluates source during inspection or instrumentation', () => {
    const original=snapshot('globalThis.__must_not_run=true; throw new Error("do not execute"); export default ()=> <h1>inert</h1>;');
    delete (globalThis as Record<string,unknown>).__must_not_run;
    expect(instrumentReactSnapshot(original).elements[0].text).toBe('inert');
    applyReactStudioEdit(original,{elementId:'n1',text:'still inert'});
    expect((globalThis as Record<string,unknown>).__must_not_run).toBeUndefined();
  });
});

describe('bounded React project import', () => {
  let directory='';
  beforeAll(async()=>{directory=await mkdtemp(join(tmpdir(),'mohassan-react-source-'));});
  afterAll(async()=>{
    const base=await realpath(tmpdir()),target=await realpath(directory),inside=relative(base,target);
    if(!inside||isAbsolute(inside)||inside.startsWith('..')||!inside.startsWith('mohassan-react-source-'))throw new Error('Unsafe cleanup');
    await rm(target,{recursive:true,force:true});
  });

  it('reads supported source while ignoring generated dependency trees and executable config', async()=>{
    const folder=join(directory,'valid');await mkdir(join(folder,'src'),{recursive:true});
    await mkdir(join(folder,'node_modules'));await writeFile(join(folder,'node_modules','.env'),'must never be read');
    await writeFile(join(folder,'src','App.tsx'),'export default ()=> <h1>مرحبا</h1>');
    await writeFile(join(folder,'README.md'),'metadata');
    await writeFile(join(folder,'next.config.js'),'throw new Error("must never execute")');
    await writeFile(join(folder,'package.json'),'{"scripts":{"start":"arbitrary-command"}}');
    const imported=await inspectReactProject(folder,'src/App.tsx',[directory],'react');
    expect(imported.files.map(file=>file.path)).toEqual(['package.json','src/App.tsx']);
    applyReactStudioEdit(imported,{elementId:'n1',text:'review only'});
    expect(await readFile(join(folder,'src','App.tsx'),'utf8')).toContain('مرحبا');
    await expect(inspectReactProject(folder,'src/App.tsx',[join(directory,'missing')],'react')).rejects.toThrow();
  });

  it('rejects sensitive paths without requiring readable secret content and rejects hard links', async()=>{
    const folder=join(directory,'sensitive');await mkdir(folder);await writeFile(join(folder,'App.tsx'),'export default ()=> <p>x</p>');await mkdir(join(folder,'.env'));
    await expect(inspectReactProject(folder,'App.tsx',[directory],'react')).rejects.toMatchObject({code:'SENSITIVE_REACT_PATH'});
    const linked=join(directory,'linked');await mkdir(linked);await link(join(folder,'App.tsx'),join(linked,'App.tsx'));
    await expect(inspectReactProject(linked,'App.tsx',[directory],'react')).rejects.toMatchObject({code:'UNSUPPORTED_REACT_PATH'});
  });
});
