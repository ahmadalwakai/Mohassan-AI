import { createHash,randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { sql,type Kysely } from 'kysely';
import { CodingEngine,createRepairDemoProject,deterministicCodingMessage,generateDeterministicEdits,inspectProject,lookupImports,searchProjectFiles,type SandboxRunner } from '@mohassan/coding';
import { WindowsAppContainerSandbox } from '@mohassan/sandbox';
import { ProjectSchema,RegisterProjectSchema,type Project,type CodingWorkspace } from '@mohassan/contracts';
import { verifyRecoveryAuthority,type VerificationRecoveryContext } from '@mohassan/runtime';

export interface CodingConfig {
  dataDir?:string;allowedRoots?:string[];sandbox?:SandboxRunner;
}
export interface CodingProjectRegistrationOptions {
  expectedBaseCommit: string;
  persist: <T>(write: (db: Kysely<any>) => Promise<T>) => Promise<T>;
}
function projectDto(row:any):Project{return ProjectSchema.parse({id:row.id,ownerId:row.owner_id,name:row.name,path:row.repo_path,baseCommit:row.base_commit,allowedPaths:row.allowed_paths,testProfile:row.test_profile,createdAt:new Date(row.created_at).toISOString()});}
function fault(code:string,message:string,statusCode=409){return Object.assign(new Error(message),{code,statusCode});}
export async function createCodingControl(db:Kysely<any>,config:CodingConfig){
  const dataDir=config.dataDir?resolve(config.dataDir):null;
  const roots=[...(config.allowedRoots??[]),...(dataDir?[dataDir]:[])];
  const sandbox=config.sandbox??new WindowsAppContainerSandbox();
  const isolated=dataDir?await sandbox.available():{available:false,provider:null,message:'لم يُجهز مجلد عمل لمحرك البرمجة.'};
  const availability={...isolated,message:isolated.available?deterministicCodingMessage:isolated.message};
  const engine=dataDir&&availability.available?new CodingEngine({dataDir,allowedRoots:roots,sandbox,generateEdits:generateDeterministicEdits}):null;
  async function projects(ownerId:string){return (await db.selectFrom('coding_projects').selectAll().where('owner_id','=',ownerId).orderBy('created_at','desc').execute()).map(projectDto);}
  async function workspace(ownerId:string):Promise<CodingWorkspace>{return {projects:await projects(ownerId),sandbox:availability};}
  async function project(ownerId:string,id:string):Promise<Project>{const row=await db.selectFrom('coding_projects').selectAll().where('id','=',id).where('owner_id','=',ownerId).executeTakeFirst();if(!row)throw fault('PROJECT_NOT_FOUND','لم يُعثر على المشروع.',404);return projectDto(row);}
  async function inspect(path: string) {
    // The internal demo root may not exist until a demo is created. An absent
    // fallback must not mask the engine's outside-roots error on a fresh setup.
    const hasImplicitRoot = dataDir && await lstat(dataDir).then(() => true, (error: NodeJS.ErrnoException) => error.code !== 'ENOENT');
    const { path: canonicalPath, baseCommit, candidateEditablePaths, testFiles } = await inspectProject(path, hasImplicitRoot ? roots : config.allowedRoots ?? []);
    return { path: canonicalPath, baseCommit, candidateEditablePaths, testFiles };
  }
  async function register(ownerId:string,input:unknown,options?:CodingProjectRegistrationOptions):Promise<Project>{
    if(!dataDir)throw fault('CODING_NOT_CONFIGURED','محرك البرمجة غير مجهز.',503);
    const request=RegisterProjectSchema.parse(input);const inspection=await inspect(request.path);
    if (options && inspection.baseCommit !== options.expectedBaseCommit) {
      throw fault('PROJECT_HEAD_CHANGED', 'تغير HEAD منذ طلب الموافقة؛ يلزم طلب موافقة جديد لتسجيل المشروع.');
    }
    const allowedPaths=[...new Set(request.allowedPaths)].sort();
    if(allowedPaths.length!==request.allowedPaths.length||allowedPaths.some(path=>!inspection.candidateEditablePaths.includes(path)))throw fault('INVALID_EDIT_SCOPE','اختر ملفات تنفيذ موجودة؛ الاختبارات والإعدادات محمية.',400);
    const scopeHash=createHash('sha256').update(JSON.stringify([process.platform==='win32'?inspection.path.toLowerCase():inspection.path,inspection.baseCommit,allowedPaths])).digest('hex');
    const write = async (connection: Kysely<any>): Promise<Project> => {
      const row=await connection.insertInto('coding_projects').values({id:randomUUID(),owner_id:ownerId,name:request.name,repo_path:inspection.path,base_commit:inspection.baseCommit,allowed_paths:JSON.stringify(allowedPaths),test_profile:'node-test',scope_hash:scopeHash})
        .onConflict(conflict=>conflict.columns(['owner_id','scope_hash']).doNothing()).returningAll().executeTakeFirst();
      if(row)return projectDto(row);
      return projectDto(await connection.selectFrom('coding_projects').selectAll().where('owner_id','=',ownerId).where('scope_hash','=',scopeHash).executeTakeFirstOrThrow());
    };
    return options ? options.persist(write) : write(db);
  }
  async function demo(ownerId:string):Promise<Project>{
    if(!dataDir)throw fault('CODING_NOT_CONFIGURED','محرك البرمجة غير مجهز.',503);
    const ownerKey=createHash('sha256').update(ownerId).digest('hex').slice(0,20);
    const created=await createRepairDemoProject(join(dataDir,'demos',ownerKey));
    return register(ownerId,{name:'مشروع تجربة الجمع',path:created.path,allowedPaths:created.allowedPaths});
  }
  async function execute(goal:string,context:{signal:AbortSignal;taskId:string;ownerId:string;projectId:string;leaseToken:string;onProgress?:(stage:string,message:string)=>Promise<void>;onModelReceipt?:(receipt:{model:string;usage:{inputTokens:number;outputTokens:number}})=>Promise<void>}){
    if((await db.selectFrom('tasks').select('verification_only').where('id','=',context.taskId).where('owner_id','=',context.ownerId).executeTakeFirst())?.verification_only)throw fault('SKILL_VERIFY_READ_ONLY','استعادة التحقق لا تسمح بتنفيذ جديد.',409);
    if(!engine)throw fault('SANDBOX_UNAVAILABLE','لم يثبت توفر بيئة عزل؛ لم يُشغّل كود.',503);
    const selected=await project(context.ownerId,context.projectId);
    const resource=createHash('sha256').update(process.platform==='win32'?selected.path.toLowerCase():selected.path).digest('hex');
    const token=randomUUID();
    const claimed=await sql<{token:string}>`INSERT INTO coding_project_locks(resource_key,project_id,task_id,token,expires_at) VALUES(${resource},${selected.id},${context.taskId},${token},CURRENT_TIMESTAMP+interval '240 seconds') ON CONFLICT(resource_key) DO UPDATE SET project_id=EXCLUDED.project_id,task_id=EXCLUDED.task_id,token=EXCLUDED.token,expires_at=EXCLUDED.expires_at WHERE coding_project_locks.expires_at<CURRENT_TIMESTAMP RETURNING token`.execute(db);
    if(claimed.rows[0]?.token!==token)throw fault('PROJECT_BUSY','توجد مهمة أخرى تعمل على هذا المشروع.');
    try{return await engine.execute({taskId:context.taskId,ownerId:context.ownerId,goal,project:selected,signal:context.signal,onProgress:context.onProgress,onModelReceipt:context.onModelReceipt});}
    finally{await db.deleteFrom('coding_project_locks').where('resource_key','=',resource).where('token','=',token).execute();}
  }
  async function verify(raw:unknown,context:{taskId:string;ownerId:string;projectId:string;signal:AbortSignal}&VerificationRecoveryContext){
    if(!engine||!await verifyRecoveryAuthority(db,context))return null;
    const result=await engine.verify(raw,{taskId:context.taskId,project:await project(context.ownerId,context.projectId),signal:context.signal});
    return await verifyRecoveryAuthority(db,context)?result:null;
  }
  // Read-only views for the chat without a model: the committed files of a registered project, and its own checks run once in the sandbox.
  async function committedFiles(ownerId:string,projectId:string){return (await inspectProject((await project(ownerId,projectId)).path,roots)).files;}
  async function search(ownerId:string,projectId:string,query:string){return searchProjectFiles(await committedFiles(ownerId,projectId),query);}
  async function imports(ownerId:string,projectId:string,reference:string){return lookupImports(await committedFiles(ownerId,projectId),reference);}
  async function check(ownerId:string,projectId:string,signal:AbortSignal){
    if(!engine)throw fault('SANDBOX_UNAVAILABLE','لم يثبت توفر بيئة عزل؛ لم يُشغّل كود.',503);
    return engine.check({ownerId,project:await project(ownerId,projectId),signal});
  }
  return {available:Boolean(engine),workspace,projects,inspect,register,demo,execute,verify,sandbox,search,imports,check};
}
