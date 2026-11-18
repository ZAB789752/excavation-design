import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import './model-settings.css';

type ModelConfig = {
  enabled: boolean; configured: boolean; keyHint?: string; source?: string;
  baseUrl?: string; modelSlots?: Record<string, string>; allowedHosts?: string[];
};

const PROVIDERS = [
  { id: 'discovery', name: '内部网关（当前）', baseUrl: 'https://discovery-api.intern-ai.org.cn/v1',
    fast: 'deepseek-v4.1-flash-1017', pro: 'deepseek-v4.1-flash-1017' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
    fast: 'deepseek-chat', pro: 'deepseek-reasoner' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
    fast: 'gpt-4o-mini', pro: 'gpt-4o' },
  { id: 'dashscope', name: '通义千问（阿里云）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    fast: 'qwen-plus', pro: 'qwen-max' },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    fast: 'glm-4-flash', pro: 'glm-4-plus' },
  { id: 'moonshot', name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1',
    fast: 'moonshot-v1-8k', pro: 'moonshot-v1-32k' },
  { id: 'volcengine', name: '火山方舟（豆包）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    fast: 'doubao-1-5-lite-32k-250115', pro: 'doubao-1-5-pro-32k-250115' },
  { id: 'custom', name: '自定义', baseUrl: '', fast: '', pro: '' },
];

export default function ModelSettingsDialog({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<ModelConfig | null>(null);
  const [providerId, setProviderId] = useState('discovery');
  const [baseUrl, setBaseUrl] = useState('');
  const [fast, setFast] = useState('');
  const [pro, setPro] = useState('');
  const [tier, setTier] = useState<'flash' | 'pro'>('flash');
  const [keyDraft, setKeyDraft] = useState('');
  const [custom, setCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [test, setTest] = useState<{ ok: boolean; reason?: string; latencyMs?: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const value = await api.modelConfiguration();
      setCfg(value);
      setBaseUrl(value.baseUrl ?? '');
      setFast(value.modelSlots?.fast ?? '');
      setPro(value.modelSlots?.reasoning ?? value.modelSlots?.fast ?? '');
      setTier(value.modelSlots?.fast && value.modelSlots?.fast === value.modelSlots?.reasoning ? 'pro' : 'flash');
      const matched = PROVIDERS.find((item) => item.baseUrl && item.baseUrl === value.baseUrl);
      setProviderId(matched ? matched.id : 'custom');
      setCustom(!matched);
    } catch (reason) { setError(String(reason)); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const chosen = tier === 'pro' ? (pro || fast) : fast;
      const payload: Record<string, string> = {
        ENABLE: cfg?.enabled ? '1' : '0',
        BASE_URL: baseUrl.trim(),
        MODEL_FAST: chosen.trim(),
        MODEL_REASONING: chosen.trim(),
      };
      if (keyDraft.trim()) payload.API_KEY = keyDraft.trim();
      const saved = await api.saveModelConfiguration(payload);
      setCfg(saved as unknown as ModelConfig);
      setKeyDraft('');
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }, [cfg, baseUrl, fast, pro, tier, keyDraft]);

  const runTest = useCallback(async () => {
    setBusy(true); setError(''); setTest(null);
    try { setTest(await api.testModelConnection()); }
    catch (reason) { setTest({ ok: false, reason: String(reason) }); }
    finally { setBusy(false); }
  }, []);

  return (
    <div className="modelSettingsOverlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modelSettingsCard" aria-label="模型设置">
        <header>
          <div><strong>模型设置</strong><span>全局生效，所有项目共用同一套模型</span></div>
          <button type="button" className="secondary" onClick={onClose}>关闭</button>
        </header>

        <label className="msToggle">
          <input type="checkbox" checked={Boolean(cfg?.enabled)}
            onChange={(event) => setCfg((prev) => (prev ? { ...prev, enabled: event.target.checked } : prev))} />
          启用（仅参数理解、总控路由、扫描件识别；不参与数值与规范判定）
        </label>

        <label>服务商
          <select value={providerId} onChange={(event) => {
            const next = event.target.value;
            setProviderId(next);
            const preset = PROVIDERS.find((item) => item.id === next);
            if (preset && preset.baseUrl) {
              setBaseUrl(preset.baseUrl); setFast(preset.fast); setPro(preset.pro); setCustom(false);
            } else { setCustom(true); }
          }}>
            {PROVIDERS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <small className="msHint">{baseUrl.replace(/^https?:\/\//, '').split('/')[0] || '未配置地址'}</small>
        </label>

        {custom ? (
          <>
            <label>接口地址（Base URL）
              <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://…/v1" />
            </label>
            <label>模型名（Flash）
              <input value={fast} onChange={(event) => setFast(event.target.value)} />
            </label>
            <label>模型名（Pro）
              <input value={pro} onChange={(event) => setPro(event.target.value)} />
            </label>
          </>
        ) : null}

        <label>API Key
          <input type="password" value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)}
            placeholder={cfg?.configured ? `已保存 ${cfg.keyHint ?? ''}，留空不改` : '粘贴 sk-…'} autoComplete="off" />
        </label>

        <div className="msTier">
          <span>模型</span>
          <div>
            <label className={tier === 'flash' ? 'on' : ''}>
              <input type="radio" name="tier" checked={tier === 'flash'} onChange={() => setTier('flash')} />
              <b>Flash</b><small>快 · 省</small>
            </label>
            <label className={tier === 'pro' ? 'on' : ''}>
              <input type="radio" name="tier" checked={tier === 'pro'} onChange={() => setTier('pro')} />
              <b>Pro</b><small>更强 · 更慢</small>
            </label>
          </div>
        </div>
        <p className="msHint">{tier === 'pro' && (!pro || pro === fast) ? 'Pro 未单独配置，当前与 Flash 相同' : (tier === 'pro' ? pro : fast)}</p>

        {error ? <p className="msError">{error}</p> : null}
        {test ? <p className={test.ok ? 'msOk' : 'msError'}>{test.ok ? `连通正常 · ${test.latencyMs ?? '-'} ms` : `失败：${test.reason ?? ''}`}</p> : null}

        <footer>
          <button type="button" onClick={() => void save()} disabled={busy}>{busy ? '处理中…' : '保存'}</button>
          <button type="button" className="secondary" onClick={() => void runTest()} disabled={busy}>测试连接</button>
        </footer>
      </section>
    </div>
  );
}
