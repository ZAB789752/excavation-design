import { useState } from 'react';
import { api } from '../api/client';
import './bim-model-card.css';

type Profile = 'detailed' | 'visual' | 'light';

const PROFILES: Array<{ id: Profile; name: string; hint: string }> = [
  { id: 'detailed', name: '语义详细', hint: '真实钢筋实体，用于审查、对量' },
  { id: 'visual', name: '施工可视', hint: '代理实体，通用查看器更稳' },
  { id: 'light', name: '轻量协调', hint: '只出构件与参数，不含逐根钢筋' },
];

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
  notes: string[];
};

export default function BimModelCard({ projectId }: { projectId: string }) {
  const [profile, setProfile] = useState<Profile>('detailed');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BimResult | null>(null);

  async function generate() {
    setBusy(true);
    setError('');
    try {
      const data = await api.generateBimModel(projectId, profile);
      setResult(data as BimResult);
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
          {result.notes?.length ? (
            <ul className="bimNotes">
              {result.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
