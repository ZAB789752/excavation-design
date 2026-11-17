"""自动生成每阶段留票：角色、阶段、状态、事件都要落库。"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "services" / "api") not in sys.path:
    sys.path.insert(0, str(ROOT / "services" / "api"))


def test_records_ticket_with_events(tmp_path, monkeypatch):
    monkeypatch.setenv("PITGUARD_AGENT_DB_PATH", str(tmp_path / "agent.sqlite3"))
    from app.agents import calculation_book_autopilot as autopilot
    from app.agents.store import AgentStore

    ticket_id = autopilot.record_stage_ticket(
        project_id="project-test", role_id="A5", stage_id="DESIGN.CALCULATION",
        summary="检查 fail=0", executor="calculation_engine",
    )
    store = AgentStore()
    ticket = store.get_ticket(ticket_id)
    assert ticket["roleId"] == "A5"
    assert ticket["stageId"] == "DESIGN.CALCULATION"
    assert ticket["status"] == "done"
    assert ticket["mandate"]["formalConstructionIssue"] is False
    kinds = [event["kind"] for event in store.ticket_events(ticket_id)]
    assert "worker_started" in kinds and "worker_done" in kinds
