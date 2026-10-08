// 同じ親から出る線は出口も幹も1本ずつ分ける: 幹を共有すると光の粒が重なり、どの子へ流れているのか読めなくなるため
// `unknown` を `idle`・`ok` と分ける: 確かめられないものを仕事なし・正常と描くと、確かめたように読めるため
export type TopologyStatus =
  'idle' | 'running' | 'awaiting' | 'waiting' | 'error' | 'offline' | 'ok' | 'unknown';
export type TopologyFlow = 'idle' | 'down' | 'up' | 'both';

export interface TopologyDetail {
  label: string;
  value: string;
  mono?: boolean;
}

// 欄が無いことは「不明」: 既定のモデルで埋めない
export interface TopologyAgent {
  model?: string;
}

export interface TopologyWorker {
  id: string;
  label: string;
  task?: string;
  status: TopologyStatus;
  flow?: TopologyFlow;
  details?: readonly TopologyDetail[];
  agent?: TopologyAgent;
}

export interface TopologyManager {
  id: string;
  // 器の無い・突き合わないマネージャーは「器の分からない委譲」の枠へ入れる: 図から黙って消さないため
  runner?: string;
  label: string;
  task?: string;
  status: TopologyStatus;
  flow?: TopologyFlow;
  workers?: readonly TopologyWorker[];
  details?: readonly TopologyDetail[];
  agent?: TopologyAgent;
  // 複数のマネージャーをまとめた札には担当の札を付けない: 1つのモデルを名乗れないため
  group?: boolean;
}

// `status` を持たない: 観測できるのは最後に呼ばれた時刻だけで、外部サービスの状態は観測していないため
export interface TopologyExternal {
  id: string;
  label: string;
  task?: string;
  flow?: TopologyFlow;
  details?: readonly TopologyDetail[];
}

export interface TopologyRunner {
  id: string;
  label: string;
  status: TopologyStatus;
}

export interface TopologyScene {
  human?: { label?: string; flow?: TopologyFlow };
  externals?: readonly TopologyExternal[];
  clone: {
    label?: string;
    task?: string;
    status: TopologyStatus;
    details?: readonly TopologyDetail[];
    agent?: TopologyAgent;
  };
  db: {
    label?: string;
    task?: string;
    status: TopologyStatus;
    flow?: TopologyFlow;
    details?: readonly TopologyDetail[];
  };
  daemon?: { label?: string };
  runners: readonly TopologyRunner[];
  managers: readonly TopologyManager[];
  // 在れば、地図が空でも「居ない」と言い切らない
  unreadableCount?: number;
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

export type NodeKind = 'human' | 'external' | 'db' | 'clone' | 'manager' | 'worker';

export interface LaidNode {
  key: string;
  kind: NodeKind;
  box: Box;
  label: string;
  task?: string;
  status?: TopologyStatus;
  details?: readonly TopologyDetail[];
  // 在る札だけが詳細にモデルの行を出す（クローン・マネージャー・作業者）。中身が空なら「不明」
  agent?: TopologyAgent;
  edges: string[];
}

export interface LaidEdge {
  key: string;
  points: Point[];
  flow: TopologyFlow;
  broken: boolean;
  reverse: boolean;
}

export type ContainerState = 'ok' | 'unknown' | 'offline';

function containerState(status: TopologyStatus): ContainerState {
  return status === 'offline' ? 'offline' : status === 'unknown' ? 'unknown' : 'ok';
}

export interface LaidContainer {
  key: string;
  box: Box;
  label: string;
  // `unknown` を `ok` と同じ見た目にしない: 確かめたように読ませないため
  state: ContainerState;
  labelAlign: 'start' | 'end';
  empty?: Box;
}

export interface TopologyLayout {
  width: number;
  height: number;
  nodes: LaidNode[];
  edges: LaidEdge[];
  containers: LaidContainer[];
  empty?: Box;
}

// 利用者に見える名前は日本語にする: 内部の呼び名（alteroidd・db）を出さないため
export const DB_CONTAINER_LABEL = '記憶の置き場';
export const DAEMON_CONTAINER_LABEL = 'alteroid 本体';
// 短くする: 細い札（スマホ幅で 120 幅）に収まらなくなるため
const HUMAN_TASK = '画面・端末';

export const UNKNOWN_RUNNER_KEY = 'unknown-runner';
export const UNKNOWN_RUNNER_LABEL = '器の分からない委譲';

interface RunnerGroup {
  key: string;
  label: string;
  state: ContainerState;
  broken: boolean;
  members: number[];
}

// 器が分からない・突き合わないものを捨てない: 実行中なのに図に居ない、を作らないため
function groupManagers(scene: TopologyScene): RunnerGroup[] {
  const groups: RunnerGroup[] = scene.runners.map((r) => ({
    key: r.id,
    label: r.label,
    state: containerState(r.status),
    broken: r.status === 'offline',
    members: [],
  }));
  const byKey = new Map(groups.map((g) => [g.key, g]));
  let unknown: RunnerGroup | undefined;
  scene.managers.forEach((m, i) => {
    const hit = m.runner === undefined ? undefined : byKey.get(m.runner);
    if (hit) {
      hit.members.push(i);
      return;
    }
    unknown ??= {
      key: UNKNOWN_RUNNER_KEY,
      label: UNKNOWN_RUNNER_LABEL,
      state: 'unknown',
      broken: false,
      members: [],
    };
    unknown.members.push(i);
  });
  return unknown ? [...groups, unknown] : groups;
}

const NODE_H = 60;
const HEAD = 28;
const PAD = 16;

const cy = (b: Box) => b.y + b.h / 2;
const right = (b: Box) => b.x + b.w;

function spread(n: number, span: number, max: number): number[] {
  if (n <= 1) return [0];
  const step = Math.min(max, span / (n - 1));
  return Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * step);
}

// 遠い子ほど外側を回す: 線どうしが交わらないため
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

// 遠い（下の）子ほど左の出口を使う: 線どうしが交わらないため
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
      task: HUMAN_TASK,
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
      label: scene.clone.label ?? 'クローン',
      task: scene.clone.task,
      status: scene.clone.status,
      details: scene.clone.details,
      agent: scene.clone.agent ?? {},
      edges: [
        'human',
        'db',
        ...(scene.externals ?? []).map((x) => `x-${x.id}`),
        ...scene.managers.map((m) => `m-${m.id}`),
      ],
    }),
  };
}

function externalNode(external: TopologyExternal, box: Box): LaidNode {
  const key = `x-${external.id}`;
  return {
    key,
    kind: 'external',
    box,
    label: external.label,
    task: external.task,
    details: external.details,
    edges: [key],
  };
}

// 上へ折れる線は上の札ほど内側の幹、下へ折れる線は下の札ほど内側の幹にする: どの線も別の線の幹と横線を横切らないため
function fanInto(sources: readonly Box[], target: Box): Point[][] {
  const x1 = Math.max(...sources.map(right));
  const ports = spread(sources.length, target.h - 24, 12);
  const py = sources.map((_, i) => cy(target) + ports[i]!);
  const up = sources.map((_, i) => i).filter((i) => cy(sources[i]!) < py[i]! - 0.5);
  const down = sources
    .map((_, i) => i)
    .filter((i) => cy(sources[i]!) > py[i]! + 0.5)
    .reverse();
  const xb = target.x - 16;
  const trunk = new Map<number, number>();
  for (const group of [up, down]) {
    const step = Math.min(12, (xb - (x1 + 16)) / Math.max(1, group.length - 1));
    group.forEach((i, k) => trunk.set(i, xb - k * step));
  }
  return sources.map((box, i) => {
    const tx = trunk.get(i);
    if (tx === undefined)
      return [
        { x: right(box), y: py[i]! },
        { x: target.x, y: py[i]! },
      ];
    return [
      { x: right(box), y: cy(box) },
      { x: tx, y: cy(box) },
      { x: tx, y: py[i]! },
      { x: target.x, y: py[i]! },
    ];
  });
}

export function layoutWide(scene: TopologyScene): TopologyLayout {
  const W = 208;
  const ROW_H = 80;
  const TOP = 64;
  const COL = { left: 24, clone: 328, manager: 632, worker: 904 };
  const width = COL.worker + W + 24 + PAD;

  const rows = scene.managers.map((m) => Math.max(1, m.workers?.length ?? 0));
  const groups = groupManagers(scene);
  const GROUP_GAP = 12;
  const EMPTY_BODY = NODE_H + 8;

  let stackY = TOP;
  const laidGroups = groups.map((g) => {
    const bodyH = g.members.reduce((a, i) => a + rows[i]! * ROW_H, 0);
    const box: Box = {
      x: COL.manager - PAD,
      y: stackY - HEAD - 4,
      w: COL.worker + W + PAD - (COL.manager - PAD),
      h: HEAD + 4 + (g.members.length === 0 ? EMPTY_BODY : bodyH),
    };
    const rowTop = stackY;
    const empty: Box | undefined =
      g.members.length === 0
        ? { x: COL.manager, y: rowTop, w: COL.worker + W - COL.manager, h: NODE_H }
        : undefined;
    stackY = box.y + box.h + GROUP_GAP + HEAD + 4;
    return { group: g, box, rowTop, empty };
  });
  const stackBottom =
    laidGroups.length === 0 ? TOP : laidGroups.at(-1)!.box.y + laidGroups.at(-1)!.box.h;
  const empty: Box | undefined =
    laidGroups.length === 0
      ? { x: COL.manager, y: TOP + ROW_H, w: COL.worker + W - COL.manager, h: NODE_H }
      : undefined;
  const externals = scene.externals ?? [];
  const leftNeed = externals.length === 0 ? 0 : (externals.length + 1) * ROW_H + 160;
  const contentH = Math.max(3 * ROW_H, stackBottom - TOP, leftNeed);
  const height = Math.max(TOP + contentH, empty ? empty.y + empty.h : 0) + PAD + 8;
  const at = (x: number, centerY: number): Box => ({ x, y: centerY - NODE_H / 2, w: W, h: NODE_H });

  const make = baseNodes(scene);
  const cloneBox = at(COL.clone, TOP + contentH / 2);
  const humanBox = at(COL.left, TOP + ROW_H / 2);
  const dbBox = at(COL.left, TOP + contentH - ROW_H / 2);

  const nodes: LaidNode[] = [];
  const edges: LaidEdge[] = [];
  const dbDown = scene.db.status === 'offline';

  // 出口を上下に分ける: 最後の横の区間を共有させないため
  // 縦の幹も左右にずらす: 同じ x だと、上下から来た2本が1本の線に見えるため
  if (externals.length === 0) {
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
  } else {
    const extBoxes = externals.map((_, i) =>
      at(COL.left, TOP + ROW_H + HEAD + 4 + (i + 0.5) * ROW_H),
    );
    const ordered: { key: string; box: Box; flow: TopologyFlow; reverse: boolean }[] = [
      ...(scene.human
        ? [{ key: 'human', box: humanBox, flow: scene.human.flow ?? 'idle', reverse: false }]
        : []),
      ...externals.map((x, i) => ({
        key: `x-${x.id}`,
        box: extBoxes[i]!,
        flow: x.flow ?? 'idle',
        reverse: false,
      })),
      { key: 'db', box: dbBox, flow: scene.db.flow ?? 'idle', reverse: true },
    ];
    const paths = fanInto(
      ordered.map((s) => s.box),
      cloneBox,
    );
    ordered.forEach((s, i) => {
      edges.push({
        key: s.key,
        points: paths[i]!,
        flow: s.flow,
        broken: s.key === 'db' && dbDown,
        reverse: s.reverse,
      });
    });
    externals.forEach((x, i) => nodes.push(externalNode(x, extBoxes[i]!)));
  }
  if (scene.human) nodes.push(make.human(humanBox));
  nodes.push(make.db(dbBox), make.clone(cloneBox));

  const managerBoxes: { box: Box; workerBoxes: Box[] }[] = [];
  for (const { group, rowTop } of laidGroups) {
    let cursor = 0;
    for (const i of group.members) {
      const m = scene.managers[i]!;
      const span = rows[i] ?? 1;
      const box = at(COL.manager, rowTop + (cursor + span / 2) * ROW_H);
      const workerBoxes = (m.workers ?? []).map((_, j) =>
        at(COL.worker, rowTop + (cursor + j) * ROW_H + ROW_H / 2),
      );
      cursor += span;
      managerBoxes[i] = { box, workerBoxes };
    }
  }
  const brokenOf = new Map<number, boolean>();
  for (const g of groups) for (const i of g.members) brokenOf.set(i, g.broken);

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
      broken: brokenOf.get(i) ?? false,
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
      ...(m.group === true ? {} : { agent: m.agent ?? {} }),
      edges: [`m-${m.id}`, ...(m.workers ?? []).map((w) => `w-${w.id}`)],
    });
    const toWorkers = fanRight(box, workerBoxes);
    (m.workers ?? []).forEach((w, j) => {
      edges.push({
        key: `w-${w.id}`,
        points: toWorkers[j]!,
        flow: w.flow ?? 'idle',
        broken: brokenOf.get(i) ?? false,
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
        agent: w.agent ?? {},
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
      {
        key: 'db',
        box: wrap(dbBox),
        label: DB_CONTAINER_LABEL,
        state: containerState(scene.db.status),
        labelAlign: 'start',
      },
      {
        key: 'daemon',
        box: wrap(cloneBox),
        label: scene.daemon?.label ?? DAEMON_CONTAINER_LABEL,
        state: 'ok',
        labelAlign: 'start',
      },
      ...laidGroups.map(({ group, box, empty: groupEmpty }): LaidContainer => ({
        key: `runner:${group.key}`,
        box,
        label: group.label,
        state: group.state,
        labelAlign: 'start',
        empty: groupEmpty,
      })),
    ],
    empty,
  };
}

export function layoutNarrow(scene: TopologyScene): TopologyLayout {
  const width = 360;
  const ROW_H = 72;
  const GAP = 24;
  const make = baseNodes(scene);
  const dbDown = scene.db.status === 'offline';

  const dbContainer: Box = { x: 152, y: 8, w: 200, h: HEAD + NODE_H + 8 };
  const dbBox: Box = { x: 160, y: 8 + HEAD, w: 184, h: NODE_H };
  const humanBox: Box = { x: 16, y: 8 + HEAD, w: 120, h: NODE_H };

  const daemonContainer: Box = {
    x: 8,
    y: dbContainer.y + dbContainer.h + GAP,
    w: 344,
    h: HEAD + NODE_H + 8,
  };
  const cloneBox: Box = { x: 16, y: daemonContainer.y + HEAD, w: 328, h: NODE_H };

  const externals = scene.externals ?? [];
  let rowY = daemonContainer.y + daemonContainer.h + GAP;
  const extBoxes: Box[] = externals.map((_, i) => ({
    x: 48,
    y: rowY + i * ROW_H,
    w: 248,
    h: NODE_H,
  }));
  const extEdges: LaidEdge[] = [];
  if (externals.length > 0) {
    // 下の札ほど外側（右）の幹へ: 上の札の横線が下の札の幹まで届かず、交わらないため
    const xMin = 304;
    const step = Math.min(8, (336 - xMin) / Math.max(1, externals.length - 1));
    externals.forEach((x, i) => {
      const box = extBoxes[i]!;
      const gx = xMin + i * step;
      extEdges.push({
        key: `x-${x.id}`,
        points: [
          { x: right(box), y: cy(box) },
          { x: gx, y: cy(box) },
          { x: gx, y: cloneBox.y + cloneBox.h },
        ],
        flow: x.flow ?? 'idle',
        broken: false,
        reverse: false,
      });
    });
    rowY += externals.length * ROW_H + GAP / 2;
  }

  const groups = groupManagers(scene);
  const brokenOf = new Map<number, boolean>();
  const managerBoxes: { box: Box; workerBoxes: Box[] }[] = [];
  const runnerContainers: LaidContainer[] = [];
  for (const g of groups) {
    const top = rowY;
    rowY += HEAD;
    for (const i of g.members) {
      brokenOf.set(i, g.broken);
      const m = scene.managers[i]!;
      const box: Box = { x: 48, y: rowY, w: 296, h: NODE_H };
      rowY += ROW_H;
      const workerBoxes = (m.workers ?? []).map(() => {
        const wb: Box = { x: 80, y: rowY, w: 264, h: NODE_H };
        rowY += ROW_H;
        return wb;
      });
      managerBoxes[i] = { box, workerBoxes };
    }
    let groupEmpty: Box | undefined;
    if (g.members.length === 0) {
      groupEmpty = { x: 16, y: rowY, w: 328, h: NODE_H };
      rowY += NODE_H + 8;
    }
    runnerContainers.push({
      key: `runner:${g.key}`,
      box: { x: 8, y: top, w: 344, h: rowY - top },
      label: g.label,
      state: g.state,
      labelAlign: 'end',
      empty: groupEmpty,
    });
    rowY += GAP / 2;
  }
  const emptyBox: Box | undefined =
    groups.length === 0 ? { x: 16, y: rowY + HEAD, w: 328, h: NODE_H } : undefined;
  const height = Math.max(rowY - GAP / 2, emptyBox ? emptyBox.y + emptyBox.h : 0) + 8;

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
  externals.forEach((x, i) => nodes.push(externalNode(x, extBoxes[i]!)));
  edges.push(...extEdges);
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
      broken: brokenOf.get(i) ?? false,
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
      ...(m.group === true ? {} : { agent: m.agent ?? {} }),
      edges: [`m-${m.id}`, ...(m.workers ?? []).map((w) => `w-${w.id}`)],
    });
    const toWorkers = fanDown(box, workerBoxes, box.x + 8, (workerBoxes[0]?.x ?? 80) - 8);
    (m.workers ?? []).forEach((w, j) => {
      edges.push({
        key: `w-${w.id}`,
        points: toWorkers[j]!,
        flow: w.flow ?? 'idle',
        broken: brokenOf.get(i) ?? false,
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
        agent: w.agent ?? {},
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
      {
        key: 'db',
        box: dbContainer,
        label: DB_CONTAINER_LABEL,
        state: containerState(scene.db.status),
        labelAlign: 'end',
      },
      {
        key: 'daemon',
        box: daemonContainer,
        label: scene.daemon?.label ?? DAEMON_CONTAINER_LABEL,
        state: 'ok',
        labelAlign: 'end',
      },
      ...runnerContainers,
    ],
    empty: emptyBox,
  };
}

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
