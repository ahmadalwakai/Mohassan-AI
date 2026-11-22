"""A stand-in for Mohassan's Wasla gateway (apps/server/src/wasla.ts), for phone testing.

The real Wasla service on the computer forwards /v1/mohassan/* to this server over
127.0.0.1 exactly as it would to Mohassan, so the phone's whole path is real except the
brain. The brain here is a script: it answers after a few seconds, and certain words
in the goal make it stop and ask, as the real brain does.

    "حملة"   -> several questions in one card (fields with suggestions), plus «توقف هنا»
    "اختر"   -> one question with options, a clarification and a typed answer allowed
    "نفّذ"   -> an approval before acting
    "دخول"   -> a sign-in step that only the web can complete
    anything else -> steps, progress and a plain answer

Response shapes follow packages/contracts/src/command-chat.ts and the gateway's phone
field list. Run on the same computer as the Wasla service:

    python apps/android/Tools/fake_mohassan_gateway.py --port 4000

then pair the service to it with a 16-character code (any is accepted here):

    python -m wasla.mohassan pair ABCDEFGHIJKLMNOP --url http://127.0.0.1:4000 --state <state folder>
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import secrets
import uuid

from aiohttp import web

BASE = "/api/wasla/gateway"
GATEWAYS: dict[str, str] = {}
CONVERSATIONS: dict[str, dict] = {}
TASKS: set[asyncio.Task] = set()
THINK_SECONDS = 3.0


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def fault(status: int, code: str, message: str) -> web.Response:
    return web.json_response({"error": {"code": code, "message": message}}, status=status)


def authorized(request: web.Request) -> bool:
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return False
    gateway_id, _, key = header[7:].partition(".")
    return GATEWAYS.get(gateway_id) == key


def message(role: str, text: str) -> dict:
    return {"id": str(uuid.uuid4()), "role": role, "text": text, "createdAt": now()}


def step(text: str) -> dict:
    return {"id": str(uuid.uuid4()), "text": text, "createdAt": now()}


def new_conversation(goal: str) -> dict:
    conversation = {
        "id": str(uuid.uuid4()), "title": goal[:60], "status": "running", "updatedAt": now(),
        "messages": [message("user", goal)], "question": None, "approval": None, "secure": None,
        "progress": "أقرأ طلبك…", "steps": [], "error": None, "configured": True,
        # Never reaches the phone through the real gateway; here it proves the shape is tolerated.
        "browser": None,
    }
    CONVERSATIONS[conversation["id"]] = conversation
    return conversation


def phone_view(conversation: dict) -> dict:
    keys = ("id", "title", "status", "updatedAt", "messages", "question", "approval", "secure", "progress", "steps", "error", "configured")
    return {key: conversation[key] for key in keys}


def summary(conversation: dict) -> dict:
    return {"id": conversation["id"], "title": conversation["title"], "status": conversation["status"], "updatedAt": conversation["updatedAt"], "browserAccount": None}


def pause(conversation: dict, status: str, **fields) -> None:
    conversation.update(status=status, progress=None, updatedAt=now(), **fields)


def finish(conversation: dict, text: str, status: str = "idle") -> None:
    conversation["messages"].append(message("assistant", text))
    conversation.update(status=status, progress=None, question=None, approval=None, secure=None, updatedAt=now())


async def think(conversation: dict, goal: str) -> None:
    """The scripted brain: a few steps, then an answer or a pause."""
    try:
        for text in ("أفهم الطلب.", "أراجع ما أعرفه.", "أجهّز الرد."):
            await asyncio.sleep(THINK_SECONDS / 3)
            if conversation["status"] != "running":
                return
            conversation["steps"].append(step(text))
            conversation["progress"] = text
            conversation["updatedAt"] = now()
        if "حملة" in goal:
            pause(conversation, "waiting_user", question={
                "id": str(uuid.uuid4()),
                "prompt": "قبل أن أخطط الحملة أحتاج ثلاث إجابات:\nما هدف الحملة؟\nأين تريد الظهور؟\nما الميزانية اليومية؟",
                "options": [{"id": "stop", "label": "توقف هنا"}],
                "fields": [
                    {"id": "goal", "prompt": "ما هدف الحملة؟", "suggestions": [
                        {"label": "مكالمات هاتفية", "reason": "موقعك فيه رقم هاتف قابل للنقر"},
                        {"label": "زيارات للموقع"}, {"label": "رسائل واتساب", "reason": "زر واتساب في أسفل الصفحة"}], "selected": [0]},
                    {"id": "places", "prompt": "أين تريد الظهور؟", "suggestions": [{"label": "الرياض"}, {"label": "جدة"}, {"label": "الدمام"}], "multiple": True},
                    {"id": "budget", "prompt": "ما الميزانية اليومية بالريال؟", "suggestions": [], "placeholder": "مثال: 50"},
                ],
            })
        elif "اختر" in goal:
            pause(conversation, "waiting_user", question={
                "id": str(uuid.uuid4()), "prompt": "وجدت حسابين إعلانيين. أيهما أستخدم؟",
                "options": [{"id": "first", "label": "الحساب الأول (123-456-7890)"}, {"id": "second", "label": "الحساب الثاني (987-654-3210)"}, {"id": "connect", "label": "ربط حساب آخر"}],
                "action": "google_ads_connect",
                "clarification": {"reason": "الحساب الأول هو الذي استُخدم آخر مرة.", "recommendedOptionId": "first", "allowText": True},
            })
        elif "نفّذ" in goal or "نفذ" in goal:
            pause(conversation, "waiting_approval", approval={
                "id": str(uuid.uuid4()), "prompt": "سأنشئ حملة متوقفة باسم «تجربة الهاتف» بميزانية 50 ر.س يوميًا.",
                "detail": "الحملة تُنشأ بحالة PAUSED ولا تُنفق شيئًا حتى تفعّلها بنفسك.",
            })
        elif "دخول" in goal:
            pause(conversation, "waiting_input", secure={
                "id": str(uuid.uuid4()), "kind": "login", "site": "ads.google.com", "prompt": "الموقع يطلب تسجيل الدخول قبل المتابعة.", "note": None,
                "fields": [{"id": "username", "label": "البريد", "type": "text"}, {"id": "password", "label": "كلمة المرور", "type": "password"}],
            })
        else:
            finish(conversation, f"هذا رد تجريبي من بوابة موحسن الوهمية على طلبك: «{goal.strip()}».\n\nالمسار حقيقي حتى هنا: الهاتف ← خدمة Wasla ← هذه البوابة على 127.0.0.1.")
    except asyncio.CancelledError:
        pass


def run_brain(conversation: dict, goal: str) -> None:
    task = asyncio.create_task(think(conversation, goal))
    TASKS.add(task)
    task.add_done_callback(TASKS.discard)


def resume(conversation: dict, note: str, final: str) -> None:
    conversation.update(status="running", question=None, approval=None, secure=None, progress=note, updatedAt=now())
    conversation["steps"].append(step(note))

    async def later():
        await asyncio.sleep(THINK_SECONDS / 2)
        if conversation["status"] == "running":
            finish(conversation, final)
    task = asyncio.create_task(later())
    TASKS.add(task)
    task.add_done_callback(TASKS.discard)


# --- routes -----------------------------------------------------------------

async def pair(request: web.Request) -> web.Response:
    data = await request.json()
    code = data.get("code", "")
    if not isinstance(code, str) or len(code) != 16:
        return fault(401, "WASLA_PAIRING_INVALID", "رمز ربط وصلة غير صالح أو انتهت مدته.")
    gateway_id, key = str(uuid.uuid4()), secrets.token_urlsafe(32)
    GATEWAYS[gateway_id] = key
    print(f"paired gateway {gateway_id} ({data.get('name')})", flush=True)
    return web.json_response({"gatewayId": gateway_id, "gatewayKey": f"{gateway_id}.{key}"})


@web.middleware
async def guard(request: web.Request, handler):
    if request.path != BASE + "/pair" and not authorized(request):
        return fault(401, "WASLA_GATEWAY_UNAUTHORIZED", "مفتاح وصلة غير صالح.")
    return await handler(request)


async def status(request: web.Request) -> web.Response:
    return web.json_response({"ok": True, "bridge": "mohassan"})


async def conversations(request: web.Request) -> web.Response:
    if request.method == "GET":
        ordered = sorted(CONVERSATIONS.values(), key=lambda item: item["updatedAt"], reverse=True)
        return web.json_response({"conversations": [summary(item) for item in ordered]})
    data = await request.json() if request.can_read_body else {}
    goal = data.get("goal")
    if not isinstance(goal, str) or not goal.strip():
        return fault(400, "VALIDATION", "goal is required")
    conversation = new_conversation(goal)
    run_brain(conversation, goal)
    return web.json_response(phone_view(conversation))


def find(request: web.Request) -> dict | None:
    return CONVERSATIONS.get(request.match_info["id"])


async def detail(request: web.Request) -> web.Response:
    conversation = find(request)
    if conversation is None:
        return fault(404, "CHAT_NOT_FOUND", "المحادثة غير موجودة.")
    if request.method == "DELETE":
        del CONVERSATIONS[conversation["id"]]
        return web.json_response({"ok": True})
    return web.json_response(phone_view(conversation))


async def events(request: web.Request) -> web.Response:
    if find(request) is None:
        return fault(404, "CHAT_NOT_FOUND", "المحادثة غير موجودة.")
    return web.json_response({"events": [], "cursor": int(request.query.get("after", 0))})


async def messages(request: web.Request) -> web.Response:
    conversation = find(request)
    if conversation is None:
        return fault(404, "CHAT_NOT_FOUND", "المحادثة غير موجودة.")
    data = await request.json()
    text = str(data.get("text", "")).strip()
    if not text:
        return fault(400, "VALIDATION", "text is required")
    conversation["messages"].append(message("user", text))
    if conversation["status"] == "waiting_user":
        resume(conversation, "سُجلت إجابتك.", f"شكرًا. قرأت إجابتك بالترتيب الذي سألت به:\n{text}\n\nسأكمل على هذا الأساس.")
    elif conversation["status"] == "running":
        return fault(409, "CHAT_BUSY", "موحسن يعمل الآن؛ انتظر حتى ينتهي.")
    else:
        conversation["status"] = "running"
        run_brain(conversation, text)
    return web.json_response(phone_view(conversation))


async def respond(request: web.Request) -> web.Response:
    conversation = find(request)
    if conversation is None:
        return fault(404, "CHAT_NOT_FOUND", "المحادثة غير موجودة.")
    data = await request.json()
    question = conversation.get("question")
    if conversation["status"] != "waiting_user" or not question or data.get("questionId") != question["id"]:
        return fault(409, "CHAT_QUESTION_CHANGED", "هذا السؤال لم يعد معلقًا.")
    option_id, text = data.get("optionId"), data.get("text")
    if option_id == "stop":
        conversation.update(status="cancelled", question=None, progress=None, updatedAt=now())
        conversation["messages"].append(message("assistant", "توقفت هنا كما طلبت."))
    elif option_id:
        option = next((item for item in question["options"] if item["id"] == option_id), None)
        if option is None:
            return fault(409, "CHAT_QUESTION_CHANGED", "هذا السؤال لم يعد معلقًا.")
        conversation["messages"].append(message("user", option["label"]))
        resume(conversation, f"اخترت: {option['label']}.", f"حسنًا، سأستخدم «{option['label']}».")
    elif isinstance(text, str) and text.strip():
        conversation["messages"].append(message("user", text.strip()))
        resume(conversation, "سُجلت إجابتك.", f"حسنًا، سجلت إجابتك: «{text.strip()}».")
    else:
        return fault(400, "VALIDATION", "optionId or text is required")
    return web.json_response(phone_view(conversation))


async def approve(request: web.Request) -> web.Response:
    conversation = find(request)
    if conversation is None:
        return fault(404, "CHAT_NOT_FOUND", "المحادثة غير موجودة.")
    data = await request.json()
    approval = conversation.get("approval")
    if conversation["status"] != "waiting_approval" or not approval or data.get("approvalId") != approval["id"]:
        return fault(409, "CHAT_APPROVAL_CHANGED", "طلب الموافقة لم يعد معلقًا.")
    if data.get("approved") is True:
        resume(conversation, "وافقت؛ أنفّذ الآن.", "نُفّذ الإجراء: أُنشئت الحملة «تجربة الهاتف» بحالة متوقفة (PAUSED).")
    else:
        conversation.update(status="idle", approval=None, progress=None, updatedAt=now())
        conversation["messages"].append(message("assistant", "لم أنفّذ شيئًا؛ أُلغي الإجراء بناءً على رفضك."))
    return web.json_response(phone_view(conversation))


async def cancel(request: web.Request) -> web.Response:
    conversation = find(request)
    if conversation is None:
        return fault(404, "CHAT_NOT_FOUND", "المحادثة غير موجودة.")
    conversation.update(status="cancelled", question=None, approval=None, secure=None, progress=None, updatedAt=now())
    conversation["messages"].append(message("assistant", "أُوقفت المهمة."))
    return web.json_response(phone_view(conversation))


def create_app() -> web.Application:
    app = web.Application(middlewares=[guard])
    chat = BASE + "/conversations"
    app.add_routes([
        web.post(BASE + "/pair", pair), web.get(BASE + "/status", status),
        web.get(chat, conversations), web.post(chat, conversations),
        web.get(chat + "/{id}", detail), web.delete(chat + "/{id}", detail),
        web.get(chat + "/{id}/campaign-events", events),
        web.post(chat + "/{id}/messages", messages), web.post(chat + "/{id}/respond", respond),
        web.post(chat + "/{id}/approve", approve), web.post(chat + "/{id}/cancel", cancel),
    ])
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Fake Mohassan gateway for phone tests")
    parser.add_argument("--port", type=int, default=4000)
    args = parser.parse_args()
    print(f"fake Mohassan gateway on http://127.0.0.1:{args.port}{BASE}", flush=True)
    web.run_app(create_app(), host="127.0.0.1", port=args.port, print=None)


if __name__ == "__main__":
    main()
