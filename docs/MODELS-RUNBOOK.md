# Verified Python coding on the VM

The verifier requires Linux, `libseccomp.so.2`, and Python 3.11 or newer. The VM's `mohassan.service` runs the API and its Python verifier children as `User=mohassan` and `Group=mohassan`. Keep this dedicated system account unprivileged. When preparing a new VM, use the account and release layout created by the Linux deployment procedure. [Linux deployment procedure](../scripts/cloud-linux/README.md)

The launcher uses `/usr/bin/python3` by default. To select another interpreter, set `TEST_DRIVEN_CODING_PYTHON` to its absolute path in the root-owned `/etc/mohassan/server.env`. The resolved executable must be owned by root. The service account must have execute access and lack write access to the executable and its resolved parent directories. The startup check verifies these permissions and the interpreter version with Python's isolated flags. Restart the API after changing the interpreter or its permissions.

Keep `/opt/mohassan/app/apps/server/src/assistant/test-driven-coding` and its Python modules in the root-owned release tree, readable by `mohassan` with no service-user write access. Keep the release's parent directories outside the service user's writable paths. Use `/var/lib/mohassan` for service-owned state. The worker's temporary directory is created for each request, and the isolation self-check must succeed before the worker reads that request.

On the VM, run this smoke check with the same user and interpreter configured for the API. Use the configured absolute interpreter path if it differs from `/usr/bin/python3`.

```bash
sudo -u mohassan -- /usr/bin/env -i /usr/bin/python3 -I -B -S \
  /opt/mohassan/app/apps/server/src/assistant/test-driven-coding/worker.py <<'JSON'
{"mode":"verify","source":"def increment(value):\n    return value + 1","assertions":["assert increment(2) == 3"]}
JSON
```

Expect one line, `{"status":"passed"}`, and exit status 0. A worker started as root, or one whose file and socket isolation checks fail, reports `isolation-unavailable`. Configure `TEST_DRIVEN_CODING_ENABLED=true` only after validating the deployed permissions and smoke check. The API admits up to two verification requests at once and applies a 250 ms cooldown per account after each verification.
