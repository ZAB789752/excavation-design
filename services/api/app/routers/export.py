from __future__ import annotations

import json
import hashlib
import math
from datetime import datetime, timezone
from importlib import import_module
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse

from app.storage.repository import ProjectRepository, get_repository

router = APIRouter(prefix="/api/projects/{project_id}/export", tags=["export"])

EXPORT_DIR = Path(__file__).resolve().parents[2] / "exports"


def _record_export_manifest(project, key: str, path: Path, *, export_type: str, metadata: dict | None = None) -> dict:
    payload = {
        "schema": "pitguard-export-manifest-v387",
        "exportType": export_type,
        "fileName": path.name,
        "fileSize": path.stat().st_size if path.exists() else 0,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "metadata": metadata or {},
    }
    project.advanced_engineering[key] = payload
    return payload


def _lazy_call(module: str, name: str, *args, **kwargs):
    """Load export-only dependencies after an export request reaches a worker.

    DXF/IFC/DOCX/XLSX stacks are intentionally excluded from the always-on API
    import graph. This keeps login, health and project-list endpoints available
    even if an optional exporter is missing or a worker is under memory pressure.
    """
    return getattr(import_module(module), name)(*args, **kwargs)


def build_drawing_set_manifest(*args, **kwargs):
    return _lazy_call("app.drawings.cad_export", "build_drawing_set_manifest", *args, **kwargs)


def export_construction_cad_package(*args, **kwargs):
    return _lazy_call("app.drawings.cad_export", "export_construction_cad_package", *args, **kwargs)


def export_construction_svg_package(*args, **kwargs):
    return _lazy_call("app.drawings.cad_export", "export_construction_svg_package", *args, **kwargs)


def export_formal_drawing_package(*args, **kwargs):
    return _lazy_call("app.drawings.formal_issue", "export_formal_drawing_package", *args, **kwargs)


def evaluate_drawing_issue_gate(*args, **kwargs):
    return _lazy_call("app.drawing_rules", "evaluate_drawing_issue_gate", *args, **kwargs)


def review_status(*args, **kwargs):
    return _lazy_call("app.services.review_workflow", "review_status", *args, **kwargs)


def export_simplified_ifc(*args, **kwargs):
    return _lazy_call("app.ifc.exporter", "export_simplified_ifc", *args, **kwargs)


def build_rebar_ifc_visualization(*args, **kwargs):
    return _lazy_call("app.ifc.rebar_visualization", "build_rebar_ifc_visualization", *args, **kwargs)


def evaluate_ifc_model_compatibility(*args, **kwargs):
    return _lazy_call("app.quality.ifc_compatibility", "evaluate_ifc_model_compatibility", *args, **kwargs)


def validate_ifc_file(*args, **kwargs):
    return _lazy_call("app.quality.ifc_compatibility", "validate_ifc_file", *args, **kwargs)


def export_docx_report(*args, **kwargs):
    return _lazy_call("app.reports.docx_report", "export_docx_report", *args, **kwargs)


def export_wall_length_redundancy_report(*args, **kwargs):
    return _lazy_call("app.services.wall_length_optimizer", "export_wall_length_redundancy_report", *args, **kwargs)


def export_design_scheme_ledger(*args, **kwargs):
    return _lazy_call("app.services.design_scheme_ledger", "export_design_scheme_ledger", *args, **kwargs)


def build_rebar_design_scheme(*args, **kwargs):
    return _lazy_call("app.services.rebar_scheme_optimizer", "build_rebar_design_scheme", *args, **kwargs)


def export_rebar_detailing_package(*args, **kwargs):
    return _lazy_call("app.services.rebar_export", "export_rebar_detailing_package", *args, **kwargs)


def export_coordinated_delivery_package(*args, **kwargs):
    return _lazy_call("app.services.delivery_package", "export_coordinated_delivery_package", *args, **kwargs)


def evaluate_delivery_release_readiness(*args, **kwargs):
    return _lazy_call("app.services.delivery_release", "evaluate_delivery_release_readiness", *args, **kwargs)


def _export_ifc_with_check(project, mode: str, ledger: list | None = None) -> tuple[Path, object]:
    precheck = evaluate_ifc_model_compatibility(project)
    path = export_simplified_ifc(project, EXPORT_DIR, export_mode=mode, ledger=ledger)
    file_check = validate_ifc_file(path, base=precheck)
    sidecar = path.with_suffix(".ifc_check.json")
    sidecar.write_text(json.dumps(file_check.model_dump(mode="json", by_alias=True), ensure_ascii=False, indent=2), encoding="utf-8")
    return path, file_check


@router.post("/ifc")
@router.get("/ifc", include_in_schema=False)
def export_ifc(
    project_id: str,
    mode: Literal["coordination_light", "analysis_model", "design_detailed", "construction_visual"] = Query("design_detailed", description="IFC export mode: coordination_light, analysis_model, construction_visual or design_detailed"),
    repo: ProjectRepository = Depends(get_repository),
) -> FileResponse:
    project = repo.require(project_id)
    path, check = _export_ifc_with_check(project, mode)
    _record_export_manifest(project, "ifcExportManifest", path, export_type=f"ifc:{mode}", metadata={"checkStatus": getattr(check, "status", None)})
    repo.save(project, action="export.ifc_manifest", summary=f"Record IFC {mode} export manifest")
    return FileResponse(path=path, filename=path.name, media_type="application/octet-stream")


@router.post("/ifc-light")
@router.get("/ifc-light", include_in_schema=False)
def export_ifc_light(project_id: str, repo: ProjectRepository = Depends(get_repository)) -> FileResponse:
    project = repo.require(project_id)
    path, _ = _export_ifc_with_check(project, "coordination_light")
    return FileResponse(path=path, filename=path.name, media_type="application/octet-stream")




@router.post("/ifc-analysis")
@router.get("/ifc-analysis", include_in_schema=False)
def export_ifc_analysis(project_id: str, repo: ProjectRepository = Depends(get_repository)) -> FileResponse:
    project = repo.require(project_id)
    path, _ = _export_ifc_with_check(project, "analysis_model")
    return FileResponse(path=path, filename=path.name, media_type="application/octet-stream")


@router.post("/ifc-construction-visual")
@router.get("/ifc-construction-visual", include_in_schema=False)
def export_ifc_construction_visual(project_id: str, repo: ProjectRepository = Depends(get_repository)) -> FileResponse:
    project = repo.require(project_id)
    path, _ = _export_ifc_with_check(project, "construction_visual")
    return FileResponse(path=path, filename=path.name, media_type="application/octet-stream")


@router.post("/ifc-detailed")
@router.get("/ifc-detailed", include_in_schema=False)
def export_ifc_detailed(project_id: str, repo: ProjectRepository = Depends(get_repository)) -> FileResponse:
    project = repo.require(project_id)
    path, _ = _export_ifc_with_check(project, "design_detailed")
    return FileResponse(path=path, filename=path.name, media_type="application/octet-stream")


@router.post("/ifc-check")
@router.get("/ifc-check", include_in_schema=False)
def export_ifc_check(
    project_id: str,
    mode: Literal["coordination_light", "analysis_model", "design_detailed", "construction_visual"] = Query("design_detailed"),
    repo: ProjectRepository = Depends(get_repository),
) -> dict:
    project = repo.require(project_id)
    _, result = _export_ifc_with_check(project, mode)
    return result.model_dump(mode="json", by_alias=True)


@router.post("/ifc-rebar-visualization")
@router.get("/ifc-rebar-visualization", include_in_schema=False)
def export_ifc_rebar_visualization(
    project_id: str,
    max_bars: int = Query(2400, ge=50, le=5000, description="Maximum sampled bars returned for browser visualization"),
    focus_host_id: str | None = Query(None, description="Optional host id/code for a complete single-component reinforcement preview"),
    repo: ProjectRepository = Depends(get_repository),
) -> dict:
    project = repo.require(project_id)
    return build_rebar_ifc_visualization(project, max_bars=max_bars, focus_host_id=focus_host_id)


@router.post("/drawings-cad")
@router.get("/drawings-cad", include_in_schema=False)
def export_drawings_cad(
    project_id: str,
    scope: Literal["full", "general", "rebar", "details"] = Query("full"),
    rebar_mode: Literal["conservative", "balanced", "economic"] = Query("balanced"),
    issue_mode: Literal["review", "construction"] = Query("review"),
    repo: ProjectRepository = Depends(get_repository),
) -> FileResponse:
    project = repo.require(project_id)
    scheme = build_rebar_design_scheme(project, mode=rebar_mode)
    can_issue = bool((scheme.get("diagnostics") or {}).get("canIssueConstructionDrawings"))
    approval = review_status(project)
    current_revision = next((r for r in reversed(project.drawing_revisions) if r.issue_status == "construction" and r.snapshot_hash == approval.get("currentSnapshotHash")), None)
    issue_gate = evaluate_drawing_issue_gate(
        project, issue_mode=issue_mode, engineering_gate_allowed=can_issue, approval=approval, current_revision_valid=current_revision is not None
    )
    if not issue_gate["allowed"]:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "当前出图规则集的施工版发行条件未满足，只能导出审查版 CAD。",
                "diagnostics": scheme.get("diagnostics"),
                "review": approval,
                "drawingIssueGate": issue_gate,
            },
        )
    path = export_construction_cad_package(project, EXPORT_DIR, scope=scope, rebar_mode=rebar_mode, issue_mode=issue_mode)
    _record_export_manifest(project, "drawingExportManifest", path, export_type=f"cad:{issue_mode}:{scope}", metadata={"rebarMode": rebar_mode})
    repo.save(project, action="export.cad_manifest", summary="Record CAD drawing package manifest")
    return FileResponse(path=path, filename=path.name, media_type="application/zip")


@router.get("/drawings-manifest")
def get_drawings_manifest(project_id: str, repo: ProjectRepository = Depends(get_repository)) -> dict:
    return build_drawing_set_manifest(repo.require(project_id))


@router.post("/drawings-svg")
@router.get("/drawings-svg", include_in_schema=False)
def export_drawings_svg(project_id: str, repo: ProjectRepository = Depends(get_repository)) -> FileResponse:
    project = repo.require(project_id)
    path = export_construction_svg_package(project, EXPORT_DIR)
    return FileResponse(path=path, filename=path.name, media_type="application/zip")




@router.post("/rebar-detailing-package")
@router.get("/rebar-detailing-package", include_in_schema=False)
def export_rebar_detailing_zip(
    project_id: str,
    mode: Literal["conservative", "balanced", "economic"] = Query("balanced"),
    repo: ProjectRepository = Depends(get_repository),
) -> FileResponse:
    project = repo.require(project_id)
    path = export_rebar_detailing_package(project, EXPORT_DIR, mode=mode)
    return FileResponse(path=path, filename=path.name, media_type="application/zip")


@router.post("/report")
@router.get("/report", include_in_schema=False)
def export_report(project_id: str, repo: ProjectRepository = Depends(get_repository)) -> FileResponse:
    project = repo.require(project_id)
    path = export_docx_report(project, EXPORT_DIR)
    sections = [
        "project_overview", "design_basis", "geology_groundwater", "surroundings", "parameters",
        "scheme", "analysis_model", "loads", "design_stages", "wall_results", "support_results",
        "stability", "reinforcement", "adverse_scenarios", "conclusions", "manual_review",
    ]
    project.advanced_engineering["calculationReportSections"] = sections
    _record_export_manifest(project, "calculationReportManifest", path, export_type="docx_calculation_report", metadata={"sections": sections})
    repo.save(project, action="export.report_manifest", summary="Record calculation report manifest")
    return FileResponse(path=path, filename=path.name, media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document")


@router.post("/json")
@router.get("/json", include_in_schema=False)
def export_json(project_id: str, repo: ProjectRepository = Depends(get_repository)) -> FileResponse:
    project = repo.require(project_id)
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    path = EXPORT_DIR / f"{project.id}.json"
    path.write_text(json.dumps(project.model_dump(mode="json", by_alias=True), ensure_ascii=False, indent=2), encoding="utf-8")
    return FileResponse(path=path, filename=path.name, media_type="application/json")

@router.post("/design-scheme-ledger")
@router.get("/design-scheme-ledger", include_in_schema=False)
def export_design_scheme(project_id: str, mode: str = Query("balanced", pattern="^(conservative|balanced|economic)$"), repo: ProjectRepository = Depends(get_repository)) -> FileResponse:
    project = repo.require(project_id)
    path = export_design_scheme_ledger(project, EXPORT_DIR, mode=mode)
    return FileResponse(path=path, filename=path.name, media_type="application/json")


@router.post("/wall-length-redundancy")
@router.get("/wall-length-redundancy", include_in_schema=False)
def export_wall_length_redundancy(project_id: str, mode: str = Query("balanced", pattern="^(conservative|balanced|economic)$"), repo: ProjectRepository = Depends(get_repository)) -> FileResponse:
    project = repo.require(project_id)
    path = export_wall_length_redundancy_report(project, EXPORT_DIR, mode=mode)
    return FileResponse(path=path, filename=path.name, media_type="application/json")



@router.post("/formal-drawing-package")
@router.get("/formal-drawing-package", include_in_schema=False)
def export_formal_drawings(
    project_id: str,
    issue_mode: Literal["review", "construction"] = Query("review"),
    rebar_mode: Literal["conservative", "balanced", "economic"] = Query("balanced"),
    repo: ProjectRepository = Depends(get_repository),
) -> FileResponse:
    project = repo.require(project_id)
    scheme = build_rebar_design_scheme(project, mode=rebar_mode)
    approval = review_status(project)
    current_revision = next((r for r in reversed(project.drawing_revisions) if r.issue_status == "construction" and r.snapshot_hash == approval.get("currentSnapshotHash")), None)
    issue_gate = evaluate_drawing_issue_gate(
        project,
        issue_mode=issue_mode,
        engineering_gate_allowed=bool((scheme.get("diagnostics") or {}).get("canIssueConstructionDrawings")),
        approval=approval,
        current_revision_valid=current_revision is not None,
    )
    if not issue_gate["allowed"]:
        raise HTTPException(status_code=409, detail={
            "message": "正式图纸包发行条件未满足。",
            "review": approval, "constructionRevisionValid": current_revision is not None,
            "diagnostics": scheme.get("diagnostics"), "drawingIssueGate": issue_gate,
        })
    path = export_formal_drawing_package(project, EXPORT_DIR, issue_mode=issue_mode, rebar_mode=rebar_mode)
    _record_export_manifest(project, "formalDrawingManifest", path, export_type=f"formal_drawings:{issue_mode}", metadata={"rebarMode": rebar_mode})
    repo.save(project, action="export.formal_drawing_manifest", summary="Record formal drawing package manifest")
    return FileResponse(path=path, filename=path.name, media_type="application/zip")


@router.get("/release-readiness")
def get_release_readiness(
    project_id: str,
    issue_mode: Literal["review", "construction"] = Query("review"),
    repo: ProjectRepository = Depends(get_repository),
) -> dict:
    return evaluate_delivery_release_readiness(repo.require(project_id), issue_mode=issue_mode)


@router.post("/coordinated-delivery-package")
@router.get("/coordinated-delivery-package", include_in_schema=False)
def export_coordinated_delivery(
    project_id: str,
    issue_mode: Literal["review", "construction"] = Query("review"),
    rebar_mode: Literal["conservative", "balanced", "economic"] = Query("balanced"),
    include_ifc_profiles: bool = Query(True),
    repo: ProjectRepository = Depends(get_repository),
) -> FileResponse:
    project = repo.require(project_id)
    try:
        path = export_coordinated_delivery_package(
            project, EXPORT_DIR, issue_mode=issue_mode, rebar_mode=rebar_mode, include_ifc_profiles=include_ifc_profiles
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={
            "message": str(exc),
            "releaseReadiness": evaluate_delivery_release_readiness(project, issue_mode=issue_mode),
        }) from exc
    _record_export_manifest(project, "coordinatedDeliveryManifest", path, export_type=f"coordinated_delivery:{issue_mode}", metadata={"rebarMode": rebar_mode, "includeIfcProfiles": include_ifc_profiles})
    repo.save(project, action="export.coordinated_delivery_manifest", summary="Record coordinated delivery package manifest")
    return FileResponse(path=path, filename=path.name, media_type="application/zip")

BIM_PROFILES = {
    "detailed": ("design_detailed", "语义详细模型：真实 IfcReinforcingBar，桩/墙/支撑/梁全笼"),
    "visual": ("construction_visual", "施工可视模型：同一几何用代理实体，兼容通用查看器"),
    "light": ("coordination_light", "轻量协调模型：只保留构件与参数，不输出逐根钢筋"),
}


STEEL_DENSITY_KG_M3 = 7850.0


def _unit_weight_kg(diameter_mm: float) -> float:
    d = max(float(diameter_mm or 0.0), 0.0) / 1000.0
    return math.pi * d * d / 4.0 * STEEL_DENSITY_KG_M3


def _bar_weight_kg(diameter_mm: float, length_m: float) -> float:
    return _unit_weight_kg(diameter_mm) * max(float(length_m or 0.0), 0.0)


def _pile_quantity_check(rows: list[dict], project) -> dict:
    """用设计参数独立算一遍桩的钢筋量，和模型台账比。

    这里校核的是「模型有没有如实表达设计参数」，不是「和 BBS 对量」——
    BBS 要考虑搭接、锚固、损耗，是下一步的事。但只有这一步对上了，
    模型里的吨位才值得拿去和别人的量比。
    """
    main = next((row for row in rows if row["barType"] == "pile_main"), None)
    if not main:
        return {}
    advanced = getattr(project, "advanced_engineering", None) or {}
    parsed = (advanced.get("calculationBookAutopilot") or {}).get("parsed") or {}
    pile = parsed.get("pile") or {}
    cage = parsed.get("pileCage") or {}
    if not pile or not cage:
        return {}
    diameter = float(pile.get("diameter") or 0.0)
    length = float(pile.get("length") or 0.0)
    main_count = int(cage.get("providedBarCount") or cage.get("barCount") or 0)
    main_d = float(cage.get("mainDiameterMm") or 0.0)
    hoop_d = float(cage.get("hoopDiameterMm") or 0.0)
    hoop_spacing = float(cage.get("hoopSpacingMm") or 0.0)
    strong_d = float(cage.get("strongHoopDiameterMm") or 0.0)
    strong_spacing = float(cage.get("strongHoopSpacingMm") or 2000.0)
    cover = float(cage.get("clearCoverMm") or 50.0) / 1000.0
    if min(diameter, length, main_count, main_d, hoop_d, hoop_spacing) <= 0:
        return {}
    pile_count = int(round(main["count"] / main_count)) if main_count else 0
    if pile_count <= 0:
        return {}

    usable = max(length - 2 * cover, 0.2)
    hoop_radius = max(diameter / 2.0 - cover - hoop_d / 1000.0 / 2.0, 0.05)
    pitch = max(hoop_spacing / 1000.0, 0.05)
    turns = usable / pitch
    spiral_length = turns * math.hypot(2.0 * math.pi * hoop_radius, pitch)
    strong_rings = max(1, min(int(length / max(strong_spacing / 1000.0, 0.5)) + 1, 4))

    theory = {
        "pile_main": pile_count * main_count * usable * _unit_weight_kg(main_d),
        "pile_hoop_spiral": pile_count * spiral_length * _unit_weight_kg(hoop_d),
        "pile_strong_hoop": pile_count * strong_rings * 2.0 * math.pi * hoop_radius * _unit_weight_kg(strong_d),
    }
    ifc = {
        name: next((row["kg"] for row in rows if row["barType"] == name), 0.0)
        for name in theory
    }
    theory_total = sum(theory.values())
    ifc_total = sum(ifc.values())
    if theory_total <= 0:
        return {}
    return {
        "pile": {
            "count": pile_count,
            "ifcKg": round(ifc_total, 1),
            "theoryKg": round(theory_total, 1),
            "diffPct": round((ifc_total - theory_total) / theory_total * 100.0, 2),
            "kgPerM": round(ifc_total / (pile_count * length), 1) if length > 0 else None,
            "breakdown": [
                {"item": name, "ifcKg": round(ifc[name], 1), "theoryKg": round(theory[name], 1)}
                for name in ("pile_main", "pile_hoop_spiral", "pile_strong_hoop")
            ],
            "basis": "按设计参数独立核算（桩数 × 根数 × 定尺长度），不含搭接与损耗",
        }
    }


def _scheme_summary(project) -> dict:
    system = getattr(project, "retaining_system", None)
    scheme = getattr(system, "rebar_design_scheme", None)
    if scheme is None and isinstance(system, dict):
        scheme = system.get("rebarDesignScheme")
    if scheme is None:
        return {}
    summary = getattr(scheme, "summary", None)
    if summary is None and isinstance(scheme, dict):
        summary = scheme.get("summary")
    return summary if isinstance(summary, dict) else {}


def _design_quantity_compare(rows: list[dict], project) -> dict:
    """和配筋方案里的纵筋重量指数对比。

    这是唯一一处真正的外部参照：模型是从同一份设计参数长出来的，
    如果它的纵筋吨位和配筋方案自己算的重量差得远，说明导出时丢了构件。
    """
    scheme = _scheme_summary(project)
    scheme_kg = scheme.get("supportLongitudinalSteelWeightIndexKg")
    if not scheme_kg:
        return {}
    ifc_kg = sum(row["kg"] for row in rows if row["barType"] == "longitudinal")
    if ifc_kg <= 0:
        return {}
    diff = (ifc_kg - float(scheme_kg)) / float(scheme_kg) * 100.0
    return {
        "supportLongitudinal": {
            "ifcKg": round(ifc_kg, 1),
            "schemeKg": round(float(scheme_kg), 1),
            "diffPct": round(diff, 2),
            "status": "pass" if abs(diff) <= 5.0 else "review",
        },
        "basis": "与配筋方案 summary.supportLongitudinalSteelWeightIndexKg 对比，±5% 视为一致",
    }


def _rebar_quantity_summary(ledger: list, project) -> dict:
    groups: dict[tuple[str, float], dict] = {}
    for item in ledger or []:
        diameter = float(item.get("diameterMm") or 0.0)
        key = (str(item.get("barType") or "unknown"), diameter)
        row = groups.get(key)
        if row is None:
            row = {"barType": key[0], "diameterMm": diameter, "count": 0, "lengthM": 0.0, "kg": 0.0}
            groups[key] = row
        row["count"] += 1
        row["lengthM"] += float(item.get("lengthM") or 0.0)
        row["kg"] += _bar_weight_kg(diameter, item.get("lengthM"))
    rows = sorted(groups.values(), key=lambda item: -item["kg"])
    total = sum(row["kg"] for row in rows)
    for row in rows:
        row["lengthM"] = round(row["lengthM"], 1)
        row["kg"] = round(row["kg"], 1)
    summary = {
        "totalKg": round(total, 1),
        "totalT": round(total / 1000.0, 2),
        "byType": rows[:14],
    }
    summary.update(_pile_quantity_check(rows, project))
    summary.update(_design_quantity_compare(rows, project))
    return summary


def _exporter_revision() -> str:
    """导出器源码指纹。

    缓存只按计算版本判断时，改了钢筋/几何导出逻辑但计算没变，会命中旧 sidecar，
    出现“摘要写 36 MB、文件实际 38 MB”的不一致。把导出器源码纳入签名。
    """
    source = Path(__file__).resolve().parents[1] / "ifc" / "exporter.py"
    try:
        return hashlib.sha1(source.read_bytes()).hexdigest()[:10]
    except OSError:
        return "unknown"


@router.post("/bim")
def generate_bim_model(
    project_id: str,
    profile: Literal["detailed", "visual", "light"] = Query("detailed", description="BIM 模型档位"),
    repo: ProjectRepository = Depends(get_repository),
) -> dict:
    """一键生成 BIM 模型：出 IFC、跑自检、返回可下载地址与模型清单。"""
    if profile not in BIM_PROFILES:
        raise HTTPException(status_code=400, detail=f"未知档位：{profile}")
    mode, description = BIM_PROFILES[profile]
    project = repo.require(project_id)

    # 用计算版本而不是 updated_at：保存清单会刷新时间戳，导致缓存永远不命中
    calc = project.calculation_results[-1] if project.calculation_results else None
    design_version = getattr(calc, "id", "") if calc else ""
    rebar_version = len(getattr(project.retaining_system, "diaphragm_walls", []) or []) if project.retaining_system else 0
    signature = f"{project.id}|{design_version}|{rebar_version}|{mode}|bim-{_exporter_revision()}"
    sidecar = EXPORT_DIR / f"{project_id}_{mode}.bim.json"
    if sidecar.is_file():
        try:
            cached = json.loads(sidecar.read_text(encoding="utf-8"))
            if cached.get("signature") == signature and Path(cached.get("path", "")).is_file():
                summary_cached = dict(cached.get("summary") or {})
                summary_cached["cached"] = True
                return summary_cached
        except Exception:
            pass

    ledger: list[dict] = []
    path, check = _export_ifc_with_check(project, mode, ledger=ledger)
    counts = dict(getattr(check, "entity_counts", {}) or {})
    text_head = path.read_text(encoding="utf-8", errors="ignore")
    if "IFCPILE" not in counts:
        counts["IFCPILE"] = text_head.count("IFCPILE(")
    del text_head
    rebar = int(counts.get("IFCREINFORCINGBAR", 0) or 0)
    piles = int(counts.get("IFCPILE", 0) or 0)
    notes = [description]
    if piles:
        notes.append("计算按等代地下连续墙，BIM 按排桩表达；两者在构件属性中分别标注。")
    if rebar:
        notes.append("钢筋按主筋/箍筋/加强箍分色；查看器默认透视，可切换实体、透视与只看钢筋。")
        notes.append("闭合箍筋按一道一个实体统计（不是四段直筋），因此钢筋根数按构件数计。")
    if piles:
        notes.append("桩箍筋为整根螺旋（IfcSweptDiskSolid），圈数按设计间距，不是示意抽样。")
    summary = {
        "profile": profile,
        "mode": mode,
        "description": description,
        "filename": path.name,
        "sizeMB": round(path.stat().st_size / 1048576, 2),
        "downloadUrl": f"/api/projects/{project_id}/export/ifc?mode={mode}",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "counts": counts,
        "pileCount": piles,
        "rebarCount": rebar,
        "wallCount": int(counts.get("IFCWALL", 0) or 0),
        "beamCount": int(counts.get("IFCBEAM", 0) or 0),
        "columnCount": int(counts.get("IFCCOLUMN", 0) or 0),
        "validation": {
            "score": getattr(check, "score", None),
            "status": getattr(check, "status", None),
            "summary": getattr(check, "summary", None),
        },
        "rebarQuantity": _rebar_quantity_summary(ledger, project),
        "notes": notes,
        "formalConstructionIssue": False,
    }
    summary["cached"] = False
    _record_export_manifest(project, "bimGenerationManifest", path, export_type=f"bim:{profile}",
                            metadata={"mode": mode, "rebarCount": rebar, "pileCount": piles,
                                      "sizeMB": summary["sizeMB"]})
    repo.save(project, action="export.bim_generate", summary=f"生成 BIM 模型（{profile}）")
    try:
        sidecar.write_text(json.dumps({"signature": signature, "path": str(path), "summary": summary},
                                      ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass
    return summary
