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
    runners: [{ id: 'r1', label: 'runner-1', status: 'ok' }],
    managers: workerCounts.map((n, i) => ({
      id: `m${i}`,
      runner: 'r1',
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
    expect(states(layout(base))).toEqual({ db: 'ok', daemon: 'ok', 'runner:r1': 'ok' });
    expect(
      states(layout({ ...base, runners: [{ id: 'r1', label: 'runner-1', status: 'offline' }] }))[
        'runner:r1'
      ],
    ).toBe('offline');
    expect(states(layout({ ...base, db: { status: 'unknown' } })).db).toBe('unknown');
    expect(states(layout({ ...base, db: { status: 'offline' } })).db).toBe('offline');
  });
});

describe('器ごとの枠', () => {
  const two: TopologyScene = {
    ...scene([0, 2, 0]),
    runners: [
      { id: 'r1', label: 'runner-1', status: 'ok' },
      { id: 'r2', label: 'runner-2', status: 'ok' },
    ],
  };
  const withRunners = (ids: (string | undefined)[]): TopologyScene => ({
    ...two,
    managers: two.managers.map((m, i) => ({ ...m, runner: ids[i] })),
  });
  const inside = (outer: Box, b: Box) =>
    b.x >= outer.x &&
    b.y >= outer.y &&
    b.x + b.w <= outer.x + outer.w &&
    b.y + b.h <= outer.y + outer.h;

  it.each([
    ['wide', layoutWide],
    ['narrow', layoutNarrow],
  ] as const)(
    '%s: 器ごとに1枠。大枠は無く、各マネージャーと作業者は自分の器の枠の中に居る',
    (_n, layout) => {
      const l = layout(withRunners(['r1', 'r2', 'r1']));
      const keys = l.containers.map((c) => c.key);
      expect(keys).toContain('runner:r1');
      expect(keys).toContain('runner:r2');
      expect(keys).not.toContain('runner');
      const box = (key: string) => l.containers.find((c) => c.key === key)!.box;
      const node = (key: string) => l.nodes.find((n) => n.key === key)!.box;
      expect(inside(box('runner:r1'), node('m-m0'))).toBe(true);
      expect(inside(box('runner:r1'), node('m-m2'))).toBe(true);
      expect(inside(box('runner:r2'), node('m-m1'))).toBe(true);
      expect(inside(box('runner:r2'), node('w-m1w0'))).toBe(true);
      // 枠どうしは重ならない
      const a = box('runner:r1');
      const b = box('runner:r2');
      expect(a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
    },
  );

  it.each([
    ['wide', layoutWide],
    ['narrow', layoutNarrow],
  ] as const)(
    '%s: 器が分からない・突き合わないマネージャーは消さず「器の分からない委譲」へ（unknown）',
    (_n, layout) => {
      const l = layout(withRunners(['r1', undefined, 'gone']));
      expect(l.nodes.filter((n) => n.kind === 'manager')).toHaveLength(3);
      const unknown = l.containers.find((c) => c.key === 'runner:unknown-runner')!;
      expect(unknown.state).toBe('unknown');
      expect(unknown.label).toBe('器の分からない委譲');
      const node = (key: string) => l.nodes.find((n) => n.key === key)!.box;
      expect(inside(unknown.box, node('m-m1'))).toBe(true);
      expect(inside(unknown.box, node('m-m2'))).toBe(true);
    },
  );

  it.each([
    ['wide', layoutWide],
    ['narrow', layoutNarrow],
  ] as const)(
    '%s: 器が0台でマネージャーも0本なら枠は出さず案内だけ。器が在れば空の枠と案内',
    (_n, layout) => {
      const none = layout({ ...two, runners: [], managers: [] });
      expect(none.containers.map((c) => c.key).filter((k) => k.startsWith('runner'))).toEqual([]);
      expect(none.empty).toBeDefined();
      // 器が在れば案内は図全体で1つではなく、空の器の枠ごとに、その枠の中へ置く
      const idle = layout({ ...two, managers: [] });
      const runnerBoxes = idle.containers.filter((c) => c.key.startsWith('runner:'));
      expect(runnerBoxes).toHaveLength(2);
      expect(idle.empty).toBeUndefined();
      for (const c of runnerBoxes) {
        expect(c.empty).toBeDefined();
        expect(inside(c.box, c.empty!)).toBe(true);
      }
      expect(idle.height).toBeGreaterThanOrEqual(
        Math.max(...runnerBoxes.map((c) => c.box.y + c.box.h)),
      );
    },
  );

  it.each([
    ['wide', layoutWide],
    ['narrow', layoutNarrow],
  ] as const)(
    '%s: 案内の枠は居ない器にだけ付く（r1 空・r2 に居る）。止まっている札だけの器は空に数えない',
    (_n, layout) => {
      const mgr = (id: string, runner: string, status: 'running' | 'waiting') => ({
        id,
        runner,
        label: id,
        status,
      });
      const emptyOf = (l: ReturnType<typeof layout>, key: string) =>
        l.containers.find((c) => c.key === `runner:${key}`)!.empty;

      const half = layout({ ...two, managers: [mgr('a', 'r2', 'running')] });
      expect(emptyOf(half, 'r1')).toBeDefined();
      expect(emptyOf(half, 'r2')).toBeUndefined();

      const stopped = layout({ ...two, managers: [mgr('a', 'r1', 'waiting')] });
      expect(emptyOf(stopped, 'r1')).toBeUndefined();
      expect(emptyOf(stopped, 'r2')).toBeDefined();

      const all = layout({ ...two, managers: [] });
      expect(emptyOf(all, 'r1')).toBeDefined();
      expect(emptyOf(all, 'r2')).toBeDefined();
    },
  );
});

/**
 * 外部サービス（連携の鍵）の札と、外部 → クローンの線（Issue #3676）。
 * 札は 0〜6 枚（上限 5 + 「ほか N 件」）。**線が重ならない・交わらない・札を突き抜けない**を、
 * マネージャーの数と組み合わせて測る。
 */
function externalsOf(n: number): NonNullable<TopologyScene['externals']> {
  return Array.from({ length: n }, (_, i) => ({
    id: `external:k${i}`,
    label: `鍵${i}`,
    flow: i % 2 === 0 ? ('down' as const) : ('idle' as const),
  }));
}

const externalShapes: (readonly [number, number[]])[] = [];
for (const n of [1, 2, 3, 4, 5, 6]) {
  for (const counts of [[], [0], [2, 0, 1], [1, 1, 1, 1, 1, 1, 1, 1]]) {
    externalShapes.push([n, counts]);
  }
}

describe.each([
  ['wide', layoutWide],
  ['narrow', layoutNarrow],
] as const)('%s の配置（外部サービス）', (_name, layout) => {
  const withExternals = (n: number, counts: number[]): TopologyScene => ({
    ...scene(counts),
    externals: externalsOf(n),
  });

  it.each(
    externalShapes.map((s) => [`外部 ${s[0]} 枚・作業者 ${JSON.stringify(s[1])}`, s] as const),
  )('%s のとき、別々の線は重ならず交わらず、札を突き抜けない', (_label, [n, counts]) => {
    const laid = layout(withExternals(n, counts));
    const segs = segments(laid);
    const clashes = segs.flatMap((s, i) =>
      segs
        .slice(i + 1)
        .filter((t) => t.edge !== s.edge && clash(s, t))
        .map((t) => `${s.edge} × ${t.edge}`),
    );
    expect(clashes).toEqual([]);
    const pierced = segs.flatMap((s) =>
      laid.nodes.filter((node) => piercesBox(s, node.box)).map((node) => `${s.edge} → ${node.key}`),
    );
    expect(pierced).toEqual([]);
  });

  it('外部の札は種類 external で出て、線は札とクローンの edges に載る（ホバーで強調できる）', () => {
    const laid = layout(withExternals(3, [1]));
    const cards = laid.nodes.filter((node) => node.kind === 'external');
    expect(cards.map((c) => c.label)).toEqual(['鍵0', '鍵1', '鍵2']);
    const clone = laid.nodes.find((node) => node.kind === 'clone')!;
    for (const card of cards) {
      expect(laid.edges.some((e) => e.key === card.key)).toBe(true);
      expect(card.edges).toContain(card.key);
      expect(clone.edges).toContain(card.key);
    }
  });

  it('線の向きは外部 → クローンで、光は札の flow に従う（down のとき forward）', () => {
    const laid = layout(withExternals(2, []));
    const cards = laid.nodes.filter((node) => node.kind === 'external');
    const clone = laid.nodes.find((node) => node.kind === 'clone')!;
    const flows = cards.map((card) => laid.edges.find((e) => e.key === card.key));
    expect(flows.map((e) => [e?.flow, e?.reverse])).toEqual([
      ['down', false],
      ['idle', false],
    ]);
    // 始点は札の縁、終点はクローンの縁
    for (const [i, edge] of flows.entries()) {
      const box = cards[i]!.box;
      const start = edge!.points[0]!;
      const end = edge!.points.at(-1)!;
      const onBoxEdge = (p: Point, b: Box) =>
        p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
      expect(onBoxEdge(start, box)).toBe(true);
      expect(onBoxEdge(end, clone.box)).toBe(true);
    }
  });

  it('外部が 0 枚（省く・空）なら、配置は今までと同じ', () => {
    const none = layout(scene([2, 0]));
    expect(layout({ ...scene([2, 0]), externals: [] })).toEqual(none);
    expect(none.nodes.some((node) => node.kind === 'external')).toBe(false);
  });
});
