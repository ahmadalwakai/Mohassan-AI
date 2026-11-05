import {describe,it,expect} from 'vitest';
import {createApplication} from '../apps/server/src/app.js';
const production={authSecret:'a'.repeat(40),internalSecret:'b'.repeat(40),setupToken:'',webOrigin:'https://fixture.example.test',production:true,runWorker:false,databaseUrl:'postgresql://unused.invalid/fixture'};
describe('local fixture settings cannot reach production',()=>{
  it('refuses a test request allowance before connecting to the database',async()=>{
    await expect(createApplication({...production,testRequestLimit:1000})).rejects.toThrow('Test request limits are restricted');
  });
  it('refuses private browser test origins before connecting to the database',async()=>{
    await expect(createApplication({...production,browser:{testOrigins:['http://127.0.0.1:4201']}})).rejects.toThrow('Test browser origins cannot be enabled');
  });
});
