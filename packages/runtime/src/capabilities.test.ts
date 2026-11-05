import { describe,expect,it } from 'vitest';
import { createDatabase,migrate } from '@mohassan/database';
import { createCapabilities,Runtime } from './index.ts';
import type { CreateTaskInput } from '@mohassan/contracts';

describe('module readiness metadata remains separate from task execution authority',()=>{
  it('leaves unconnected module capabilities unavailable to default planning registries',()=>{
    const registry=createCapabilities(true,true,true);
    for(const id of ['studio.visual','browser.research','memory.skills','device.remote'])expect(registry.find(item=>item.id===id)?.status).toBe('planned');
    expect(registry.find(item=>item.id==='plan.draft')?.status).toBe('active');
  });
  it('reports only explicitly connected module interfaces and keeps Windows pairing grant-specific',()=>{
    const connected=createCapabilities(false,false,false,{studioVisual:true,browser:true,memory:true,windows:true});
    for(const id of ['studio.visual','browser.research','memory.skills'])expect(connected.find(item=>item.id===id)?.status).toBe('active');
    expect(connected.find(item=>item.id==='device.remote')).toMatchObject({status:'needs_configuration'});
    expect(connected.find(item=>item.id==='device.remote')?.description).toContain('محددة المدة');
    expect(connected.find(item=>item.id==='studio.change')?.status).toBe('needs_configuration');
    const worker=createCapabilities(false,false,false,{studioVisual:true,memory:true});
    expect(worker.find(item=>item.id==='browser.research')?.status).toBe('planned');
    connected.find(item=>item.id==='memory.skills')!.requiredScopes.push('untrusted:grant');
    expect(createCapabilities().find(item=>item.id==='memory.skills')!.requiredScopes).not.toContain('untrusted:grant');
  });
  it('never accepts manual module operations as generic tasks even when their interfaces are active',async()=>{
    const store=await createDatabase();
    try{await migrate(store.db);const runtime=new Runtime(store.db,{moduleAvailability:{studioVisual:true,browser:true,memory:true,windows:true}});
      expect(runtime.getCapabilities().find(item=>item.id==='memory.skills')?.status).toBe('active');
      for(const capabilityId of ['studio.visual','browser.research','memory.skills','device.remote'])await expect(runtime.createTask('owner',{title:'طلب وحدة منفصلة',goal:'هذا الطلب لا يجيز تجاوز واجهة الوحدة أو منحها.',capabilityId,autonomy:'scoped'} as CreateTaskInput,`manual-module-${capabilityId}`)).rejects.toMatchObject({code:'INVALID_INPUT'});
      expect(await store.db.selectFrom('tasks').select('id').execute()).toEqual([]);
    }finally{await store.close();}
  });
});
