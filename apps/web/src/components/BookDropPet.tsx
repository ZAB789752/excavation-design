import { useCallback, useRef, useState } from 'react';
import { api } from '../api/client';
import '../features/agent/assistant-panel.css';
import './book-drop-pet.css';

export default function BookDropPet({ onImported }: { onImported: () => void }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [offset, setOffset] = useState<{ x: number; y: number }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('pitguard-agent-pet-pos-v2') || 'null');
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return { x: saved.x, y: saved.y };
    } catch { /* 忽略 */ }
    return { x: 0, y: 0 };
  });
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startY: event.clientY, baseX: offset.x, baseY: offset.y, moved: false };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    const next = { x: drag.baseX + dx, y: drag.baseY + dy };
    setOffset(next);
    try { localStorage.setItem('pitguard-agent-pet-pos-v2', JSON.stringify(next)); } catch { /* 忽略 */ }
  };
  const onPointerUp = () => {
    if (dragRef.current?.moved) suppressClick.current = true;
    dragRef.current = null;
  };

  const ingest = useCallback(async (file: File) => {
    setBusy(true); setError(''); setDone(''); setOpen(true);
    setStage('正在识别剖面…');
    try {
      const started = await api.importCalculationBook(file);
      if (started.mode === 'single') {
        setStage('只有一个剖面，正在生成…');
      } else {
        setStage(`识别到 ${started.count ?? 0} 个剖面，正在逐个计算…`);
      }
      let status = await api.taskStatus(started.taskId);
      for (let i = 0; i < 900 && !['success', 'failed', 'cancelled'].includes(status.status); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        status = await api.taskStatus(started.taskId);
        setStage(status.currentStep || '正在处理…');
      }
      if (status.status !== 'success') throw new Error(status.error || `任务未完成：${status.status}`);
      setDone(started.mode === 'group'
        ? `已生成 ${started.count ?? 0} 个剖面项目，点击列表里的分组展开`
        : '已生成 1 个项目');
      onImported();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false); setStage('');
    }
  }, [onImported]);

  return (
    <div
      className={`bookPet ${hover ? 'isOver' : ''}`}
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault(); setHover(true); setOpen(true);
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && event.currentTarget.contains(next)) return;
        setHover(false);
      }}
      onDrop={(event) => {
        const file = event.dataTransfer.files?.[0];
        if (!file) return;
        event.preventDefault(); setHover(false);
        void ingest(file);
      }}
    >
      {open ? (
        <section className="bookPetCard">
          <header>
            <strong>拖入计算书</strong>
            <button type="button" onClick={() => setOpen(false)}>收起</button>
          </header>
          <p>{busy ? (stage || '处理中…') : done || error || '把 PDF 拖到这张卡片上，自动识别剖面数'}</p>
          {!busy && !done && !error ? (
            <small>一个剖面 → 直接生成一个项目；多个剖面 → 生成可展开的分组</small>
          ) : null}
          {error ? <small className="bookPetError">{error}</small> : null}
        </section>
      ) : null}
      <button
        type="button"
        className="bookPetBall"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDragStart={(event) => event.preventDefault()}
        onDoubleClick={() => {
          setOffset({ x: 0, y: 0 });
          try { localStorage.removeItem('pitguard-agent-pet-pos-v2'); } catch { /* 忽略 */ }
        }}
        onClick={() => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          setOpen((prev) => !prev);
        }}
        aria-label="拖入计算书"
        title="拖入计算书 · 可拖动，双击回原位"
      >
        {busy ? <span className="bookPetSpin" /> : <img src="/assistant-logo.jpg" alt="" draggable={false} />}
      </button>
    </div>
  );
}
