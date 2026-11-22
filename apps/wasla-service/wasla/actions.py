"""Explicit, small application actions; never execute model or retrieved text.

The caller must authenticate the device and pass only the latest direct user
message to plan(). Plans are typed values, not model tool calls. Successful
execution means Windows accepted a launch request; no UI outcome is claimed.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import queue
import re
import socket
import subprocess
import threading
import unicodedata
from urllib.parse import unquote, urlsplit, urlunsplit
import uuid

from .security import atomic_json, read_json, state_lock


class ActionError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


@dataclass(frozen=True)
class ActionPlan:
    action: str
    target: str | None = None


APPS = frozenset({'browser', 'notepad', 'calculator'})
DEFAULT_BROWSER_URL = 'https://www.bing.com/'
MAX_RECEIPTS = 2048
_DNS_SLOTS = threading.BoundedSemaphore(2)
_QUOTES = frozenset('"\'`«»“”‘’')
_IMPERATIVE = re.compile(r'^(?:open|launch|run|start|delete|remove|close|kill|install|download|execute|'
                         r'افتح|شغل|شغّل|احذف|امسح|اغلق|أغلق|اقتل|ثبت|ثبّت|نزّل|نفذ|نفّذ)(?:\s|$)', re.IGNORECASE)
_APP_NAMES = {
    'browser': 'browser', 'the browser': 'browser', 'web browser': 'browser', 'المتصفح': 'browser', 'متصفح': 'browser',
    'notepad': 'notepad', 'the notepad': 'notepad', 'المفكرة': 'notepad', 'مفكرة': 'notepad',
    'calculator': 'calculator', 'the calculator': 'calculator', 'الآلة الحاسبة': 'calculator',
    'الاله الحاسبه': 'calculator', 'الحاسبة': 'calculator', 'الحاسبه': 'calculator',
}


def validate_url(value: str) -> str:
    """Lexical URL validation only. Public DNS is checked just before opening."""
    if type(value) is not str or not 1 <= len(value) <= 2048:
        raise ActionError('unsafe_url', 'استخدم رابط HTTPS عامًا وصحيحًا.')
    if any(ord(char) < 33 or ord(char) == 127 or char in '\\"\'`' for char in value):
        raise ActionError('unsafe_url', 'الرابط يحتوي محارف غير مسموحة.')
    if any(ord(char) < 32 or ord(char) == 127 for char in unquote(value)):
        raise ActionError('unsafe_url', 'الرابط يحتوي محارف تحكم مخفية.')
    try:
        parts = urlsplit(value)
        host = parts.hostname
        if (parts.scheme.lower() != 'https' or not host or parts.username is not None
                or parts.password is not None or '%' in parts.netloc or parts.port not in (None, 443)):
            raise ValueError()
        host = host.rstrip('.').encode('idna').decode('ascii').lower()
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            if ('.' not in host or host.endswith(('.localhost', '.local', '.lan', '.internal', '.home', '.test', '.invalid', '.onion'))
                    or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in host.split('.'))):
                raise ValueError()
            authority = host
        else:
            if not address.is_global:
                raise ValueError()
            authority = f'[{address.compressed}]' if address.version == 6 else address.compressed
        return urlunsplit(('https', authority, parts.path or '/', parts.query, parts.fragment))
    except (ValueError, UnicodeError):
        raise ActionError('unsafe_url', 'يمكن فتح روابط HTTPS العامة فقط، دون عنوان محلي أو بيانات دخول.') from None


def _resolve_addresses(host: str) -> list[str]:
    """Bound DNS waits without leaving a non-daemon worker blocking shutdown."""
    if not _DNS_SLOTS.acquire(blocking=False):
        raise ActionError('url_resolution_busy', 'التحقق من الرابط مشغول؛ حاول لاحقًا.', 503)
    results = queue.Queue(maxsize=1)
    def resolve():
        try:
            results.put((True, [entry[4][0] for entry in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)]))
        except Exception:
            results.put((False, None))
        finally:
            _DNS_SLOTS.release()
    threading.Thread(target=resolve, daemon=True).start()
    try:
        success, addresses = results.get(timeout=3)
    except queue.Empty:
        raise ActionError('url_resolution_failed', 'تعذر التحقق من عنوان الرابط؛ لم يُفتح.', 503) from None
    if not success:
        raise ActionError('url_resolution_failed', 'تعذر التحقق من عنوان الرابط؛ لم يُفتح.', 503)
    return addresses


def _assert_public_host(url: str, resolver):
    host = urlsplit(url).hostname
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        addresses = resolver(host)
    else:
        addresses = [str(literal)]
    try:
        if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
            raise ValueError()
    except (ValueError, TypeError):
        raise ActionError('unsafe_url', 'الرابط يشير إلى شبكة محلية أو عنوان غير عام؛ لم يُفتح.') from None


def _assert_interactive():
    # Reuse the existing locked/secure/noninteractive desktop checks, without
    # taking screenshots or sending any mouse/keyboard events.
    from .desktop import WindowsDesktop
    WindowsDesktop().info()


def _launch_windows(plan: ActionPlan):
    if os.name != 'nt':
        raise OSError('Windows is required')
    if plan.action == 'open_url':
        os.startfile(plan.target, 'open')
    elif plan.action == 'open_browser' or plan.target == 'browser':
        os.startfile(DEFAULT_BROWSER_URL, 'open')
    else:
        import win32api
        system = Path(win32api.GetSystemDirectory()).resolve()
        executable = system / {'notepad': 'notepad.exe', 'calculator': 'calc.exe'}[plan.target]
        if not executable.is_file():
            raise FileNotFoundError('The Windows application is unavailable')
        subprocess.Popen([str(executable)], shell=False, cwd=str(system), stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)


def _validated_plan(plan):
    if type(plan) is not ActionPlan:
        raise ActionError('invalid_action', 'طلب تشغيل غير صالح.')
    if plan.action == 'open_browser' and plan.target is None:
        return plan
    if plan.action == 'open_app' and type(plan.target) is str and plan.target in APPS:
        return plan
    if plan.action == 'open_url':
        return ActionPlan('open_url', validate_url(plan.target))
    raise ActionError('unsupported_action', 'المتاح حاليًا فتح المتصفح أو المفكرة أو الآلة الحاسبة أو رابط HTTPS عام.')


class ActionsController:
    def __init__(self, allowed=False, state_root=None, *, launcher=None, session_guard=None, resolver=None):
        self.allowed = allowed is True
        self.root = Path(state_root) if state_root is not None else None
        self._launcher = launcher or _launch_windows
        self._session_guard = session_guard or _assert_interactive
        self._resolver = resolver or _resolve_addresses
        self._lock = threading.Lock()

    def plan(self, text: str) -> ActionPlan | None:
        if type(text) is not str or not text.strip() or len(text) > 4096:
            return None
        text = unicodedata.normalize('NFKC', text.strip())
        # Quoted/code text and questions are discussion, never execution input.
        if any(char in _QUOTES for char in text) or text.endswith(('?', '؟')):
            return None
        if any(ord(char) < 32 or unicodedata.category(char) == 'Cf' for char in text):
            return None
        text = re.sub(r'\s+', ' ', text)
        text = re.sub(r'^(?:please|من فضلك|لو سمحت)\s+', '', text, flags=re.IGNORECASE)
        text = re.sub(r'\s+(?:please|من فضلك|لو سمحت)$', '', text, flags=re.IGNORECASE)
        app_text = text.rstrip('.!').strip()
        match = re.fullmatch(r'(?:open|launch|افتح)\s+(?:(?:app|تطبيق|برنامج)\s+)?(.+)', app_text, re.IGNORECASE)
        if match:
            app = _APP_NAMES.get(match[1].casefold())
            if app:
                return ActionPlan('open_browser') if app == 'browser' else ActionPlan('open_app', app)
        match = re.fullmatch(r'(?:open\s+(?:(?:url|link)\s+)?|افتح\s+(?:(?:الرابط|الموقع)\s+)?)(https://\S+)', text, re.IGNORECASE)
        if match:
            return ActionPlan('open_url', validate_url(match[1]))
        if _IMPERATIVE.match(text):
            raise ActionError('unsupported_action', 'يمكنني فتح المتصفح أو المفكرة أو الآلة الحاسبة أو رابط HTTPS عام فقط. اكتب أمرًا واحدًا واضحًا.')
        return None

    @staticmethod
    def _result(record, request_id, replayed):
        messages = {
            'completed': 'أُرسل طلب الفتح إلى Windows. لم أتحقق من ظهور النافذة أو اكتمال تحميلها.',
            'pending': 'نتيجة طلب الفتح السابق غير مؤكدة. لم أكرره حتى لا يُنفّذ مرتين.',
            'failed': 'تعذر تأكيد فتح التطبيق. لم أعد تنفيذ الطلب نفسه.',
        }
        statuses = {'completed': 'launch_requested', 'pending': 'outcome_unknown', 'failed': 'launch_failed'}
        return {'action': record['action'], 'status': statuses[record['state']], 'message': messages[record['state']],
                'request_id': request_id, 'replayed': replayed, 'ui_verified': False}

    def execute(self, plan, *, device_id, request_id=None):
        plan = _validated_plan(plan)
        if not request_id:
            raise ActionError('request_id_required', 'حدّث تطبيق وصلة لتنفيذ الأوامر بأمان؛ هذه النسخة لا ترسل معرّف طلب.', 409)
        try:
            if type(request_id) is not str or str(uuid.UUID(request_id)) != request_id.lower():
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise ActionError('invalid_request_id', 'معرّف طلب التشغيل غير صالح.') from None
        if type(device_id) is not str or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', device_id):
            raise ActionError('invalid_device', 'يجب اقتران الهاتف قبل تنفيذ أمر.', 401)
        if self.allowed is not True:
            raise ActionError('actions_disabled', 'فعّل «السماح بفتح التطبيقات من المحادثة» في لوحة Windows ثم أعد تشغيل وصلة.', 403)
        if self.root is None or not self.root.is_dir():
            raise ActionError('actions_unavailable', 'سجل أوامر الكمبيوتر غير متاح؛ لم يُنفّذ الطلب.', 503)
        request_id = request_id.lower()
        key = hashlib.sha256((device_id + '\0' + request_id).encode()).hexdigest()
        digest = hashlib.sha256(json.dumps([plan.action, plan.target], ensure_ascii=True).encode()).hexdigest()
        with self._lock, state_lock(self.root):
            try:
                journal = read_json(self.root / 'actions.json', {})
            except (OSError, ValueError):
                raise ActionError('actions_unavailable', 'تعذر قراءة سجل الأوامر؛ لم يُنفّذ الطلب.', 503) from None
            if type(journal) is not dict or any(type(value) is not dict for value in journal.values()):
                raise ActionError('actions_unavailable', 'سجل أوامر الكمبيوتر غير صالح؛ لم يُنفّذ الطلب.', 503)
            existing = journal.get(key)
            if existing is not None:
                if existing.get('plan_sha256') != digest or existing.get('device_id') != device_id or existing.get('request_id') != request_id:
                    raise ActionError('request_id_conflict', 'استُخدم معرّف الطلب لأمر مختلف؛ أرسل طلبًا جديدًا.', 409)
                if existing.get('state') not in ('pending', 'completed', 'failed') or existing.get('action') != plan.action:
                    raise ActionError('actions_unavailable', 'حالة الطلب السابق غير صالحة؛ لم أكرر التنفيذ.', 503)
                return self._result(existing, request_id, True)
            if len(journal) >= MAX_RECEIPTS:
                raise ActionError('actions_journal_full', 'سجل أوامر الكمبيوتر ممتلئ؛ لم يُنفّذ طلب جديد.', 503)
            try:
                self._session_guard()
            except Exception:
                raise ActionError('desktop_unavailable', 'افتح قفل Windows وأغلق نوافذ الأمان قبل فتح التطبيقات.', 403) from None
            if plan.action == 'open_url':
                _assert_public_host(plan.target, self._resolver)
                try:
                    self._session_guard()
                except Exception:
                    raise ActionError('desktop_unavailable', 'افتح قفل Windows قبل فتح الرابط.', 403) from None
            # Permission may be revoked while a DNS/session check is pending.
            if self.allowed is not True:
                raise ActionError('actions_disabled', 'إذن فتح التطبيقات مغلق؛ لم يُنفّذ الطلب.', 403)
            record = {'device_id': device_id, 'request_id': request_id, 'action': plan.action,
                      'plan_sha256': digest, 'state': 'pending'}
            journal[key] = record
            # Persist intent before launch. A crash leaves an unknown outcome;
            # the same request is never replayed, including after restart.
            try:
                atomic_json(self.root / 'actions.json', journal)
            except OSError:
                raise ActionError('actions_unavailable', 'تعذر حفظ الطلب بأمان؛ لم يُنفّذ.', 503) from None
            launch_error = None
            try:
                if self.allowed is not True:
                    raise ActionError('actions_disabled', 'إذن فتح التطبيقات مغلق؛ لم يُنفّذ الطلب.', 403)
                try:
                    self._session_guard()
                except Exception:
                    raise ActionError('desktop_unavailable', 'افتح قفل Windows قبل فتح التطبيق.', 403) from None
                self._launcher(plan)
            except ActionError as error:
                launch_error = error
                record['state'] = 'failed'
            except Exception:
                record['state'] = 'failed'
            else:
                record['state'] = 'completed'
            try:
                atomic_json(self.root / 'actions.json', journal)
            except OSError:
                # The pending receipt on disk still prevents a duplicate.
                record['state'] = 'pending'
            if launch_error is not None:
                raise launch_error
            return self._result(record, request_id, False)
