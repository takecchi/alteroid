// @vitest-environment jsdom
/**
 * 稼働状況の図の大きさ。図は viewBox を枠へ伸ばして描くので、**広い枠で図も文字も大きくならない**こと
 * （描画幅の上限）と、**狭い枠では縮みすぎず木へ倒れる**ことを確かめる。jsdom は幅を測れないので
 * `ResizeObserver` を偽の幅で差し替える。
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { awaitingScene, busyScene, externalsScene, idleScene, usageBlockedScene } from './samples';
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

describe('札の文言（#2726）', () => {
  it('idle は「仕事なし」、awaiting は「完了待ち」と言い、「待機」とは言わない', () => {
    stubFrameWidth(1000);
    const { container } = render(<SystemTopology {...awaitingScene} />);
    const names = Array.from(container.querySelectorAll('button')).map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(names.some((n) => /^クローン .*完了待ち$/.test(n ?? ''))).toBe(true);
    expect(names).toContain('マネージャー mgr-7f3a 完了待ち');
    expect(names).toContain('マネージャー mgr-c019 仕事なし');
    expect(names).toContain('作業者 implementer 不明');
    expect(container.textContent).not.toContain('待機');
  });
});

describe('利用枠の上限で止まっている札', () => {
  it('枠で止まったマネージャーはクローンと同じ「止まっている」で、仕事なしと区別され、読み上げに理由が出る', () => {
    stubFrameWidth(1000);
    const { container } = render(<SystemTopology {...usageBlockedScene} />);
    const names = Array.from(container.querySelectorAll('button')).map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(names.some((n) => /^クローン .*止まっている$/.test(n ?? ''))).toBe(true);
    expect(names).toContain('マネージャー mgr-7f3a 止まっている');
    expect(names).toContain('マネージャー mgr-c019 仕事なし');
    const summary = container.querySelector('figcaption')?.textContent ?? '';
    expect(summary).toContain('マネージャー mgr-7f3a: 止まっている（利用枠の上限で止まっている:');
    expect(summary).toContain('マネージャー mgr-c019: 仕事なし');
  });
});

describe('器の枠の状態（#2706）', () => {
  const containerOf = (c: HTMLElement, key: string) =>
    c.querySelector(`[data-container="${key}"]`)!;

  it('器の分からない委譲は「— 不明」の破線の枠へ入れ、ok の器には何も足さない', () => {
    stubFrameWidth(1000);
    const { container } = render(
      <SystemTopology
        {...busyScene}
        managers={[{ ...busyScene.managers[0]!, runner: undefined }]}
      />,
    );
    const runner = containerOf(container, 'runner:unknown-runner');
    expect(runner.textContent).toContain('器の分からない委譲');
    expect(runner.textContent).toContain('— 不明');
    expect(runner.querySelector('rect')!.getAttribute('stroke-dasharray')).toBe('6 4');
    expect(containerOf(container, 'runner:r1').textContent).not.toContain('不明');
    const db = containerOf(container, 'db');
    expect(db.textContent).not.toContain('不明');
    expect(db.querySelector('rect')!.getAttribute('stroke-dasharray')).toBeNull();
  });

  it('offline は「— 未接続」のまま', () => {
    stubFrameWidth(1000);
    const { container } = render(
      <SystemTopology
        {...busyScene}
        runners={busyScene.runners.map((r) => ({ ...r, status: 'offline' as const }))}
      />,
    );
    expect(containerOf(container, 'runner:r1').textContent).toContain('— 未接続');
  });
});

describe('読めない委譲の行（#2705）', () => {
  it('地図が空で unreadableCount が在れば、居ないと言い切らず件数を言う', () => {
    stubFrameWidth(1000);
    const { container } = render(<SystemTopology {...idleScene} unreadableCount={3} />);
    expect(container.textContent).toContain('読めない行が 3 件ある。居ないとは限らない');
    expect(container.textContent).not.toContain('走っているマネージャーはいません');
  });

  it('対照: 欄が無ければ従来の文言（器は在る）', () => {
    stubFrameWidth(1000);
    const { container } = render(<SystemTopology {...idleScene} />);
    expect(container.textContent).toContain('走っているマネージャーはいません');
  });

  describe('居ない旨は器（runner）の枠ごと', () => {
    const NONE = '走っているマネージャーはいません';
    const two = {
      ...idleScene,
      runners: [
        { id: 'r1', label: 'runner-primary', status: 'ok' as const },
        { id: 'r2', label: 'runner-2', status: 'ok' as const },
      ],
    };
    const mgr = (status: 'running' | 'waiting', runner: string) => ({
      id: `m-${runner}`,
      runner,
      label: `mgr-${runner}`,
      status,
    });
    const frame = (c: HTMLElement, key: string) =>
      c.querySelector(`[data-container="runner:${key}"]`)!;
    // 枠の中の案内かどうかは、案内の箱が枠の矩形に収まるかで測る
    const noteInside = (c: HTMLElement, key: string) => {
      const rect = frame(c, key).querySelector('rect')!;
      const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((a) => Number(rect.getAttribute(a)));
      return [...c.querySelectorAll('foreignObject')].filter((fo) => {
        const fx = Number(fo.getAttribute('x'));
        const fy = Number(fo.getAttribute('y'));
        return fo.textContent === NONE && fx >= x! && fy >= y! && fy <= y! + h! && fx <= x! + w!;
      }).length;
    };

    it.each([1000, 360])(
      'primary が空で runner-2 に居る（%ipx）: 案内は primary の枠にだけ',
      (w) => {
        stubFrameWidth(w);
        const { container } = render(<SystemTopology {...two} managers={[mgr('running', 'r2')]} />);
        expect(noteInside(container, 'r1')).toBe(1);
        expect(noteInside(container, 'r2')).toBe(0);
        expect(container.textContent!.split(NONE)).toHaveLength(2);
        expect(frame(container, 'r2').textContent).toContain('runner-2');
      },
    );

    it('全部の器で居なければ、器ごとに1つずつ出る', () => {
      stubFrameWidth(1000);
      const { container } = render(<SystemTopology {...two} managers={[]} />);
      expect(noteInside(container, 'r1')).toBe(1);
      expect(noteInside(container, 'r2')).toBe(1);
      expect(container.textContent!.split(NONE)).toHaveLength(3);
    });

    it('枠で止まっている札だけの器には出さない（止まっている札を図に出す側）', () => {
      stubFrameWidth(1000);
      const { container } = render(<SystemTopology {...two} managers={[mgr('waiting', 'r1')]} />);
      expect(noteInside(container, 'r1')).toBe(0);
      expect(noteInside(container, 'r2')).toBe(1);
      expect(container.textContent).toContain('止まっている');
    });

    it('読めない行が在れば、空の器ごとに「居ないとは限らない」と言い、居ないと言い切らない', () => {
      stubFrameWidth(1000);
      const { container } = render(<SystemTopology {...two} managers={[]} unreadableCount={2} />);
      expect(container.textContent).not.toContain(NONE);
      expect(container.textContent!.split('居ないとは限らない')).toHaveLength(3);
    });
  });

  it('器が0台なら大枠を出さず「稼働中の器はありません」', () => {
    stubFrameWidth(1000);
    const { container } = render(<SystemTopology {...idleScene} runners={[]} />);
    expect(container.textContent).toContain('稼働中の器（runner）はありません');
    expect(container.querySelector('[data-container^="runner"]')).toBeNull();
  });

  it('器ごとに枠が1つずつ出る（manager-runner の大枠は無い）', () => {
    stubFrameWidth(1000);
    const { container } = render(<SystemTopology {...busyScene} />);
    expect(container.textContent).toContain('runner-primary');
    expect(container.textContent).toContain('runner-2');
    expect(container.textContent).not.toContain('manager-runner');
  });
});

describe('器と札の名前（#2772）', () => {
  /** 図が見せる文字（枠の名前の <text> と札のボタン）。ツールチップ（<title>）と読み上げは含めない。 */
  const visibleText = (container: HTMLElement) =>
    [
      ...container.querySelectorAll('[data-container] text'),
      ...container.querySelectorAll('button'),
    ]
      .map((e) => e.textContent)
      .join(' ');

  it.each([
    ['広い配置', 1000],
    ['狭い配置', 300],
  ])('%s: 内部の英字の名前（alteroidd・db・clone・Web UI / CLI）を見せない', (_, w) => {
    stubFrameWidth(w);
    const { container } = render(<SystemTopology {...busyScene} />);
    const text = visibleText(container);
    expect(text).toContain('alteroid 本体');
    expect(text).toContain('記憶の置き場');
    expect(text).not.toContain('alteroidd');
    expect(text).not.toMatch(/\bdb\b/);
    expect(text).not.toContain('clone');
    expect(text).not.toContain('Web UI');
    expect(text).not.toContain('CLI');
    expect(text).not.toContain('manager-runner');
  });

  it('runner の枠の名前（runner-N）はそのまま出る', () => {
    stubFrameWidth(1000);
    const { container } = render(<SystemTopology {...busyScene} />);
    expect(visibleText(container)).toContain('runner-primary');
    expect(visibleText(container)).toContain('runner-2');
  });

  it('英字の正式名はツールチップに残し、枠の鍵は変えない', () => {
    stubFrameWidth(1000);
    const { container } = render(<SystemTopology {...busyScene} />);
    expect(container.querySelector('[data-container="daemon"] title')!.textContent).toContain(
      'alteroidd',
    );
    expect(container.querySelector('[data-container="db"] title')!.textContent).toContain('db');
  });
});

describe('外部サービスの札（Issue #3676）', () => {
  it.each([1000, 360])(
    '（%ipx）札は外部サービスとして出て、状態は言わず、光る線は down の1本だけ',
    (w) => {
      stubFrameWidth(w);
      const { container } = render(<SystemTopology {...externalsScene} />);
      const names = Array.from(container.querySelectorAll('button')).map((b) =>
        b.getAttribute('aria-label'),
      );
      // 状態（正常・仕事なし等）を付けない。外部サービスの状態は観測していない。
      expect(names).toContain('外部サービス GitHub 連携');
      expect(names).toContain('外部サービス CI');
      expect(names).toContain('外部サービス ほか 2 件');
      // 光（Pulse）はアクティブな線だけ。down の `GitHub 連携` の線に、下りの色の光が流れる
      const lit = container.querySelector('[data-edge="x-external:k1"]')!;
      expect(lit.querySelector('animateMotion')).not.toBeNull();
      expect(lit.querySelector('.fill-primary')).not.toBeNull();
      expect(container.querySelector('[data-edge="x-external:k2"] animateMotion')).toBeNull();
      expect(container.querySelector('[data-edge="x-external-others"] animateMotion')).toBeNull();
    },
  );

  it('読み上げには名前と最後の呼び出しが出て、いま呼ばれた札はそれも言う', () => {
    stubFrameWidth(1000);
    const { container } = render(<SystemTopology {...externalsScene} />);
    const summary = container.querySelector('figcaption')?.textContent ?? '';
    expect(summary).toContain('外部サービス GitHub 連携（最後の呼び出し: たった今）。いま呼ばれた');
    expect(summary).toContain('外部サービス CI（最後の呼び出し: 3 分前）');
  });

  it('外部が無い場面には外部の札も線も出ない（今までと同じ）', () => {
    stubFrameWidth(1000);
    const { container } = render(<SystemTopology {...idleScene} />);
    expect(container.querySelector('[data-edge^="x-"]')).toBeNull();
    expect(container.textContent).not.toContain('外部サービス');
  });
});
