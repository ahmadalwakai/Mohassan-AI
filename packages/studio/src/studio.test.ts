import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { runInNewContext } from 'node:vm';
import { applyStudioEdit, createStudioDemo, inspectStaticProject, renderStudio, studioRevision, type StudioSnapshot } from './index.ts';

const nonce = 'studio-unit-nonce-00000001';
function snapshot(html: string, css = 'p{color:#223344}') : StudioSnapshot { return { entryPath: 'index.html', files: [{ path: 'index.html', content: html }, { path: 'styles.css', content: css }] }; }

describe('bounded declarative preview and exact source edits', () => {
  it('renders a static Arabic demo with source mapping and a trusted bridge', () => {
    const source = createStudioDemo(), rendered = renderStudio(source, nonce);
    expect(rendered.document).toContain('مساحة جديدة');
    expect(rendered.document).toContain('data-mohassan-studio-id="n1"');
    expect(rendered.document).toContain("default-src 'none'");
    expect(rendered.document).toContain(`script nonce="${nonce}"`);
    expect(rendered.document).toContain('mohassan:studio:draft');
    expect(rendered.elements.find(element => element.tag === 'h2')).toMatchObject({ file: 'index.html', editableText: true });
    expect(rendered.elements.find(element => element.tag === 'h1')?.editableText).toBe(true);
    expect(rendered.warnings).toEqual([]);
  });

  it('removes script, SVG, executable attributes, injected mapping and navigable URLs', () => {
    const source = snapshot('<html><head><script>parent.PWNED=true</script></head><body><p onclick="alert(1)" data-mohassan-studio-id="n999">hello</p><a href="https://external.test">go</a><svg><script>alert(2)</script></svg><iframe srcdoc="bad"></iframe><img src="https://external.test/leak"></body></html>');
    const rendered = renderStudio(source, nonce);
    expect(rendered.document).not.toContain('PWNED'); expect(rendered.document).not.toContain('alert(');
    expect(rendered.document).not.toContain('onclick='); expect(rendered.document).not.toContain('n999');
    expect(rendered.document).not.toContain('https://external.test');
    expect(rendered.document).not.toContain('<svg'); expect(rendered.document).not.toContain('<iframe');
    expect(rendered.warnings.length).toBeGreaterThan(0);
  });

  it('inlines only existing local CSS and blocks CSS resource loading and style breakout', () => {
    const local = renderStudio(snapshot('<link rel="stylesheet" href="styles.css"><p>hello</p>'), nonce);
    expect(local.document).toContain('p{color:#223344}');
    const childSelector = renderStudio(snapshot('<link rel="stylesheet" href="styles.css"><div><p>hello</p></div>', 'div > p{color:#223344}'), nonce);
    expect(childSelector.document).toContain('div > p{color:#223344}');
    expect(childSelector.warnings).not.toContain('حُجب CSS يحتوي موارد خارجية أو صياغة غير مدعومة.');
    for (const css of ['p{background:url(https://external.test/x)}', 'p{background:image-set("https://external.test/x" 1x)}', '@import "https://external.test/x";', 'p{background:u\\72l(https://external.test/x)}', '</style><script>alert(1)</script>']) {
      const rendered = renderStudio(snapshot('<link rel="stylesheet" href="styles.css"><p>hello</p>', css), nonce);
      expect(rendered.document).not.toContain('external.test'); expect(rendered.document).not.toContain('alert(1)');
      expect(rendered.warnings).toContain('حُجب CSS يحتوي موارد خارجية أو صياغة غير مدعومة.');
    }
    expect(renderStudio(snapshot('<link rel="stylesheet" href="../private.css"><p>hello</p>'), nonce).warnings.length).toBeGreaterThan(0);
  });

  it('patches only the selected text range and style attribute while preserving unrelated source', () => {
    const html = '<!doctype html>\n<p  class="sample" style="padding: 2px; color: red">A &amp; B</p>\n<!-- keep exact -->\n<p id="other">untouched</p>\n';
    const original = snapshot(html); const element = renderStudio(original, nonce).elements[0];
    const next = applyStudioEdit(original, { elementId: element.id, text: '<safe> & "text"', styles: { color: '#223344', fontSize: 24 } });
    expect(next.files[0].content).toContain('<p  class="sample" style="padding: 2px; color: #223344 !important; font-size: 24px !important">&lt;safe&gt; &amp; "text"</p>');
    expect(next.files[0].content).toContain('\n<!-- keep exact -->\n<p id="other">untouched</p>\n');
    expect(original.files[0].content).toBe(html); expect(next.files[1]).toEqual(original.files[1]);
    expect(renderStudio(next, nonce).elements[0].id).toBe(element.id);
  });

  it('bounds output even when a source repeats the same large local stylesheet', () => {
    const source = snapshot('<link rel="stylesheet" href="styles.css">'.repeat(100) + '<p>hello</p>', '/*' + 'a'.repeat(30000) + '*/p{color:#123456}');
    const rendered = renderStudio(source, nonce);
    expect(rendered.document.length).toBeLessThan(40000);
    expect(rendered.warnings).toContain('أُدرج ملف CSS المحلي مرة واحدة فقط ضمن حدود المعاينة.');
  });

  it('adds styles to an element with no inline style and preserves a self-closing void tag', () => {
    const source = snapshot('<p title="say > here">hello</p><hr/>');
    const elements = renderStudio(source, nonce).elements;
    const next = applyStudioEdit(source, { elementId: elements[0].id, styles: { backgroundColor: '#abcdef' } });
    expect(next.files[0].content).toContain('<p title="say > here" style="background-color: #abcdef !important">hello</p>');
    expect(applyStudioEdit(source, { elementId: elements[1].id, styles: { color: '#123456' } }).files[0].content).toContain('<hr style="color: #123456 !important"/>');
  });

  it('preserves quoted semicolons and CSS functions when changing a different declaration', () => {
    const source = snapshot('<p style="font-family: \'A;B\'; padding: calc(1px + 2px); /* keep ; */ color: red !important">hello</p>');
    const next = applyStudioEdit(source, { elementId: 'n1', styles: { color: '#112233' } });
    expect(next.files[0].content).toContain("font-family: 'A;B'; padding: calc(1px + 2px); color: #112233 !important");
    expect(renderStudio(next, nonce).elements[0].styles.color).toBe('#112233');
    expect(() => applyStudioEdit(snapshot('<p style="font-family: \'broken">hello</p>'), { elementId: 'n1', styles: { color: '#112233' } })).toThrow(/غير مكتمل/);
    expect(() => applyStudioEdit(snapshot('<p style="background:url(external)">hello</p>'), { elementId: 'n1', styles: { color: '#112233' } })).toThrow(/محجوبة/);
  });

  it('explicit saved and draft styles override stylesheet important rules and retain inspector values', () => {
    const source = snapshot('<link rel="stylesheet" href="styles.css"><p>hello</p>', 'p{color:#ff0000!important;background-color:#000000!important;font-size:12px!important}');
    const next = applyStudioEdit(source, { elementId: 'n1', styles: { color: '#112233', backgroundColor: '#abcdef', fontSize: 28 } });
    const rendered = renderStudio(next, nonce);
    expect(rendered.document).toContain('p{color:#ff0000!important');
    expect(rendered.document).toContain('color: #112233 !important; background-color: #abcdef !important; font-size: 28px !important');
    expect(rendered.elements[0].styles).toEqual({ color: '#112233', backgroundColor: '#abcdef', fontSize: '28px' });
    const script = rendered.document.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)![1];
    const listeners = new Map<string, (event: any) => void>(), applied: unknown[][] = [];
    const parent = {}, target = { textContent: 'hello', style: { setProperty: (...values: unknown[]) => applied.push(values) } };
    runInNewContext(script, { parent, document: { querySelector: () => target }, addEventListener: (name: string, handler: (event: any) => void) => listeners.set(name, handler) });
    const revision = studioRevision(next);
    listeners.get('message')!({ source: parent, data: { type: 'mohassan:studio:draft', nonce, revision, elementId: 'n1', text: 'a'.repeat(4000), styles: { color: '#223344', backgroundColor: '#ddeeff', fontSize: 32 } } });
    expect(applied).toEqual([['color', '#223344', 'important'], ['background-color', '#ddeeff', 'important'], ['font-size', '32px', 'important']]);
    expect(target.textContent).toHaveLength(4000);
    listeners.get('message')!({ source: parent, data: { type: 'mohassan:studio:draft', nonce, revision, elementId: 'n1', text: 'b'.repeat(4001) } });
    expect(target.textContent).toHaveLength(4000);
    expect(() => applyStudioEdit(source, { elementId: 'n1', text: 'a'.repeat(4000) })).not.toThrow();
    expect(() => applyStudioEdit(source, { elementId: 'n1', text: 'a'.repeat(4001) })).toThrow(/النص/);
  });

  it('refuses guessed source paths, unbound elements, container text replacement and CSS injection', () => {
    const source = snapshot('<div><p>Hello</p></div>');
    expect(() => applyStudioEdit(source, { elementId: 'n999', text: 'bad' })).toThrow(/العنصر/);
    expect(() => applyStudioEdit(source, { elementId: 'n1', text: 'bad' })).toThrow(/عناصر أخرى/);
    expect(() => applyStudioEdit(source, { elementId: 'n2', text: 'bad', file: '../private.html' } as any)).toThrow(/صريحًا/);
    expect(() => applyStudioEdit(source, { elementId: 'n2', styles: { color: 'red; background:url(x)' } })).toThrow(/HEX/);
    expect(() => applyStudioEdit(source, { elementId: 'n2', styles: { fontSize: 97 } })).toThrow(/96/);
    expect(() => applyStudioEdit(source, { elementId: 'n2', styles: { position: 'fixed' } } as any)).toThrow(/التنسيق/);
  });

  it('binds the bridge to trusted nonce and server revision, including after content undo', () => {
    const source = snapshot('<p>hello</p>'); const revision = 'a'.repeat(64);
    expect(renderStudio(source, nonce, revision).document).toContain(`revision="${revision}"`);
    expect(() => renderStudio(source, 'bad" nonce')).toThrow(/رمز/);
    expect(() => renderStudio(source, nonce, 'untrusted')).toThrow(/إصدار/);
    expect(studioRevision({ ...source, files: [...source.files].reverse() })).toBe(studioRevision(source));
    expect(studioRevision(applyStudioEdit(source, { elementId: 'n1', text: 'changed' }))).not.toBe(studioRevision(source));
  });

  it('reports bounded computed appearance with the mapped selection ID and no source hints', () => {
    const rendered = renderStudio(snapshot('<p>Hello</p>'), nonce), script = rendered.document.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)![1];
    const listeners = new Map<string, (event: any) => void>(), messages: any[] = [];
    class MappedElement {
      closest() { return this; }
      setAttribute() {}
      removeAttribute() {}
      getAttribute() { return 'n1'; }
    }
    runInNewContext(script, {
      parent: { postMessage: (message: unknown) => messages.push(message) }, Element: MappedElement,
      getComputedStyle: () => ({ color: 'rgb(17, 34, 51)', backgroundColor: 'rgba(0, 0, 0, 0)', fontSize: '62px' }),
      addEventListener: (name: string, handler: (event: any) => void) => listeners.set(name, handler),
    });
    listeners.get('click')!({ target: new MappedElement(), preventDefault() {}, stopPropagation() {} });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: 'mohassan:studio:select', nonce, revision: studioRevision(snapshot('<p>Hello</p>')), elementId: 'n1', styles: { color: 'rgb(17, 34, 51)', backgroundColor: 'rgba(0, 0, 0, 0)', fontSize: '62px' } });
    expect(Object.keys(messages[0])).toEqual(['type', 'nonce', 'revision', 'elementId', 'styles']);
  });

  it('rejects oversized snapshots, unsupported extensions, unsafe paths and excessive HTML depth', () => {
    expect(() => renderStudio(snapshot('<p>' + 'a'.repeat(64000) + '</p>'), nonce)).toThrow(/حدود/);
    expect(() => renderStudio({ entryPath: '../index.html', files: [{ path: '../index.html', content: '<p>x</p>' }] }, nonce)).toThrow(/مسار/);
    expect(() => renderStudio({ entryPath: 'index.html', files: [{ path: 'index.html', content: '<p>x</p>' }, { path: 'code.js', content: 'alert(1)' }] }, nonce)).toThrow(/HTML وCSS/);
    expect(() => renderStudio(snapshot('<div>'.repeat(150) + 'x' + '</div>'.repeat(150)), nonce)).toThrow(/التداخل/);
  });
});

describe('verified JSX source mapping on untrusted rendered HTML', () => {
  const sourceElement = {id:'n77',tag:'h1',file:'src/components/Hero.tsx',line:12,text:'Mapped title',styles:{color:'',backgroundColor:'',fontSize:''},editableText:true,editableStyles:true};
  const mapping = {sourceElements:[sourceElement],sourceAttribute:'data-mohassan-source-id' as const};

  it('binds one known same-tag rendered element to its JSX file and line instead of the generated HTML', () => {
    const rendered=renderStudio(snapshot('<h1 data-mohassan-source-id="n77">Mapped title</h1>'),nonce,undefined,mapping);
    expect(rendered.elements).toEqual([sourceElement]);
    expect(rendered.document).toContain('<h1 data-mohassan-studio-id="n77">Mapped title</h1>');
    expect(rendered.document).not.toContain('data-mohassan-source-id');
    expect(rendered.elements[0].file).not.toBe('index.html');
  });

  it('never falls back to generated HTML mapping for unknown, repeated, missing or mismatched IDs', () => {
    for (const html of [
      '<h1 data-mohassan-source-id="n999">Mapped title</h1>',
      '<h1 data-mohassan-source-id="n77">Mapped title</h1><h1 data-mohassan-source-id="n77">Mapped title</h1>',
      '<p data-mohassan-source-id="n77">Mapped title</p>',
      '<h1>Mapped title</h1>',
    ]) {
      const rendered=renderStudio(snapshot(html),nonce,undefined,mapping);
      expect(rendered.elements).toEqual([]);
      expect(rendered.document).not.toMatch(/<(?:h1|p)[^>]*data-mohassan-studio-id/);
    }
    // A generated HTML ID may coincide with a source ID; only the bound attribute
    // and its unique occurrence can grant a source selection.
    expect(renderStudio(snapshot('<h1>Mapped title</h1>'),nonce,undefined,{...mapping,sourceElements:[{...sourceElement,id:'n1'}]}).elements).toEqual([]);
  });

  it('permits normalized literal text but disables text changed by runtime or inserted child elements', () => {
    const normalized=renderStudio(snapshot('<h1 data-mohassan-source-id="n77">\n Mapped\t title \n</h1>'),nonce,undefined,mapping);
    expect(normalized.elements[0].editableText).toBe(true);
    for (const html of ['<h1 data-mohassan-source-id="n77">Runtime replacement</h1>','<h1 data-mohassan-source-id="n77">Mapped <span>title</span></h1>']) {
      const rendered=renderStudio(snapshot(html),nonce,undefined,mapping);
      expect(rendered.elements[0]).toMatchObject({id:'n77',file:sourceElement.file,line:12,editableText:false,text:null});
    }
  });

  it('rejects draft style changes to a dynamically styled JSX element while retaining permitted text drafts', () => {
    const input=snapshot('<h1 data-mohassan-source-id="n77">Mapped title</h1>');
    const rendered=renderStudio(input,nonce,undefined,{...mapping,sourceElements:[{...sourceElement,editableStyles:false}]});
    expect(rendered.elements[0].editableStyles).toBe(false);
    const listeners=new Map<string,(event:any)=>void>(),applied:unknown[][]=[];
    const parent={},target={textContent:'Mapped title',style:{setProperty:(...values:unknown[])=>applied.push(values)}};
    const script=rendered.document.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)![1];
    runInNewContext(script,{parent,document:{querySelector:()=>target},addEventListener:(name:string,handler:(event:any)=>void)=>listeners.set(name,handler)});
    const send=(data:Record<string,unknown>)=>listeners.get('message')!({source:parent,data:{type:'mohassan:studio:draft',nonce,revision:studioRevision(input),elementId:'n77',...data}});
    send({styles:{color:'#123456'}});
    expect(applied).toEqual([]);
    expect(target.textContent).toBe('Mapped title');
    send({text:'Safe literal draft',styles:{}});
    expect(target.textContent).toBe('Safe literal draft');
    expect(applied).toEqual([]);
  });

  it('blocks JSX formatting overridden by runtime priority CSS while retaining exact text mapping', () => {
    for (const html of [
      '<style>h1{color:red !/**/important}</style><h1 data-mohassan-source-id="n77">Mapped title</h1>',
      '<h1 data-mohassan-source-id="n77" style="color:#123456 !important">Mapped title</h1>',
    ]) {
      const input=snapshot(html),rendered=renderStudio(input,nonce,undefined,mapping);
      expect(rendered.elements[0]).toMatchObject({id:'n77',file:sourceElement.file,editableStyles:false,editableText:true,text:'Mapped title'});
      expect(rendered.warnings.length).toBeGreaterThan(0);
      const listeners=new Map<string,(event:any)=>void>(),applied:unknown[][]=[];
      const parent={},target={textContent:'Mapped title',style:{setProperty:(...values:unknown[])=>applied.push(values)}};
      runInNewContext(rendered.document.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)![1],{parent,document:{querySelector:()=>target},addEventListener:(name:string,handler:(event:any)=>void)=>listeners.set(name,handler)});
      const send=(data:Record<string,unknown>)=>listeners.get('message')!({source:parent,data:{type:'mohassan:studio:draft',nonce,revision:studioRevision(input),elementId:'n77',...data}});
      send({styles:{color:'#abcdef'}});
      expect(applied).toEqual([]);
      send({text:'Permitted literal text',styles:{}});
      expect(target.textContent).toBe('Permitted literal text');
    }
  });
});

describe('static folder import boundaries', () => {
  let directory = '';
  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'mohassan-studio-engine-')); });
  afterAll(async () => {
    if (!directory) return;
    const target = await realpath(directory), base = await realpath(tmpdir()), inside = relative(base, target);
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('mohassan-studio-engine-')) throw new Error('Unsafe cleanup path');
    await rm(target, { recursive: true, force: true });
  });
  it('imports bounded UTF-8 HTML/CSS without modifying originals', async () => {
    const root = join(directory, 'site'); await mkdir(root);
    await writeFile(join(root, 'index.html'), '<link rel="stylesheet" href="styles.css"><p>مرحبا</p>');
    await writeFile(join(root, 'styles.css'), 'p{color:#123456}');
    const imported = await inspectStaticProject(root, 'index.html', [directory]);
    expect(imported.files.map(file => file.path)).toEqual(['index.html', 'styles.css']);
    applyStudioEdit(imported, { elementId: 'n1', text: 'نسخة مراجعة' });
    expect(await readFile(join(root, 'index.html'), 'utf8')).toContain('مرحبا');
    await expect(inspectStaticProject(root, 'index.html', [join(directory, 'elsewhere')])).rejects.toThrow();
  });
  it('rejects sensitive paths before reading and rejects hard-linked files', async () => {
    const root = join(directory, 'secret-site'); await mkdir(root);
    await writeFile(join(root, 'index.html'), '<p>hello</p>'); await writeFile(join(root, '.env'), 'sensitive');
    await expect(inspectStaticProject(root, 'index.html', [directory])).rejects.toMatchObject({ code: 'SENSITIVE_STUDIO_PATH' });
    const linked = join(directory, 'linked-site'); await mkdir(linked);
    await link(join(root, 'index.html'), join(linked, 'index.html'));
    await expect(inspectStaticProject(linked, 'index.html', [directory])).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
  });
  it('rejects nondeclarative project files without executing them', async () => {
    const root = join(directory, 'runtime-site'); await mkdir(root);
    await writeFile(join(root, 'index.html'), '<p>hello</p>'); await writeFile(join(root, 'script.js'), 'throw new Error("must never run")');
    await expect(inspectStaticProject(root, 'index.html', [directory])).rejects.toMatchObject({ code: 'STATIC_FILES_REQUIRED' });
  });
});
