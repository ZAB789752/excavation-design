"""BIM 模型生成功能：一键出 IFC 并返回模型清单。"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.main import app


def headers():
    return {'X-PitGuard-Key': 'key-designer'}


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv('PITGUARD_DB_PATH', str(tmp_path / 'projects.sqlite3'))
    monkeypatch.setenv('PITGUARD_AGENT_DB_PATH', str(tmp_path / 'agent.sqlite3'))
    monkeypatch.setenv('PITGUARD_ONE_STRUT_STORE', str(tmp_path / 'one_strut'))
    monkeypatch.setenv('PITGUARD_API_KEYS', json.dumps({
        'key-designer': {'role': 'designer', 'actor': 'alice'},
    }))
    monkeypatch.delenv('PITGUARD_USERS', raising=False)
    with TestClient(app) as client:
        yield client


def test_bim_generate_returns_model_summary_and_download_url(api):
    created = api.post('/api/projects', json={'name': 'BIM 生成'}, headers=headers())
    assert created.status_code in (200, 201)
    project_id = created.json()['id']

    # 轻量档位不生成逐根钢筋，用于验证"生成 → 清单 → 下载地址"这条链路
    result = api.post(f'/api/projects/{project_id}/export/bim?profile=light', headers=headers())
    assert result.status_code == 200, result.text
    body = result.json()

    assert body['profile'] == 'light'
    assert body['mode'] == 'coordination_light'
    assert body['filename'].endswith('.ifc')
    assert body['downloadUrl'].endswith('/export/ifc?mode=coordination_light')
    # 空项目没有围护体系，IFC 自检可能直接判 fail；这里只校验字段齐全
    assert isinstance(body['validation'].get('status'), str)
    assert isinstance(body['validation'].get('score'), (int, float))
    assert isinstance(body['rebarCount'], int)
    assert 'formalConstructionIssue' in body

    # 同一项目同档位再生成一次应命中缓存
    again = api.post(f'/api/projects/{project_id}/export/bim?profile=light', headers=headers())
    assert again.status_code == 200
    assert again.json()['cached'] is True
