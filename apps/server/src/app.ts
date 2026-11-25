import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sql } from 'kysely';
import { z } from 'zod';
import { createDatabase, migrate } from '@mohassan/database';
import { Runtime } from '@mohassan/runtime';
import { CreateTaskSchema, SetupSchema, WorkspaceSnapshotSchema, SkillBenchmarkSuiteSchema, type Integration } from '@mohassan/contracts';
import { createAuth, createOwner, migrateAuth, recoverLocalSetupClaim } from './auth.js';
import { MEMBER_QUOTA_ROUTES, MEMBER_ROUTES, PUBLIC_ROUTES, memberRunsToday, migrateMembers, registerMemberRoutes, roleOf, routeKey, type WorkspaceRole } from './members.js';
import { lockOwnerToolAccess } from './owner-tool-authorization.js';
import { createRequestRateLimitKey } from './request-rate-limit.js';
import { createAIControl } from './ai.js';
import { ProviderError, GroqProvider } from '@mohassan/providers';
import { createCodingControl } from './coding.js';
import type { SandboxRunner } from '@mohassan/coding';
import { CodingError } from '@mohassan/coding';
import { createCapabilities } from '@mohassan/runtime';
import { createStudioControl } from './studio.js';
import { StudioError } from '@mohassan/studio';
import { registerBrowserRoutes } from './browser.js';
import { AgentBrowser, BrowserError, SafeNetwork, SearchEngine, SqlSearchStore, LocalPublicIndex, RobotsPolicy, migrateSearch, readableSource, type BrowserConfig } from '@mohassan/browser';
import { registerSearchRoutes } from './search.js';
import { registerBrowserFileRoutes } from './browser-files.js';
import { createDocumentControl, migrateDocuments, registerDocumentRoutes } from './documents.js';
import { PdfError } from '@mohassan/pdf';
import { registerMemoryRoutes } from './memory.js';
import { registerLearningRoutes, type LearningConfig } from './learning.js';
import { createIsolatedLearningEvaluator } from './learning-evaluator.js';
import { OllamaProvider } from '@mohassan/providers';
import { LearningContentError } from '@mohassan/learning';
import { registerSkillRoutes } from './skills.js';
import { registerWindowsRoutes, windowsMigration, revokeWindowsSession } from '@mohassan/windows';
import { createAssistantTools } from './assistant/tools.js';
import { createStudioAiControl, registerStudioAiRoutes } from './studio-ai.js';
import { createSitesControl, registerSiteRoutes } from './sites.js';
import { createVercelPublisher, noPublisher } from './sites-publish.js';
import { createStudioLiveControl } from './studio-live.js';
import { createBrowserTaskControl } from './browser-task.js';
import { registerCommandChatRoutes } from './command-chat.js';
import { createRefusalAwareCommandChat as createCommandChatControl } from './assistant/refusal/chat-control.js';
import { createImageReader } from './image-reader.js';
import { createInferenceControl, registerInferenceRoutes, type InferenceConfig } from './inference.js';
import { createExecutorControl, executorConfigFromEnv, registerExecutorRoutes, type ExecutorConfig } from './executor.js';
import { createAdsLab, createAdsModelWorker, registerAdsLabRoutes, type AdsLabConfig } from './ads-lab.js';
import { createAdsModelChat } from './assistant/ads-model-chat.js';
import type { Mind, MindDeps } from './assistant/mind/contract.js';
import { createMind } from './assistant/mind/index.js';
import { createShadowRouter } from './assistant/router.js';
import { createConversationShadow } from './assistant/conversation-state-shadow.js';
import { createJudgeShadow, judgeSettings } from './assistant/judge-shadow.js';
import { createPageCache } from './assistant/page-cache.js';
import { withoutFigures } from './assistant/readable-page.js';
import { createChromeExtensionControl, registerChromeExtensionRoutes } from './chrome-extension.js';
import { DesktopEngine } from '@mohassan/desktop';
import { registerDesktopRoutes } from './desktop.js';
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
import { recordSkillGap, createSkillBenchmarkControl, createSkillForgeControl, createGitSkillTransport, preloadInstructionMetadata, MAX_SKILL_CONTEXT_CHARS, type SkillRemoteTransport } from '@mohassan/skills';
import { MAX_GITHUB_SKILLS, MAX_IMPORTED_VERSIONS_PER_OWNER } from '../../../packages/skills/src/import-store.js';
import { buildSkillReaderIndex, createSkillReader, skillInstructionText } from './assistant/skill-reader.js';
import { createSkillRemoteScheduler, registerSkillRemoteRoutes, type SkillRemoteSettings } from './skill-remote.js';

/** Fallback window for the reader when no catalogue index is given (tests). The chat passes the catalogue index, which has no window. */
const SKILL_READER_DISCOVERY = MAX_GITHUB_SKILLS + MAX_IMPORTED_VERSIONS_PER_OWNER + 50;

export interface AppConfig {
  dataDir?: string; databaseUrl?: string; authSecret: string; internalSecret: string;
  setupToken: string; webOrigin: string; production: boolean; runWorker: boolean;
  groqApiKey?:string;groqModel?:string;groqReasoningModel?:string;aiFetch?:typeof fetch;
  codingDataDir?:string;codingAllowedRoots?:string[];sandboxRunner?:SandboxRunner;
  browser?:BrowserConfig;windowsEnabled?:boolean;browserProfileDir?:string;browserChannel?:'chrome'|null;
  studioAiDataDir?:string;groqVisionModel?:string;studioGatewayUrl?:string;studioGatewaySecret?:string;studioPreviewPort?:number;
  skillEngineEnabled?: boolean;
  /** The GitHub skills source from SKILL_REMOTE_*. Absent, or `config: null`: the library panel reports it as not configured. */
  skillRemote?: SkillRemoteSettings;
  /** Injected by isolated tests only; otherwise the restricted Git transport is built from `skillRemote`. */
  skillRemoteTransport?: SkillRemoteTransport;
  /** FreeLLMAPI gateway and failover policy. Absent: FreeLLMAPI stays off and Groq works as before. */
  inference?: Omit<InferenceConfig,'groq'|'fetch'>;
  /** Absent values leave the integration in its not-configured state. */
  googleAds?: Partial<Omit<GoogleAdsConfig,'webOrigin'>>;
  learning?: LearningConfig;
  /** Where created PDFs are stored, and bundled fonts for them. Defaults: .data/documents and no bundled fonts. */
  documentsDir?:string;documentsFontsDir?:string;
  learningLocalModel?:{model:string;baseUrl?:string};
  /** Owner-only local experiment with the scratch-trained execution model. Absent: off. */
  executor?:ExecutorConfig;
  adsLab?:AdsLabConfig;
  /** Tests only: a stand-in for the own Ads model's worker, so the chat path runs without Python. */
  adsModelWorker?:Parameters<typeof createAdsModelChat>[0]['worker'];
  /** An assembled evidence mind, used only in the local lab behind its flag. */
  mind?: Mind;
  mindEnabled?: boolean;
  /** Server-side fixture load only; never an API option or production setting. */
  testRequestLimit?:number;
  /** Chat requests a member may start in 24 hours. */
  memberDailyRuns?:number;
  /** Generated websites: where they publish. Absent or 'none': preview and ZIP only. */
  sites?:{vercelToken?:string;vercelTeamId?:string;publishTarget?:'vercel'|'none';fetch?:typeof fetch};
  /** The owner's own Windows session (desktop app): off on the cloud deployment and in tests unless enabled. */
  desktop?:{enabled:boolean;dataDir?:string;projectsRoot?:string;roots?:string[];screenshotsDir?:string};
}
export function secretEqual(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

class RobotsSearchNetwork extends SafeNetwork {
  constructor(network: SafeNetwork, private readonly robots: RobotsPolicy) {
    super(network.policy);
  }

  override async request(url: string, options: Parameters<SafeNetwork['request']>[1] = {}) {
    await this.robots.assertAllowed(url, options.signal);
    return super.request(url, options);
  }
}
export async function createApplication(config: AppConfig) {
  if (config.authSecret.length < 32 || config.internalSecret.length < 32) throw new Error('يلزم سر جلسة وسر خدمة بطول 32 حرفًا على الأقل.');
  if (config.production && (!config.databaseUrl || !config.webOrigin.startsWith('https://'))) throw new Error('الإنتاج يحتاج PostgreSQL واتصال HTTPS.');
  if(config.production&&config.browser?.testOrigins?.length)throw new Error('Test browser origins cannot be enabled in production.');
  if(config.testRequestLimit!==undefined&&(config.production||!Number.isInteger(config.testRequestLimit)||config.testRequestLimit<120||config.testRequestLimit>2000))throw new Error('Test request limits are restricted to bounded local fixtures.');
  const database = await createDatabase({connectionString: config.databaseUrl, dataDir: config.dataDir});
  await migrateAuth(database.db);
  await migrateMembers(database.db);
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
  // publicWeb:false — the scraped engines are out: bing.com/robots.txt forbids /search and html.duckduckgo.com answers
  // with a human check (measured 2026-11-22, artifacts/perf/2026-11-22/search-providers). The documented APIs remain.
  const searchProvider=config.browser?.searchProvider??new SearchEngine(searchNetwork,{store:searchStore,localIndex:searchIndex,admission:searchStore,publicWeb:false});
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
  // Every registered route, so tests can prove each one sits behind the member gate.
  const routes = new Set<string>();
  app.addHook('onRoute', route => { for (const method of [route.method].flat()) { const key = routeKey(method, route.url); if (key) routes.add(key); } });
  type SessionUser = {id: string; name: string; email: string};
  const sessions = new WeakMap<object, Promise<SessionUser | null>>();
  const roles = new WeakMap<object, Promise<WorkspaceRole | null>>();
  const sessionUser = (request: {headers: Record<string, unknown>}) => {
    let found = sessions.get(request);
    if (!found) {
      const headers = new Headers();
      if (typeof request.headers.cookie === 'string') headers.set('cookie', request.headers.cookie);
      found = auth.api.getSession({headers}).then(session => session ? {id: session.user.id, name: session.user.name, email: session.user.email} : null);
      sessions.set(request, found);
    }
    return found;
  };
  await app.register(rateLimit, {max: config.testRequestLimit??120, timeWindow: '1 minute',
    keyGenerator: createRequestRateLimitKey({
      trusted: request => typeof request.headers['x-mohassan-internal'] === 'string'
        && secretEqual(request.headers['x-mohassan-internal'], config.internalSecret),
      userId: async request => (await sessionUser(request))?.id ?? null,
    }),
  });
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
  const roleFor = (request: {headers: Record<string, unknown>}, userId: string) => {
    let found = roles.get(request);
    if (!found) { found = roleOf(database.db, userId); roles.set(request, found); }
    return found;
  };
  const memberDailyRuns = config.memberDailyRuns ?? 40;
  // Default-deny: every route needs a session, and a member reaches only MEMBER_ROUTES.
  app.addHook('onRequest', async (request, reply) => {
    const key = routeKey(request.method, request.routeOptions.url);
    if (!key || PUBLIC_ROUTES.has(key)) return;
    const user = await sessionUser(request);
    if (!user) return reply.code(401).send({error: {code: 'UNAUTHORIZED', message: 'سجل الدخول للمتابعة.'}});
    const role = await roleFor(request, user.id);
    if (role === 'owner') return;
    if (role !== 'member' || !MEMBER_ROUTES.has(key)) return reply.code(403).send({error: {code: 'MEMBER_FORBIDDEN', message: 'هذه الخدمة غير متاحة لحسابك.'}});
    if (MEMBER_QUOTA_ROUTES.has(key) && await memberRunsToday(database.db, user.id) >= memberDailyRuns) {
      return reply.code(429).send({error: {code: 'MEMBER_DAILY_LIMIT', message: `وصلت إلى حد ${memberDailyRuns} طلبًا خلال 24 ساعة. حاول لاحقًا.`}});
    }
  });
  app.setErrorHandler((error: any, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({error: {code: 'VALIDATION_ERROR', message: 'تحقق من الحقول المطلوبة وطول المدخلات.'}});
    if (error instanceof StudioError) return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}});
    if (error instanceof BrowserError) return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}});
    if (error instanceof LearningContentError) return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}});
    if (error instanceof PdfError) return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}});
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
    const user = await sessionUser(request);
    if (!user) throw Object.assign(new Error('سجل الدخول للمتابعة.'), {statusCode: 401, code: 'UNAUTHORIZED'});
    return user;
  };
  const role = async (request: {headers: Record<string, unknown>}) => {
    const found = await roleFor(request, (await owner(request)).id);
    if (!found) throw Object.assign(new Error('هذه الخدمة غير متاحة لحسابك.'), {statusCode: 403, code: 'MEMBER_FORBIDDEN'});
    return found;
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
  // The GitHub skills source: no network at boot; the transport is only used by a started sync.
  const skillRemote=config.skillRemote??{config:null,problem:null,dataDir:resolve('.data/skills-remote')};
  const skillRemoteTransport=config.skillRemoteTransport??(skillRemote.config?createGitSkillTransport(skillRemote.dataDir,skillRemote.config):null);
  // Owner decision for the release, 2026-11-22 («بدون حذف»): a sync never deletes a GitHub skill version on this server.
  // Retention stays in packages/skills (prune.ts) with its tests; nothing here calls it and no setting turns it on.
  skills=await registerSkillRoutes(app,{db:database.db,owner,allowedRoots:config.codingAllowedRoots??[],enabled:config.skillEngineEnabled,executableReady:async()=>scriptsReady,remote:{config:skillRemote.config,problem:skillRemote.problem,transport:skillRemoteTransport,pruneOldVersions:false},environment:()=>({capabilities:createCapabilities(Boolean(config.groqApiKey),coding.available,studioAi.available,moduleAvailability,true,config.skillEngineEnabled),modelReady:Boolean(config.groqApiKey),visionReady:Boolean(config.groqApiKey&&config.groqVisionModel),executableReady:scriptsReady,gatewayTools:skillGatewayTools({enabled:config.skillEngineEnabled,coding:coding.available,studio:studioAi.available,vision:Boolean(config.groqApiKey&&config.groqVisionModel)})})});
  await registerSkillRemoteRoutes(app,{skills,owner});
  await skills.remote.recoverInterrupted();
  const skillRemoteScheduler=skillRemote.config&&config.skillEngineEnabled===true&&skillRemote.config.intervalMinutes>0?createSkillRemoteScheduler({skills,db:database.db,intervalMinutes:skillRemote.config.intervalMinutes}):null;
  skillRemoteScheduler?.start();
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
  // The desktop engine acts on this computer's own session; it never exists on the cloud server.
  const desktop=config.desktop?.enabled&&!config.production?new DesktopEngine({dataDir:config.desktop.dataDir??resolve('.data/desktop'),...(config.desktop.projectsRoot?{projectsRoot:config.desktop.projectsRoot}:{}),...(config.desktop.roots?.length?{roots:config.desktop.roots}:{}),...(config.desktop.screenshotsDir?{screenshotsDir:config.desktop.screenshotsDir}:{})}):null;
  await registerDesktopRoutes(app,{owner,engine:desktop});
  if(desktop)app.addHook('onClose',async()=>{await desktop.dispose();});
  const googleAds=createGoogleAdsControl(database.db,{...config.googleAds,webOrigin:config.webOrigin,fetchPage:config.googleAds?.fetchPage??landingPageReader(config.browser)});
  await registerGoogleAdsRoutes(app,{control:googleAds,owner});
  // Generated websites (no model): composed from a brief, previewed by token, exported as ZIP, published to Vercel when a token is set.
  const sites=await createSitesControl(database.db,{tokenSecret:config.internalSecret,publisher:config.sites?.publishTarget==='vercel'?createVercelPublisher({token:config.sites.vercelToken,teamId:config.sites.vercelTeamId,fetch:config.sites.fetch}):noPublisher});
  await registerSiteRoutes(app,{control:sites,owner,role});
  await registerMemberRoutes(app,{db:database.db,auth,webOrigin:config.webOrigin,owner,role,dailyRuns:memberDailyRuns,adsAvailable:()=>googleAds.configured,imagesAvailable:()=>false,sitesAvailable:()=>true});
  const assistantTools=createAssistantTools({memory,coding,studio,studioChange:studioAi.available,runtime,windows,googleAds});
  const inference=await createInferenceControl(database.db,{...config.inference,groq:{apiKey:config.groqApiKey,fast:[config.groqModel??'openai/gpt-oss-20b'],deep:[config.groqReasoningModel??'openai/gpt-oss-120b']},fetch:config.aiFetch});
  await registerInferenceRoutes(app,{control:inference,owner});
  // The local executor uses only Mohassan's own model. No external AI provider is wired in:
  // assisted mode stays off until reasoning runs locally (owner decision, 2026-11-12).
  const executor=createExecutorControl({config:config.executor??executorConfigFromEnv({},process.cwd(),true),sandbox:coding.sandbox});
  await registerExecutorRoutes(app,{control:executor,owner});
  app.addHook('onClose',async()=>{executor.shutdown();});
  // Mohassan's own Ads model: local worker + checker gate, owner-only, on only with the executor experiment.
  const executorConfig=config.executor??executorConfigFromEnv({},process.cwd(),true);
  const adsLab=createAdsLab(config.adsLab??{enabled:false,python:executorConfig.python,packageDir:executorConfig.packageDir,device:'cpu',startupTimeoutMs:120_000,requestTimeoutMs:90_000});
  await registerAdsLabRoutes(app,{lab:adsLab,owner});
  app.addHook('onClose',async()=>{adsLab.shutdown();});
  // The same model's pointer fine-tune answers campaign sentences in the main chat (owner-only, lab only).
  const adsChatWorker=config.adsLab?.enabled?createAdsModelWorker({...config.adsLab,finetune:config.adsLab.chatFinetune??'pointer-v3'}):null;
  if(adsChatWorker)app.addHook('onClose',async()=>{adsChatWorker.stop();});
  const adsWorker=adsChatWorker??config.adsModelWorker;
  const adsModel=adsWorker?createAdsModelChat({worker:adsWorker,fetchPage:config.googleAds?.fetchPage??landingPageReader(config.browser)}):undefined;
  const agentBrowser=new AgentBrowser({profileDir:config.browserProfileDir??join(tmpdir(),`mohassan-browser-${randomUUID()}`),testOrigins:config.browser?.testOrigins,channel:config.browserChannel});
  const chromeExtension=await createChromeExtensionControl(database.db);
  registerChromeExtensionRoutes(app,{control:chromeExtension,owner});
  const adsSleep=config.googleAds?.sleep;
  // The own router model runs in shadow outside production, only when its exported weights exist.
  const routerDir = join(process.cwd(), 'artifacts', 'router');
  const shadowRouter = !config.production && process.env.MOHASSAN_ROUTER_SHADOW !== '0' && !process.env.VITEST && existsSync(join(routerDir, 'router-b0.bin'))
    ? createShadowRouter({ modelDir: routerDir, logFile: join(process.cwd(), '.data', 'router', 'shadow.jsonl') }) : undefined;
  // Conversation state v2 runs in shadow outside production (MOHASSAN_CONVERSATION_SHADOW=0 turns it off); no reply path reads it.
  const conversationShadow = !config.production && process.env.MOHASSAN_CONVERSATION_SHADOW !== '0' && !process.env.VITEST
    ? createConversationShadow({ logFile: join(process.cwd(), '.data', 'conversation', 'shadow.jsonl') }) : undefined;
  // Deferred shadow turns (observeLater) are written before the server closes.
  if (conversationShadow) app.addHook('onClose', async () => { await conversationShadow.flush(); });
  // The judge («الحَكَم»): one verdict per reply (MOHASSAN_JUDGE_SHADOW=0 turns it off).
  // Its mechanical fix is applied on the owner's own account (the owner's word, 2026-11-22; MOHASSAN_JUDGE_FIX=0 turns that off),
  // and so is its withhold: a fixed sentence with the page link instead of a refused answer (same day; MOHASSAN_JUDGE_WITHHOLD=0 turns it off).
  // In production too, by the owner's word of the same day («نعم شغله»): the same fix and withhold for the owner, and for
  // every other account the verdict alone, logged without a word of the conversation (judgeSettings in judge-shadow.ts).
  const judgeConfig = judgeSettings(config.production, process.env, process.cwd());
  const judgeShadow = judgeConfig.enabled ? createJudgeShadow({ logFile: judgeConfig.logFile }) : undefined;
  if (judgeShadow) app.addHook('onClose', async () => { await judgeShadow.flush(); });
  if (judgeShadow && config.production) console.log(JSON.stringify({ level: 'info', event: 'judge_enabled', fixForOwner: judgeConfig.fixForOwner, withholdForOwner: judgeConfig.withholdForOwner, logText: judgeConfig.logText, logFile: judgeConfig.logFile }));
  const mind = config.mindEnabled === true && !config.production ? config.mind ?? createMind() : undefined;
  const mindRobots = new RobotsPolicy(searchNetwork);
  const mindSearch = mind && !config.browser?.searchProvider
    ? new SearchEngine(new RobotsSearchNetwork(searchNetwork, mindRobots), { localIndex: searchIndex, admission: searchStore })
    : searchProvider;
  const mindMemory = assistantTools.memory;
  const mindDeps = (ownerId: string): Omit<MindDeps, 'step'> => ({
    search: (query, limit, signal) => mindSearch.search(query, limit, signal, { ownerId }),
    async read(url, signal) {
      await mindRobots.assertAllowed(url, signal);
      const response = await searchNetwork.request(url, { signal });
      const headers = { ...response.headers };
      delete headers['set-cookie'];
      const type = headers['content-type'] ?? '';
      const isHtml = /^(?:text\/html|application\/xhtml\+xml)(?:[;\s]|$)/i.test(type);
      const isText = /^(?:text\/|application\/(?:[a-z0-9.-]+\+)?xml(?:[;\s]|$))/i.test(type);
      if (!isHtml && !isText) return { url: response.url, status: response.status, headers, html: '', text: '' };
      const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1] ?? 'utf-8';
      const body = new TextDecoder(charset, { fatal: true }).decode(response.body);
      const text = isHtml ? readableSource(body, response.url).text : body;
      return { url: response.url, status: response.status, headers, html: isHtml ? body : '', text };
    },
    ...(mindMemory ? { async memory(query: string) {
      const result = await mindMemory.search(ownerId, query);
      return typeof result === 'string' ? [] : result.evidence;
    } } : {}),
    knowledge: async query => (await learning.knowledge.retrieve(ownerId, query)).map(({ title, text, source }) => ({ title, text, source })),
    async siteSnapshot(url) {
      const prior = await database.db.selectFrom('search_index_documents')
        .select(['source_hash', 'fetched_at']).where('owner_id', '=', ownerId).where('url', '=', url)
        .where('expires_at', '>', new Date()).orderBy('fetched_at', 'desc').executeTakeFirst();
      return prior ? { sourceHash: prior.source_hash, fetchedAt: new Date(prior.fetched_at).toISOString() } : null;
    },
    now: () => new Date(),
  });
  /**
   * A search result read over HTTP for the model-free hands: robots.txt first, HTML only, a bounded time
   * (READ_PAGE_TIMEOUT_MS is a proposed value; the report counts how often it is hit). Null hands the page to the
   * hidden browser; 'disallowed' skips it there too.
   */
  const READ_PAGE_TIMEOUT_MS = 4000;
  const READ_PAGE_RETRY_TIMEOUT_MS = 10_000;
  // The network's default cap is 2 MB. Measured on 2026-11-22: ar.wikipedia «مصر» 3.01 MB, «المغرب» 3.27 MB, «السعودية»
  // 3.51 MB, en «United States» 2.98 MB; over the cap they fell to the hidden browser (9.7 s for «كم عدد سكان مصر»).
  // Over HTTP the largest took 0.8 s to fetch and 0.3 s to parse. 8 MB leaves room above the largest measured article.
  const READ_PAGE_MAX_BYTES = 8_000_000;
  // Pages read over HTTP are kept by site kind (plan §5.2 P4): an encyclopedia article for a week, documentation
  // for a day, news for a quarter of an hour. A page read for a live fact is fetched every time.
  const pageCache = createPageCache();
  const readPage = async (url: string, signal: AbortSignal, options: { live?: boolean } = {}) => {
    const cached = pageCache.get(url, options);
    if (cached) return cached;
    const combined = AbortSignal.any([signal, AbortSignal.timeout(READ_PAGE_TIMEOUT_MS)]);
    try { await mindRobots.assertAllowed(url, combined); }
    catch (error) {
      if (signal.aborted) throw error;
      return error instanceof BrowserError && error.code === 'RESEARCH_ROBOTS_DENIED' ? 'disallowed' as const : null;
    }
    let response: Awaited<ReturnType<SafeNetwork['request']>>;
    try { response = await searchNetwork.request(url, { signal: combined, maxBytes: READ_PAGE_MAX_BYTES }); }
    catch (error) {
      if (signal.aborted) throw error;
      // A large article on a busy machine can outlast the 4 s budget; one more try with a longer one is far cheaper
      // than the hidden browser it would otherwise fall back to (32 s measured on 2026-11-22 under full load).
      if (!combined.aborted) return null;
      try { response = await searchNetwork.request(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(READ_PAGE_RETRY_TIMEOUT_MS)]), maxBytes: READ_PAGE_MAX_BYTES }); }
      catch (retryError) { if (signal.aborted) throw retryError; return null; }
    }
    const type = response.headers['content-type'] ?? '';
    if (response.status >= 400 || !/^(?:text\/html|application\/xhtml\+xml)(?:[;\s]|$)/i.test(type)) return null;
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1] ?? 'utf-8';
    let body: string;
    try { body = new TextDecoder(charset, { fatal: true }).decode(response.body); } catch { return null; }
    // Captions are not the article's sentences; joined into the text they glued onto the next one (readable-page.ts).
    const source = readableSource(withoutFigures(body), response.url);
    return pageCache.put({ url: response.url, title: source.title, text: source.text, status: response.status }, options);
  };
  // PDF files from the chat: stored under the data directory; local .pdf paths are read for the owner only, inside the coding roots.
  await migrateDocuments(database.db);
  const documents=createDocumentControl(database.db,{dir:config.documentsDir??resolve('.data/documents'),fontsDir:config.documentsFontsDir,allowedRoots:async ownerId=>await roleOf(database.db,ownerId)==='owner'?(config.codingAllowedRoots??[]):[]});
  const documentLink=(id:string)=>`${config.webOrigin}/api/documents/${id}/content`;
  // The own image reader (packages/vision): exported weights in artifacts/vision/ocr-v1 unless MOHASSAN_OCR_MODEL_DIR points elsewhere.
  const imageReader=await createImageReader({modelDir:process.env.MOHASSAN_OCR_MODEL_DIR??join(process.cwd(),'artifacts','vision','ocr-v1'),workers:Number(process.env.MOHASSAN_OCR_WORKERS??3)});
  const chat=await createCommandChatControl(database.db,{...(shadowRouter?{shadowRouter}:{}),...(conversationShadow?{conversationShadow}:{}),...(judgeShadow?{judgeShadow,judgeFixForOwner:judgeConfig.fixForOwner,judgeWithholdForOwner:judgeConfig.withholdForOwner,judgeLogText:judgeConfig.logText}:{}),...(imageReader.available?{imageReader}:{}),...(mind?{mind,mindDeps}:{}),...(adsModel?{adsModel}:{}),sites:{createFromBrief:(ownerId,brief,options)=>sites.create(ownerId,{brief,conversationId:options.conversationId,role:options.role}),command:(ownerId,siteId,input)=>sites.command(ownerId,siteId,input),detail:(ownerId,siteId)=>sites.detail(ownerId,siteId),roleOf:ownerId=>roleOf(database.db,ownerId),link:siteId=>`${new URL(config.webOrigin).origin}/#sites=${siteId}`},...(desktop?{desktop:{parse:(text:string)=>desktop.parse(text),describe:(command,lang)=>desktop.describe(command,lang),execute:(command,options)=>desktop.execute(command,options)}}:{}),...(adsSleep?{campaignSleep:(milliseconds:number)=>adsSleep(milliseconds)}:{}),apiKey:config.groqApiKey,tools:assistantTools,documents:{control:documents,link:documentLink},inference,models:{fast:[config.groqModel??'openai/gpt-oss-20b'],deep:[config.groqReasoningModel??'openai/gpt-oss-120b'],vision:config.groqVisionModel??'qwen/qwen3.8-27b'},fetch:config.aiFetch,browser:agentBrowser,networkPolicy:config.browser,searchProvider,readPage,fullAccess:async ownerId=>await roleOf(database.db,ownerId)==='owner',accountFullAccess:(ownerId,tx)=>lockOwnerToolAccess(tx,ownerId),accountActive:async(ownerId,tx)=>{const role=await roleOf(tx,ownerId);if(role!=='member')return role!==null;return Boolean(await tx.selectFrom('workspace_members').select('user_id').where('user_id','=',ownerId).where('role','=','member').where('disabled_at','is',null).forShare().executeTakeFirst());},memoryContext:(ownerId,goal)=>memory.context(ownerId,goal,undefined,{readOnly:true}),
    learningContext:learning.context,chromeExtension,
    knowledgeSearch:async(ownerId,query)=>(await learning.knowledge.retrieve(ownerId,query)).map(({title,text,source})=>({title,text,source})),
    ...(config.skillEngineEnabled?{recordSkillGap,skillContext:skills.context,loadSkill:skills.loadInstruction,
    // Model-free answers read active instruction skills through the same verified gate as the model prompt.
    skillAnswer:createSkillReader({candidates:ownerId=>preloadInstructionMetadata(database.db,ownerId,SKILL_READER_DISCOVERY),index:async ownerId=>(await skills.catalogue.snapshot(ownerId)).memo('skill-reader',buildSkillReaderIndex),instructions:async(ownerId,id)=>skillInstructionText((await skills.loadInstruction(ownerId,id,MAX_SKILL_CONTEXT_CHARS)).text)}),
    runSkill:async(ownerId,input,context)=>{
      context.signal.throwIfAborted();
      return runtime.createTask(ownerId,{title:'تشغيل مهارة من المحادثة',goal:context.goal.slice(0,4000),capabilityId:'skill.run',autonomy:'assisted',skillInput:input},context.idempotencyKey,context.runId);
    }}:{}),
  });
  await registerCommandChatRoutes(app,{control:chat,owner:async request=>{const user=await owner(request);windows.noteSession(user.id,request);return user;}});
  await registerBrowserFileRoutes(app,{db:database.db,browser:agentBrowser,owner});
  await registerDocumentRoutes(app,{control:documents,owner,link:documentLink});
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
      {id: 'desktop', name: 'سطح المكتب', description: 'إنشاء المشاريع والملفات والتحكم بهذا الكمبيوتر', status: desktop?'connected':'needs_configuration', detail: desktop?`يعمل على هذا الجهاز. مجلد المشاريع: ${desktop.projects.projectsRoot}`:'يعمل من تطبيق موحسن لسطح المكتب على جهاز المالك فقط.'},
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
  app.addHook('onClose', async () => {clearInterval(benchmarkMaintenance);try{await skillRemoteScheduler?.stop();await skills.remote.shutdown();await benchmarkMaintenanceRun;await Promise.all([skillBenchmarks.shutdown(),skillForge.shutdown()]);}finally{try{await chat.shutdown();}finally{try{await runtime.stop();}finally{try{await browser.shutdown();}finally{try{await studioLive.close();}finally{await database.close();}}}}}});
  if (config.runWorker) runtime.start();
  await app.ready();
  return {app, routes, runtime, database, auth,ai,coding,studio,studioAi,studioLive,browser,browserTask,memory,skills,chat,skillExecution,skillBenchmarks,skillForge,googleAds,inference,chromeExtension};
}
