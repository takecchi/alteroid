import { describe, expect, it } from 'vitest';

import {
  layoutNarrow,
  layoutWide,
  roundedPath,
  type Box,
  type Point,
  type TopologyLayout,
  type TopologyScene,
} from './layout';

/**
 * 線を折れ線にして出口と幹を線ごとに分けたのは、光の粒がどの線を走っているかを
 * 読めるようにするためである。**その約束 —— 別々の線が重ならない・交わらない・札を
 * 突き抜けない —— を、マネージャー 0〜8 本 × 作業者 0〜4 人の組み合わせで総当たりに測る。**
 */

interface Seg {
  edge: string;
  a: Point;
  b: Point;
}

function segments(layout: TopologyLayout): Seg[] {
  return layout.edges.flatMap((e) =>
    e.points.slice(1).map((b, i) => ({ edge: e.key, a: e.points[i]!, b })),
  );
}

const horizontal = (s: Seg) => s.a.y === s.b.y;
const lo = (p: number, q: number) => Math.min(p, q);
const hi = (p: number, q: number) => Math.max(p, q);

/** 別の線の2区間が、重なる（同じ直線上で長さを持って被る）か交わるか。 */
function clash(s: Seg, t: Seg): boolean {
  if (horizontal(s) === horizontal(t)) {
    if (horizontal(s)) {
      if (s.a.y !== t.a.y) return false;
      return (
        Math.min(hi(s.a.x, s.b.x), hi(t.a.x, t.b.x)) -
          Math.max(lo(s.a.x, s.b.x), lo(t.a.x, t.b.x)) >
        0
      );
    }
    if (s.a.x !== t.a.x) return false;
    return (
      Math.min(hi(s.a.y, s.b.y), hi(t.a.y, t.b.y)) - Math.max(lo(s.a.y, s.b.y), lo(t.a.y, t.b.y)) >
      0
    );
  }
  const [h, v] = horizontal(s) ? [s, t] : [t, s];
  return (
    v.a.x >= lo(h.a.x, h.b.x) &&
    v.a.x <= hi(h.a.x, h.b.x) &&
    h.a.y >= lo(v.a.y, v.b.y) &&
    h.a.y <= hi(v.a.y, v.b.y)
  );
}

/** 区間が札の内側（縁を除く）を通るか。線は札の縁で止まるので、内側に入ったら突き抜けている。 */
function piercesBox(s: Seg, box: Box): boolean {
  const inside = (x: number, y: number) =>
    x > box.x + 0.5 && x < box.x + box.w - 0.5 && y > box.y + 0.5 && y < box.y + box.h - 0.5;
  for (let t = 0; t <= 1; t += 1 / 64) {
    if (inside(s.a.x + (s.b.x - s.a.x) * t, s.a.y + (s.b.y - s.a.y) * t)) return true;
  }
  return false;
}

function scene(workerCounts: readonly number[]): TopologyScene {
  return {
    human: { flow: 'down' },
    clone: { status: 'running' },
    db: { status: 'running', flow: 'both' },
    runner: { status: 'running' },
    managers: workerCounts.map((n, i) => ({
      id: `m${i}`,
      label: `m${i}`,
      status: 'running',
      flow: 'down',
      workers: Array.from({ length: n }, (_, j) => ({
        id: `m${i}w${j}`,
        label: `w${j}`,
        status: 'running',
        flow: 'up',
      })),
    })),
  };
}

const shapes: number[][] = [[]];
for (let n = 1; n <= 8; n++) {
  shapes.push(Array.from({ length: n }, () => 0));
  shapes.push(Array.from({ length: n }, (_, i) => i % 5));
  shapes.push(Array.from({ length: n }, (_, i) => 4 - (i % 5)));
}

describe.each([
  ['wide', layoutWide],
  ['narrow', layoutNarrow],
] as const)('%s の配置', (_name, layout) => {
  it.each(shapes.map((s) => [JSON.stringify(s), s] as const))(
    '作業者 %s のとき、別々の線は重ならず交わらない',
    (_label, counts) => {
      const segs = segments(layout(scene(counts)));
      const clashes = segs.flatMap((s, i) =>
        segs
          .slice(i + 1)
          .filter((t) => t.edge !== s.edge && clash(s, t))
          .map((t) => `${s.edge} × ${t.edge}`),
      );
      expect(clashes).toEqual([]);
    },
  );

  it.each(shapes.map((s) => [JSON.stringify(s), s] as const))(
    '作業者 %s のとき、線は札を突き抜けない',
    (_label, counts) => {
      const laid = layout(scene(counts));
      const pierced = segments(laid).flatMap((s) =>
        laid.nodes.filter((n) => piercesBox(s, n.box)).map((n) => `${s.edge} → ${n.key}`),
      );
      expect(pierced).toEqual([]);
    },
  );

  it('どの線も、その両端の札の edges に名前が載っている（ホバーで強調できる）', () => {
    const laid = layout(scene([2, 0, 1]));
    for (const e of laid.edges) {
      const owners = laid.nodes.filter((n) => n.edges.includes(e.key));
      expect(owners.length, e.key).toBe(2);
    }
  });
});

describe('roundedPath', () => {
  it('角を丸め、始点と終点は動かさない', () => {
    const d = roundedPath([
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 40 },
    ]);
    expect(d).toBe('M 0 0 L 32 0 Q 40 0 40 8 L 40 40');
  });

  it('短い区間では、半径を区間の半分まで縮める', () => {
    const d = roundedPath([
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 6 },
      { x: 80, y: 6 },
    ]);
    expect(d).toBe('M 0 0 L 37 0 Q 40 0 40 3 L 40 3 Q 40 6 43 6 L 80 6');
  });
});

describe('器の状態（#2706）', () => {
  const states = (l: TopologyLayout) =>
    Object.fromEntries(l.containers.map((c) => [c.key, c.state]));

  it.each([
    ['wide', layoutWide],
    ['narrow', layoutNarrow],
  ] as const)('%s: runner / db の状態が器へ載る。unknown は ok と別', (_name, layout) => {
    const base = scene([1]);
    expect(states(layout(base))).toEqual({ db: 'ok', daemon: 'ok', runner: 'ok' });
    expect(states(layout({ ...base, runner: { status: 'unknown' } })).runner).toBe('unknown');
    expect(states(layout({ ...base, runner: { status: 'offline' } })).runner).toBe('offline');
    expect(states(layout({ ...base, db: { status: 'unknown' } })).db).toBe('unknown');
    expect(states(layout({ ...base, db: { status: 'offline' } })).db).toBe('offline');
  });
});
