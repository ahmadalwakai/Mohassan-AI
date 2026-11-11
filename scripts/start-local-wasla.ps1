# Starts Mohassan on this PC for the Wasla iPhone app.
# - Own embedded database (never the production tunnel): DATABASE_URL is forced empty.
# - Wasla bridge on, loopback only (server 127.0.0.1:4100, web 127.0.0.1:3100).
# - The owner's local model on Ollama.
# The first time: open http://127.0.0.1:3100, create the owner account with the
# token in .data/setup-token, then «الاتصالات» → «ربط وصلة».
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$data = if ($env:MOHASSAN_LOCAL_DATA) { $env:MOHASSAN_LOCAL_DATA } else { Join-Path $env:USERPROFILE 'Documents\Mohassan-Local' }
New-Item -ItemType Directory -Force -Path $data | Out-Null

$env:DATABASE_URL = ''
$env:NODE_ENV = 'development'
$env:DATA_DIR = Join-Path $data 'postgres'
$env:CODING_DATA_DIR = Join-Path $data 'coding'
$env:STUDIO_AI_DATA_DIR = Join-Path $data 'studio-ai'
$env:BROWSER_PROFILE_DIR = Join-Path $data 'browser-profile'
$env:SERVER_HOST = '127.0.0.1'
$env:SERVER_PORT = '4100'
$env:WEB_ORIGIN = 'http://127.0.0.1:3100'
$env:WASLA_BRIDGE_ENABLED = 'true'
if (-not $env:LOCAL_MODEL_NAME) { $env:LOCAL_MODEL_NAME = 'qwen3.5:9b-q4_K_M' }
if (-not $env:LOCAL_MODEL_URL) { $env:LOCAL_MODEL_URL = 'http://127.0.0.1:11434' }

Set-Location $root
node scripts/dev.mjs
