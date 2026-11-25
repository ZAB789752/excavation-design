import { Suspense, lazy, useState } from 'react';
import { api } from '../api/client';
import './bim-model-card.css';

const BimViewer = lazy(() => import('./BimViewer'));

type Profile = 'detailed' | 'visual' | 'light';

const PROFILES: Array<{ id: Profile; name: string; hint: string }> = [
  { id: 'detailed', name: '语义详细', hint: '真实钢筋实体，用于审查、对量' },
  { id: 'visual', name: '施工可视', hint: '代理实体，通用查看器更稳' },
  { id: 'light', name: '轻量协调', hint: '只出构件与参数，不含逐根钢筋' },
];

type QuantityRow = { barType: string; diameterMm: number; count: number; lengthM: number; kg: number };

type RebarQuantity = {
  totalKg: number;
  totalT: number;
  byType: QuantityRow[];
  pile?: {
    count: number;
    ifcKg: number;
    theoryKg: number;
    diffPct: number;
    kgPerM?: number | null;
    basis: string;
  };
  supportLongitudinal?: {
    ifcKg: number;
    schemeKg: number;
    diffPct: number;
    status: string;
  };
};

type BimResult = {
  profile: string;
  mode: string;
  description: string;
  filename: string;
  sizeMB: number;
  downloadUrl: string;
  generatedAt: string;
  pileCount: number;
  rebarCount: number;
  wallCount: number;
  beamCount: number;
  columnCount: number;
  validation: { score?: number; status?: string; summary?: string };
  rebarQuantity?: RebarQuantity;
  clash?: {
    checkedPairs: number;
    count: number;
    status: string;
    items: Array<Record<string, unknown>>;
    basis: string;
  };
  notes: string[];
};

export default function BimModelCard({ projectId }: { projectId: string }) {
  const [profile, setProfile] = useState<Profile>('detailed');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BimResult | null>(null);
  const [preview, setPreview] = useState<'' | 'design_detailed' | 'coordination_light'>('');
  const [full, setFull] = useState(false);

  async function generate() {
    setBusy(true);
    setError('');
    try {
      const data = await api.generateBimModel(projectId, profile);
      setResult(data as BimResult);
      setPreview('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const score = result?.validation?.score;
  const status = result?.validation?.status;

  return (
    <section className="bimCard">
      <header className="bimCardHead">
        <div>
          <h3>生成 BIM 模型</h3>
          <p>按当前设计与配筋生成 IFC，含桩、冠梁、围檩、支撑、墙体的钢筋笼；生成后给出模型清单与兼容性自检。</p>
        </div>
        <button type="button" className="bimGenerate" onClick={() => void generate()} disabled={busy}>
          {busy ? '正在生成…' : '生成模型'}
        </button>
      </header>

      <div className="bimProfiles">
        {PROFILES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`bimProfile ${profile === item.id ? 'on' : ''}`}
            onClick={() => setProfile(item.id)}
            disabled={busy}
          >
            <strong>{item.name}</strong>
            <span>{item.hint}</span>
          </button>
        ))}
      </div>

      {busy ? <p className="bimHint">正在生成，详细档位约 10–20 秒；生成期间可以切到别的页签。</p> : null}
      {error ? <p className="bimError">生成失败：{error}</p> : null}

      {result ? (
        <div className="bimResult">
          <div className="bimStats">
            <div><b>{result.pileCount}</b><span>排桩</span></div>
            <div><b>{result.rebarCount.toLocaleString()}</b><span>钢筋根数</span></div>
            <div><b>{result.beamCount}</b><span>梁 / 支撑</span></div>
            <div><b>{result.sizeMB}</b><span>MB</span></div>
          </div>
          <div className="bimResultBar">
            <span className={`bimBadge ${status === 'pass' ? 'ok' : 'warn'}`}>
              自检 {status ?? '-'}{typeof score === 'number' ? ` · ${score} 分` : ''}
            </span>
            <code>{result.filename}</code>
            <a className="bimDownload" href={`${api.exportUrl(projectId, 'ifc')}?mode=${result.mode}`} download>
              下载 IFC
            </a>
          </div>
          {result.rebarQuantity ? (
            <div className="bimQuantity">
              <div>
                <span>钢筋总量</span>
                <strong>{result.rebarQuantity.totalT} t</strong>
                <em>{result.rebarQuantity.byType.length} 类规格</em>
              </div>
              {result.rebarQuantity.pile?.kgPerM ? (
                <div>
                  <span>桩身含钢量</span>
                  <strong>{result.rebarQuantity.pile.kgPerM} kg/m</strong>
                  <em>{result.rebarQuantity.pile.count} 根 · 模型与设计参数一致</em>
                </div>
              ) : null}
              {result.rebarQuantity.supportLongitudinal ? (
                <div>
                  <span>纵筋量 vs 配筋方案</span>
                  <strong className={result.rebarQuantity.supportLongitudinal.status === 'pass' ? 'ok' : 'warn'}>
                    {result.rebarQuantity.supportLongitudinal.diffPct > 0 ? '+' : ''}
                    {result.rebarQuantity.supportLongitudinal.diffPct}%
                  </strong>
                  <em>
                    {Math.round(result.rebarQuantity.supportLongitudinal.ifcKg / 100) / 10} t / {Math.round(result.rebarQuantity.supportLongitudinal.schemeKg / 100) / 10} t
                  </em>
                </div>
              ) : null}
            </div>
          ) : null}
          {result.clash ? (
            <div className={`bimClash ${result.clash.status === 'pass' ? 'pass' : 'review'}`}>
              <span>几何校核</span>
              <strong>
                {result.clash.checkedPairs.toLocaleString()} 对构件 · {result.clash.count === 0 ? '无冲突' : `${result.clash.count} 处冲突`}
              </strong>
              <em>{result.clash.basis}</em>
            </div>
          ) : null}
          {result.notes?.length ? (
            <ul className="bimNotes">
              {result.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          ) : null}
          <div className="bimPreviewBar">
            <button
              type="button"
              className={preview === 'design_detailed' ? 'on' : ''}
              onClick={() => setPreview(preview === 'design_detailed' ? '' : 'design_detailed')}
            >
              {preview === 'design_detailed' ? '收起三维预览' : '三维预览（含钢筋）'}
            </button>
            <button
              type="button"
              className={preview === 'coordination_light' ? 'on' : ''}
              onClick={() => setPreview(preview === 'coordination_light' ? '' : 'coordination_light')}
            >
              {preview === 'coordination_light' ? '收起轻量预览' : '轻量预览（快）'}
            </button>
            <small>含钢筋的预览首次解析约 20–60 秒；轻量档位只出构件。</small>
            {preview ? <button type="button" onClick={() => setFull((value) => !value)}>{full ? '退出全屏' : '全屏查看'}</button> : null}
          </div>
          {preview ? (
            <div className={full ? 'bimPreviewFull' : undefined}>
              {full ? <button type="button" className="bimFullClose" onClick={() => setFull(false)}>退出全屏</button> : null}
              <Suspense fallback={<p className="bimHint">正在加载三维查看器…</p>}>
                <BimViewer url={`${api.exportUrl(projectId, 'ifc')}?mode=${preview}`} height={440} />
              </Suspense>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
