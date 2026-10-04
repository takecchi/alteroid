/**
 * 稼働状況の図の配置。**純関数で、React も DOM も知らない**（線が交わらないことをテストで測るため）。
 *
 * 2つの配置を持つ:
 * - `wide` —— 左から右へ（人間・DB → クローン → マネージャー → 作業者）。広い画面
 * - `narrow` —— 上から下へ、字下げした木。狭い画面（スマホ）。札の大きさは縮めず、縦に伸ばす
 *
 * **線は折れ線で、同じ親から出る線は出口も幹も1本ずつ分ける。** 幹を共有させると光の粒が
 * 重なって、どの子へ流れているのかが読めなくなるからである。分け方は「遠い子ほど外側を回す」
 * —— この順なら線どうしが交わらない（`layout.test.ts` が総当たりで測る）。
 */

/**
 * 札の状態。**`ok`（正常）と `unknown`（不明）を `idle`（待機）と分けてある。**
 * 「何も走っていない」と「確かめられない」は別のことで、後者を待機・正常と描くと
 * 確かめたように読める。`ok` は走る・走らないの無い対象（記憶ストア・runner の器）の
 * 「繋がっている」に使う。
 */
export type TopologyStatus =
  'idle' | 'running' | 'waiting' | 'error' | 'offline' | 'ok' | 'unknown';
export type TopologyFlow = 'idle' | 'down' | 'up' | 'both';

/** 札を押したときに出す詳細の1行（名前と値） */
export interface TopologyDetail {
  label: string;
  value: string;
  /** 識別子・パスなど、等幅で出したい値 */
  mono?: boolean;
}

export interface TopologyWorker {
  id: string;
  label: string;
  /** いま手を動かしていること（1行。溢れたら省略する） */
  task?: string;
  status: TopologyStatus;
  /** マネージャー ↔ この作業者の線 */
  flow?: TopologyFlow;
  details?: readonly TopologyDetail[];
}

export interface TopologyManager {
  id: string;
  label: string;
  task?: string;
  status: TopologyStatus;
  /** クローン ↔ このマネージャーの線 */
  flow?: TopologyFlow;
  workers?: readonly TopologyWorker[];
  details?: readonly TopologyDetail[];
}

export interface TopologyScene {
  /** 人間（Web UI / CLI）。省けば描かない */
  human?: { label?: string; flow?: TopologyFlow };
  clone: {
    label?: string;
    task?: string;
    status: TopologyStatus;
    details?: readonly TopologyDetail[];
  };
  /** 記憶ストア。`flow` はクローン ↔ DB の線 */
  db: {
    label?: string;
    /** 状態の補足（繋がらないときの理由など。1行） */
    task?: string;
    status: TopologyStatus;
    flow?: TopologyFlow;
    details?: readonly TopologyDetail[];
  };
  /** デーモンの器（クローンと記憶ストアの接続情報を持つ側） */
  daemon?: { label?: string };
  /** manager-runner の器。`offline` ならクローンからの線を切れた形で描く */
  runner: { label?: string; status: TopologyStatus };
  managers: readonly TopologyManager[];
}

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type NodeKind = 'human' | 'db' | 'clone' | 'manager' | 'worker';

export interface LaidNode {
  key: string;
  kind: NodeKind;
  box: Box;
  label: string;
  task?: string;
  status?: TopologyStatus;
  details?: readonly TopologyDetail[];
  /** この札につながる線の key（ホバーで強調する） */
  edges: string[];
}

export interface LaidEdge {
  key: string;
  /** 軸に沿った折れ線の頂点。**始点は指示を出す側**（DB の線だけは DB が始点で `reverse`） */
  points: Point[];
  flow: TopologyFlow;
  broken: boolean;
  /** 始点 → 終点の向きが「上り」のとき（DB の線: 描くのは DB → クローン、下りはクローン → DB） */
  reverse: boolean;
}

export interface LaidContainer {
  key: string;
  box: Box;
  label: string;
  down: boolean;
  /** 器の名前を左上・右上のどちらへ置くか。狭い配置では左の縁を線が下りるので右へ寄せる */
  labelAlign: 'start' | 'end';
}

export interface TopologyLayout {
  width: number;
  height: number;
  nodes: LaidNode[];
  edges: LaidEdge[];
  containers: LaidContainer[];
  /** マネージャーが1本も無いときの「いません」の枠 */
  empty?: Box;
}

const NODE_H = 60;
const HEAD = 28;
const PAD = 16;

const cy = (b: Box) => b.y + b.h / 2;
const right = (b: Box) => b.x + b.w;

/** 親の1辺に n 個の出口を、中央から等間隔で並べる（間隔は `max` まで、全体で `span` に収める）。 */
function spread(n: number, span: number, max: number): number[] {
  if (n <= 1) return [0];
  const step = Math.min(max, span / (n - 1));
  return Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * step);
}

/**
 * 親の右辺から、右に並ぶ子の左辺へ（`wide`）。横 → 縦 → 横。
 *
 * 出口は子の上下の順に親の右辺へ並べる。上へ向かう線は**いちばん上の子ほど手前で**折れ、
 * 下へ向かう線は**いちばん下の子ほど手前で**折れる（遠い子ほど外側を回る）。
 */
function fanRight(parent: Box, children: readonly Box[]): Point[][] {
  const x1 = right(parent);
  const order = children.map((_, i) => i).sort((a, b) => cy(children[a]!) - cy(children[b]!));
  const offsets = spread(children.length, parent.h - 24, 12);
  const port = new Map(order.map((idx, rank) => [idx, cy(parent) + offsets[rank]!]));

  const up = order.filter((i) => cy(children[i]!) < port.get(i)! - 0.5);
  const down = order.filter((i) => cy(children[i]!) > port.get(i)! + 0.5).reverse();
  const trunk = new Map<number, number>();
  for (const group of [up, down]) {
    const x2 = Math.min(...children.map((c) => c.x));
    const step = Math.min(12, (x2 - x1 - 32) / Math.max(1, group.length - 1));
    group.forEach((i, k) => trunk.set(i, x1 + 16 + k * step));
  }

  return children.map((child, i) => {
    const py = port.get(i)!;
    const tx = trunk.get(i);
    if (tx === undefined)
      return [
        { x: x1, y: py },
        { x: child.x, y: py },
      ];
    return [
      { x: x1, y: py },
      { x: tx, y: py },
      { x: tx, y: cy(child) },
      { x: child.x, y: cy(child) },
    ];
  });
}

/**
 * 親の下辺から、下に字下げして並ぶ子の左辺へ（`narrow`）。縦 → 横の L 字。
 * 出口は親の下辺の左寄り `[xMin, xMax]` に置き、**遠い（下の）子ほど左の出口**を使う。
 */
function fanDown(parent: Box, children: readonly Box[], xMin: number, xMax: number): Point[][] {
  const n = children.length;
  const step = n <= 1 ? 0 : Math.min(8, (xMax - xMin) / (n - 1));
  const order = children.map((_, i) => i).sort((a, b) => cy(children[a]!) - cy(children[b]!));
  const px = new Map(order.map((idx, rank) => [idx, xMax - rank * step]));
  const y1 = parent.y + parent.h;
  return children.map((child, i) => [
    { x: px.get(i)!, y: y1 },
    { x: px.get(i)!, y: cy(child) },
    { x: child.x, y: cy(child) },
  ]);
}

function baseNodes(scene: TopologyScene) {
  return {
    human: (box: Box): LaidNode => ({
      key: 'human',
      kind: 'human',
      box,
      label: scene.human?.label ?? 'あなた',
      task: 'Web UI / CLI',
      edges: ['human'],
    }),
    db: (box: Box): LaidNode => ({
      key: 'db',
      kind: 'db',
      box,
      label: scene.db.label ?? 'PostgreSQL',
      task: scene.db.task,
      status: scene.db.status,
      details: scene.db.details,
      edges: ['db'],
    }),
    clone: (box: Box): LaidNode => ({
      key: 'clone',
      kind: 'clone',
      box,
      label: scene.clone.label ?? 'clone',
      task: scene.clone.task,
      status: scene.clone.status,
      details: scene.clone.details,
      edges: ['human', 'db', ...scene.managers.map((m) => `m-${m.id}`)],
    }),
  };
}

/** 左から右へ。広い画面。 */
export function layoutWide(scene: TopologyScene): TopologyLayout {
  const W = 208;
  const ROW_H = 80;
  const TOP = 64;
  const COL = { left: 24, clone: 328, manager: 632, worker: 904 };
  const width = COL.worker + W + 24 + PAD;

  const rows = scene.managers.map((m) => Math.max(1, m.workers?.length ?? 0));
  const contentH =
    Math.max(
      3,
      rows.reduce((a, b) => a + b, 0),
    ) * ROW_H;
  const height = TOP + contentH + PAD + 8;
  const at = (x: number, centerY: number): Box => ({ x, y: centerY - NODE_H / 2, w: W, h: NODE_H });

  const make = baseNodes(scene);
  const cloneBox = at(COL.clone, TOP + contentH / 2);
  const humanBox = at(COL.left, TOP + ROW_H / 2);
  const dbBox = at(COL.left, TOP + contentH - ROW_H / 2);

  const nodes: LaidNode[] = [];
  const edges: LaidEdge[] = [];
  const runnerDown = scene.runner.status === 'offline';
  const dbDown = scene.db.status === 'offline';

  // 人間と DB → クローンの左辺。出口を上下に分けて、最後の横の区間を共有させない。
  // 縦の幹も左右にずらす —— 同じ x だと、上下から来た2本が1本の線に見える。
  const sources: { key: 'human' | 'db'; box: Box }[] = [
    ...(scene.human ? [{ key: 'human' as const, box: humanBox }] : []),
    { key: 'db', box: dbBox },
  ];
  const inOffsets = spread(sources.length, NODE_H - 24, 12);
  const mid = (right(humanBox) + cloneBox.x) / 2;
  sources.forEach(({ key, box }, i) => {
    const py = cy(cloneBox) + inOffsets[i]!;
    const tx = mid + (key === 'human' ? -8 : 8);
    const points = [
      { x: right(box), y: cy(box) },
      { x: tx, y: cy(box) },
      { x: tx, y: py },
      { x: cloneBox.x, y: py },
    ];
    edges.push(
      key === 'human'
        ? { key, points, flow: scene.human?.flow ?? 'idle', broken: false, reverse: false }
        : { key, points, flow: scene.db.flow ?? 'idle', broken: dbDown, reverse: true },
    );
  });
  if (scene.human) nodes.push(make.human(humanBox));
  nodes.push(make.db(dbBox), make.clone(cloneBox));

  let cursor = 0;
  const managerBoxes = scene.managers.map((m, i) => {
    const span = rows[i] ?? 1;
    const box = at(COL.manager, TOP + (cursor + span / 2) * ROW_H);
    const workerBoxes = (m.workers ?? []).map((_, j) =>
      at(COL.worker, TOP + (cursor + j) * ROW_H + ROW_H / 2),
    );
    cursor += span;
    return { box, workerBoxes };
  });

  const toManagers = fanRight(
    cloneBox,
    managerBoxes.map((m) => m.box),
  );
  scene.managers.forEach((m, i) => {
    const { box, workerBoxes } = managerBoxes[i]!;
    edges.push({
      key: `m-${m.id}`,
      points: toManagers[i]!,
      flow: m.flow ?? 'idle',
      broken: runnerDown,
      reverse: false,
    });
    nodes.push({
      key: `m-${m.id}`,
      kind: 'manager',
      box,
      label: m.label,
      task: m.task,
      status: m.status,
      details: m.details,
      edges: [`m-${m.id}`, ...(m.workers ?? []).map((w) => `w-${w.id}`)],
    });
    const toWorkers = fanRight(box, workerBoxes);
    (m.workers ?? []).forEach((w, j) => {
      edges.push({
        key: `w-${w.id}`,
        points: toWorkers[j]!,
        flow: w.flow ?? 'idle',
        broken: runnerDown,
        reverse: false,
      });
      nodes.push({
        key: `w-${w.id}`,
        kind: 'worker',
        box: workerBoxes[j]!,
        label: w.label,
        task: w.task,
        status: w.status,
        details: w.details,
        edges: [`w-${w.id}`],
      });
    });
  });

  const wrap = (b: Box): Box => ({
    x: b.x - PAD,
    y: b.y - HEAD - 4,
    w: b.w + PAD * 2,
    h: b.h + HEAD + PAD + 4,
  });
  return {
    width,
    height,
    nodes,
    edges,
    containers: [
      { key: 'db', box: wrap(dbBox), label: 'db', down: dbDown, labelAlign: 'start' },
      {
        key: 'daemon',
        box: wrap(cloneBox),
        label: scene.daemon?.label ?? 'alteroidd',
        down: false,
        labelAlign: 'start',
      },
      {
        key: 'runner',
        box: {
          x: COL.manager - PAD,
          y: TOP - HEAD - 4,
          w: COL.worker + W + PAD - (COL.manager - PAD),
          h: contentH + HEAD + 4,
        },
        label: scene.runner.label ?? 'manager-runner',
        down: runnerDown,
        labelAlign: 'start',
      },
    ],
    empty:
      scene.managers.length === 0
        ? { x: COL.manager, y: TOP + ROW_H, w: COL.worker + W - COL.manager, h: NODE_H }
        : undefined,
  };
}

/** 上から下へ、字下げした木。狭い画面。 */
export function layoutNarrow(scene: TopologyScene): TopologyLayout {
  const width = 360;
  const ROW_H = 72;
  const GAP = 24;
  const make = baseNodes(scene);
  const runnerDown = scene.runner.status === 'offline';
  const dbDown = scene.db.status === 'offline';

  // 1段目: 人間と DB を横に並べる（人間が居なければ DB だけ右に置く）
  // 人間の札は状態を持たないので細くし、そのぶん DB（名前と状態が並ぶ）へ回す。
  const dbContainer: Box = { x: 152, y: 8, w: 200, h: HEAD + NODE_H + 8 };
  const dbBox: Box = { x: 160, y: 8 + HEAD, w: 184, h: NODE_H };
  const humanBox: Box = { x: 16, y: 8 + HEAD, w: 120, h: NODE_H };

  // 2段目: クローン（デーモンの器）
  const daemonContainer: Box = {
    x: 8,
    y: dbContainer.y + dbContainer.h + GAP,
    w: 344,
    h: HEAD + NODE_H + 8,
  };
  const cloneBox: Box = { x: 16, y: daemonContainer.y + HEAD, w: 328, h: NODE_H };

  // 3段目: runner の器の中に、マネージャー → その下に字下げした作業者
  const runnerY = daemonContainer.y + daemonContainer.h + GAP;
  let rowY = runnerY + HEAD;
  const managerBoxes = scene.managers.map((m) => {
    const box: Box = { x: 48, y: rowY, w: 296, h: NODE_H };
    rowY += ROW_H;
    const workerBoxes = (m.workers ?? []).map(() => {
      const wb: Box = { x: 80, y: rowY, w: 264, h: NODE_H };
      rowY += ROW_H;
      return wb;
    });
    return { box, workerBoxes };
  });
  const rowsH = Math.max(ROW_H, rowY - (runnerY + HEAD));
  const runnerContainer: Box = { x: 8, y: runnerY, w: 344, h: HEAD + rowsH };
  const height = runnerContainer.y + runnerContainer.h + 8;

  const nodes: LaidNode[] = [];
  const edges: LaidEdge[] = [];
  if (scene.human) {
    nodes.push(make.human(humanBox));
    edges.push({
      key: 'human',
      points: [
        { x: humanBox.x + humanBox.w / 2, y: humanBox.y + humanBox.h },
        { x: humanBox.x + humanBox.w / 2, y: cloneBox.y },
      ],
      flow: scene.human.flow ?? 'idle',
      broken: false,
      reverse: false,
    });
  }
  nodes.push(make.db(dbBox), make.clone(cloneBox));
  edges.push({
    key: 'db',
    points: [
      { x: dbBox.x + dbBox.w / 2, y: dbBox.y + dbBox.h },
      { x: dbBox.x + dbBox.w / 2, y: cloneBox.y },
    ],
    flow: scene.db.flow ?? 'idle',
    broken: dbDown,
    reverse: true,
  });

  const toManagers = fanDown(
    cloneBox,
    managerBoxes.map((m) => m.box),
    cloneBox.x + 6,
    managerBoxes[0]?.box.x ? managerBoxes[0].box.x - 8 : 40,
  );
  scene.managers.forEach((m, i) => {
    const { box, workerBoxes } = managerBoxes[i]!;
    edges.push({
      key: `m-${m.id}`,
      points: toManagers[i]!,
      flow: m.flow ?? 'idle',
      broken: runnerDown,
      reverse: false,
    });
    nodes.push({
      key: `m-${m.id}`,
      kind: 'manager',
      box,
      label: m.label,
      task: m.task,
      status: m.status,
      details: m.details,
      edges: [`m-${m.id}`, ...(m.workers ?? []).map((w) => `w-${w.id}`)],
    });
    const toWorkers = fanDown(box, workerBoxes, box.x + 8, (workerBoxes[0]?.x ?? 80) - 8);
    (m.workers ?? []).forEach((w, j) => {
      edges.push({
        key: `w-${w.id}`,
        points: toWorkers[j]!,
        flow: w.flow ?? 'idle',
        broken: runnerDown,
        reverse: false,
      });
      nodes.push({
        key: `w-${w.id}`,
        kind: 'worker',
        box: workerBoxes[j]!,
        label: w.label,
        task: w.task,
        status: w.status,
        details: w.details,
        edges: [`w-${w.id}`],
      });
    });
  });

  return {
    width,
    height,
    nodes,
    edges,
    containers: [
      { key: 'db', box: dbContainer, label: 'db', down: dbDown, labelAlign: 'end' },
      {
        key: 'daemon',
        box: daemonContainer,
        label: scene.daemon?.label ?? 'alteroidd',
        down: false,
        labelAlign: 'end',
      },
      {
        key: 'runner',
        box: runnerContainer,
        label: scene.runner.label ?? 'manager-runner',
        down: runnerDown,
        labelAlign: 'end',
      },
    ],
    empty:
      scene.managers.length === 0 ? { x: 16, y: runnerY + HEAD, w: 328, h: NODE_H } : undefined,
  };
}

/** 軸に沿った折れ線を、角だけ半径 `r` で丸めた SVG の path にする。 */
export function roundedPath(points: readonly Point[], r = 8): string {
  const pts = points.filter(
    (p, i) => i === 0 || p.x !== points[i - 1]!.x || p.y !== points[i - 1]!.y,
  );
  if (pts.length === 0) return '';
  const out = [`M ${pts[0]!.x} ${pts[0]!.y}`];
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, b, c] = [pts[i - 1]!, pts[i]!, pts[i + 1]!];
    const lenIn = Math.hypot(b.x - a.x, b.y - a.y);
    const lenOut = Math.hypot(c.x - b.x, c.y - b.y);
    const k = Math.min(r, lenIn / 2, lenOut / 2);
    const p1 = { x: b.x - ((b.x - a.x) / lenIn) * k, y: b.y - ((b.y - a.y) / lenIn) * k };
    const p2 = { x: b.x + ((c.x - b.x) / lenOut) * k, y: b.y + ((c.y - b.y) / lenOut) * k };
    out.push(`L ${p1.x} ${p1.y}`, `Q ${b.x} ${b.y} ${p2.x} ${p2.y}`);
  }
  const last = pts[pts.length - 1]!;
  out.push(`L ${last.x} ${last.y}`);
  return out.join(' ');
}
