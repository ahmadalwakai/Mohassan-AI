import { describe,expect,it } from 'vitest';
import { bindStudioEdits,editableStudioPath,selectStudioPaths,studioCanonicalJson } from './index.ts';
const snapshot={entryPath:'index.html',files:[{path:'index.html',content:'<h1>Before</h1>'},{path:'styles.css',content:'h1{color:red}'},{path:'test/component.test.ts',content:'// immutable fixture'},{path:'next.config.ts',content:'export default {}'},{path:'package.json',content:'{"private":true}'}]};
describe('studio model edit policy and canonical receipts',()=>{
  it('binds hashes on the server and excludes configs, tests, credentials and package manifests',()=>{
    expect(selectStudioPaths(snapshot)).toEqual(['index.html','styles.css']);for(const path of ['next.config.ts','test/component.test.ts','package.json','secrets.css'])expect(editableStudioPath(path)).toBe(false);
    const proposal=bindStudioEdits(snapshot,['index.html'],{summary:'Proposed source change',edits:[{path:'index.html',content:'<h1>After</h1>'}]});expect(proposal.edits[0].expectedHash).toMatch(/^[a-f0-9]{64}$/);
    for(const edits of [[{path:'../.env',content:'bad'}],[{path:'package.json',content:'{}'}],[{path:'index.html',content:'<h1>After</h1>',expectedHash:'forged'}],[{path:'index.html',content:'<h1>After</h1>'},{path:'index.html',content:'<h1>Other</h1>'}]])expect(()=>bindStudioEdits(snapshot,['index.html'],{summary:'Rejected source change',edits})).toThrow();
  });
  it('canonical serialization survives database object-key reordering while preserving array order',()=>{
    expect(studioCanonicalJson({z:2,a:{y:'yes',b:[1,2]}})).toBe(studioCanonicalJson({a:{b:[1,2],y:'yes'},z:2}));expect(studioCanonicalJson({a:[2,1]})).not.toBe(studioCanonicalJson({a:[1,2]}));
  });
});
