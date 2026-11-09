import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'kysely';
import { z } from 'zod';
import { createDatabase, migrate } from '@mohassan/database';
import { Runtime } from '@mohassan/runtime';
import { CreateTaskSchema, SetupSchema, WorkspaceSnapshotSchema, SkillBenchmarkSuiteSchema, type Integration } from '@mohassan/contracts';
import { createAuth, createOwner, migrateAuth, recoverLocalSetupClaim } from './auth.js';
import { createAIControl } from './ai.js';
import { ProviderError, GroqProvider } from '@mohassan/providers';
import { createCodingControl } from './coding.js';
import type { SandboxRunner } from '@mohassan/coding';
import { CodingError } from '@mohassan/coding';
import { createCapabilities } from '@mohassan/runtime';
import { createStudioControl } from './studio.js';
import { StudioError } from '@mohassan/studio';
import { registerBrowserRoutes } from './browser.js';
import { AgentBrowser, BrowserError, SafeNetwork, SearchEngine, SqlSearchStore, LocalPublicIndex, migrateSearch, type BrowserConfig } from '@mohassan/browser';
import { registerSearchRoutes } from './search.js';
import { registerBrowserFileRoutes } from './browser-files.js';
import { registerMemoryRoutes } from './memory.js';
import { registerLearningRoutes, type LearningConfig } from './learning.js';
import { createIsolatedLearningEvaluator } from './learning-evaluator.js';
import { OllamaProvider } from '@mohassan/providers';
import { LearningContentError } from '@mohassan/learning';
import { registerSkillRoutes } from './skills.js';
import { registerWindowsRoutes, windowsMigration, revokeWindowsSession } from '@mohassan/windows';
import { createAssistantTools } from './assistant/tools.js';
import { createStudioAiControl, registerStudioAiRoutes } from './studio-ai.js';
import { createStudioLiveControl } from './studio-live.js';
import { createBrowserTaskControl } from './browser-task.js';
import { createCommandChatControl, registerCommandChatRoutes } from './command-chat.js';
import { createInferenceControl, registerInferenceRoutes, type InferenceConfig } from './inference.js';
import { createGoogleAdsControl, googleAdsMigration, GoogleAdsError, type GoogleAdsConfig } from '@mohassan/google-ads';
import { landingPageReader, registerGoogleAdsRoutes } from './google-ads.js';
import { createSkillRuntime, skillGatewayTools } from './skill-runtime.js';
import { registerSkillRunRoutes } from './skill-runs.js';
import { createSkillRollbackControl } from '../../../packages/skills/src/rollback.js';
import { registerSkillRollbackRoutes } from './skill-rollback.js';
import { registerSkillSandboxRoutes } from './skill-sandbox.js';
import { registerSkillGapRoutes } from './skill-gaps.js';
import { registerSkillGraphRoutes } from './skill-graph.js';
import { registerSkillPortfolioRoutes } from './skill-portfolio.js';
import { registerSkillBenchmarkRoutes } from './skill-benchmarks.js';
import { registerSkillForgeRoutes } from './skill-forge.js';
import { rebuildSkillGraph } from '../../../packages/skills/src/graph.js';
import { createSkillBenchmarkRunner } from './skill-benchmark-runner.js';
import { benchmarkSuites, getSkillBenchmarkSuite } from '../../../packages/skills/src/benchmark-suites.js';
import { recordSkillGap, createSkillBenchmarkControl, createSkillForgeControl } from '@mohassan/skills';

export interface AppConfig {
  dataDir?: string; databaseUrl?: string; authSecret: string; internalSecret: string;
  setupToken: string; webOrigin: string; production: boolean; runWorker: boolean;
  groqApiKey?:string;groqModel?:string;groqReasoningModel?:string;aiFetch?:typeof fetch;
  codingDataDir?:string;codingAllowedRoots?:string[];sandboxRunner?:SandboxRunner;
  browser?:BrowserConfig;windowsEnabled?:boolean;browserProfileDir?:string;browserChannel?:'chrome'|null;
  studioAiDataDir?:string;groqVisionModel?:string;studioGatewayUrl?:string;studioGatewaySecret?:string;studioPreviewPort?:number;
  skillEngineEnabled?: boolean;
  /** FreeLLMAPI gateway and failover policy. Absent: FreeLLMAPI stays off and Groq works as before. */
  inference?: Omit<InferenceConfig,'groq'|'fetch'>;
  /** Absent values leave the integration in its not-configured state. */
  googleAds?: Partial<Omit<GoogleAdsConfig,'webOrigin'>>;
  learning?: LearningConfig;
  learningLocalModel?:{model:string;baseUrl?:string};
  /** Server-side fixture load only; never an API option or production setting. */
  testRequestLimit?:number;
}
export function secretEqual(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function createApplication(config: AppConfig) {
  if (config.authSecret.length < 32 || config.internalSecret.length < 32) throw new Error('يلزم سر جلسة وسر خدمة بطول 32 حرفًا على الأقل.');
  if (config.production && (!config.databaseUrl || !config.webOrigin.startsWith('https://'))) throw new Error('الإنتاج يحتاج PostgreSQL واتصال HTTPS.');
  if(config.production&&config.browser?.testOrigins?.length)throw new Error('Test browser origins cannot be enabled in production.');
  if(config.testRequestLimit!==undefined&&(config.production||!Number.isInteger(config.testRequestLimit)||config.testRequestLimit<120||config.testRequestLimit>2000))throw new Error('Test request limits are restricted to bounded local fixtures.');
  const database = await createDatabase({connectionString: config.databaseUrl, dataDir: config.dataDir});
  await migrateAuth(database.db);
  if (database.mode === 'embedded' && !config.production) await recoverLocalSetupClaim(database.db);
  await migrate(database.db);
  await windowsMigration(database.db);
  await googleAdsMigration(database.db);
  const auth = createAuth(database.db, {secret: config.authSecret, webOrigin: config.webOrigin, production: config.production});
  const coding=await createCodingControl(database.db,{dataDir:config.codingDataDir,allowedRoots:config.codingAllowedRoots,apiKey:config.groqApiKey,model:config.groqReasoningModel,fetch:config.aiFetch,sandbox:config.sandboxRunner});
  let studio:Awaited<ReturnType<typeof createStudioControl>>;
  const studioLive=await createStudioLiveControl(database.db,{gatewayUrl:config.studioGatewayUrl,gatewaySecret:config.studioGatewaySecret,webOrigin:config.webOrigin,production:config.production,previewPort:config.studioPreviewPort,getSession:(ownerId,id)=>studio.detail(ownerId,id)});
  studio=await createStudioControl(database.db,{allowedRoots:config.codingAllowedRoots??[],sandbox:coding.sandbox,buildNext:studioLive.available?((snapshot,signal)=>studioLive.build(snapshot,signal)):undefined});
  const studioAi=await createStudioAiControl(database.db,{dataDir:config.studioAiDataDir??(config.codingDataDir?resolve(config.codingDataDir,'studio-ai'):undefined),apiKey:config.groqApiKey,model:config.groqReasoningModel,visionModel:config.groqVisionModel,fetch:config.aiFetch,studio,validateCandidate:studio.validateCandidate,applyCandidate:studio.applyCandidate});
  let browser:Awaited<ReturnType<typeof registerBrowserRoutes>>;
  await migrateSearch(database.db);
  const searchNetwork=new SafeNetwork(config.browser),searchStore=new SqlSearchStore(database.db),searchIndex=new LocalPublicIndex(database.db,searchNetwork);
  const searchProvider=config.browser?.searchProvider??new SearchEngine(searchNetwork,{store:searchStore,localIndex:searchIndex,admission:searchStore});
  const browserTask=await createBrowserTaskControl(database.db,{browser:{create:(ownerId,input)=>browser.create(ownerId,input),action:(ownerId,id,input)=>browser.action(ownerId,id,input),detail:(ownerId,id)=>browser.detail(ownerId,id),close:(ownerId,id)=>browser.close(ownerId,id)},networkPolicy:config.browser});
  const moduleAvailability={studioVisual:true,browser:true,memory:true,windows:true};
  const ai=await createAIControl(database.db,{apiKey:config.groqApiKey,model:config.groqModel,reasoningModel:config.groqReasoningModel,fetch:config.aiFetch,capabilities:createCapabilities(Boolean(config.groqApiKey),coding.available,studioAi.available,moduleAvailability,true,config.skillEngineEnabled)});
  let memory:Awaited<ReturnType<typeof registerMemoryRoutes>>;
  let skills:Awaited<ReturnType<typeof registerSkillRoutes>>;
  const runtimeOptions: ConstructorParameters<typeof Runtime>[1] = {moduleAvailability,openBrowser:browserTask.execute,verifyBrowser:browserTask.verify,plan:ai.engine?(async(goal,context)=>{
    const task=await database.db.selectFrom('tasks').select('owner_id').where('id','=',context.taskId).executeTakeFirstOrThrow();
    const [memoryContext,guidance]=await Promise.all([memory.context(task.owner_id,goal,context.taskId),skills.context(task.owner_id,goal,{budgetChars:4000})]);
    return ai.plan(goal,{...context,memoryContext,...(guidance.text?{skillContext:guidance.text}:{})});
  }):undefined,code:coding.available?coding.execute:undefined,verifyCode:coding.available?coding.verify:undefined,studioChange:studioAi.available?studioAi.execute:undefined,verifyStudioChange:studioAi.available?studioAi.verify:undefined,onTaskSettled:async(ownerId)=>{await memory.sync(ownerId);},onError: () => console.error(JSON.stringify({level:'error',event:'worker_tick_failed',message:'تعذر تقدم طابور المهام؛ ستعاد المحاولة.'}))};
  const app = Fastify({logger: false, bodyLimit: 16384, trustProxy: false});
  await app.register(rateLimit, {max: config.testRequestLimit??120, timeWindow: '1 minute'});
  const origins = new Set([new URL(config.webOrigin).origin]);
  if (!config.production) {
    const alias = new URL(config.webOrigin);
    if (['127.0.0.1', 'localhost'].includes(alias.hostname)) {
      alias.hostname = alias.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
      origins.add(alias.origin);
    }
  }
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    if (request.url === '/health') return;
    const companionPath=request.url.split('?')[0];
    if(request.method==='POST'&&['/api/windows/companion/pair','/api/windows/companion/poll'].includes(companionPath!))return;
    const serviceSecret = request.headers['x-mohassan-internal'];
    if (typeof serviceSecret !== 'string' || !secretEqual(serviceSecret, config.internalSecret)) {
      return reply.code(401).send({error: {code: 'SERVICE_UNAUTHORIZED', message: 'الاتصال غير مصرح به.'}});
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (typeof request.headers.origin !== 'string' || !origins.has(request.headers.origin)) {
        return reply.code(403).send({error: {code: 'ORIGIN_DENIED', message: 'مصدر الطلب غير مسموح به.'}});
      }
    }
  });
  app.setErrorHandler((error: any, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({error: {code: 'VALIDATION_ERROR', message: 'تحقق من الحقول المطلوبة وطول المدخلات.'}});
    if (error instanceof StudioError) return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}});
    if (error instanceof BrowserError) return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}});
    if (error instanceof LearningContentError) return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}});
    if (error instanceof GoogleAdsError) { if (error.options.retryAfterSeconds) reply.header('Retry-After', String(error.options.retryAfterSeconds)); return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}}); }
    if(error instanceof CodingError)return reply.code(error.code==='PROJECT_BUSY'?409:error.code==='SANDBOX_UNAVAILABLE'?503:400).send({error:{code:error.code,message:error.message}});
    const code = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    return reply.code(code).send({error: {code: typeof error.code === 'string' && code < 500 ? error.code : 'INTERNAL_ERROR', message: code < 500 ? error.message : 'تعذر إكمال الطلب. أعد المحاولة.'}});
  });
  app.get('/health', async () => ({status: 'ok'}));
  app.get('/api/setup', async () => {
    const user = await database.db.selectFrom('user').select('id').limit(1).executeTakeFirst();
    return {needsSetup: !user, setupAvailable: !config.production};
  });
  app.post('/api/setup', {config: {rateLimit: {max: 5, timeWindow: '1 minute'}}}, async (request, reply) => {
    if (config.production) return reply.code(403).send({error: {code: 'SETUP_DISABLED', message: 'يُنشأ المالك من بيئة الخادم في الإنتاج.'}});
    const input = SetupSchema.parse(request.body);
    if (!secretEqual(input.setupToken, config.setupToken)) return reply.code(403).send({error: {code: 'SETUP_TOKEN_INVALID', message: 'رمز الإعداد غير صحيح.'}});
    await createOwner(database.db, auth, input);
    return {ok: true};
  });
  app.route({method: ['GET', 'POST'], url: '/api/auth/*', handler: async (request, reply) => {
    const path = request.url.split('?')[0];
    const allowed = new Set(['POST /api/auth/sign-in/email', 'GET /api/auth/get-session', 'POST /api/auth/sign-out']);
    if (!allowed.has(`${request.method} ${path}`)) return reply.code(403).send({error: {code: 'AUTH_ACTION_DISABLED', message: 'هذه العملية غير متاحة.'}});
    if(request.method==='POST'&&path==='/api/auth/sign-out')await revokeWindowsSession(database.db,typeof request.headers.cookie==='string'?request.headers.cookie:'');
    const headers = new Headers();
    for (const key of ['cookie', 'origin', 'user-agent', 'content-type']) {
      const value = request.headers[key];
      if (typeof value === 'string') headers.set(key, value);
    }
    const response = await auth.handler(new Request(new URL(request.url, config.webOrigin), {
      method: request.method, headers,
      ...(request.method !== 'GET' ? {body: JSON.stringify(request.body ?? {})} : {}),
    }));
    for (const [key, value] of response.headers) if (!['set-cookie', 'content-length', 'transfer-encoding'].includes(key)) reply.header(key, value);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) reply.header('set-cookie', cookies);
    return reply.code(response.status).send(await response.text());
  }});
  const owner = async (request: {headers: Record<string, unknown>}) => {
    const headers = new Headers();
    if (typeof request.headers.cookie === 'string') headers.set('cookie', request.headers.cookie);
    const session = await auth.api.getSession({headers});
    if (!session) throw Object.assign(new Error('سجل الدخول للمتابعة.'), {statusCode: 401, code: 'UNAUTHORIZED'});
    return session.user;
  };
  await registerSearchRoutes(app,{owner,index:searchIndex,store:searchStore});
  browser=await registerBrowserRoutes(app,{db:database.db,owner,config:{...config.browser,searchProvider},managedLifecycle:false});
  app.get<{Params:{id:string}}>('/api/browser/tasks/:id/screenshot',async(request,reply)=>{const picture=await browserTask.screenshot((await owner(request)).id,z.uuid().parse(request.params.id));return reply.type(picture.mimeType).header('Content-Disposition','inline').send(picture.bytes);});
  memory=await registerMemoryRoutes(app,{db:database.db,owner});
  const learningAbort=new AbortController();
  const localEvaluation=config.learningLocalModel?createIsolatedLearningEvaluator({model:config.learningLocalModel.model,createProvider:model=>new OllamaProvider({model,baseUrl:config.learningLocalModel?.baseUrl}),signal:learningAbort.signal}):undefined;
  const learning=await registerLearningRoutes(app,{db:database.db,owner,config:{allowedRoots:config.codingAllowedRoots??[],...(localEvaluation?{evaluate:localEvaluation,stopEvaluation:()=>learningAbort.abort()}:{}),...config.learning}});
  // Reading readiness starts no process; available() already ran its fixed probes.
  const scriptsReady=(await coding.sandbox.executableReadiness?.())?.enabled===true;
  skills=await registerSkillRoutes(app,{db:database.db,owner,allowedRoots:config.codingAllowedRoots??[],enabled:config.skillEngineEnabled,executableReady:async()=>scriptsReady,environment:()=>({capabilities:createCapabilities(Boolean(config.groqApiKey),coding.available,studioAi.available,moduleAvailability,true,config.skillEngineEnabled),modelReady:Boolean(config.groqApiKey),visionReady:Boolean(config.groqApiKey&&config.groqVisionModel),executableReady:scriptsReady,gatewayTools:skillGatewayTools({enabled:config.skillEngineEnabled,coding:coding.available,studio:studioAi.available,vision:Boolean(config.groqApiKey&&config.groqVisionModel)})})});
  const skillExecutionSupport = createSkillRuntime(database.db,{skills,browser,memory,sandbox:coding.sandbox,testOrigins:config.browser?.testOrigins,
    ...(ai.engine?{modelGenerate:ai.generateSkill}:{}),
    ...(config.groqApiKey&&config.groqVisionModel?{vision:{provider:new GroqProvider({apiKey:config.groqApiKey,model:config.groqVisionModel,fetch:config.aiFetch,timeoutMs:20000}),image:studioAi.image}}:{}),
  });
  const skillExecution = config.skillEngineEnabled ? skillExecutionSupport : undefined;
  const skillRollback = createSkillRollbackControl(database.db);
  const runtime = new Runtime(database.db,{...runtimeOptions,cancelSkillRun:skillExecutionSupport.scheduler.cancelRun,recoverSkillRollbacks:skillRollback.recoverExpired,...(skillExecution?{skillRuntime:skillExecution.runtimeOptions,rollback:skillRollback}:{})});
  await registerSkillRunRoutes(app,{db:database.db,owner,skills,runtime,enabled:config.skillEngineEnabled === true});
  await registerSkillRollbackRoutes(app,{owner,runtime,rollback:skillRollback,enabled:config.skillEngineEnabled === true});
  await registerSkillSandboxRoutes(app,{owner,sandbox:coding.sandbox});
  await registerSkillGapRoutes(app,{db:database.db,owner});
  await registerSkillGraphRoutes(app,{db:database.db,owner});
  await registerSkillPortfolioRoutes(app,{db:database.db,owner});
  const skillBenchmarks = createSkillBenchmarkControl(database.db, { suite: id => SkillBenchmarkSuiteSchema.parse(getSkillBenchmarkSuite(id)), runner: createSkillBenchmarkRunner() });
  await skillBenchmarks.recoverExpired();
  await registerSkillBenchmarkRoutes(app,{control:skillBenchmarks,suites:benchmarkSuites.map(definition=>SkillBenchmarkSuiteSchema.parse(definition)),enabled:config.skillEngineEnabled===true,owner});
  const skillForge = createSkillForgeControl(database.db, { generate: ai.generateSkill, rebuildGraph: async (tx, ownerId) => { await rebuildSkillGraph(tx, ownerId); } });
  await skillForge.recoverExpired();
  await registerSkillForgeRoutes(app,{control:skillForge,skills,enabled:config.skillEngineEnabled===true,modelConfigured:Boolean(ai.engine),owner});
  let benchmarkMaintenanceRun: Promise<void> | null = null;
  const benchmarkMaintenance = setInterval(() => {
    if (benchmarkMaintenanceRun) return;
    benchmarkMaintenanceRun = Promise.all([skillBenchmarks.recoverExpired(),skillForge.recoverExpired()]).then(() => undefined).catch(() => console.error(JSON.stringify({level:'error',event:'skill_maintenance_failed'}))).finally(() => { benchmarkMaintenanceRun = null; });
  }, 10000);
  benchmarkMaintenance.unref();
  const windows=await registerWindowsRoutes(app,{db:database.db,owner,config:{webOrigin:config.webOrigin,production:config.production,windowsEnabled:config.windowsEnabled}});
  const googleAds=createGoogleAdsControl(database.db,{...config.googleAds,webOrigin:config.webOrigin,fetchPage:config.googleAds?.fetchPage??landingPageReader(config.browser)});
  await registerGoogleAdsRoutes(app,{control:googleAds,owner});
  const assistantTools=createAssistantTools({memory,coding,studio,studioChange:studioAi.available,runtime,windows,googleAds});
  const inference=await createInferenceControl(database.db,{...config.inference,groq:{apiKey:config.groqApiKey,fast:[config.groqModel??'openai/gpt-oss-20b'],deep:[config.groqReasoningModel??'openai/gpt-oss-120b']},fetch:config.aiFetch});
  await registerInferenceRoutes(app,{control:inference,owner});
  const agentBrowser=new AgentBrowser({profileDir:config.browserProfileDir??join(tmpdir(),`mohassan-browser-${randomUUID()}`),testOrigins:config.browser?.testOrigins,channel:config.browserChannel});
  const chat=await createCommandChatControl(database.db,{apiKey:config.groqApiKey,tools:assistantTools,inference,models:{fast:[config.groqModel??'openai/gpt-oss-20b'],deep:[config.groqReasoningModel??'openai/gpt-oss-120b'],vision:config.groqVisionModel??'qwen/qwen3.8-27b'},fetch:config.aiFetch,browser:agentBrowser,networkPolicy:config.browser,searchProvider,memoryContext:(ownerId,goal)=>memory.context(ownerId,goal,undefined,{readOnly:true}),
    learningContext:learning.context,
    ...(config.skillEngineEnabled?{recordSkillGap,skillContext:skills.context,loadSkill:skills.loadInstruction,runSkill:async(ownerId,input,context)=>{
      context.signal.throwIfAborted();
      return runtime.createTask(ownerId,{title:'تشغيل مهارة من المحادثة',goal:context.goal.slice(0,4000),capabilityId:'skill.run',autonomy:'assisted',skillInput:input},context.idempotencyKey,context.runId);
    }}:{}),
  });
  await registerCommandChatRoutes(app,{control:chat,owner:async request=>{const user=await owner(request);windows.noteSession(user.id,request);return user;}});
  await registerBrowserFileRoutes(app,{db:database.db,browser:agentBrowser,owner});
  await registerStudioAiRoutes(app,{control:studioAi,owner});
  await studio.reviews.register(app,owner);
  await studioLive.register(app,owner);
  app.get('/api/workspace', async (request) => {
    const user = await owner(request);
    const snapshot = await runtime.snapshot(user.id);
    await sql`SELECT 1`.execute(database.db);
    const aiStatus=await ai.status();
    const codingWorkspace=await coding.workspace(user.id);
    const adsStatus=await googleAds.status(user.id);
    const integrations: Integration[] = [
      {id: 'database', name: database.mode === 'embedded' ? 'PostgreSQL محلي' : 'PostgreSQL / Neon', description: 'حفظ المهام والجلسات والأحداث', status: 'connected', detail: database.mode === 'embedded' ? 'مخزن تطوير دائم، تديره خدمة واحدة.' : 'تم التحقق من اتصال قاعدة البيانات.'},
      {id: 'groq', name: 'Groq', description: 'النماذج والتخطيط الذكي', status: aiStatus.status==='verified'?'connected':'needs_configuration', detail: aiStatus.message},
      {id: 'freellmapi', name: 'FreeLLMAPI', description: 'نماذج مجانية عبر بوابة محلية مع تبديل تلقائي للمحادثة', status: inference.active()?'connected':'needs_configuration', detail: inference.active()?'مفعّل للمساعد. التخطيط والبرمجة والاستوديو تبقى على Groq.':inference.configured?'مهيأ على الخادم وغير مفعّل. فعّله من إعدادات المزودين.':'غير مهيأ. أضف FREELLMAPI_API_KEY إلى ملف .env على الخادم.'},
      {id: 'coding', name: 'Coding Engine', description: 'تعديل معزول واختبارات ومراجعة Git', status: coding.available?'connected':'needs_configuration', detail: codingWorkspace.sandbox.message},
      {id:'studio',name:'Visual Studio',description:'معاينة وتعديل المصدر ومراجعة الفروقات',status:'connected',detail:'اختيار عناصر وتعديلها، ومقترحات ذكية بموافقة وصور مقارنة قبل التطبيق؛ تشغيل Next الكامل يحتاج ربط مشغّل المعاينة.'},
      {id: 'browser', name: 'Browser & Research', description: 'بحث موثق وجلسات مستقلة', status: 'connected', detail: 'جلسات Chromium مستقلة، ومصادر محفوظة، وموافقة منفصلة لإرسال النماذج.'},
      {id:'memory',name:'Memory & Skills',description:'ذاكرة بأدلة ومهارات مقاسة',status:'connected',detail:'استرجاع مرتبط بالمصدر والصلاحية، وتقييم وموافقة قبل تفعيل المهارات.'},
      {id: 'windows', name: 'Windows Companion', description: 'ربط الجهاز والتحكم المصرح', status: 'needs_configuration', detail: 'يلزم ربط المساعد المحلي واختيار نافذة وموافقة محلية قبل أي تحكم.'},
      {id: 'iphone', name: 'iPhone', description: 'مركز تحكم SwiftUI', status: 'planned', detail: 'يحتاج Xcode وتوقيع Apple وAPNs.'},
      {id: 'ads', name: 'Google Ads', description: 'تحليل الحملات والتحويلات', status: adsStatus.state==='connected'||adsStatus.state==='rate_limited'?'connected':'needs_configuration', detail: adsStatus.message},
    ];
    return WorkspaceSnapshotSchema.parse({apiVersion: '1', user: {id: user.id, name: user.name, email: user.email}, ...snapshot, integrations, storage: {mode: database.mode, healthy: true},ai:aiStatus,coding:codingWorkspace});
  });
  app.get('/api/coding/projects',async request=>coding.workspace((await owner(request)).id));
  app.get('/api/studio/sessions',async request=>studio.workspace((await owner(request)).id));
  app.post('/api/studio/sessions',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async request=>studio.create((await owner(request)).id,request.body));
  app.post('/api/studio/sessions/demo',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async request=>{const user=await owner(request);const input=z.object({framework:z.enum(['static','react','next']).default('static')}).strict().parse(request.body??{});return studio.demo(user.id,input.framework);});
  app.get<{Params:{id:string}}>('/api/studio/sessions/:id',async request=>studio.detail((await owner(request)).id,z.uuid().parse(request.params.id)));
  app.get<{Params:{id:string}}>('/api/studio/sessions/:id/preview',async request=>studio.preview((await owner(request)).id,z.uuid().parse(request.params.id)));
  app.get<{Params:{id:string}}>('/api/studio/sessions/:id/baseline',async request=>studio.preview((await owner(request)).id,z.uuid().parse(request.params.id),true));
  app.post<{Params:{id:string}}>('/api/studio/sessions/:id/edits',async request=>studio.edit((await owner(request)).id,z.uuid().parse(request.params.id),request.body));
  app.post<{Params:{id:string}}>('/api/studio/sessions/:id/undo',async request=>studio.undo((await owner(request)).id,z.uuid().parse(request.params.id),request.body));
  app.post('/api/coding/projects',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async request=>coding.register((await owner(request)).id,request.body));
  app.post('/api/coding/projects/demo',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async request=>{const user=await owner(request);z.object({}).strict().parse(request.body??{});return coding.demo(user.id);});
  app.post('/api/ai/verify',{config:{rateLimit:{max:3,timeWindow:'1 minute'}}},async(request,reply)=>{
    await owner(request);z.object({}).strict().parse(request.body??{});
    try{return await ai.verify();}
    catch(error){return reply.code(error instanceof ProviderError&&error.code==='NOT_CONFIGURED'?409:502).send({error:{code:error instanceof ProviderError?error.code:'AI_VERIFICATION_FAILED',message:error instanceof ProviderError?error.message:'تعذر التحقق من اتصال Groq.'}});}
  });
  app.post('/api/tasks', async (request) => {
    const user = await owner(request);
    const input = CreateTaskSchema.parse(request.body);
    const key = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).parse(request.headers['idempotency-key']);
    return runtime.createTask(user.id, input, key);
  });
  app.get<{Params: {id: string}}>('/api/tasks/:id', async (request) => runtime.detail((await owner(request)).id, request.params.id));
  app.post<{Params: {id: string}}>('/api/tasks/:id/cancel', async (request) => runtime.cancel((await owner(request)).id, request.params.id));
  app.post<{Params: {id: string}}>('/api/tasks/:id/approve', async (request) => runtime.approve((await owner(request)).id, request.params.id));
  app.addHook('onClose', async () => {clearInterval(benchmarkMaintenance);try{await benchmarkMaintenanceRun;await Promise.all([skillBenchmarks.shutdown(),skillForge.shutdown()]);}finally{try{await chat.shutdown();}finally{try{await runtime.stop();}finally{try{await browser.shutdown();}finally{try{await studioLive.close();}finally{await database.close();}}}}}});
  if (config.runWorker) runtime.start();
  await app.ready();
  return {app, runtime, database, auth,ai,coding,studio,studioAi,studioLive,browser,browserTask,memory,skills,chat,skillExecution,skillBenchmarks,skillForge,googleAds,inference};
}
