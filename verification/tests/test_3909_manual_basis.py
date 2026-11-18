"""页面手填的设计参数也要算“已确认”，否则填了还提示缺。"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "services" / "api") not in sys.path:
    sys.path.insert(0, str(ROOT / "services" / "api"))

from app.agents.design_basis_intake import mark_manual_applied, missing_summary  # noqa: E402
from app.schemas.domain import Project  # noqa: E402


def test_manual_edit_clears_missing_even_when_value_is_default() -> None:
    project = Project(name="缺项测试")
    before = {item["key"] for item in missing_summary(project)["items"]}
    assert "defaultRebarGrade" in before
    assert "defaultCoverMm" in before

    # HRB400 / 50 恰好是模板默认值，以前会被当成“没填”
    mark_manual_applied(project, {"defaultRebarGrade": "HRB400", "defaultCoverMm": 50.0})

    after = {item["key"] for item in missing_summary(project)["items"]}
    assert "defaultRebarGrade" not in after
    assert "defaultCoverMm" not in after


def test_empty_payload_changes_nothing() -> None:
    project = Project(name="空提交")
    mark_manual_applied(project, {})
    mark_manual_applied(project, None)
    assert not (project.advanced_engineering or {}).get("designBasisIntake")


def test_default_values_are_amber_not_red() -> None:
    project = Project(name="默认值分类")
    summary = missing_summary(project)
    defaults = {item["key"] for item in summary["defaults"]}
    missing = {item["key"] for item in summary["missing"]}
    # 模板自带值 → 黄
    assert "defaultRebarGrade" in defaults
    assert "defaultCoverMm" in defaults
    # 没有默认值又没填 → 红
    assert "bearingCapacityKpa" in missing
    assert "defaultRebarGrade" not in missing
