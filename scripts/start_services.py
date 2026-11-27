"""启动 PitGuard 前后端（脱离当前 shell，避免被回收）。"""
from __future__ import annotations

import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = ROOT / "services" / "api"
WEB = ROOT / "apps" / "web"
PY = ROOT / ".venv" / "Scripts" / "python.exe"
NODE = Path(r"C:\Users\76836\.workbuddy\binaries\node\versions\22.22.2-6\node.exe")

DETACHED = 0x00000008
NEW_GROUP = 0x00000200
BREAKAWAY = 0x01000000

# Windows 环境变量大小写不敏感，父进程里可能同时有 http_proxy / HTTP_PROXY，
# 直接传给子进程会报“字典关键字重复”，统一转大写去重。
env = {k.upper(): v for k, v in os.environ.items()}
env.update({
    "PITGUARD_LLM_ENABLE": "1",
    "PITGUARD_LLM_MODEL_FAST": "deepseek-v4.1-flash-1017",
    "PITGUARD_LLM_BASE_URL": "https://discovery-api.intern-ai.org.cn/v1",
    "PITGUARD_LLM_ALLOWED_HOSTS": "discovery-api.intern-ai.org.cn",
    "PITGUARD_LLM_TIMEOUT": "60",
    "PITGUARD_LLM_MAX_TOKENS": "2000",
})

# API key 只从本机环境变量读。这个仓库是公开的，任何写进文件的 key 都等于公开。
# 设置一次即可（新开终端生效）：setx PITGUARD_LLM_API_KEY "sk-..."
KEY_ENV = "PITGUARD_LLM_API_KEY"
if os.environ.get(KEY_ENV):
    env[KEY_ENV] = os.environ[KEY_ENV]
else:
    env.pop(KEY_ENV, None)
    print(f"[warn] {KEY_ENV} 未设置：LLM 相关功能会不可用。\n"
          f'       设置方法：setx {KEY_ENV} "sk-..."（新开终端生效）',
          file=sys.stderr)


def spawn(name: str, args: list[str], cwd: Path, log_name: str) -> int:
    log = open(ROOT / log_name, "w", encoding="utf-8", errors="ignore")
    flags = DETACHED | NEW_GROUP
    try:
        proc = subprocess.Popen(args, cwd=str(cwd), env=env, stdout=log,
                                stderr=subprocess.STDOUT, creationflags=flags | BREAKAWAY)
    except OSError:
        proc = subprocess.Popen(args, cwd=str(cwd), env=env, stdout=log,
                                stderr=subprocess.STDOUT, creationflags=flags)
    print(f"{name} pid={proc.pid}")
    return proc.pid


def probe(url: str) -> str:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url, timeout=5) as resp:
            return f"{resp.status}"
    except Exception as exc:  # noqa: BLE001
        return f"down ({type(exc).__name__})"


def main() -> int:
    spawn("api", [str(PY), "-m", "uvicorn", "app.main:app",
                  "--host", "127.0.0.1", "--port", "8002"], API, "runtime-api.log")
    spawn("web", [str(NODE), "node_modules/vite/bin/vite.js",
                  "--port", "5173", "--strictPort", "--host", "127.0.0.1"], WEB, "runtime-web.log")
    for _ in range(12):
        time.sleep(2)
        api = probe("http://127.0.0.1:8002/health")
        web = probe("http://127.0.0.1:5173/")
        if api == "200" and web == "200":
            print("api:", api, "web:", web)
            return 0
    print("api:", probe("http://127.0.0.1:8002/health"), "web:", probe("http://127.0.0.1:5173/"))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
