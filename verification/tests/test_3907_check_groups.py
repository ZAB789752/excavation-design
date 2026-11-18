"""检查项聚合：同因项归到一族，别再平铺几十条。"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "services" / "api") not in sys.path:
    sys.path.insert(0, str(ROOT / "services" / "api"))

from app.routers.calculation import _family_of  # noqa: E402


def test_column_and_support_are_split() -> None:
    assert _family_of("PITGUARD-COLUMN-VERTICAL-LOAD-MISSING") == "立柱桩"
    assert _family_of("PITGUARD-SUPPORT-CONSTRUCTION-EFFECT-APPLICABILITY") == "支撑体系"


def test_normative_families() -> None:
    assert _family_of("JGJ120-2012-4.2-EMBEDMENT-STABILITY-SCREEN") == "嵌固稳定"
    assert _family_of("JGJ120-2012-OVERALL-STABILITY-CIRCULAR-SCREEN") == "整体稳定"
    assert _family_of("PITGUARD-REBAR-DETAIL") == "配筋与构造"
    assert _family_of("PITGUARD-NODE-BEARING") == "节点构造"


def test_unknown_falls_back() -> None:
    assert _family_of("SOMETHING-ELSE") == "其他筛查"
