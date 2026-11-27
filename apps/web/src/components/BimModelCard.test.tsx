import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BimModelCard from './BimModelCard';

const { generateBimModel, exportUrl, bimModelFileUrl } = vi.hoisted(() => ({
  generateBimModel: vi.fn(async () => ({
    profile: 'detailed', mode: 'design_detailed', description: '语义详细模型', filename: 'p.ifc', sizeMB: 20.01,
    downloadUrl: '/api/projects/project-1/export/ifc?mode=design_detailed', generatedAt: '',
    pileCount: 226, rebarCount: 13431, wallCount: 4, beamCount: 35, columnCount: 12,
    counts: {}, validation: { score: 100, status: 'pass' }, notes: [],
  })),
  exportUrl: vi.fn((id: string, kind: string) => `/api/projects/${id}/export/${kind}`),
  bimModelFileUrl: vi.fn((id: string, mode: string) => `/api/projects/${id}/export/bim/file?mode=${mode}`),
}));

// 真查看器要 WebGL 和 web-ifc；这里换成一个只把收到的地址显示出来的桩
vi.mock('./BimViewer', () => ({
  default: ({ url }: { url: string }) => <p data-testid="viewer-url">{url}</p>,
}));
vi.mock('../api/client', () => ({ api: { generateBimModel, exportUrl, bimModelFileUrl } }));

describe('BimModelCard', () => {
  it('opens the rebar preview from the read-only file endpoint', async () => {
    render(<BimModelCard projectId="project-1" />);
    fireEvent.click(screen.getByRole('button', { name: '生成模型' }));
    fireEvent.click(await screen.findByRole('button', { name: '三维预览（含钢筋）' }));

    expect((await screen.findByTestId('viewer-url')).textContent)
      .toBe('/api/projects/project-1/export/bim/file?mode=design_detailed');
    // 打开预览不能再触发生成：生成要十几秒，还会往项目里写导出记录
    expect(generateBimModel).toHaveBeenCalledTimes(1);
    expect(bimModelFileUrl).toHaveBeenCalledWith('project-1', 'design_detailed');
  });

  it('opens the light preview from the same endpoint', async () => {
    render(<BimModelCard projectId="project-1" />);
    fireEvent.click(screen.getByRole('button', { name: '生成模型' }));
    fireEvent.click(await screen.findByRole('button', { name: '轻量预览（快）' }));

    expect((await screen.findByTestId('viewer-url')).textContent)
      .toBe('/api/projects/project-1/export/bim/file?mode=coordination_light');
  });
});
