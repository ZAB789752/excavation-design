import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import './model-settings.css';

type ModelConfig = {
  enabled: boolean; configured: boolean; keyHint?: string; source?: string;
  baseUrl?: string; modelSlots?: Record<string, string>;
};

type Provider = { id: string; name: string; baseUrl: string; models: string[] };

const PROVIDERS: Provider[] = [
  { id: 'discovery', name: '内部网关', baseUrl: 'https://discovery-api.intern-ai.org.cn/v1',
    models: ['deepseek-v4.1-flash-1017'] },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'] },
  { id: 'dashscope', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'] },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-flash', 'glm-4-plus', 'glm-4-air'] },
  { id: 'moonshot', name: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  { id: 'volcengine', name: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-1-5-lite-32k-250115', 'doubao-1-5-pro-32k-250115'] },
  { id: 'custom', name: '自定义', baseUrl: '', models: [] },
];

const CUSTOM = '__custom__';

export default function ModelSettingsDialog({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<ModelConfig | null>(null);
  const [providerId, setProviderId] = useState('discovery');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [showUrl, setShowUrl] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [test, setTest] = useState<{ ok: boolean; reason?: string; latencyMs?: number } | null>(null);

  const provider = useMemo(
    () => PROVIDERS.find((item) => item.id === providerId) ?? PROVIDERS[0],
    [providerId],
  );

  const load = useCallback(async () => {
    try {
      const value = await api.modelConfiguration();
      setCfg(value);
      const saved = value.modelSlots?.fast ?? '';
      const matched = PROVIDERS.find((item) => item.baseUrl && item.baseUrl === value.baseUrl);
      setProviderId(matched ? matched.id : 'custom');
      setBaseUrl(value.baseUrl ?? '');
      if (matched && matched.models.includes(saved)) {
        setModel(saved);
        setCustomModel('');
        setShowUrl(false);
      } else {
        setModel(CUSTOM);
        setCustomModel(saved);
        setShowUrl(!matched);
      }
    } catch (reason) { setError(String(reason)); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const chosenModel = model === CUSTOM ? customModel.trim() : model;

  const save = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const payload: Record<string, string> = {
        ENABLE: cfg?.enabled ? '1' : '0',
        BASE_URL: baseUrl.trim(),
        MODEL_FAST: chosenModel,
        MODEL_REASONING: chosenModel,
      };
      if (keyDraft.trim()) payload.API_KEY = keyDraft.trim();
      const saved = await api.saveModelConfiguration(payload);
      setCfg(saved as unknown as ModelConfig);
      setKeyDraft('');
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }, [cfg, baseUrl, chosenModel, keyDraft]);

  const runTest = useCallback(async () => {
    setBusy(true); setError(''); setTest(null);
    try { setTest(await api.testModelConnection()); }
    catch (reason) { setTest({ ok: false, reason: String(reason) }); }
    finally { setBusy(false); }
  }, []);

  const pickProvider = (next: Provider) => {
    setProviderId(next.id);
    setTest(null);
    if (next.baseUrl) {
      setBaseUrl(next.baseUrl);
      setModel(next.models[0] ?? CUSTOM);
      setCustomModel('');
      setShowUrl(false);
    } else {
      setBaseUrl('');
      setModel(CUSTOM);
      setShowUrl(true);
    }
  };

  return (
    <div className="msOverlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="msPanel" aria-label="模型设置">
        <header className="msHead">
          <div>
            <strong>模型设置</strong>
            <span>全局生效：所有项目共用同一个模型</span>
          </div>
          <button type="button" className="msGhost" onClick={onClose}>关闭</button>
        </header>

        <div className="msBody">
          <nav className="msProviders">
            {PROVIDERS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={providerId === item.id ? 'on' : ''}
                onClick={() => pickProvider(item)}
              >
                {item.name}
              </button>
            ))}
          </nav>

          <div className="msForm">
            <div className="msRow">
              <span>状态</span>
              <em className={cfg?.configured ? 'msChip ok' : 'msChip'}>
                {cfg?.configured ? `已配置 ${cfg.keyHint ?? ''}` : '未配置'}
              </em>
            </div>

            <label className="msField">
              <span>API Key</span>
              <input type="password" value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)}
                placeholder={cfg?.configured ? '已保存，留空不改' : '粘贴 sk-…'} autoComplete="off" />
            </label>

            <label className="msField">
              <span>模型</span>
              <select value={model} onChange={(event) => setModel(event.target.value)}>
                {provider.models.map((name) => <option key={name} value={name}>{name}</option>)}
                <option value={CUSTOM}>自定义模型名…</option>
              </select>
            </label>

            {model === CUSTOM ? (
              <label className="msField">
                <span>模型 ID</span>
                <input value={customModel} onChange={(event) => setCustomModel(event.target.value)}
                  placeholder="服务商文档里的模型标识" />
              </label>
            ) : null}

            <div className="msField">
              <span>接口地址</span>
              <div className="msUrl">
                <code>{baseUrl.replace(/^https?:\/\//, '') || '未设置'}</code>
                <button type="button" onClick={() => setShowUrl((prev) => !prev)}>
                  {showUrl ? '收起' : '修改'}
                </button>
              </div>
              {showUrl ? (
                <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://…/v1" />
              ) : null}
            </div>

            <label className="msSwitch">
              <input type="checkbox" checked={Boolean(cfg?.enabled)}
                onChange={(event) => setCfg((prev) => (prev ? { ...prev, enabled: event.target.checked } : prev))} />
              启用模型（仅参数理解、总控路由、扫描件识别；不参与数值与规范判定）
            </label>

            {error ? <p className="msBad">{error}</p> : null}
            {test ? (
              <p className={test.ok ? 'msGood' : 'msBad'}>
                {test.ok ? `连接正常 · ${test.latencyMs ?? '-'} ms` : `连接失败：${test.reason ?? ''}`}
              </p>
            ) : null}
          </div>
        </div>

        <footer className="msFoot">
          <button type="button" className="msGhost" onClick={() => void runTest()} disabled={busy}>测试连接</button>
          <button type="button" className="msPrimary" onClick={() => void save()} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </footer>
      </section>
    </div>
  );
}
