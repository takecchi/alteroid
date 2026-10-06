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
 * 札の状態。**`ok`（正常）と `unknown`（不明）を `idle`（仕事なし）と分けてある。**
 * 「何も走っていない」と「確かめられない」は別のことで、後者を仕事なし・正常と描くと
 * 確かめたように読める。`awaiting`（完了待ち）は仕事の途中で完了を待っている状態で、
 * `idle` とは別（`running` と同じ系統で描く）。`ok` は走る・走らないの無い対象（記憶ストア・runner の器）の
 * 「繋がっている」に使う。
 */
export type TopologyStatus =
  'idle' | 'running' | 'awaiting' | 'waiting' | 'error' | 'offline' | 'ok' | 'unknown';
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
  /**
   * このマネージャーが居る器（`TopologyScene.runners[].id`）。**無い・どの器とも突き合わない
   * ときは「器の分からない委譲」の枠へ入れる**（図から黙って消さない）。
   */
  runner?: string;
  label: string;
  task?: string;
  status: TopologyStatus;
  /** クローン ↔ このマネージャーの線 */
  flow?: TopologyFlow;
  workers?: readonly TopologyWorker[];
  details?: readonly TopologyDetail[];
}

/**
 * 外部サービスの札（連携の鍵1本ぶん、または上限を超えた分をまとめた「ほか N 件」）。
 * **`status` を持たない**——観測できるのは最後に呼ばれた時刻だけで、外部サービスの状態は観測していない。
 */
export interface TopologyExternal {
  id: string;
  label: string;
  task?: string;
  /** 外部サービス → クローンの線（`down` だけが在りうる） */
  flow?: TopologyFlow;
  details?: readonly TopologyDetail[];
}

/** runner の器1台。`id` は `managers[].runner` と突き合わせる鍵。 */
export interface TopologyRunner {
  id: string;
  /** 枠の名前（runner の名前。例: runner-primary） */
  label: string;
  /** `offline` ならこの器の中のマネージャーへの線を切れた形で描く */
  status: TopologyStatus;
}

export interface TopologyScene {
  /** 人間（Web UI / CLI）。省けば描かない */
  human?: { label?: string; flow?: TopologyFlow };
  /**
   * 外部サービス（連携の鍵）。**左の列の人間と記憶ストアのあいだ**（狭い配置ではクローンの下）へ
   * 置き、線は外部 → クローン。省く・空なら今までと同じ配置。
   */
  externals?: readonly TopologyExternal[];
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
  /**
   * 生きている runner の器。**1台に1枠**を描き、その中にその器の上で確認できているマネージャーを
   * 入れる（大きな「manager-runner」の枠は無い）。0台なら枠は出さず、空の案内だけを出す。
   * 死んだ器（名簿で `lost` など）は呼び手が入れない。
   */
  runners: readonly TopologyRunner[];
  managers: readonly TopologyManager[];
  /**
   * 台帳の行が読めず、地図に載せられなかった委譲の件数（`snapshot.unreadable` の長さ。#2705）。
   * **1件以上のときだけ渡す**（API は 0 件なら鍵ごと載せない。古いデーモンも同じく来ない——
   * 形の上では「0 件」と「欄が無い」は区別できない）。在れば、地図が空でも「居ない」と言い切らない。
   */
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

export type ContainerState = 'ok' | 'unknown' | 'offline';

/** 場面の状態から器の状態へ。走る・走らないの無い対象なので、`offline` と `unknown` 以外は `ok`。 */
function containerState(status: TopologyStatus): ContainerState {
  return status === 'offline' ? 'offline' : status === 'unknown' ? 'unknown' : 'ok';
}

export interface LaidContainer {
  key: string;
  box: Box;
  label: string;
  /**
   * 器の状態。`offline` は切れている（赤い破線）、`unknown` は確かめられない（灰色の破線と「不明」）、
   * `ok` は何も足さない。**`unknown` を `ok` と同じ見た目にしない**（確かめたように読ませない。#2706）。
   */
  state: ContainerState;
  /** 器の名前を左上・右上のどちらへ置くか。狭い配置では左の縁を線が下りるので右へ寄せる */
  labelAlign: 'start' | 'end';
  /**
   * この器にマネージャーが1本も居ないときの案内の枠（枠の中に置く）。**器ごとに持つ**
   * （図全体で1つではない。ある器が空でも、別の器に居れば居る側は札を出す）。
   * 枠で止まっている札（`waiting`）も `scene.managers` に居るので、居ない側には数えない。
   */
  empty?: Box;
}

export interface TopologyLayout {
  width: number;
  height: number;
  nodes: LaidNode[];
  edges: LaidEdge[];
  containers: LaidContainer[];
  /** 器（runner）が0台のときの案内の枠。器が在れば案内は各器の枠の中（`LaidContainer.empty`） */
  empty?: Box;
}

/**
 * 器の枠に出す名前。**利用者に見える名前は日本語にする**（内部の呼び名 alteroidd・db は出さない）。
 * 正式な英字の名前は枠のツールチップ（`system-topology.tsx` の `CONTAINER_HINT`）に残す。鍵（`db` / `daemon`）は変えない。
 */
export const DB_CONTAINER_LABEL = '記憶の置き場';
export const DAEMON_CONTAINER_LABEL = 'alteroid 本体';
/** 人間の札の補足。細い札（スマホ幅で 120 幅）に収まる短さにする。 */
const HUMAN_TASK = '画面・端末';

/** どの生きた器とも突き合わないマネージャーを入れる枠の鍵。 */
export const UNKNOWN_RUNNER_KEY = 'unknown-runner';
export const UNKNOWN_RUNNER_LABEL = '器の分からない委譲';

interface RunnerGroup {
  key: string;
  label: string;
  state: ContainerState;
  broken: boolean;
  /** `scene.managers` の添字 */
  members: number[];
}

/**
 * マネージャーを器ごとの枠へ振り分ける。**器が分からない・突き合わないものを捨てない**——
 * 最後の「器の分からない委譲」へ入れる（実行中なのに図に居ない、を作らない）。
 */
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
      edges: [
        'human',
        'db',
        ...(scene.externals ?? []).map((x) => `x-${x.id}`),
        ...scene.managers.map((m) => `m-${m.id}`),
      ],
    }),
  };
}

/** 外部サービスの札と、その線（札 → クローン）。位置は呼び手が決める。 */
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

/**
 * 左の列の札（人間・外部サービス・記憶）から、右のクローンの左辺へ（`wide`）。横 → 縦 → 横。
 * `sources` は上から下の順。出口はクローンの左辺に上下の順で並べ、**上へ折れる線（札がクローンの
 * 出口より上）は上の札ほど内側（クローンに近い幹）、下へ折れる線は下の札ほど内側**にする。
 * この順なら、どの線も別の線の幹と横線を横切らない（`layout.test.ts` が総当たりで測る）。
 */
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

/** 左から右へ。広い画面。 */
export function layoutWide(scene: TopologyScene): TopologyLayout {
  const W = 208;
  const ROW_H = 80;
  const TOP = 64;
  const COL = { left: 24, clone: 328, manager: 632, worker: 904 };
  const width = COL.worker + W + 24 + PAD;

  const rows = scene.managers.map((m) => Math.max(1, m.workers?.length ?? 0));
  const groups = groupManagers(scene);
  const GROUP_GAP = 12;
  /** 空の枠（マネージャーが居ない器）の中身の高さ。案内の枠（`NODE_H`）と余白。 */
  const EMPTY_BODY = NODE_H + 8;

  // 器ごとの枠を縦に積む。枠の上端は名前の行（HEAD + 4）の分だけ行の開始より上。
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
  // 外部サービスは左の列の人間（1行目）と記憶ストア（最終行）のあいだに縦に積む。
  // 記憶の枠（札の上に名前の行がある）に触れない高さを、札の数から出す。0 枚なら何も足さない。
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

  // 人間と DB → クローンの左辺。出口を上下に分けて、最後の横の区間を共有させない。
  // 縦の幹も左右にずらす —— 同じ x だと、上下から来た2本が1本の線に見える。
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
    // 外部サービスが居るとき。人間・外部サービス（上から下）・記憶を、クローンの左辺へ分けて入れる。
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

/** 上から下へ、字下げした木。狭い画面。 */
export function layoutNarrow(scene: TopologyScene): TopologyLayout {
  const width = 360;
  const ROW_H = 72;
  const GAP = 24;
  const make = baseNodes(scene);
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

  // 3段目: 外部サービス（連携の鍵）。クローンの下に縦に並べ、線は札の右から右の余白を通ってクローンの
  // 下辺へ上る（マネージャーの線は左の余白を通るので交わらない）。0 枚なら何も足さない。
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
    // 下の札ほど外側（右）の幹へ。上の札の横線が、下の札の幹まで届かない（交わらない）。
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

  // 4段目: 器（runner）ごとの枠。その中に、マネージャー → その下に字下げした作業者
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
