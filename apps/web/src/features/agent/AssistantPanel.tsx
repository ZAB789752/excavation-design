import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  api,
  type AgentMessage,
  type AgentPlan,
  type AgentProjectStatus,
  type SuperAgentTriggerResult,
} from '../../api/client';
import './assistant-panel.css';

type Props = {
  projectId: string;
  projectName?: string;
  onProjectChanged?: () => void;
};
type Notice = { id: number; kind: 'alert' | 'error'; title: string; text: string };
type ModelConfig = {
  enabled: boolean; configured: boolean; keyHint?: string; source?: string;
  baseUrl?: string; modelSlots?: Record<string, string>; allowedHosts?: string[];
};
type Gap = { text: string; items: string[]; tone: 'ok' | 'warn' | 'error' };

const POLL_INTERVAL_MS = 15000;
const NOTICE_LIFETIME_MS = 12000;
const PET_POS_KEY = 'pitguard-agent-pet-pos-v2';
const OPEN_KEY = 'pitguard-agent-open';
const FIELD_KEYS: Record<string, string> = {
  surchargeGeneral: 'surcharge',
  safetyLevel: 'excavationSafetyLevel',
  importanceFactor: 'importanceFactor',
  concreteGrade: 'defaultConcreteGrade',
};

function fallbackGap(type: string, title: string): string[] {
  switch (type) {
    case 'human_confirm': return ['设计基准确认'];
    case 'needs_data': return ['工程输入资料'];
    case 'needs_frozen_result': return ['冻结的单剖面结果'];
    case 'role_not_ready': return [`「${title}」的执行链`];
    case 'upstream_incomplete': return ['上一步尚未完成'];
    default: return [];
  }
}

function describeGap(plan: AgentPlan): Gap {
  const next = plan.next;
  const gate = next.gate;
  if (gate.type === 'done') return { text: '六步都完成了', items: [], tone: 'ok' };
  if (gate.type === 'already_in_progress') {
    if (/awaiting_review/.test(gate.reason)) {
      return { text: '还缺：人工复核（任务已算完，等你采用或拒绝）', items: ['人工复核'], tone: 'warn' };
    }
    return { text: '当前有任务在运行，暂无缺项', items: [], tone: 'ok' };
  }
  const items = next.missing?.length ? next.missing : fallbackGap(gate.type, next.title);
  if (!items.length) {
    return { text: gate.reason || '暂无缺项', items: [], tone: 'ok' };
  }
  return { text: `还缺：${items.join('、')}`, items, tone: 'warn' };
}

/**
 * Minimal desktop-pet assistant: launcher, one conversation, one "what is
 * missing" line. No role roster, no task launcher, no conversation switcher.
 *
 * Assistant turns remain status receipts only: no model call, no engineering
 * judgement, no authority to change a design.
 */
export default function AssistantPanel({ projectId, projectName, onProjectChanged }: Props) {
  // 工作区恢复数据时会重渲染外层，展开状态放 sessionStorage 才不会被重置。
  const [open, setOpen] = useState(() => {
    try { return sessionStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
  });
  const [activeId, setActiveId] = useState('');
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<AgentProjectStatus | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [gap, setGap] = useState<Gap>({ text: '正在读取缺项…', items: [], tone: 'ok' });
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachStage, setAttachStage] = useState('');
  const [dropActive, setDropActive] = useState(false);
  const [section, setSection] = useState(() => {
    try { return localStorage.getItem('pitguard-upload-section') || ''; } catch { return ''; }
  });
  const [runP3, setRunP3] = useState(() => {
    try { return localStorage.getItem('pitguard-upload-p3') === '1'; } catch { return false; }
  });
  const [batchAll, setBatchAll] = useState(() => {
    try { return localStorage.getItem('pitguard-upload-batch') === '1'; } catch { return false; }
  });
  const [apiOpen, setApiOpen] = useState(false);
  const [apiCfg, setApiCfg] = useState<ModelConfig | null>(null);
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [apiModelFast, setApiModelFast] = useState('');
  const [apiModelReasoning, setApiModelReasoning] = useState('');
  const [apiHosts, setApiHosts] = useState('');
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [modelTier, setModelTier] = useState<'flash' | 'pro'>('flash');
  const [apiTest, setApiTest] = useState<{ ok: boolean; reason?: string; latencyMs?: number; model?: string } | null>(null);
  const [apiBusy, setApiBusy] = useState(false);
  const [apiError, setApiError] = useState('');
  const [callLog, setCallLog] = useState<{
    calls: Array<{ id: number; createdAt: string; purpose: string; model: string; ok: boolean;
      promptTokens: number | null; completionTokens: number | null; durationMs: number }>;
    totals: { calls: number; promptTokens: number; completionTokens: number };
  } | null>(null);
  const [petOffset, setPetOffset] = useState<{ x: number; y: number }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PET_POS_KEY) || 'null');
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        return { x: saved.x, y: saved.y };
      }
    } catch (error) { void error; }
    return { x: 0, y: 0 };
  });
  const [dragging, setDragging] = useState(false);
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const threadRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);
  const noticeSeq = useRef(0);
  const lastSignature = useRef('');
  const dragRef = useRef<{
    startX: number; startY: number; baseX: number; baseY: number;
    moved: boolean; lastX?: number; lastY?: number;
  } | null>(null);
  const offsetRef = useRef(petOffset);
  const suppressClick = useRef(false);

  useEffect(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPetOffset((prev) => {
      const next = {
        x: Math.min(12, Math.max(78 - vw, prev.x)),
        y: Math.min(12, Math.max(78 - vh, prev.y)),
      };
      offsetRef.current = next;
      return next.x === prev.x && next.y === prev.y ? prev : next;
    });
  }, []);

  useEffect(() => {
    try { sessionStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch (error) { void error; }
  }, [open]);

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPetPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    dragRef.current = {
      startX: event.clientX, startY: event.clientY,
      baseX: offsetRef.current.x, baseY: offsetRef.current.y, moved: false,
    };
    setDragging(true);
  };

  // Listen on the window, not the launcher: the pointer leaves the 54px circle
  // almost immediately, and element-level listeners would stop receiving moves.
  useEffect(() => {
    if (!dragging) return;
    const clampOffset = (x: number, y: number) => ({
      x: Math.min(12, Math.max(78 - window.innerWidth, x)),
      y: Math.min(12, Math.max(78 - window.innerHeight, y)),
    });
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const px = event.clientX;
      const py = event.clientY;
      if ((px === 0 && py === 0) || px < 0 || py < 0
          || px > window.innerWidth || py > window.innerHeight) return;
      const dx = px - drag.startX;
      const dy = py - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      drag.lastX = px;
      drag.lastY = py;
      const next = clampOffset(drag.baseX + dx, drag.baseY + dy);
      offsetRef.current = next;
      setPetOffset(next);
    };
    const onUp = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      if (!drag) return;
      if (!drag.moved && drag.lastX !== undefined && drag.lastY !== undefined) {
        const dx = drag.lastX - drag.startX;
        const dy = drag.lastY - drag.startY;
        if (Math.hypot(dx, dy) >= 4) {
          drag.moved = true;
          const next = clampOffset(drag.baseX + dx, drag.baseY + dy);
          offsetRef.current = next;
          setPetOffset(next);
        }
      }
      if (!drag.moved) return;
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 350);
      try {
        localStorage.setItem(PET_POS_KEY, JSON.stringify(offsetRef.current));
      } catch (error) { void error; }
    };
    const onBlur = () => onUp();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [dragging]);

  const resetPetPosition = () => {
    const origin = { x: 0, y: 0 };
    offsetRef.current = origin;
    setPetOffset(origin);
    setOpen(false);
    try { localStorage.removeItem(PET_POS_KEY); } catch (error) { void error; }
  };

  const pushNotice = useCallback((kind: Notice['kind'], title: string, text: string) => {
    setNotices((prev) => {
      if (prev.some((n) => n.kind === kind && n.text === text)) return prev;
      const id = ++noticeSeq.current;
      if (kind === 'alert') {
        window.setTimeout(
          () => setNotices((current) => current.filter((n) => n.id !== id)),
          NOTICE_LIFETIME_MS,
        );
      }
      return [...prev, { id, kind, title, text }].slice(-2);
    });
  }, []);

  const dismissNotice = useCallback((id: number) => {
    setNotices((prev) => prev.filter((n) => n.id !== id));
  }, []);

  // Unattended state watch: runs whether or not the panel is open.
  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const { digest } = await api.agentProjectStatus(projectId);
        if (dead) return;
        setStatus(digest);
        const fail = digest.failCount ?? 0;
        const blockers = digest.blockers ?? [];
        const signature = [
          digest.statusUnavailable ? 'unavailable' : 'ok',
          fail, digest.warningCount ?? 0, blockers.join('|'),
        ].join('::');
        if (signature === lastSignature.current) return;
        lastSignature.current = signature;
        if (digest.statusUnavailable) {
          pushNotice('error', '工程状态读取失败', '未能读取当前工程状态，请检查后端服务。');
        } else if (fail > 0 || blockers.length) {
          const headline = fail > 0 ? `验算未通过 ${fail} 项` : `${blockers.length} 项待处理`;
          const detail = blockers.length ? blockers.slice(0, 2).join('；') : '打开助手查看当前缺项。';
          pushNotice('alert', headline, detail);
        }
      } catch (e) {
        if (!dead) pushNotice('error', '助手连接失败', String(e));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => { dead = true; window.clearInterval(timer); };
  }, [projectId, pushNotice]);

  const refreshGap = useCallback(async () => {
    try {
      const basis = await api.designBasisMissing(projectId);
      if (basis.count > 0) {
        setGap({ text: basis.text, items: basis.items.map((item) => item.label), tone: 'warn' });
        return;
      }
      const plan = await api.agentPlan(projectId);
      setGap(describeGap(plan));
    } catch (e) {
      setGap({ text: '缺项读取失败', items: [], tone: 'error' });
      void e;
    }
  }, [projectId]);

  // Conversation data is loaded on first open only.
  useEffect(() => {
    if (!open || loadedRef.current) return;
    loadedRef.current = true;
    let dead = false;
    (async () => {
      try {
        const list = await api.agentConversations(projectId);
        if (dead) return;
        const items = list.conversations ?? [];
        if (items.length) {
          setActiveId(items[0].id);
          return;
        }
        const created = await api.createAgentConversation(projectId, '设计助手会话');
        if (dead) return;
        setActiveId(created.id);
      } catch (e) {
        const text = String(e);
        if (!dead) setError(text);
        pushNotice('error', '助手加载失败', text);
      }
    })();
    return () => { dead = true; };
  }, [open, projectId, pushNotice]);

  useEffect(() => {
    if (!open) return;
    void refreshGap();
  }, [open, refreshGap]);

  useEffect(() => {
    if (!activeId) return;
    let dead = false;
    api.agentConversation(activeId)
      .then((data) => { if (!dead) setMessages(data.messages ?? []); })
      .catch((e) => { if (!dead) setError(String(e)); });
    return () => { dead = true; };
  }, [activeId]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const reloadMessages = useCallback(async () => {
    if (!activeId) return;
    const data = await api.agentConversation(activeId);
    setMessages(data.messages ?? []);
  }, [activeId]);

  const reportRouter = useCallback((result: SuperAgentTriggerResult) => {
    const execution = result.execution;
    if (execution && !execution.dispatched) {
      pushNotice('error', '总控未派单', execution.reason || result.reason);
      return;
    }
    const outcome = execution?.outcome;
    if (!outcome) {
      pushNotice('alert', '总控已记录', result.reason);
      return;
    }
    if (outcome.mode === 'chain') {
      // 连续执行：停在哪个闸口、下一步要人做什么，一次说清。
      const stage = outcome.currentStage?.title ?? '已完成';
      const actionNote = outcome.nextAction?.note ? ` ${outcome.nextAction.note}` : '';
      pushNotice(outcome.flowStatus === 'blocked' ? 'error' : 'alert',
        `连续执行 · ${stage}`, outcome.summary + actionNote);
      onProjectChanged?.();
      return;
    }
    if (outcome.mode === 'run_created') {
      // A5 诊断 / A6 优化：任务在后台跑，进展会作为消息回到对话框。
      pushNotice('alert', `${execution?.roleId ?? 'Agent'} 已受理`,
        `任务 ${String(outcome.run?.id ?? '').slice(0, 8)} 在后台执行（${outcome.run?.step ?? ''}），`
        + '诊断与候选复算结果会陆续回到这里；采用候选仍需人工复核。');
      onProjectChanged?.();
      return;
    } else if (outcome.mode === 'assessment') {
      // A2/A7/A8 的盘点与生成回执：现状、缺项建议，必要时附任务号。
      pushNotice('alert', outcome.label ?? '资料盘点',
        outcome.summary
        + (outcome.suggestedNext?.length ? ' 建议：' + outcome.suggestedNext.join('；') : ''));
      return;
    } else if (outcome.mode === 'filled') {
      pushNotice('alert', `已填入 ${outcome.applied.length} 项设计基准`,
        (outcome.remaining?.text ?? '')
        + (outcome.conflicts?.length
            ? `；其中 ${outcome.conflicts.length} 项覆盖了此前的自动录入值（已标记参数冲突，请核对）。`
            : '')
        + (outcome.requiresRecalculation ? '；原计算结果已失效，请重新验算。' : '')
        + (outcome.modelStatus === 'not_configured' ? '（模型未接入，按确定性规则抽取）' : ''));
      onProjectChanged?.();
    } else {
      pushNotice('alert', '未识别到可填字段', outcome.remaining?.text ?? '');
    }
    if (outcome.warnings?.length) {
      pushNotice('alert', '录入提示', outcome.warnings.join(' '));
    }
  }, [pushNotice, onProjectChanged]);

  async function send() {
    const text = draft.trim();
    if (!text || !activeId || busy) return;
    setBusy(true); setError('');
    setDraft('');
    try {
      // 不写死角色：后端按内容分流到 A1（参数录入）/ A5（诊断）/ A6（优化）。
      const result = await api.superTrigger({
        projectId, kind: 'user_message',
        payload: { text },
        conversationId: activeId, acceptMode: 'auto',
      });
      await reloadMessages();
      await refreshGap();
      reportRouter(result);
    } catch (e) {
      const message = String(e);
      setError(message);
      setDraft(text);
      pushNotice('error', '录入失败', message);
    } finally { setBusy(false); }
  }

  const ingestFile = useCallback(async (file: File) => {
    setAttachBusy(true); setError(''); setAttachStage('正在读取文件…');
    try {
      if (file.name.toLowerCase().endsWith('.pdf') && batchAll) {
        const started = await api.startCalculationBookBatch(file);
        setAttachStage('已提交，正在逐个剖面建模计算…');
        let status = await api.taskStatus(started.taskId);
        for (let i = 0; i < 600 && !['success', 'failed', 'cancelled'].includes(status.status); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          status = await api.taskStatus(started.taskId);
          setAttachStage(status.currentStep || '正在逐个剖面计算…');
        }
        if (status.status !== 'success') throw new Error(status.error || `批量未完成：${status.status}`);
        await refreshGap();
        onProjectChanged?.();
        pushNotice('alert', '多剖面批量完成', '每个剖面各建一个项目，汇总表已写入 exports/book-sections-summary-*.csv');
        return;
      }
      if (file.name.toLowerCase().endsWith('.pdf')) {
        const started = await api.startCalculationBookAutopilot(projectId, file, section || undefined, runP3);
        setAttachStage('已提交，正在解析计算书…');
        let status = await api.taskStatus(started.taskId);
        for (let i = 0; i < 300 && !['success', 'failed', 'cancelled'].includes(status.status); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2500));
          status = await api.taskStatus(started.taskId);
          setAttachStage(status.currentStep || '正在生成…');
        }
        if (status.status !== 'success') {
          throw new Error(status.error || `任务未完成：${status.status}`);
        }
        pushNotice('alert', '计算书已生成', '六阶段已跑完，成果包在“成果交付”里');
        await refreshGap();
        onProjectChanged?.();
        return;
      }
      let fields: Array<Record<string, unknown>> = [];
      if (file.name.toLowerCase().endsWith('.json')) {
        const parsed = JSON.parse(await file.text()) as {
          scalarParameters?: Array<Record<string, unknown>>;
          fields?: Array<Record<string, unknown>>;
        };
        fields = parsed.scalarParameters ?? parsed.fields ?? [];
      } else {
        const extracted = await api.extractAgentDocument(file);
        fields = extracted.fields.map((item) => ({
          key: FIELD_KEYS[item.key] ?? item.targetField.split('.').pop(),
          value: item.value, raw: item.raw, page: item.page,
        }));
      }
      const mapped = fields.map((item) => ({
        ...item,
        key: FIELD_KEYS[String(item.key)] ?? String(item.key),
      }));
      const result = await api.superTrigger({
        projectId, kind: 'document_uploaded',
        payload: { roleId: 'A1', fields: mapped, documentName: file.name },
        conversationId: activeId || undefined, acceptMode: 'auto',
      });
      await reloadMessages();
      await refreshGap();
      reportRouter(result);
    } catch (e) {
      const text = String(e);
      setError(text);
      pushNotice('error', '文件录入失败', text);
    } finally { setAttachBusy(false); setAttachStage(''); }
  }, [projectId, activeId, reloadMessages, refreshGap, reportRouter, pushNotice, onProjectChanged, section, runP3, batchAll]);

  const handleFileDragOver = useCallback((event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropActive(true);
  }, []);

  const handleFileDragLeave = useCallback((event: React.DragEvent) => {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    setDropActive(false);
  }, []);

  const handleFileDrop = useCallback((event: React.DragEvent) => {
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    event.preventDefault();
    setDropActive(false);
    setOpen(true);
    pushNotice('alert', '已接收计算书', `${file.name} 正在提交自动生成…`);
    void ingestFile(file);
  }, [ingestFile, pushNotice]);

  const openApiConfig = useCallback(async () => {
    setApiOpen(true); setApiError(''); setApiTest(null);
    try {
      const cfg = await api.modelConfiguration();
      setApiCfg(cfg);
      setApiBaseUrl(cfg.baseUrl ?? '');
      setApiModelFast(cfg.modelSlots?.fast ?? '');
      setApiModelReasoning(cfg.modelSlots?.reasoning ?? cfg.modelSlots?.fast ?? '');
      setApiHosts((cfg.allowedHosts ?? []).join(','));
      setModelTier(cfg.modelSlots?.fast && cfg.modelSlots?.fast === cfg.modelSlots?.reasoning ? 'pro' : 'flash');
      setApiKeyDraft('');
      setCallLog(await api.modelCallLog(6).catch(() => null));
    } catch (error) { setApiError(String(error)); }
  }, []);

  const saveApiConfig = useCallback(async () => {
    setApiBusy(true); setApiError('');
    try {
      const flash = apiModelFast.trim();
      const pro = (apiModelReasoning || apiModelFast).trim();
      const chosen = modelTier === 'pro' ? pro : flash;
      const payload: Record<string, string> = {
        ENABLE: apiCfg?.enabled ? '1' : '0',
        BASE_URL: apiBaseUrl.trim(),
        MODEL_FAST: chosen,
        MODEL_REASONING: chosen,
        ALLOWED_HOSTS: apiHosts.trim(),
      };
      if (apiKeyDraft.trim()) payload.API_KEY = apiKeyDraft.trim();
      const saved = await api.saveModelConfiguration(payload);
      setApiCfg(saved as unknown as ModelConfig);
      setApiKeyDraft('');
      pushNotice('alert', '模型接入已保存', '配置立即生效，无需重启服务');
    } catch (error) { setApiError(String(error)); }
    finally { setApiBusy(false); }
  }, [apiCfg, apiBaseUrl, apiModelFast, apiModelReasoning, apiHosts, apiKeyDraft, modelTier, pushNotice]);

  const testApiConfig = useCallback(async () => {
    setApiBusy(true); setApiError(''); setApiTest(null);
    try { setApiTest(await api.testModelConnection()); }
    catch (error) { setApiTest({ ok: false, reason: String(error) }); }
    finally {
      setApiBusy(false);
      setCallLog(await api.modelCallLog(6).catch(() => null));
    }
  }, []);

  useEffect(() => {
    try { localStorage.setItem('pitguard-upload-section', section); } catch { /* 忽略隐私模式 */ }
  }, [section]);
  useEffect(() => {
    try { localStorage.setItem('pitguard-upload-batch', batchAll ? '1' : '0'); } catch { /* 同上 */ }
  }, [batchAll]);
  useEffect(() => {
    try { localStorage.setItem('pitguard-upload-p3', runP3 ? '1' : '0'); } catch { /* 同上 */ }
  }, [runP3]);

  const failCount = status?.failCount ?? 0;
  const badge = status?.statusUnavailable || notices.some((n) => n.kind === 'error')
    ? '!'
    : failCount > 0 ? (failCount > 99 ? '99+' : String(failCount)) : '';

  const renderNotices = () => notices.map((notice) => (
    <div key={notice.id} className={`agentNotice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      <div>
        <strong>{notice.title}</strong>
        <p>{notice.text}</p>
        <button type="button" className="agentNoticeOpen" onClick={() => { dismissNotice(notice.id); setOpen(true); }}>
          打开助手
        </button>
      </div>
      <button type="button" className="agentNoticeClose" aria-label="关闭提醒" onClick={() => dismissNotice(notice.id)}>×</button>
    </div>
  ));

  // Open the dock toward whichever side has room, so dragging the pet to a
  // corner never pushes the conversation off screen.
  const ballRight = viewport.w - 20 + petOffset.x;
  const ballBottom = viewport.h - 20 + petOffset.y;
  const ballLeft = ballRight - 54;
  const ballTop = ballBottom - 54;
  const roomAbove = ballTop - 18;
  const roomBelow = viewport.h - ballBottom - 18;
  const vertical = roomAbove >= roomBelow ? 'above' : 'below';
  const roomRight = viewport.w - ballRight - 8;
  const roomLeft = ballLeft - 8;
  const panelWidth = Math.min(356, viewport.w - 40);
  const horizontal = roomRight >= panelWidth || roomRight >= roomLeft ? 'fromLeft' : 'fromRight';
  // 空面板也保持和对话态一样高：面板就该有面板的样子
  const dockHeight = Math.max(320, Math.min(620, vertical === 'above' ? roomAbove : roomBelow));
  const placement = `place-${vertical}-${horizontal}`;

  return (
    <div
      className={`agentPet ${placement} ${dragging ? 'isDragging' : ''} ${dropActive ? 'isDropActive' : ''}`}
      style={{ transform: `translate(${petOffset.x}px, ${petOffset.y}px)` }}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
    >
      {open ? (
        <aside className="agentDock" style={{ height: dockHeight }} aria-label="智能设计助手">
          {apiOpen ? (
            <div className="agentDockSettings">
              <header className="agentDockSettingsHead">
                <button type="button" className="agentDockBack" onClick={() => setApiOpen(false)}>← 返回</button>
                <strong>设置</strong>
              </header>
              <div className="agentDockSettingsBody">
                <div className="agentApiSectionTitle">上传</div>
                <label>剖面
                  <select value={section} onChange={(event) => setSection(event.target.value)}>
                    <option value="">自动（优先 2-2）</option>
                    <option value="1-1">1-1</option>
                    <option value="1'-1'">1'-1'</option>
                    <option value="2-2">2-2</option>
                    <option value="3-3">3-3</option>
                    <option value="3'-3'">3'-3'</option>
                    <option value="4-4">4-4</option>
                    <option value="4'-4'">4'-4'</option>
                    <option value="5-5">5-5</option>
                    <option value="5'-5'">5'-5'</option>
                    <option value="出土口">出土口</option>
                  </select>
                </label>
                <label className="agentApiToggle">
                  <input type="checkbox" checked={batchAll} onChange={(event) => setBatchAll(event.target.checked)} />
                  批量：全书每个剖面各算一遍（只算不出包，约 40 分钟）
                </label>
                <label className="agentApiToggle">
                  <input type="checkbox" checked={runP3} onChange={(event) => setRunP3(event.target.checked)} />
                  P3：出包后继续跑预埋件与套筒深化（耗时长）
                </label>
                <div className="agentApiSectionTitle">模型接入</div>
                <p className="agentApiHint">{apiCfg?.configured ? `已配置 ${apiCfg.keyHint ?? ''}` : '尚未配置 Key'}{apiCfg?.source ? ` · 来源 ${apiCfg.source}` : ''}</p>
                <label className="agentApiToggle">
                  <input type="checkbox" checked={Boolean(apiCfg?.enabled)}
                    onChange={(event) => setApiCfg((prev) => (prev ? { ...prev, enabled: event.target.checked } : prev))} />
                  启用（仅参数理解、路由、扫描件；不参与数值判定）
                </label>
                <label>服务地址
                  <input value={apiBaseUrl} onChange={(event) => setApiBaseUrl(event.target.value)} placeholder="https://…/v1" />
                </label>
                <div className="agentDockTier">
                  <span>模型</span>
                  <div>
                    <label className={modelTier === 'flash' ? 'on' : ''}>
                      <input type="radio" name="modelTier" checked={modelTier === 'flash'}
                        onChange={() => setModelTier('flash')} />
                      Flash
                    </label>
                    <label className={modelTier === 'pro' ? 'on' : ''}>
                      <input type="radio" name="modelTier" checked={modelTier === 'pro'}
                        onChange={() => setModelTier('pro')} />
                      Pro
                    </label>
                  </div>
                </div>
                <p className="agentApiHint">{modelTier === 'pro' ? (apiModelReasoning || apiModelFast) : apiModelFast}</p>
                <label>API Key
                  <input type="password" value={apiKeyDraft} onChange={(event) => setApiKeyDraft(event.target.value)}
                    placeholder={apiCfg?.configured ? '已保存，留空不改' : '粘贴 sk-…'} autoComplete="off" />
                </label>
                <div className="agentApiSectionTitle">调用记录</div>
                <p className="agentApiHint">
                  {callLog ? `共 ${callLog.totals.calls} 次 · 输入 ${callLog.totals.promptTokens} / 输出 ${callLog.totals.completionTokens}` : '正在读取…'}
                </p>
                {callLog?.calls?.length ? (
                  <ul className="agentApiCalls">
                    {callLog.calls.slice(0, 3).map((call) => (
                      <li key={call.id} className={call.ok ? '' : 'failed'}>
                        <span>{String(call.createdAt).slice(5, 16).replace('T', ' ')}</span>
                        <em>{call.purpose}</em>
                        <b>{call.promptTokens ?? '-'} / {call.completionTokens ?? '-'}</b>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {apiError ? <p className="agentApiError">{apiError}</p> : null}
                {apiTest ? (
                  <p className={apiTest.ok ? 'agentApiOk' : 'agentApiError'}>
                    {apiTest.ok ? `连通正常 · ${apiTest.latencyMs ?? '-'} ms` : `失败：${apiTest.reason ?? ''}`}
                  </p>
                ) : null}
              </div>
              <footer className="agentDockSettingsFoot">
                <button type="button" onClick={() => void saveApiConfig()} disabled={apiBusy}>{apiBusy ? '处理中…' : '保存'}</button>
                <button type="button" className="secondary" onClick={() => void testApiConfig()} disabled={apiBusy}>测试连接</button>
              </footer>
            </div>
          ) : (<>
          <header className="agentDockHeader">
            <div>
              <strong>智能设计助手</strong>
              <span>{projectName || '当前项目'}</span>
            </div>
            <div className="agentDockHeaderActions">
              <button type="button" className="agentDockGear" title="设置" onClick={() => void openApiConfig()}>⚙</button>
              <button type="button" className="secondary" onClick={() => setOpen(false)}>收起</button>
            </div>
          </header>

          <div className={`agentDockGap ${gap.tone}`} role="status" title={gap.text}>
            {gap.text}
          </div>

          <div className={`agentDockBody ${messages.length ? 'hasMessages' : ''}`} ref={threadRef}>
            {messages.map((message) => (
              message.role === 'tool' ? (
                <article key={message.id} className="agentMessage tool">
                  <small>任务 · {new Date(message.createdAt).toLocaleTimeString()}</small>
                  <p>{message.content}</p>
                </article>
              ) : (
                <article key={message.id} className={`agentMessage ${message.role}`}>
                  <small>
                    {message.role === 'user' ? '我' : '助手'}
                    {' · '}{new Date(message.createdAt).toLocaleTimeString()}
                  </small>
                  <p>{message.content}</p>
                </article>
              )
            ))}
          </div>

          <footer className="agentDockCompose">
            <div className="agentDockComposeInput">
              <textarea
                className="agentDockInput"
                rows={3}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
                }}
                placeholder={attachBusy
                  ? (attachStage || '正在读取文件…')
                  : '把 PDF / Excel / Word / 图片 拖进来；也可以直接说：施工荷载改成 35kPa'}
                aria-label="向智能设计助手提问"
              />
              <button type="button" className="agentDockSend" onClick={() => void send()} disabled={busy || attachBusy || !draft.trim()}>
                {busy ? '发送中' : '发送'}
              </button>
            </div>
          </footer>

          {error ? <p className="agentDockError" role="alert">{error}</p> : null}
          </>)}
        </aside>
      ) : (
        notices.length ? <div className="agentDockToasts">{renderNotices()}</div> : null
      )}

      <div className="agentPetLauncherWrap">
        <button
          type="button"
          className={`agentPetLauncher ${open ? 'isOpen' : ''} ${badge ? 'hasBadge' : ''}`}
          onPointerDown={onPetPointerDown}
          onDragStart={(event) => event.preventDefault()}
          onDoubleClick={resetPetPosition}
          onClick={() => {
            if (suppressClick.current) { suppressClick.current = false; return; }
            setOpen((prev) => !prev);
          }}
          aria-label={open ? '收起智能设计助手' : '打开智能设计助手'}
          aria-expanded={open}
          title={open ? '收起助手 · 可拖动，双击回原位'
            : `智能设计助手${badge ? ` · ${badge} 项需关注` : ''} · 拖动移动，双击回原位`}
        >
          {open
            ? <span className="agentPetGlyph">×</span>
            : <img className="agentPetLogo" src="/assistant-logo.jpg" alt="" draggable={false} />}
        </button>
        {badge ? <span className="agentPetBadge">{badge}</span> : null}
      </div>



    </div>
  );
}
