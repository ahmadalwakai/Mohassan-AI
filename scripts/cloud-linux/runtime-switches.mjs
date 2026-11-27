// Deployment profiles and runtime defaults were checked on 2026-11-27 against the deployed source:
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/docs/DEPLOY-WAVE-6-2026-11-25.md#environment-changes
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/scripts/cloud-linux/preflight-wave-6.mjs
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/scripts/cloud-linux/server.env.example
// `default` is the effective production default. `production` is the cutover value, `ownerTrial`
// is the monitor-trial value, and ownerV5/ownerCouncil override those profiles where specified.
// Undefined means unset, null means unrestricted. `required` marks values that must be explicit.
// `off` and `on` are values for the isolated boot matrix; settings and internal inputs have no on case.
export const runtimeSwitches = [
  // https://github.com/ahmadalwakai/Mohassan-AI/tree/29448ae/apps/server/src/assistant
  { name: 'MOHASSAN_ARITHMETIC_SEARCH', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'Arithmetic ranker export for learned arithmetic ranking' },
  { name: 'MOHASSAN_BACKGROUND_RESULTS_ENABLED', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'Long-run admission for new durable runs' },
  { name: 'MOHASSAN_CLARIFY_CHOICES', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'A pending clarification with supported choices' },
  { name: 'MOHASSAN_CONTEXT_POLICY_ENABLED', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'Stored conversation context' },
  { name: 'MOHASSAN_CONVERSATION_REVIEW_APPLY', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'A reply eligible for automatic conversation review' },
  { name: 'MOHASSAN_CONVERSATION_SHADOW', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: 'decide', needs: 'Conversation history for live decisions. Shadow logging defaults on outside production.' },
  { name: 'MOHASSAN_EXTRACTIVE_WRITING', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'A supported writing request and its source material' },
  { name: 'MOHASSAN_LONG_RUN_ENABLED', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'Database-backed durable runs and a supported plan' },
  { name: 'MOHASSAN_PLAN_COMPILER', kind: 'switch', default: 'off', production: 'off', ownerTrial: 'off',
    off: 'off', on: 'on', needs: 'Supported plan tools. The shadow value records plans without executing them.' },
  { name: 'MOHASSAN_QUESTION_REWRITER', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'A public lookup eligible for question rewriting' },
  { name: 'MOHASSAN_REASONING', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'A supported local reasoning request' },
  { name: 'MOHASSAN_REFUSAL_POLICY', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'The learned refusal classifier export' },
  { name: 'MOHASSAN_REPLY_POLICY_ENABLED', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'A reply eligible for response policy composition' },
  { name: 'MOHASSAN_SCRATCH_CLASSIFIERS', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'The checked-in scratch classifier exports' },
  { name: 'MOHASSAN_SMALL_TALK_MANNERS', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'A supported conversational turn' },
  { name: 'MOHASSAN_STRUCTURED_MEMORY', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'The structured memory store' },
  { name: 'TEST_DRIVEN_CODING_ENABLED', kind: 'switch', default: 'false', production: 'false', ownerTrial: 'false',
    off: 'false', on: 'true', needs: 'Trusted Python 3.11+ and libseccomp on the Linux VM' },

  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/judge-shadow.ts#L73-L85
  { name: 'MOHASSAN_JUDGE_SHADOW', kind: 'switch', default: '1', production: '1', ownerTrial: '1',
    off: '0', on: '1', allowed: ['0'], needs: 'A service-writable judge log directory' },
  { name: 'MOHASSAN_JUDGE_FIX', kind: 'switch', default: '1', production: '1', ownerTrial: '1',
    off: '0', on: '1', allowed: ['0'], needs: 'The judge and an eligible owner reply' },
  { name: 'MOHASSAN_JUDGE_WITHHOLD', kind: 'switch', default: '1', production: '1', ownerTrial: '1',
    off: '0', on: '1', allowed: ['0'], needs: 'The judge and an eligible owner reply' },
  { name: 'MOHASSAN_JUDGE_LOG_DIR', kind: 'setting', default: '.data/judge', production: '/var/lib/mohassan/judge',
    ownerTrial: '/var/lib/mohassan/judge', needs: 'A directory writable by the service account' },

  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/model-relations/src/manager.ts
  { name: 'MOHASSAN_MODEL_RELATIONS', kind: 'switch', default: 'shadow', production: 'off', ownerTrial: 'off',
    off: 'off', on: 'shadow', required: true, needs: 'The model relations runtime and its observation journal' },
  { name: 'MOHASSAN_ARBITER_ROUTING', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'Model relations and a promoted routing decision' },
  { name: 'MOHASSAN_ARBITER_ROUTING_KILL', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'Overrides routing arbitration when enabled' },
  { name: 'MOHASSAN_ARBITER_QUESTION_REWRITE', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'Model relations and a promoted question rewrite decision' },
  { name: 'MOHASSAN_ARBITER_QUESTION_REWRITE_KILL', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'Overrides question rewrite arbitration when enabled' },
  { name: 'MOHASSAN_ARBITER_LOCAL_COMPUTATION', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'Model relations and a promoted local computation decision' },
  { name: 'MOHASSAN_ARBITER_LOCAL_COMPUTATION_KILL', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'Overrides local computation arbitration when enabled' },
  { name: 'MOHASSAN_ARBITER_COMPOUND_PLAN', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'Model relations and a promoted compound plan decision' },
  { name: 'MOHASSAN_ARBITER_COMPOUND_PLAN_KILL', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'Overrides compound plan arbitration when enabled' },
  { name: 'MOHASSAN_ARBITER_MONITOR_CONTEXT', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'Model relations, monitor context and a promoted monitor decision' },
  { name: 'MOHASSAN_ARBITER_MONITOR_CONTEXT_KILL', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'Overrides monitor context arbitration when enabled' },

  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/monitors-phase1/rollout.ts
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/monitors/flag.ts
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/monitors/decision/shadow.ts
  { name: 'MOHASSAN_MONITORS_ENABLED', kind: 'switch', default: '0', production: '0', ownerTrial: 'owner',
    off: '0', on: 'owner', needs: 'Monitor tables and the monitor scheduler. Value 1 also admits members.' },
  { name: 'MOHASSAN_MONITORS_V2', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'Smart monitors enabled' },
  { name: 'MOHASSAN_MONITORS_GITHUB', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'V2 monitors and a supported GitHub source' },
  { name: 'MOHASSAN_MONITORS_PDF', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'V2 monitors and a supported PDF source' },
  { name: 'MOHASSAN_MONITORS_VISUAL', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'V2 monitors and Chromium for visual captures' },
  { name: 'MOHASSAN_MONITOR_CONTEXT', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'V2 monitors and source context' },
  { name: 'MOHASSAN_MONITOR_CONTEXT_SHADOW', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', needs: 'V2 monitors and model relations observation' },

  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/ops/metrics/index.ts#L20-L25
  { name: 'PRODUCTION_METRICS_ENABLED', kind: 'switch', default: 'true', production: 'false', ownerTrial: 'true',
    off: 'false', on: 'true', required: true, needs: 'A service-writable metrics directory' },

  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/app.ts#L498-L507
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/model-worker.ts#L89-L116
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/model-relations/src/registry.ts#L473-L477
  { name: 'MOHASSAN_MODEL_COUNCIL', kind: 'switch', default: 'off', production: 'off', ownerTrial: 'off',
    off: 'off', on: 'owner', ownerCouncil: 'owner', needs: 'The external model store for the owner council' },
  { name: 'MOHASSAN_MODELS_ROOT', kind: 'setting', default: undefined, production: undefined, ownerTrial: undefined,
    needs: 'An absolute external model store readable by the service account and protected from service writes' },
  { name: 'MOHASSAN_MODEL_WORKER', kind: 'switch', default: '0', production: '0', ownerTrial: '0',
    off: '0', on: '1', ownerV5: '1', needs: 'Local Python, a worker config and the model files it pins' },
  { name: 'MOHASSAN_MODEL_WORKER_CONFIG', kind: 'setting', default: '.data/model-worker.json', production: undefined,
    ownerTrial: undefined, needs: 'A worker configuration file readable by the service account' },
  { name: 'MOHASSAN_V5_CHAT', kind: 'switch', default: 'off', production: 'off', ownerTrial: 'off',
    off: 'off', on: 'owner', ownerV5: 'owner', needs: 'The running resident model worker with v5 configured' },
  { name: 'MOHASSAN_OCR_MODEL_DIR', kind: 'setting', default: 'artifacts/vision/ocr-v1', production: undefined,
    ownerTrial: undefined, needs: 'An absolute external OCR store with manifest.json and weights.bin for the VM reader' },
  { name: 'MOHASSAN_OCR_WORKERS', kind: 'setting', default: '3', production: undefined, ownerTrial: undefined,
    needs: 'The OCR model export. Sets the size of its lazy worker pool.' },

  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/config.ts
  { name: 'RUN_WORKER', kind: 'switch', default: 'true', production: 'false', ownerTrial: null,
    off: 'false', on: 'true', required: true, needs: 'The application database and an approved cutover before consuming tasks' },
  { name: 'SKILL_ENGINE_ENABLED', kind: 'switch', default: 'false', production: 'false', ownerTrial: 'false',
    off: 'false', on: 'true', needs: 'Executable skills and their configured runtime' },
  { name: 'WINDOWS_REMOTE_ENABLED', kind: 'switch', default: 'false', production: 'false', ownerTrial: 'false',
    off: 'false', on: 'true', needs: 'A configured Windows remote host for Windows operations' },
  { name: 'GOOGLE_ADS_PUBLISHING_ENABLED', kind: 'switch', default: 'false', production: 'false', ownerTrial: 'false',
    off: 'false', on: 'true', needs: 'Configured Ads credentials, authorization and publication checks' },
  { name: 'MOHASSAN_ISOLATED_TEST', kind: 'switch', default: undefined, production: undefined, ownerTrial: undefined,
    needs: 'A test environment with explicit isolated settings. Skips dotenv when true.' },
  { name: 'MOHASSAN_LOCAL_LAB', kind: 'switch', default: undefined, production: undefined, ownerTrial: undefined,
    needs: 'Local development storage. Setting 1 suppresses DATABASE_URL and cannot use the production database.' },
  { name: 'MOHASSAN_MIND', kind: 'switch', default: undefined, production: undefined, ownerTrial: undefined,
    needs: 'The local lab. Disabled in production.' },

  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/skill-remote.ts#L12-L25
  { name: 'SKILL_REMOTE_AUTO_ACTIVATE', kind: 'switch', default: 'false', production: 'false', ownerTrial: 'false',
    off: 'false', on: 'true', needs: 'A configured remote skill repository and a synchronized skill' },

  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/training-monitor/route.ts#L10-L16
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/app.ts#L398-L403
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/executor.ts#L26-L55
  { name: 'MOHASSAN_DESKTOP_SHELL', kind: 'switch', default: undefined, production: undefined, ownerTrial: undefined,
    on: '1', needs: 'Loopback web and API origins for the desktop training monitor' },
  { name: 'MOHASSAN_ROUTER_SHADOW', kind: 'switch', default: undefined, production: undefined, ownerTrial: undefined,
    off: '0', on: '1', needs: 'A router export and a non-production server' },
  { name: 'EXECUTOR_EXPERIMENT', kind: 'switch', default: undefined, production: undefined, ownerTrial: undefined,
    on: 'uncontained-local', needs: 'A non-production server and local executor dependencies' },

  // These are generated by the sandbox for child scripts, including its own probes.
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/sandbox/src/index.ts
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/sandbox/src/coding-tools.ts
  { name: 'MOHASSAN_INPUT_PATH', kind: 'internal', default: undefined, production: undefined, ownerTrial: undefined,
    needs: 'Sandbox-provided input file' },
  { name: 'MOHASSAN_OUTPUT_DIR', kind: 'internal', default: undefined, production: undefined, ownerTrial: undefined,
    needs: 'Sandbox-provided writable output directory' },
  { name: 'MOHASSAN_PUBLIC_RESOURCE', kind: 'internal', default: undefined, production: undefined, ownerTrial: undefined,
    needs: 'Sandbox public resource probe fixture' },
  { name: 'MOHASSAN_SANDBOX_PROBE_SECRET', kind: 'internal', default: undefined, production: undefined, ownerTrial: undefined,
    needs: 'Sandbox environment isolation probe sentinel' },
];
