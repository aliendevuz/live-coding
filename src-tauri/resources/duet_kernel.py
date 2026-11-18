"""Duet kernel bridge.

Runs a real Jupyter kernel (ipykernel, through jupyter_client) and talks to
Duet over stdio, one JSON object per line.

  in : {"op": "execute", "id": n, "code": "..."}
       {"op": "complete" | "inspect", "id": n, "code": "...", "cursor": k}
       {"op": "interrupt"} | {"op": "restart"} | {"op": "shutdown"}
  out: {"ev": "status", "state": "starting|idle|busy|restarting|dead", ...}
       {"ev": "iopub", "id": n, "type": msg_type, "content": {...}}
       {"ev": "reply", "id": n, "type": msg_type, "content": {...}}
       {"ev": "error", "message": "..."}

The kernel exits with this process (stdin closed => shutdown).
"""

import json
import os
import sys
import threading
from queue import Empty

out_lock = threading.Lock()


def emit(obj):
    line = json.dumps(obj, default=str, ensure_ascii=False)
    with out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


try:
    from jupyter_client import KernelManager
except Exception as e:  # ipykernel / jupyter_client missing
    emit({"ev": "status", "state": "missing", "message": f"{type(e).__name__}: {e}", "python": sys.executable})
    sys.exit(3)

try:
    import ipykernel  # noqa: F401  (the python3 kernel spec needs it in this environment)
except Exception as e:
    emit({"ev": "status", "state": "missing", "message": f"{type(e).__name__}: {e}", "python": sys.executable})
    sys.exit(3)

pending = {}  # jupyter msg_id -> Duet request id
pending_lock = threading.Lock()
alive = True

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
km = KernelManager(kernel_name="python3")
emit({"ev": "status", "state": "starting", "python": sys.executable})
try:
    km.start_kernel(cwd=os.getcwd())
    kc = km.client()
    kc.start_channels()
    kc.wait_for_ready(timeout=90)
except Exception as e:
    emit({"ev": "status", "state": "dead", "message": f"Kernel failed to start: {e}", "python": sys.executable})
    sys.exit(4)

info = {}
try:
    import platform

    info = {"python_version": platform.python_version()}
except Exception:
    pass
emit({"ev": "status", "state": "idle", "python": sys.executable, **info})


def owner(msg):
    pid = msg.get("parent_header", {}).get("msg_id")
    with pending_lock:
        return pending.get(pid)


def iopub_loop():
    while alive:
        try:
            msg = kc.get_iopub_msg(timeout=0.25)
        except Empty:
            continue
        except Exception:
            if not alive:
                return
            continue
        t = msg["header"]["msg_type"]
        c = msg.get("content", {})
        if t == "status":
            emit({"ev": "status", "state": c.get("execution_state", "idle")})
            continue
        rid = owner(msg)
        if rid is None or t in ("execute_input",):
            continue
        emit({"ev": "iopub", "id": rid, "type": t, "content": c})


def shell_loop():
    while alive:
        try:
            msg = kc.get_shell_msg(timeout=0.25)
        except Empty:
            continue
        except Exception:
            if not alive:
                return
            continue
        rid = owner(msg)
        if rid is None:
            continue
        with pending_lock:
            pending.pop(msg.get("parent_header", {}).get("msg_id"), None)
        emit({"ev": "reply", "id": rid, "type": msg["header"]["msg_type"], "content": msg.get("content", {})})


threading.Thread(target=iopub_loop, daemon=True).start()
threading.Thread(target=shell_loop, daemon=True).start()


def track(msg_id, rid):
    with pending_lock:
        pending[msg_id] = rid


def shutdown():
    global alive
    alive = False
    try:
        kc.stop_channels()
    except Exception:
        pass
    try:
        km.shutdown_kernel(now=True)
    except Exception:
        pass


for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    try:
        cmd = json.loads(raw)
        op = cmd.get("op")
        if op == "execute":
            track(kc.execute(cmd["code"], allow_stdin=False, store_history=True), cmd["id"])
        elif op == "complete":
            track(kc.complete(cmd["code"], cmd["cursor"]), cmd["id"])
        elif op == "inspect":
            track(kc.inspect(cmd["code"], cmd["cursor"], detail_level=0), cmd["id"])
        elif op == "interrupt":
            km.interrupt_kernel()
        elif op == "restart":
            emit({"ev": "status", "state": "restarting"})
            km.restart_kernel(now=True)
            kc.wait_for_ready(timeout=90)
            with pending_lock:
                pending.clear()
            emit({"ev": "status", "state": "idle", "restarted": True})
        elif op == "shutdown":
            break
    except Exception as e:  # keep serving
        emit({"ev": "error", "message": f"{type(e).__name__}: {e}"})

shutdown()
emit({"ev": "status", "state": "dead"})
