import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import './model-settings.css';

type ModelConfig = {
  enabled: boolean; configured: boolean; keyHint?: string; source?: string;
  baseUrl?: string; modelSlots?: Record<string, string>;
};

const DEEPSEEK = {
  baseUrl: 'https://api.deepseek.com/v1',
  models: ['deepseek-chat', 'deepseek-reasoner'],
};

const FORMATS = [
  { id: 'openai_chat', name: 'OpenAI Chat Completions 格式', supported: true },
  { id: 'openai_responses', name: 'OpenAI Responses API 格式', supported: false },
  { id: 'anthropic', name: 'Anthropic Messages 格式', supported: false },
];

export default function ModelSettingsDialog({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'deepseek' | 'other'>('deepseek');
  const [cfg, setCfg] = useState<ModelConfig | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [model, setModel] = useState(DEEPSEEK.models[0]);
  const [format, setFormat] = useState('openai_chat');
  const [baseUrl, setBaseUrl] = useState('');
  const [fullUrl, setFullUrl] = useState(false);
  const [modelId, setModelId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [test, setTest] = useState<{ ok: boolean; reason?: string; latencyMs?: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const value = await api.modelConfiguration();
      setCfg(value);
      const fast = value.modelSlots?.fast ?? '';
      const isDeepSeek = (value.baseUrl ?? '') === DEEPSEEK.baseUrl;
      setMode(isDeepSeek ? 'deepseek' : 'other');
      if (isDeepSeek) {
        setModel(DEEPSEEK.models.includes(fast) ? fast : DEEPSEEK.models[0]);
      } else {
        setBaseUrl(value.baseUrl ?? '');
        setModelId(fast);
        setDisplayName(localStorage.getItem('pitguard-model-name') || '');
      }
      setKeyDraft('');
    } catch (reason) { setError(String(reason)); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const reset = () => {
    setKeyDraft(''); setError(''); setTest(null);
    if (mode === 'deepseek') { setModel(DEEPSEEK.models[0]); }
    else { setBaseUrl(''); setModelId(''); setDisplayName(''); setFormat('openai_chat'); setFullUrl(false); }
  };

  const save = useCallback(async () => {
    setBusy(true); setError(''); setTest(null);
    try {
      let endpoint = baseUrl.trim();
      if (fullUrl && endpoint.endsWith('/chat/completions')) {
        endpoint = endpoint.slice(0, -'/chat/completions'.length);
      }
      const chosenModel = mode === 'deepseek' ? model : modelId.trim();
      if (!chosenModel) throw new Error('请填写模型 ID');
      if (mode === 'other' && !FORMATS.find((item) => item.id === format)?.supported) {
        throw new Error('目前只支持 OpenAI Chat Completions 格式');
      }
      if (mode === 'other') localStorage.setItem('pitguard-model-name', displayName.trim());
      const payload: Record<string, string> = {
        ENABLE: cfg?.enabled ? '1' : '0',
        BASE_URL: mode === 'deepseek' ? DEEPSEEK.baseUrl : endpoint,
        MODEL_FAST: chosenModel,
        MODEL_REASONING: chosenModel,
      };
      if (keyDraft.trim()) payload.API_KEY = keyDraft.trim();
      const saved = await api.saveModelConfiguration(payload);
      setCfg(saved as unknown as ModelConfig);
      setKeyDraft('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }, [mode, baseUrl, fullUrl, model, modelId, format, displayName, cfg, keyDraft]);

  const runTest = useCallback(async () => {
    setBusy(true); setError(''); setTest(null);
    try { setTest(await api.testModelConnection()); }
    catch (reason) { setTest({ ok: false, reason: String(reason) }); }
    finally { setBusy(false); }
  }, []);

  const unsupported = mode === 'other' && !FORMATS.find((item) => item.id === format)?.supported;

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
            <button type="button" className={mode === 'deepseek' ? 'on' : ''} onClick={() => setMode('deepseek')}>DeepSeek</button>
            <button type="button" className={mode === 'other' ? 'on' : ''} onClick={() => setMode('other')}>其他模型</button>
          </nav>

          <div className="msForm">
            <div className="msRow">
              <span>状态</span>
              <em className={cfg?.configured ? 'msChip ok' : 'msChip'}>
                {cfg?.configured ? `已配置 ${cfg.keyHint ?? ''}` : '未配置'}
              </em>
              <em className="msHintText">当前：{cfg?.modelSlots?.fast || '未设置'}</em>
            </div>

            {mode === 'deepseek' ? (
              <>
                <label className="msField">
                  <span>模型</span>
                  <select value={model} onChange={(event) => setModel(event.target.value)}>
                    <option value="deepseek-chat">deepseek-chat（对话）</option>
                    <option value="deepseek-reasoner">deepseek-reasoner（推理）</option>
                  </select>
                </label>
                <label className="msField">
                  <span className="msReq">API 密钥</span>
                  <input type="password" value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)}
                    placeholder={cfg?.configured ? '已保存，留空不改' : '粘贴 sk-…'} autoComplete="off" />
                </label>
                <div className="msField">
                  <span>接口地址</span>
                  <div className="msUrl"><code>api.deepseek.com/v1</code><em>官方默认</em></div>
                </div>
              </>
            ) : (
              <>
                <label className="msField">
                  <span className="msReq">API 格式</span>
                  <select value={format} onChange={(event) => setFormat(event.target.value)}>
                    {FORMATS.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}{item.supported ? '' : '（暂未接入）'}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="msField">
                  <span className="msReq">自定义请求地址</span>
                  <div className="msFieldHead">
                    <small>兼容 OpenAI 的服务端点，不要以斜杠结尾；/chat/completions 会自动补上</small>
                    <label className="msSwitchMini">
                      <input type="checkbox" checked={fullUrl} onChange={(event) => setFullUrl(event.target.checked)} />
                      完整 URL
                    </label>
                  </div>
                  <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="例如 https://api.openai.com/v1" />
                </label>

                <label className="msField">
                  <span className="msReq">模型 ID</span>
                  <input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="输入模型 ID" />
                </label>

                <label className="msField">
                  <span>模型展示名称</span>
                  <div className="msFieldHead"><small>列表里显示的名字，不填就用模型 ID</small></div>
                  <input value={displayName} maxLength={64} onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="请输入模型展示名称" />
                </label>

                <label className="msField">
                  <span className="msReq">API 密钥</span>
                  <input type="password" value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)}
                    placeholder={cfg?.configured ? '已保存，留空不改' : '请输入 API Key'} autoComplete="off" />
                </label>

                <button type="button" className="msAdvanced" onClick={() => setShowAdvanced((prev) => !prev)}>
                  高级配置 <span>{showAdvanced ? '▾' : '▸'}</span>
                </button>
                {showAdvanced ? (
                  <label className="msSwitch">
                    <input type="checkbox" checked={Boolean(cfg?.enabled)}
                      onChange={(event) => setCfg((prev) => (prev ? { ...prev, enabled: event.target.checked } : prev))} />
                    启用模型（仅参数理解、总控路由、扫描件识别；不参与数值与规范判定）
                  </label>
                ) : null}
              </>
            )}

            {unsupported ? <p className="msBad">目前只支持 OpenAI Chat Completions 格式</p> : null}
            {error ? <p className="msBad">{error}</p> : null}
            {test ? (
              <p className={test.ok ? 'msGood' : 'msBad'}>
                {test.ok ? `连接正常 · ${test.latencyMs ?? '-'} ms` : `连接失败：${test.reason ?? ''}`}
              </p>
            ) : null}
          </div>
        </div>

        <footer className="msFoot">
          <small className="msFootNote">连通性测试会发起一次真实请求，消耗少量 Token</small>
          <button type="button" className="msGhost" onClick={reset} disabled={busy}>重置</button>
          <button type="button" className="msPrimary" onClick={() => void save()} disabled={busy || unsupported}>
            {busy ? '保存中…' : '保存'}
          </button>
        </footer>
      </section>
    </div>
  );
}
