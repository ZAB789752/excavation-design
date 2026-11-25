"""测试级隔离：模型接入配置文件指向临时路径。

`runtime/llm_settings.json` 是用户在界面里保存的真实配置，优先级高于环境变量。
如果不隔离，本机保存过的 Key/模型会让“未配置模型”“禁用模型”这类用例失效。
"""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def isolated_llm_settings(tmp_path, monkeypatch):
    from app.agents import model_gateway

    monkeypatch.setattr(model_gateway, "SETTINGS_PATH", tmp_path / "llm_settings.json")
    yield
