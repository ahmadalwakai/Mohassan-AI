"""HTTPS API. No shell execution, filesystem browsing, unauthenticated frames or CORS."""
from __future__ import annotations

import asyncio
from collections import defaultdict, deque
import hashlib
import json
from pathlib import Path
import re
import secrets
import time

from aiohttp import web

from .security import AuthError, AuthStore, atomic_json, read_json, state_lock
from .actions import ActionsController
from .intelligence import Intelligence
from .knowledge import KnowledgeStore, checked_id
from .mohassan import MohassanBridge
from .services import _messages

REQUEST_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{7,63}\Z")
STATE = web.AppKey("wasla_state", object)


class APIError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def validate_fields(data, required, optional=()):
    if not isinstance(data, dict) or set(data) - set(required) - set(optional) or set(required) - set(data):
        raise APIError("invalid_request", "The request has missing or unsupported fields.")
    return data


async def body(request, required, optional=()):
    if request.content_type != "application/json":
        raise APIError("invalid_content_type", "Use application/json.", 415)
    try:
        data = await request.json()
    except (ValueError, UnicodeError):
        raise APIError("invalid_json", "The request is not valid JSON.")
    return validate_fields(data, required, optional)


def text_value(value, name, maximum, minimum=1):
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum:
        raise APIError("invalid_request", f"{name} must contain {minimum}–{maximum} characters.")
    if any(ord(char) < 32 and char not in "\r\n\t" for char in value):
        raise APIError("invalid_request", f"{name} contains invalid control characters.")
    return value.strip()


class Runtime:
    def __init__(self, store, services, desktop, desktop_enabled, actions=None, knowledge=None, intelligence=None, cloud=None, mohassan=None):
        self.store, self.services, self.desktop = store, services, desktop
        self.mohassan = mohassan or MohassanBridge(store.root)
        self.desktop_enabled = desktop_enabled
        self.actions = actions or ActionsController(allowed=False, state_root=store.root)
        self.knowledge = knowledge or KnowledgeStore(store.root)
        async def lookup(*args):
            return await asyncio.to_thread(self.knowledge.knowledge_lookup, *args)
        async def version(*args):
            return await asyncio.to_thread(self.knowledge.knowledge_version, *args)
        self.intelligence = intelligence or Intelligence(services, knowledge_lookup=lookup, knowledge_version=version)
        self.cloud = cloud
        self.lease = None
        self.desktop_lock = asyncio.Lock()
        self.jobs = read_json(store.root / "jobs.json", {})
        self.workers = set()
        self.rates = defaultdict(deque)
        self.stopping = False

    def limit(self, key, count, seconds=60):
        now = time.monotonic()
        if len(self.rates) > 2000:
            self.rates = defaultdict(deque, {k: v for k, v in self.rates.items() if v and now - v[-1] < 60})
        if len(self.rates) > 2000 and key not in self.rates:
            raise APIError("busy", "Server is busy; try later.", 429)
        values = self.rates[key]
        while values and now - values[0] >= seconds:
            values.popleft()
        if len(values) >= count:
            raise APIError("rate_limited", "Too many requests. Wait before trying again.", 429)
        values.append(now)

    def save_jobs(self):
        with state_lock(self.store.root):
            atomic_json(self.store.root / "jobs.json", self.jobs)

    def owned_job(self, request):
        request_id = request.match_info["request_id"]
        if not REQUEST_ID.fullmatch(request_id):
            raise APIError("not_found", "Unknown image request.", 404)
        job = self.jobs.get(request_id)
        if not job or job["owner"] != request["device_id"]:
            raise APIError("not_found", "Unknown image request.", 404)
        return job

    def require_lease(self, request):
        # Re-check local revocation after any awaited desktop operation/queue delay.
        self.store.authenticate(request.headers.get("Authorization", ""))
        lease = self.lease
        if not self.desktop_enabled or self.stopping:
            raise APIError("desktop_disabled", "Enable desktop control in the Windows companion first.", 403)
        if not lease or lease["expires_at"] <= time.time() or lease["owner"] != request["device_id"]:
            raise APIError("desktop_session_expired", "Start a new desktop session.", 403)
        supplied = request.headers.get("X-Wasla-Session", "")
        if not secrets.compare_digest(lease["session_id"], supplied):
            raise APIError("desktop_session_expired", "Start a new desktop session.", 403)
        return lease


@web.middleware
async def protections(request, handler):
    runtime = request.app[STATE]
    try:
        if runtime.stopping:
            raise APIError("stopping", "The Windows companion is stopping.", 503)
        if request.headers.get("Origin") is not None:
            raise APIError("origin_denied", "Browser cross-origin requests are not accepted.", 403)
        if len(request.path_qs) > 512 or request.query_string:
            raise APIError("invalid_request", "Query parameters are not supported.")
        runtime.limit(("ip", request.remote), 1800)
        if request.path == "/v1/pair" and request.method == "POST":
            runtime.limit(("pair", request.remote), 10)
        else:
            request["device_id"] = runtime.store.authenticate(request.headers.get("Authorization", ""))
        response = await handler(request)
    except AuthError as exc:
        response = web.json_response({"error": {"code": "unauthorized", "message": str(exc)}}, status=401)
    except APIError as exc:
        response = web.json_response({"error": {"code": exc.code, "message": exc.message}}, status=exc.status)
    except web.HTTPException as exc:
        response = web.json_response({"error": {"code": "http_error", "message": exc.reason}}, status=exc.status)
    except Exception as exc:
        # ServiceError and DesktopError are intentionally mapped without leaking paths/tracebacks.
        if hasattr(exc, "code") and hasattr(exc, "status"):
            response = web.json_response({"error": {"code": exc.code, "message": str(exc)}}, status=exc.status)
        elif type(exc).__name__ in ("DesktopError", "ValueError"):
            response = web.json_response({"error": {"code": "desktop_unavailable" if type(exc).__name__ == "DesktopError" else "invalid_request", "message": str(exc)}}, status=409 if type(exc).__name__ == "DesktopError" else 400)
        else:
            print(f"Request failed: {type(exc).__name__}", flush=True)
            response = web.json_response({"error": {"code": "internal_error", "message": "The local operation failed. Check the Windows companion."}}, status=500)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
    return response


async def pair(request):
    data = await body(request, ("code", "device_name"))
    return web.json_response(request.app[STATE].store.pair(data["code"], data["device_name"]))


async def status(request):
    runtime = request.app[STATE]
    try:
        display = await asyncio.to_thread(runtime.desktop.info)
    except Exception:
        display = {"width": 0, "height": 0, "monitor": "primary", "error": "Desktop is locked or unavailable."}
    return web.json_response({"name": "Wasla Windows", "model": "qwen3.5:9b-coding-local",
        "busy": runtime.services.busy, "desktop_enabled": runtime.desktop_enabled,
        "app_actions_enabled": runtime.actions.allowed is True,
        "cloud_configured": bool(runtime.cloud and runtime.cloud.configured),
        "storage": runtime.knowledge.storage,
        "desktop": display, "capabilities": ["chat", "text_to_image_512", "web_search", "primary_desktop", "local", "live_web", "knowledge", "memory", "app_actions"],
        "chat_backend": "Ollama", "cline_task_control": False})


async def revoke(request):
    runtime = request.app[STATE]
    runtime.store.revoke(request["device_id"])
    if runtime.lease and runtime.lease["owner"] == request["device_id"]:
        runtime.lease = None
    return web.json_response({"ok": True})


async def chat(request):
    runtime = request.app[STATE]
    runtime.limit(("chat", request["device_id"]), 12)
    data = await body(request, ("messages",), ("request_id", "mode", "remember", "use_memory", "conversation_id", "allow_cloud"))
    messages = _messages(data["messages"])
    mode = data.get("mode", "auto")
    if mode not in ("auto", "live_web", "local"):
        raise APIError("invalid_mode", "اختر تلقائي أو بحث مباشر أو محلي.")
    for field in ("remember", "use_memory", "allow_cloud"):
        if field in data and type(data[field]) is not bool:
            raise APIError("invalid_request", "خيارات الطلب يجب أن تكون نعم أو لا.")
    if data.get("conversation_id"):
        checked_id(data["conversation_id"])
    started = time.perf_counter()
    # Only the latest direct user message can plan an action. Model output,
    # history, retrieved documents and web extracts never reach this dispatcher.
    plan = runtime.actions.plan(messages[-1]["content"])
    if plan:
        def execute():
            runtime.store.authenticate(request.headers.get("Authorization", ""))
            if runtime.stopping:
                raise APIError("stopping", "وصلة يتوقف الآن.", 503)
            return runtime.actions.execute(plan, device_id=request["device_id"], request_id=data.get("request_id"))
        result = await asyncio.to_thread(execute)
        answer = {"content": result["message"], "model": "Wasla actions", "route": "actions", "action": result,
                  "sources": [], "evidence": {"level": "unverified", "note": "لم يُتحقق من ظهور النافذة."},
                  "warnings": [], "cache_hit": False, "usage": {"provider": "local", "estimated_cost_usd": 0}}
    elif data.get("allow_cloud"):
        if not runtime.cloud or not runtime.cloud.configured:
            raise APIError("cloud_unconfigured", "المعالجة السحابية غير مفعّلة. النموذج المحلي متاح.", 409)
        answer = await runtime.cloud.answer(messages, mode=mode)
    else:
        answer = await runtime.intelligence.answer(messages, device_id=request["device_id"], mode=mode, use_memory=data.get("use_memory", False))
    answer["timing_ms"] = round((time.perf_counter() - started) * 1000, 2)
    # A per-send explicit choice is required, even if a saved preference is on.
    conversation_id = None
    try:
        conversation_id = await asyncio.to_thread(runtime.knowledge.save_exchange, messages, answer,
            remember=data.get("remember", False), conversation_id=data.get("conversation_id"))
    except Exception:
        answer.setdefault("warnings", []).append("memory_save_failed")
    answer.update(memory_saved=bool(conversation_id), conversation_id=conversation_id)
    try:
        await asyncio.to_thread(runtime.knowledge.record_usage, answer)
    except Exception:
        answer.setdefault("warnings", []).append("usage_record_failed")
    return web.json_response(answer)


async def knowledge_handler(request):
    runtime = request.app[STATE]
    if request.method == "GET":
        return web.json_response({"items": await asyncio.to_thread(runtime.knowledge.documents)})
    runtime.limit(("knowledge", request["device_id"]), 30)
    if request.method == "POST":
        data = await body(request, ("title", "content"))
        return web.json_response(await asyncio.to_thread(runtime.knowledge.add_document, **data), status=201)
    return web.json_response(await asyncio.to_thread(runtime.knowledge.delete_document, request.match_info["id"]))


async def conversations(request):
    store = request.app[STATE].knowledge
    item = request.match_info.get("id")
    if request.method == "DELETE":
        return web.json_response(await asyncio.to_thread(store.delete_conversation, item))
    if item:
        return web.json_response(await asyncio.to_thread(store.conversation, item))
    return web.json_response({"items": await asyncio.to_thread(store.conversations)})


async def settings(request):
    runtime = request.app[STATE]
    if request.method == "PATCH":
        data = await body(request, ("memory_enabled",))
        result = await asyncio.to_thread(runtime.knowledge.set_settings, data["memory_enabled"])
    else:
        result = await asyncio.to_thread(runtime.knowledge.settings)
    result.update(runtime.cloud.settings() if runtime.cloud else {
        "cloud_enabled": False, "cloud_daily_budget_usd": 0, "cloud_spent_usd": 0, "cloud_model": None})
    return web.json_response(result)


async def metrics(request):
    return web.json_response(await asyncio.to_thread(request.app[STATE].knowledge.metrics))


async def prepare_image(request):
    runtime = request.app[STATE]
    runtime.limit(("prepare", request["device_id"]), 8)
    data = await body(request, ("description",), ("style",))
    return web.json_response(await runtime.services.prepare_image(data["description"], data.get("style", "natural")))


def public_job(job):
    result = {"request_id": job["request_id"], "status": job["status"]}
    if job["status"] == "completed":
        result["image_url"] = f"/v1/images/{job['request_id']}/content"
    if job.get("error"):
        result["error"] = job["error"]
    return result


async def image_worker(runtime, job, data):
    job["status"] = "running"
    runtime.save_jobs()
    try:
        result = await runtime.services.generate_image(**data)
        if result.get("status") in ("succeeded", "completed"):
            job["status"] = "completed"
        else:
            job["status"] = "failed"
            job["error"] = result.get("error", "The image request did not complete.")
    except Exception as exc:
        job["status"] = "failed"
        job["error"] = str(exc) if hasattr(exc, "code") else "Image creation failed. Check the Windows companion."
    finally:
        runtime.save_jobs()


async def create_image(request):
    runtime = request.app[STATE]
    data = await body(request, ("prompt", "negative_prompt", "seed", "request_id"))
    text_value(data["prompt"], "prompt", 2000)
    text_value(data["negative_prompt"], "negative_prompt", 1000, 0)
    if type(data["seed"]) is not int or not 0 <= data["seed"] <= 4294967295:
        raise APIError("invalid_request", "seed must be a 32-bit unsigned integer.")
    request_id = data["request_id"]
    if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
        raise APIError("invalid_request", "request_id must contain 8–64 letters, digits, hyphens or underscores.")
    digest = hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    previous = runtime.jobs.get(request_id)
    if previous:
        if previous["owner"] != request["device_id"]:
            raise APIError("request_conflict", "Choose a new request ID.", 409)
        if previous["digest"] != digest:
            raise APIError("request_conflict", "This request ID already belongs to different image parameters.", 409)
        return web.json_response(public_job(previous))
    if runtime.services.busy or any(job["status"] in ("queued", "running") for job in runtime.jobs.values()):
        raise APIError("busy", "The local model is busy. Wait for the current operation.", 409)
    if await runtime.mohassan.running():
        raise APIError("busy", "موحسن يعمل الآن على الكمبيوتر. انتظر حتى ينتهي قبل إنشاء صورة.", 409)
    runtime.limit(("image", request["device_id"]), 6)
    job = {"owner": request["device_id"], "request_id": request_id, "digest": digest, "status": "queued", "created_at": time.time()}
    runtime.jobs[request_id] = job
    runtime.save_jobs()
    worker = asyncio.create_task(image_worker(runtime, job, data))
    runtime.workers.add(worker)
    worker.add_done_callback(runtime.workers.discard)
    return web.json_response(public_job(job), status=202)


async def get_image(request):
    runtime = request.app[STATE]
    job = runtime.owned_job(request)
    return web.json_response(public_job(job))


async def image_content(request):
    runtime = request.app[STATE]
    job = runtime.owned_job(request)
    if job["status"] != "completed":
        raise APIError("not_ready", "The image is not ready.", 409)
    # Existing bridge reopens PNG, checks dimensions and verifies its original digest.
    result = await runtime.services.image_status(job["request_id"])
    if result.get("status") not in ("succeeded", "completed") or not result.get("image", {}).get("path"):
        raise APIError("image_unavailable", "The saved image could not be verified.", 409)
    path = Path(result["image"]["path"])
    raw = await asyncio.to_thread(path.read_bytes)
    if len(raw) > 16 * 1024 * 1024 or hashlib.sha256(raw).hexdigest() != result["image"].get("sha256"):
        raise APIError("image_changed", "The saved image changed after verification.", 409)
    return web.Response(body=raw, content_type="image/png")


async def search(request):
    runtime = request.app[STATE]
    runtime.limit(("search", request["device_id"]), 15)
    data = await body(request, ("query",))
    return web.json_response(await runtime.services.search(data["query"]))


async def start_desktop(request):
    runtime = request.app[STATE]
    await body(request, ())
    if not runtime.desktop_enabled:
        raise APIError("desktop_disabled", "Enable desktop control in the Windows companion first.", 403)
    runtime.limit(("desktop_start", request["device_id"]), 10)
    await asyncio.to_thread(runtime.desktop.info)
    runtime.store.authenticate(request.headers.get("Authorization", ""))
    if runtime.stopping or not runtime.desktop_enabled:
        raise APIError("desktop_disabled", "Desktop control is unavailable.", 403)
    if runtime.lease and runtime.lease["expires_at"] > time.time() and runtime.lease["owner"] != request["device_id"]:
        raise APIError("desktop_busy", "Another paired device is controlling this desktop.", 409)
    runtime.lease = {"owner": request["device_id"], "session_id": secrets.token_urlsafe(32), "expires_at": time.time() + 600}
    print("Remote desktop session started (expires after 10 minutes).", flush=True)
    return web.json_response({k: v for k, v in runtime.lease.items() if k != "owner"})


async def frame(request):
    runtime = request.app[STATE]
    runtime.require_lease(request)
    runtime.limit(("frame", request["device_id"]), 240)
    if runtime.desktop_lock.locked():
        raise APIError("desktop_busy", "A desktop operation is in progress.", 429)
    async with runtime.desktop_lock:
        runtime.require_lease(request)
        raw = await asyncio.to_thread(runtime.desktop.capture)
        runtime.require_lease(request)
    return web.Response(body=raw, content_type="image/jpeg")


async def desktop_input(request):
    runtime = request.app[STATE]
    runtime.require_lease(request)
    runtime.limit(("input", request["device_id"]), 1200)
    data = await body(request, ("action",), ("x", "y", "button", "dy", "key", "text"))
    async with runtime.desktop_lock:
        runtime.require_lease(request)
        result = await asyncio.to_thread(runtime.desktop.input, data)
    return web.json_response(result)


async def end_desktop(request):
    runtime = request.app[STATE]
    runtime.require_lease(request)
    runtime.lease = None
    print("Remote desktop session ended.", flush=True)
    return web.json_response({"ok": True})


# The phone's way into Mohassan. Each call is the paired device's, checked by the
# middleware; Mohassan checks the gateway key and runs the chat itself.
MOHASSAN_FIELDS = {
    "create": ({"goal"}, set()),
    "messages": ({"text"}, {"text"}),
    "respond": ({"questionId", "optionId", "text"}, {"questionId"}),
    "approve": ({"approvalId", "approved"}, {"approvalId", "approved"}),
    "cancel": (set(), set()),
}


async def mohassan_body(request, kind):
    allowed, required = MOHASSAN_FIELDS[kind]
    if not request.can_read_body:
        data = {}
    else:
        if request.content_type != "application/json":
            raise APIError("invalid_content_type", "Use application/json.", 415)
        try:
            data = await request.json()
        except (ValueError, UnicodeError):
            raise APIError("invalid_json", "The request is not valid JSON.")
    if not isinstance(data, dict) or set(data) - allowed or required - set(data):
        raise APIError("invalid_request", "The request has missing or unsupported fields.")
    return data


def mohassan_gpu_free(runtime):
    # Mohassan's model and Wasla's images share one 4 GB GPU.
    if runtime.services.busy or any(job["status"] in ("queued", "running") for job in runtime.jobs.values()):
        raise APIError("gpu_busy", "الكمبيوتر ينشئ صورة الآن. انتظر حتى ينتهي ثم أعد المحاولة.", 409)


async def mohassan_status(request):
    return web.json_response(await request.app[STATE].mohassan.status())


async def mohassan_conversations(request):
    runtime = request.app[STATE]
    runtime.limit(("mohassan", request["device_id"]), 240)
    if request.method == "GET":
        return web.json_response(await runtime.mohassan.conversations())
    data = await mohassan_body(request, "create")
    if "goal" in data:
        mohassan_gpu_free(runtime)
        runtime.limit(("mohassan-start", request["device_id"]), 20)
    return web.json_response(await runtime.mohassan.create(data))


async def mohassan_conversation(request):
    runtime = request.app[STATE]
    runtime.limit(("mohassan", request["device_id"]), 240)
    cid = request.match_info["id"]
    if request.method == "DELETE":
        return web.json_response(await runtime.mohassan.remove(cid))
    return web.json_response(await runtime.mohassan.detail(cid))


async def mohassan_events(request):
    runtime = request.app[STATE]
    runtime.limit(("mohassan", request["device_id"]), 240)
    after = request.match_info["after"]
    if not after.isdigit() or len(after) > 6:
        raise APIError("invalid_request", "رقم الحدث غير صالح.")
    return web.json_response(await runtime.mohassan.events(request.match_info["id"], int(after)))


async def mohassan_action(request):
    runtime = request.app[STATE]
    action = request.match_info["action"]
    if action not in MOHASSAN_FIELDS or action == "create":
        raise APIError("not_found", "هذا الإجراء غير متاح عبر وصلة.", 404)
    runtime.limit(("mohassan", request["device_id"]), 240)
    data = await mohassan_body(request, action)
    if action != "cancel":
        mohassan_gpu_free(runtime)
        runtime.limit(("mohassan-start", request["device_id"]), 20)
    return web.json_response(await runtime.mohassan.act(request.match_info["id"], action, data))


async def startup(app):
    runtime = app[STATE]
    for job in runtime.jobs.values():
        if job["status"] in ("queued", "running"):
            try:
                result = await runtime.services.image_status(job["request_id"])
                job["status"] = "completed" if result.get("status") in ("succeeded", "completed") else "failed"
                if job["status"] == "failed":
                    job["error"] = result.get("error", "The previous service stopped. This request is not retried automatically.")
            except Exception:
                job["status"] = "failed"
                job["error"] = "Previous request could not be recovered. It will not restart automatically."
    runtime.save_jobs()


async def cleanup(app):
    runtime = app[STATE]
    runtime.stopping = True
    runtime.actions.allowed = False
    runtime.lease = None
    if runtime.workers:
        await asyncio.gather(*runtime.workers, return_exceptions=True)
    await runtime.mohassan.close()
    await runtime.services.close()


def create_app(store: AuthStore, services, desktop, desktop_enabled=False, *, actions=None, knowledge=None, intelligence=None, cloud=None, mohassan=None):
    app = web.Application(middlewares=[protections], client_max_size=64 * 1024)
    app[STATE] = Runtime(store, services, desktop, desktop_enabled, actions, knowledge, intelligence, cloud, mohassan)
    app.add_routes([
        web.post('/v1/pair', pair), web.get('/v1/status', status), web.delete('/v1/session', revoke),
        web.post('/v1/chat', chat), web.post('/v1/images/prepare', prepare_image),
        web.get('/v1/knowledge', knowledge_handler), web.post('/v1/knowledge', knowledge_handler), web.delete('/v1/knowledge/{id}', knowledge_handler),
        web.get('/v1/conversations', conversations), web.get('/v1/conversations/{id}', conversations), web.delete('/v1/conversations/{id}', conversations),
        web.get('/v1/settings', settings), web.patch('/v1/settings', settings), web.get('/v1/metrics', metrics),
        web.post('/v1/images', create_image), web.get('/v1/images/{request_id}/content', image_content),
        web.get('/v1/images/{request_id}', get_image), web.post('/v1/search', search),
        web.post('/v1/desktop/session', start_desktop), web.delete('/v1/desktop/session', end_desktop),
        web.get('/v1/desktop/frame', frame), web.post('/v1/desktop/input', desktop_input),
        web.get('/v1/mohassan/status', mohassan_status),
        web.get('/v1/mohassan/conversations', mohassan_conversations), web.post('/v1/mohassan/conversations', mohassan_conversations),
        web.get('/v1/mohassan/conversations/{id}', mohassan_conversation), web.delete('/v1/mohassan/conversations/{id}', mohassan_conversation),
        web.get('/v1/mohassan/conversations/{id}/events/{after}', mohassan_events),
        web.post('/v1/mohassan/conversations/{id}/{action}', mohassan_action),
    ])
    app.on_startup.append(startup)
    app.on_cleanup.append(cleanup)
    return app
