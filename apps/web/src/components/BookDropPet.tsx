import { useCallback, useState } from 'react';
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
        onClick={() => setOpen((prev) => !prev)}
        aria-label="拖入计算书"
        title="拖入计算书：自动识别剖面并生成项目"
      >
        {busy ? <span className="bookPetSpin" /> : <img src="/assistant-logo.jpg" alt="" draggable={false} />}
      </button>
    </div>
  );
}
