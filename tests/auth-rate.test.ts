import {describe,it,expect} from 'vitest';
import {createDatabase} from '@mohassan/database';
import {createAuth,migrateAuth} from '../apps/server/src/auth.js';

describe('session reads and sign-in abuse use distinct bounded rate rules',()=>{
  it('permits repeated session reads while preserving the stricter password-attempt limit',async()=>{
    const store=await createDatabase();await migrateAuth(store.db);
    const origin='http://127.0.0.1:3101',auth=createAuth(store.db,{secret:'isolated-auth-rate-fixture-secret-000000001',webOrigin:origin,production:false});
    try{
      for(let i=0;i<35;i++){const response=await auth.handler(new Request(origin+'/api/auth/get-session'));expect(response.status).toBe(200);expect(await response.json()).toBeNull();}
      const statuses=[];
      for(let i=0;i<4;i++){const response=await auth.handler(new Request(origin+'/api/auth/sign-in/email',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:'absent@rate-fixture.example.test',password:'fixture-password-not-an-account'})}));statuses.push(response.status);}
      expect(statuses).toEqual([401,401,401,429]);
    }finally{await store.close();}
  });
});
