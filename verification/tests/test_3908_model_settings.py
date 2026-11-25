"""模型接入配置：界面保存的值覆盖环境变量，Key 只回显尾号。"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "services" / "api") not in sys.path:
    sys.path.insert(0, str(ROOT / "services" / "api"))


def test_saved_settings_override_env(tmp_path, monkeypatch):
    monkeypatch.setenv("PITGUARD_LLM_SETTINGS", str(tmp_path / "llm.json"))
    monkeypatch.setenv("PITGUARD_LLM_API_KEY", "env-key-1234")
    monkeypatch.setenv("PITGUARD_LLM_MODEL_FAST", "env-model")
    monkeypatch.setenv("PITGUARD_LLM_ENABLE", "0")

    from app.agents import model_gateway

    module = importlib.reload(model_gateway)
    try:
        before = module.configuration()
        assert before["source"] == "env"
        assert before["keyHint"] == "…1234"
        assert before["modelSlots"]["fast"] == "env-model"

        after = module.update_configuration({"API_KEY": "file-key-5678", "ENABLE": "1",
                                             "MODEL_FAST": "file-model"})
        assert after["source"] == "file"
        assert after["keyHint"] == "…5678"
        assert after["enabled"] is True
        assert after["modelSlots"]["fast"] == "file-model"
    finally:
        # 还原模块状态，避免影响后续用例
        monkeypatch.delenv("PITGUARD_LLM_SETTINGS", raising=False)
        importlib.reload(model_gateway)


def test_rejects_credentials_in_base_url(tmp_path, monkeypatch):
    monkeypatch.setenv("PITGUARD_LLM_SETTINGS", str(tmp_path / "llm.json"))
    from app.agents import model_gateway

    module = importlib.reload(model_gateway)
    try:
        try:
            module.update_configuration({"BASE_URL": "https://user:pass@example.com/v1"})
        except module.GatewayUnavailable as exc:
            assert "凭据" in str(exc)
        else:
            raise AssertionError("expected GatewayUnavailable")
    finally:
        monkeypatch.delenv("PITGUARD_LLM_SETTINGS", raising=False)
        importlib.reload(model_gateway)
