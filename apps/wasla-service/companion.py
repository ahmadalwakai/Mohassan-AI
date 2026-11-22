"""Visible local controls for the Windows companion; no unattended startup.

The service runs only as this window's owned child. Closing its stdin also asks
the service to revoke the desktop lease and finish owned work before exiting.
Runtime credentials are kept outside outputs, in the private task state folder.
"""
from __future__ import annotations

from datetime import datetime
from dataclasses import dataclass
import ipaddress
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import messagebox, ttk

from wasla.security import AuthStore, PAIRING_LIFETIME, ensure_certificate, local_addresses


WINDOWS_ROOT = Path(__file__).resolve().parent
from wasla.paths import STATE_DIR as STATE_ROOT
PYTHON = Path(r"C:\Users\Administrator\Documents\Codex\2026-11-01\local-browser-agent\work\local-image-engine\venv\Scripts\python.exe")
TAILNET = ipaddress.ip_network("100.64.0.0/10")
BASE_PYTHON = (Path(sys.base_prefix) / "python.exe").resolve()


@dataclass(frozen=True)
class BackendIdentity:
    pid: int
    created_at: float


def verified_backend_identity(launcher_pid, launcher_created, reported_pid, command,
                              base_python, process_factory=None):
    """Recognize only the owned launcher or its exact interpreter child.

    Windows venv redirectors create a direct base-python child, so the ready
    PID is not always Popen.pid. Check lineage, executable identity, creation
    time and the complete expected CLI (including private state/host/port).
    No arbitrary descendant or PID from a status file is trusted.
    """
    if type(launcher_pid) is not int or type(reported_pid) is not int or reported_pid <= 0:
        return None
    if not command or not launcher_created:
        return None
    if process_factory is None:
        import psutil
        process_factory = psutil.Process
    def canonical(value):
        return os.path.normcase(os.path.realpath(value))
    allowed_executables = {canonical(command[0]), canonical(str(base_python))}
    expected_arguments = command[1:]
    try:
        launcher = process_factory(launcher_pid)
        if not launcher.is_running() or launcher.create_time() != launcher_created:
            return None
        if canonical(launcher.exe()) not in allowed_executables:
            return None
        launcher_command = launcher.cmdline()
        if not launcher_command or launcher_command[1:] != expected_arguments:
            return None
        backend = launcher if reported_pid == launcher_pid else process_factory(reported_pid)
        if not backend.is_running() or backend.create_time() < launcher_created:
            return None
        if reported_pid != launcher_pid and backend.ppid() != launcher_pid:
            return None
        if canonical(backend.exe()) not in allowed_executables:
            return None
        actual = backend.cmdline()
        if not actual or canonical(actual[0]) not in allowed_executables or actual[1:] != expected_arguments:
            return None
        return BackendIdentity(reported_pid, backend.create_time())
    except Exception:
        # Process disappearance or access denial is an unverified identity.
        return None


def read_status():
    try:
        value = json.loads((STATE_ROOT / "server-status.json").read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def ordered_addresses():
    values = list(dict.fromkeys(local_addresses()))
    return sorted(values, key=lambda address: (
        ipaddress.ip_address(address) not in TAILNET,
        ipaddress.ip_address(address).is_loopback,
        address,
    ))


class Companion:
    def __init__(self, window: tk.Tk):
        self.window = window
        self.store = None
        self.process: subprocess.Popen | None = None
        self.backend_identity: BackendIdentity | None = None
        self.launcher_created = 0.0
        self.command: list[str] = []
        self.ready = False
        self.stopping = False
        self.close_when_stopped = False
        self.identity_pending = False
        self.devices_pending = False
        self.pairing_pending = False
        self.next_device_check = 0.0
        self.pairing_expires = 0.0
        self.current_pairing = ""
        self.current_clipboard = ""
        self.clipboard_expires = 0.0
        self.started_at = 0.0
        self.addresses: list[str] = []
        self.jobs = queue.SimpleQueue()
        self.status = tk.StringVar(value="جارٍ تجهيز لوحة وصلة…")
        self.host = tk.StringVar()
        self.port = tk.StringVar(value="47621")
        self.desktop = tk.BooleanVar(value=False)
        self.app_actions = tk.BooleanVar(value=False)
        self.uri = tk.StringVar()
        self.fingerprint = tk.StringVar()
        self.pairing = tk.StringVar()
        self.pairing_note = tk.StringVar(value="اضغط تشغيل، ثم أدخل الرمز الظاهر هنا في تطبيق iPhone.")
        self.network_note = tk.StringVar()
        self.relay_note = tk.StringVar()
        self.advanced_visible = False
        self._build()
        self.window.protocol("WM_DELETE_WINDOW", self.on_close)
        self._work(self._initialize, self._initialized)
        self.window.after(200, self._poll)

    def _build(self):
        self.window.title("وصلة — لوحة الكمبيوتر")
        available_height = max(400, self.window.winfo_screenheight() - 100)
        self.window.geometry(f"780x{min(820, available_height)}")
        self.window.minsize(660, min(660, available_height))
        self.window.configure(background="#f3f4ef")
        style = ttk.Style(self.window)
        style.theme_use("clam")
        style.configure("TFrame", background="#f3f4ef")
        style.configure("TLabel", background="#f3f4ef", foreground="#172c22", font=("Segoe UI", 10))
        style.configure("TButton", font=("Segoe UI", 10), padding=(12, 7))
        style.configure("Accent.TButton", background="#28694d", foreground="#ffffff")
        style.map("Accent.TButton", background=[("active", "#20593f"), ("disabled", "#a8b9ad")])
        style.configure("TCheckbutton", background="#f3f4ef", font=("Segoe UI", 10))
        style.configure("TLabelframe", background="#f3f4ef")
        style.configure("TLabelframe.Label", background="#f3f4ef", font=("Segoe UI", 11, "bold"))
        style.configure("Treeview", rowheight=28, font=("Segoe UI", 10))
        canvas = tk.Canvas(self.window, background="#f3f4ef", highlightthickness=0)
        scrollbar = ttk.Scrollbar(self.window, orient="vertical", command=canvas.yview)
        scrollbar.pack(side="right", fill="y")
        canvas.pack(side="left", fill="both", expand=True)
        canvas.configure(yscrollcommand=scrollbar.set)
        body = ttk.Frame(canvas, padding=22)
        content = canvas.create_window((0, 0), window=body, anchor="nw")
        canvas.bind("<Configure>", lambda event: canvas.itemconfigure(content, width=event.width))
        body.bind("<Configure>", lambda event: canvas.configure(scrollregion=canvas.bbox("all")))
        self.window.bind("<MouseWheel>", lambda event: canvas.yview_scroll(-1 if event.delta > 0 else 1, "units") if event.delta else None)
        ttk.Label(body, text="وصلة", font=("Segoe UI", 25, "bold"), anchor="e").pack(fill="x")
        ttk.Label(body, text="اربط هاتفك برمز واحد", anchor="e").pack(fill="x", pady=(0, 8))
        ttk.Label(body, textvariable=self.status, anchor="e", foreground="#28694d", wraplength=710).pack(fill="x", pady=(0, 12))
        actions = ttk.Frame(body)
        actions.pack(fill="x", pady=(0, 12))
        self.start_button = ttk.Button(actions, text="تشغيل وإظهار رمز الربط", command=self.start, style="Accent.TButton", state="disabled")
        self.start_button.pack(side="right", padx=(8, 0))
        self.stop_button = ttk.Button(actions, text="إيقاف وصلة", command=self.stop, state="disabled")
        self.stop_button.pack(side="right")

        enrollment = ttk.LabelFrame(body, text="رمز ربط iPhone", padding=14)
        enrollment.pack(fill="x", pady=(0, 12))
        ttk.Label(enrollment, text="أدخل هذه الأرقام الثمانية في تطبيق وصلة على هاتفك.", anchor="center").pack(fill="x")
        ttk.Entry(enrollment, textvariable=self.pairing, state="readonly", justify="center", font=("Consolas", 32, "bold")).pack(fill="x", pady=(12, 8))
        ttk.Label(enrollment, textvariable=self.pairing_note, anchor="center", justify="center", wraplength=670, foreground="#637268").pack(fill="x", pady=(0, 8))
        pairing_actions = ttk.Frame(enrollment)
        pairing_actions.pack(anchor="center")
        self.pair_button = ttk.Button(pairing_actions, text="رمز ربط جديد", command=self.create_pairing, state="disabled")
        self.pair_button.pack(side="right", padx=(8, 0))
        self.copy_pair_button = ttk.Button(pairing_actions, text="نسخ الرمز", command=lambda: self.copy_value(self.pairing, True), state="disabled")
        self.copy_pair_button.pack(side="right")
        self.desktop_check = ttk.Checkbutton(body, text="السماح بعرض سطح المكتب والتحكم بالفأرة ولوحة المفاتيح", variable=self.desktop, state="disabled")
        self.desktop_check.pack(anchor="e", pady=(0, 4))
        self.app_actions_check = ttk.Checkbutton(body, text="السماح بفتح التطبيقات من المحادثة", variable=self.app_actions, state="disabled")
        self.app_actions_check.pack(anchor="e", pady=(0, 4))
        ttk.Label(body, text="تُطبَّق هذه الخيارات عند تشغيل وصلة، وللأجهزة المقترنة فقط.", anchor="e", foreground="#637268").pack(fill="x", pady=(0, 10))
        ttk.Label(body, textvariable=self.network_note, anchor="e", justify="right", wraplength=710, foreground="#637268").pack(fill="x", pady=(0, 8))
        ttk.Label(body, textvariable=self.relay_note, anchor="e", justify="right", wraplength=710, foreground="#637268").pack(fill="x", pady=(0, 8))

        self.advanced_button = ttk.Button(body, text="تفاصيل متقدمة ▾", command=self.toggle_advanced)
        self.advanced_button.pack(anchor="e", pady=(0, 10))
        self.advanced_frame = ttk.Frame(body)
        settings = ttk.LabelFrame(self.advanced_frame, text="إعدادات الاتصال", padding=12)
        settings.pack(fill="x", pady=(0, 8))
        settings.columnconfigure(1, weight=1)
        ttk.Label(settings, text="عنوان الكمبيوتر", anchor="e").grid(row=0, column=2, sticky="e", padx=(12, 0))
        self.host_box = ttk.Combobox(settings, textvariable=self.host, state="disabled", width=24)
        self.host_box.grid(row=0, column=1, sticky="ew")
        self.refresh_button = ttk.Button(settings, text="تحديث العناوين", command=self.refresh_addresses, state="disabled")
        self.refresh_button.grid(row=0, column=0, padx=(0, 10))
        ttk.Label(settings, text="المنفذ", anchor="e").grid(row=1, column=2, sticky="e", padx=(12, 0), pady=9)
        self.port_entry = ttk.Entry(settings, textvariable=self.port, width=12, justify="left", state="disabled")
        self.port_entry.grid(row=1, column=1, sticky="w", pady=9)
        identity = ttk.LabelFrame(self.advanced_frame, text="بيانات الربط اليدوي", padding=12)
        identity.pack(fill="x", pady=(0, 8))
        identity.columnconfigure(1, weight=1)
        self.copy_buttons = []
        for row, (label, variable) in enumerate([
            ("عنوان الاتصال", self.uri),
            ("بصمة الشهادة SHA‑256", self.fingerprint),
        ]):
            ttk.Label(identity, text=label, anchor="e").grid(row=row, column=2, sticky="e", padx=(10, 0), pady=4)
            entry = ttk.Entry(identity, textvariable=variable, state="readonly", justify="left", font=("Consolas", 10))
            entry.grid(row=row, column=1, sticky="ew", pady=4)
            button = ttk.Button(identity, text="نسخ", command=lambda value=variable: self.copy_value(value), state="disabled")
            button.grid(row=row, column=0, padx=(0, 8), pady=4)
            self.copy_buttons.append(button)

        devices = ttk.LabelFrame(body, text="الأجهزة المقترنة", padding=12)
        self.devices_frame = devices
        devices.pack(fill="both", expand=True)
        self.device_list = ttk.Treeview(devices, columns=("expires", "name"), show="headings", height=3, selectmode="none")
        self.device_list.heading("name", text="اسم الجهاز", anchor="e")
        self.device_list.heading("expires", text="تنتهي الجلسة", anchor="e")
        self.device_list.column("name", anchor="e", width=360)
        self.device_list.column("expires", anchor="e", width=180)
        self.device_list.pack(fill="both", expand=True)
        self.revoke_button = ttk.Button(devices, text="إلغاء اقتران جميع الأجهزة", command=self.revoke_all, state="disabled")
        self.revoke_button.pack(anchor="e", pady=(8, 0))
        ttk.Label(body, text="اترك هذه النافذة مفتوحة أثناء استخدام الهاتف. إغلاقها يوقف الاتصال.", anchor="e", wraplength=710, foreground="#637268").pack(fill="x", pady=(10, 0))

    def toggle_advanced(self):
        self.advanced_visible = not self.advanced_visible
        if self.advanced_visible:
            self.advanced_frame.pack(fill="x", before=self.devices_frame)
            self.advanced_button.configure(text="إخفاء التفاصيل المتقدمة ▴")
        else:
            self.advanced_frame.pack_forget()
            self.advanced_button.configure(text="تفاصيل متقدمة ▾")

    def _work(self, function, callback):
        def run():
            try:
                self.jobs.put((callback, function(), None))
            except Exception as exc:
                self.jobs.put((callback, None, str(exc)))
        threading.Thread(target=run, daemon=True).start()

    def _initialize(self):
        if os.name != "nt":
            raise RuntimeError("هذه اللوحة مخصصة لجهاز Windows.")
        if not PYTHON.is_file():
            raise RuntimeError("لم يُعثر على بيئة Python المثبتة الخاصة بالمساعد المحلي.")
        return AuthStore(STATE_ROOT), ordered_addresses()

    def _initialized(self, value, error):
        if error:
            self.status.set("تعذر تجهيز وصلة: " + error)
            return
        self.store, self.addresses = value
        self.host_box.configure(values=self.addresses)
        self.host.set(self.addresses[0] if self.addresses else "127.0.0.1")
        self._network_message()
        self.status.set("جاهز. اضغط تشغيل وإظهار رمز الربط.")
        self._controls()
        self.refresh_devices()

    def _network_message(self):
        tailnet = any(ipaddress.ip_address(value) in TAILNET for value in self.addresses)
        if tailnet:
            self.network_note.set("اتصال Tailscale متاح. أبقِ Tailscale متصلًا على الكمبيوتر وiPhone بالحساب نفسه.")
        else:
            self.network_note.set("لم يظهر عنوان Tailscale بعد. الوصول من خارج المنزل يحتاج Tailscale على الكمبيوتر وiPhone؛ العنوان المحلي يعمل داخل الشبكة فقط.")

    def refresh_addresses(self):
        if self.process and self.process.poll() is None:
            return
        self.refresh_button.configure(state="disabled")
        self._work(ordered_addresses, self._addresses_refreshed)

    def _addresses_refreshed(self, values, error):
        if error:
            self.status.set("تعذر قراءة عناوين الشبكة: " + error)
        else:
            old = self.host.get()
            self.addresses = values
            self.host_box.configure(values=values)
            preferred = values[0] if values else "127.0.0.1"
            self.host.set(preferred if ipaddress.ip_address(preferred) in TAILNET else old if old in values else preferred)
            self._network_message()
        self._controls()

    def _controls(self):
        running = self.process is not None and self.process.poll() is None
        editable = self.store is not None and not running
        self.start_button.configure(state="normal" if editable else "disabled")
        self.stop_button.configure(state="normal" if running and not self.stopping else "disabled")
        self.host_box.configure(state="readonly" if editable else "disabled")
        self.port_entry.configure(state="normal" if editable else "disabled")
        self.refresh_button.configure(state="normal" if editable else "disabled")
        self.desktop_check.configure(state="normal" if editable else "disabled")
        self.app_actions_check.configure(state="normal" if editable else "disabled")
        self.pair_button.configure(state="normal" if self.ready and not self.stopping and not self.pairing_pending else "disabled")
        self.revoke_button.configure(state="normal" if self.store is not None else "disabled")
        self.copy_buttons[0].configure(state="normal" if self.ready and not self.stopping else "disabled")
        self.copy_buttons[1].configure(state="normal" if self.ready and not self.stopping else "disabled")
        self.copy_pair_button.configure(state="normal" if self.current_pairing and self.ready and not self.stopping else "disabled")

    def start(self):
        if self.store is None or (self.process and self.process.poll() is None):
            return
        host = self.host.get()
        if host not in self.addresses:
            messagebox.showerror("عنوان الاتصال", "اختر عنوانًا من قائمة عناوين هذا الكمبيوتر.", parent=self.window)
            return
        try:
            port = int(self.port.get())
            if not 1024 <= port <= 65535:
                raise ValueError()
        except ValueError:
            messagebox.showerror("المنفذ", "أدخل منفذًا من 1024 إلى 65535.", parent=self.window)
            return
        # Do not attach to or stop another instance using an inherited PID.
        existing = read_status()
        if type(existing.get("pid")) is int:
            try:
                import psutil
                alive = psutil.pid_exists(existing["pid"])
            except Exception:
                alive = True
            if alive:
                messagebox.showerror("وصلة قيد التشغيل", "توجد خدمة مسجلة لهذه المساحة. أوقفها من نافذتها الأصلية أو استخدم Stop-Wasla.ps1، ثم أعد المحاولة.", parent=self.window)
                return
        command = [str(PYTHON), "-u", "-m", "wasla", "serve", "--state", str(STATE_ROOT),
                   "--host", host, "--port", str(port), "--stdin-control"]
        if self.desktop.get():
            command.append("--allow-desktop")
        if self.app_actions.get():
            command.append("--allow-app-actions")
        relay_config = STATE_ROOT / "relay-config.json"
        if relay_config.is_file():
            # Pass only a private file path. Secrets never enter command lines,
            # clipboard, GUI values, or an inherited relay environment.
            command.extend(["--relay-config", str(relay_config)])
        environment = {key: value for key, value in os.environ.items() if not key.startswith("WASLA_RELAY_")}
        environment["PYTHONUNBUFFERED"] = "1"
        try:
            with (STATE_ROOT / "server.log").open("ab", buffering=0) as log:
                self.process = subprocess.Popen(command, cwd=str(WINDOWS_ROOT), env=environment,
                    stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT,
                    text=True, encoding="utf-8", creationflags=subprocess.CREATE_NO_WINDOW)
            import psutil
            self.launcher_created = psutil.Process(self.process.pid).create_time()
            self.command = command
            self.backend_identity = None
        except Exception as exc:
            # Closing only our owned pipe asks an already-launched interpreter
            # to stop if identity discovery failed immediately after Popen.
            if self.process and self.process.stdin:
                try:
                    self.process.stdin.close()
                except OSError:
                    pass
            messagebox.showerror("تعذر التشغيل", str(exc), parent=self.window)
            self.process = None
            return
        self.ready, self.stopping, self.identity_pending = False, False, False
        self.close_when_stopped = False
        self.started_at = time.monotonic()
        self._clear_identity()
        self.status.set("جارٍ تشغيل الخدمة المشفّرة…")
        self._controls()

    def _clear_identity(self):
        self.uri.set("")
        self.fingerprint.set("")
        self.relay_note.set("")
        self._clear_pairing()

    def _clear_pairing(self):
        old = self.current_pairing
        self.current_pairing = ""
        self.pairing.set("")
        self.pairing_expires = 0
        if old and self.current_clipboard == old:
            self._clear_copied_secret()

    def _read_identity(self, status):
        # The backend writes readiness only after the TLS listener is bound.
        return status, ensure_certificate(STATE_ROOT)

    def _owned_status(self, status):
        if not self.process or self.process.poll() is not None:
            return None
        identity = verified_backend_identity(self.process.pid, self.launcher_created,
            status.get("pid"), self.command, BASE_PYTHON)
        if identity is None:
            return None
        if self.backend_identity is not None and identity != self.backend_identity:
            return None
        self.backend_identity = identity
        return identity

    def _identity_ready(self, value, error):
        self.identity_pending = False
        if not self.process or self.process.poll() is not None or self.stopping:
            return
        if error:
            self.status.set("تعذر التحقق من هوية الخدمة: " + error)
            self.stop()
            return
        status, fingerprint = value
        if self._owned_status(status) is None:
            return
        self.uri.set(f"https://{status['host']}:{status['port']}")
        self.fingerprint.set(fingerprint)
        self.ready = True
        self.relay_note.set("الاتصال عبر موقع وصلة مُعدّ. أبقِ الكمبيوتر وهذه اللوحة مفتوحين." if status.get("relay_enabled") else "")
        self.status.set("وصلة يعمل باتصال مشفّر. " + ("التحكم بسطح المكتب مسموح للأجهزة المقترنة." if status.get("desktop_enabled") else "عرض سطح المكتب والتحكم به غير مفعّلين."))
        if status.get("app_actions_enabled"):
            self.status.set(self.status.get() + " فتح التطبيقات من المحادثة مفعّل.")
        self.pairing_note.set("جارٍ إنشاء رمز الربط…")
        self._controls()
        self.create_pairing()

    def stop(self):
        if not self.process or self.process.poll() is not None or self.stopping:
            return
        self.stopping = True
        self.ready = False
        self._clear_pairing()
        self.status.set("جارٍ إيقاف الوصول وانتظار انتهاء العمل الجاري وتنظيف محرك الصور…")
        self.pairing_note.set("الاقتران مغلق أثناء إيقاف الخدمة.")
        try:
            if self.process.stdin:
                self.process.stdin.write("stop\n")
                self.process.stdin.flush()
                self.process.stdin.close()
        except (BrokenPipeError, OSError):
            # If stdin is closed, the backend's EOF handler requests shutdown.
            pass
        self._controls()

    def create_pairing(self):
        if not self.ready or self.stopping or self.pairing_pending:
            return
        self.pairing_pending = True
        self.pairing_note.set("جارٍ إنشاء رمز الربط…")
        self._controls()
        self._work(lambda: self.store.create_pairing_code(), self._pairing_created)

    def _pairing_created(self, value, error):
        self.pairing_pending = False
        if error:
            messagebox.showerror("تعذر إنشاء الرمز", error, parent=self.window)
        elif self.ready and not self.stopping:
            self._clear_pairing()
            self.current_pairing = value
            self.pairing.set(value)
            self.pairing_expires = time.time() + PAIRING_LIFETIME
        self._controls()

    def copy_value(self, variable, sensitive=False):
        value = variable.get()
        if not value:
            return
        self.window.clipboard_clear()
        self.window.clipboard_append(value)
        if sensitive:
            self.current_clipboard = value
            self.clipboard_expires = time.time() + 60
        self.status.set("تم النسخ. " + ("سيُمسح الرمز من الحافظة بعد دقيقة إذا بقي فيها." if sensitive else ""))

    def _clear_copied_secret(self):
        if self.current_clipboard:
            try:
                if self.window.clipboard_get() == self.current_clipboard:
                    self.window.clipboard_clear()
            except tk.TclError:
                pass
        self.current_clipboard = ""
        self.clipboard_expires = 0

    def refresh_devices(self):
        if self.store is None or self.devices_pending:
            return
        self.devices_pending = True
        self._work(self.store.list_devices, self._devices_refreshed)

    def _devices_refreshed(self, values, error):
        self.devices_pending = False
        if error:
            return
        self.device_list.delete(*self.device_list.get_children())
        for device in values:
            expiration = device.get("expires_at", 0)
            if expiration <= time.time():
                expiry = "منتهية"
            else:
                expiry = datetime.fromtimestamp(expiration).strftime("%Y-%m-%d %H:%M")
            self.device_list.insert("", "end", values=(expiry, device.get("name", "هاتف")))
        if self.current_pairing:
            try:
                entry = json.loads((STATE_ROOT / "pairing.json").read_text(encoding="utf-8"))
                if not entry.get("sha256"):
                    self._clear_pairing()
                    self.pairing_note.set("استخدم الهاتف رمز الاقتران. يمكنك إنشاء رمز جديد لجهاز آخر.")
                    self._controls()
            except (OSError, ValueError):
                pass

    def revoke_all(self):
        if self.store is None:
            return
        if not messagebox.askyesno("إلغاء اقتران الأجهزة", "هل تريد إلغاء وصول جميع الهواتف المقترنة؟ ستحتاج إلى رمز جديد لربطها مرة أخرى.", parent=self.window):
            return
        self.revoke_button.configure(state="disabled")
        self._work(self.store.revoke, self._revoked)

    def _revoked(self, value, error):
        if error:
            messagebox.showerror("تعذر إلغاء الاقتران", error, parent=self.window)
        else:
            self._clear_pairing()
            self.pairing_note.set("أُلغي اقتران جميع الأجهزة، وأُغلقت رموز الاقتران السابقة.")
            self.status.set("أُلغي وصول جميع الأجهزة المقترنة.")
            self.refresh_devices()
        self._controls()

    def _poll(self):
        while True:
            try:
                callback, value, error = self.jobs.get_nowait()
            except queue.Empty:
                break
            callback(value, error)
        now = time.time()
        if self.process:
            code = self.process.poll()
            if code is not None:
                was_stopping = self.stopping
                try:
                    if self.process.stdin and not self.process.stdin.closed:
                        self.process.stdin.close()
                except OSError:
                    pass
                self.process = None
                self.backend_identity = None
                self.launcher_created = 0.0
                self.command = []
                self.ready = self.stopping = False
                self._clear_identity()
                self.pairing_note.set("اضغط تشغيل، ثم أدخل الرمز الظاهر هنا في تطبيق iPhone.")
                if code == 0:
                    self.status.set("توقفت وصلة وأُغلق الوصول إلى الكمبيوتر.")
                else:
                    self.status.set("تعذر تشغيل الخدمة أو توقفت بخطأ. راجع سجل server.log داخل مجلد الحالة الخاص.")
                    if not was_stopping:
                        messagebox.showerror("توقفت خدمة وصلة", "لم تستمر الخدمة. قد يكون العنوان غير متاح، أو البصمة لا تشمل العنوان الجديد، أو توجد نسخة أخرى تعمل.\n\nالتفاصيل في:\n" + str(STATE_ROOT / "server.log"), parent=self.window)
                self._controls()
                if self.close_when_stopped:
                    self._destroy()
                    return
            else:
                status = read_status()
                owned = self._owned_status(status)
                if owned is not None and not self.stopping:
                    try:
                        request = json.loads((STATE_ROOT / "stop-request.json").read_text(encoding="utf-8"))
                        if request.get("pid") == owned.pid and request.get("started_at") == status.get("started_at"):
                            self.stop()
                    except (OSError, ValueError, AttributeError):
                        pass
                if owned is not None and not self.ready and not self.stopping and not self.identity_pending:
                    self.identity_pending = True
                    self._work(lambda snapshot=status: self._read_identity(snapshot), self._identity_ready)
                elif not self.ready and not self.stopping and time.monotonic() - self.started_at > 20:
                    self.status.set("ما زلنا ننتظر جاهزية الخدمة. يمكنك طلب الإيقاف دون إغلاق العمل بالقوة.")
        if self.current_pairing:
            remaining = max(0, int(self.pairing_expires - now))
            if remaining:
                self.pairing_note.set(f"رمز لمرة واحدة، ينتهي خلال {remaining // 60:02d}:{remaining % 60:02d}. لا ترسله إلى شخص آخر.")
            else:
                self._clear_pairing()
                self.pairing_note.set("انتهت صلاحية الرمز. أنشئ رمزًا جديدًا عند الحاجة.")
                self._controls()
        if self.clipboard_expires and now >= self.clipboard_expires:
            self._clear_copied_secret()
        if now >= self.next_device_check:
            self.next_device_check = now + 3
            self.refresh_devices()
        self.window.after(300, self._poll)

    def on_close(self):
        if self.process and self.process.poll() is None:
            if self.stopping:
                self.close_when_stopped = True
                self.status.set("ستُغلق النافذة بعد انتهاء الإيقاف الآمن. لا يُوقَف محرك الصور بالقوة.")
                return
            if messagebox.askyesno("إغلاق وصلة", "إغلاق النافذة سيوقف الوصول من الهاتف. سننتظر انتهاء العمل الجاري وتنظيفه قبل الإغلاق. هل تريد المتابعة؟", parent=self.window):
                self.close_when_stopped = True
                self.stop()
            return
        self._destroy()

    def _destroy(self):
        self._clear_copied_secret()
        self.window.destroy()


def main():
    window = tk.Tk()
    Companion(window)
    window.mainloop()


if __name__ == "__main__":
    main()
