"""Optional relay owned by one backend; private config, no automatic startup."""
from __future__ import annotations

import asyncio
from pathlib import Path
import threading

from .relay import RelayConfig, RelayError, RelayWorker, _read_json


def load_relay_config(path, state_root, local_url, local_pin):
    """Read only the explicit private file, bound to this backend's TLS identity."""
    if path is None:
        return None
    state_root = Path(state_root).resolve()
    path = Path(path).resolve()
    if path != state_root / "relay-config.json":
        raise RelayError("Relay configuration must be in the private state directory")
    try:
        with path.open("rb") as handle:
            value = _read_json(handle.read(16385), maximum=16384)
    except OSError:
        raise RelayError("Cannot read the private relay configuration") from None
    fields = {"enabled", "base_url", "relay_token", "installation_id", "key_base64", "local_url", "local_pin"}
    if type(value) is not dict or type(value.get("enabled")) is not bool:
        raise RelayError("Invalid private relay configuration")
    if value["enabled"] is False:
        if set(value) != {"enabled"}:
            raise RelayError("Disabled relay configuration must contain only enabled:false")
        return None
    if set(value) != fields or any(type(value[name]) is not str for name in fields - {"enabled"}):
        raise RelayError("Invalid private relay configuration")
    config = RelayConfig.from_env({
        "WASLA_RELAY_ENABLED": "1",
        "WASLA_RELAY_URL": value["base_url"],
        "WASLA_RELAY_TOKEN": value["relay_token"],
        "WASLA_RELAY_INSTALLATION_ID": value["installation_id"],
        "WASLA_RELAY_KEY_BASE64": value["key_base64"],
        "WASLA_RELAY_LOCAL_URL": value["local_url"],
        "WASLA_RELAY_LOCAL_PIN": value["local_pin"],
        "WASLA_RELAY_STATE": str(state_root),
    })
    if config.local_url != local_url or config.local_pin != local_pin.lower():
        raise RelayError("Private relay configuration does not match this backend's TLS listener")
    return config


class OwnedRelay:
    """Stop and join the same worker; never kill a process or abandon a request."""
    def __init__(self, config, *, worker_factory=RelayWorker):
        self.worker = worker_factory(config)
        self.stop_event = threading.Event()
        self.failed = False
        self.thread = threading.Thread(target=self._run, name="wasla-relay", daemon=False)

    def _run(self):
        try:
            self.worker.run_forever(self.stop_event)
        except Exception:
            self.failed = True
            # Do not print an exception, configuration, request, token or key.
            print("Wasla relay stopped unexpectedly; restart the companion to retry.", flush=True)

    def start(self):
        self.thread.start()

    def request_stop(self):
        self.stop_event.set()

    async def close(self):
        self.request_stop()
        if self.thread.ident is not None:
            # Network operations already have finite deadlines. Finish owned
            # work before exiting; keep the UI/event loop responsive meanwhile.
            await asyncio.to_thread(self.thread.join)
