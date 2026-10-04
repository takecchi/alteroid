// @vitest-environment jsdom
/**
 * 稼働状況の図の大きさ。図は viewBox を枠へ伸ばして描くので、**広い枠で図も文字も大きくならない**こと
 * （描画幅の上限）と、**狭い枠では縮みすぎず木へ倒れる**ことを確かめる。jsdom は幅を測れないので
 * `ResizeObserver` を偽の幅で差し替える。
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { busyScene, idleScene } from './samples';
import { SystemTopology, WIDE_MIN_WIDTH } from './system-topology';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFrameWidth(width: number) {
  class FakeObserver {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe() {
      this.cb([{ contentRect: { width } } as ResizeObserverEntry], this as never);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', FakeObserver);
  // `useIsMobile` の入口。枠の幅が測れる間は配置の決定には使われない（札の押し方だけ）。
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
}

const viewBoxWidth = (container: HTMLElement) =>
  Number(container.querySelector('svg')!.getAttribute('viewBox')!.split(' ')[2]);
const figureMaxWidth = (container: HTMLElement) =>
  container.querySelector('figure')!.style.maxWidth;

describe('SystemTopology の大きさ', () => {
  it.each([1000, 1104, 2400])(
    '広い枠（%ipx）では横の配置で、描画幅は 1152px（倍率 1.0） を超えない',
    (w) => {
      stubFrameWidth(w);
      const { container } = render(<SystemTopology {...busyScene} />);
      expect(viewBoxWidth(container)).toBeGreaterThan(1000);
      expect(figureMaxWidth(container)).toBe('1152px');
    },
  );

  it.each([WIDE_MIN_WIDTH - 1, 600, 360])(
    '狭い枠（%ipx）では木（縦の配置）へ倒れ、描画幅は 360px（等倍）を超えない',
    (w) => {
      stubFrameWidth(w);
      const { container } = render(<SystemTopology {...busyScene} />);
      expect(viewBoxWidth(container)).toBe(360);
      expect(figureMaxWidth(container)).toBe('360px');
    },
  );

  it('layout を固定すれば枠の幅に関わらずそれに従う', () => {
    stubFrameWidth(2400);
    const { container } = render(<SystemTopology {...busyScene} layout="narrow" />);
    expect(viewBoxWidth(container)).toBe(360);
  });
});

describe('器の枠の状態（#2706）', () => {
  const containerOf = (c: HTMLElement, key: string) =>
    c.querySelector(`[data-container="${key}"]`)!;

  it('runner が unknown なら「— 不明」と破線で言い、ok の器には何も足さない', () => {
    stubFrameWidth(1000);
    const { container } = render(<SystemTopology {...busyScene} runner={{ status: 'unknown' }} />);
    const runner = containerOf(container, 'runner');
    expect(runner.textContent).toContain('— 不明');
    expect(runner.querySelector('rect')!.getAttribute('stroke-dasharray')).toBe('6 4');
    const db = containerOf(container, 'db');
    expect(db.textContent).not.toContain('不明');
    expect(db.querySelector('rect')!.getAttribute('stroke-dasharray')).toBeNull();
  });

  it('offline は「— 未接続」のまま', () => {
    stubFrameWidth(1000);
    const { container } = render(<SystemTopology {...busyScene} runner={{ status: 'offline' }} />);
    expect(containerOf(container, 'runner').textContent).toContain('— 未接続');
  });
});

describe('読めない委譲の行（#2705）', () => {
  it('地図が空で unreadableCount が在れば、居ないと言い切らず件数を言う', () => {
    stubFrameWidth(1000);
    const { container } = render(<SystemTopology {...idleScene} unreadableCount={3} />);
    expect(container.textContent).toContain('読めない行が 3 件ある。居ないとは限らない');
    expect(container.textContent).not.toContain('走っているマネージャーはいません');
  });

  it('対照: 欄が無ければ従来の文言', () => {
    stubFrameWidth(1000);
    const { container } = render(<SystemTopology {...idleScene} />);
    expect(container.textContent).toContain('走っているマネージャーはいません');
  });
});
