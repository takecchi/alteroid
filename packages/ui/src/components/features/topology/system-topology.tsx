import { useId } from 'react';

import { Bot, Brain, Database, Hammer, User, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

import { StatusDot } from '../status-dot';

/**
 * 層の状態。文言と点の色の両方で言う（`StatusDot` と同じく、色だけで言わない）。
 * `offline` は「器ごと見えない」—— runner へ繋がっていない・DB へ届かない。
 */
export type TopologyStatus = 'idle' | 'running' | 'waiting' | 'error' | 'offline';

/**
 * 線の上を流れているもの。向きは**指示を出す側から見て**言う:
 * - `down` —— 指示が下りている（人間 → クローン → マネージャー → 作業者。DB へは書き込み）
 * - `up` —— 報告・確認が上っている（逆向き。DB からは思い出し）
 * - `both` —— 両方
 * - `idle` —— 何も流れていない
 */
export type TopologyFlow = 'idle' | 'down' | 'up' | 'both';

export interface TopologyWorker {
  id: string;
  label: string;
  /** いま手を動かしていること（1行。溢れたら省略する） */
  task?: string;
  status: TopologyStatus;
  /** マネージャー ↔ この作業者の線 */
  flow?: TopologyFlow;
}

export interface TopologyManager {
  id: string;
  label: string;
  task?: string;
  status: TopologyStatus;
  /** クローン ↔ このマネージャーの線 */
  flow?: TopologyFlow;
  workers?: readonly TopologyWorker[];
}

export interface SystemTopologyProps {
  /** 人間（Web UI / CLI）。省けば描かない */
  human?: { label?: string; flow?: TopologyFlow };
  clone: { label?: string; task?: string; status: TopologyStatus };
  /** 記憶ストア。`flow` はクローン ↔ DB の線 */
  db: { label?: string; status: TopologyStatus; flow?: TopologyFlow };
  /** デーモンの器（クローンと記憶ストアの接続情報を持つ側） */
  daemon?: { label?: string };
  /** manager-runner の器。`offline` ならクローンからの線を切れた形で描く */
  runner: { label?: string; status: TopologyStatus };
  managers: readonly TopologyManager[];
  className?: string;
}

const STATUS = {
  idle: { tone: 'neutral', label: '待機' },
  running: { tone: 'accent', label: '実行中' },
  waiting: { tone: 'warn', label: '承認待ち' },
  error: { tone: 'danger', label: '失敗' },
  offline: { tone: 'danger', label: '未接続' },
} as const;

// ---- 配置（viewBox の座標。SVG ごと縮むので画面幅には viewBox で追従する） ----
const NODE_W = 208;
const NODE_H = 60;
const ROW_H = 80;
const PAD = 16;
const HEAD = 28;
const COL = { left: 24, clone: 328, manager: 632, worker: 904 } as const;
const WIDTH = COL.worker + NODE_W + 24 + PAD;
const TOP = 64;

interface Point {
  x: number;
  y: number;
}

/**
 * 左の箱の右端から、右の箱の左端へ。横 → 縦 → 横の折れ線で、角だけ小さく丸める。
 * 折れる位置は2つの箱の中間なので、同じ親から出る線は縦の幹を共有して木の形になる。
 */
function link(from: Point, to: Point): string {
  const x1 = from.x + NODE_W;
  const x2 = to.x;
  const mid = (x1 + x2) / 2;
  const dy = to.y - from.y;
  if (Math.abs(dy) < 1) return `M ${x1} ${from.y} H ${x2}`;
  const r = Math.min(8, Math.abs(dy) / 2, (x2 - x1) / 2);
  const s = Math.sign(dy);
  return [
    `M ${x1} ${from.y}`,
    `H ${mid - r}`,
    `Q ${mid} ${from.y} ${mid} ${from.y + s * r}`,
    `V ${to.y - s * r}`,
    `Q ${mid} ${to.y} ${mid + r} ${to.y}`,
    `H ${x2}`,
  ].join(' ');
}

/**
 * 稼働の地図。**いま誰が何をしていて、どの線を指示と報告が行き来しているか**を1枚で見せる。
 *
 * 器（デーモン・manager-runner・DB）を枠で、層（人間・クローン・マネージャー・作業者）を
 * 札で描き、線の上を流れる光で「いま動いている経路」を言う。下りの光（指示）は
 * `primary`、上りの光（報告・確認）は `chart-4` の色で、向きでも色でも見分けられる。
 *
 * - **光は飾りであって、情報の本体ではない。** 動いている線は光が無くても線の色で分かり、
 *   札には状態の文言が在る。`prefers-reduced-motion` のときは光だけを消す
 * - 器が `offline` のとき、そこへ向かう線は破線の `destructive` にして光を流さない
 *   （届いていない経路に「流れている」絵を出さない）
 * - 読み上げには、図の代わりに層ごとの状態の一覧を渡す
 */
export function SystemTopology({
  human,
  clone,
  db,
  daemon,
  runner,
  managers,
  className,
}: SystemTopologyProps) {
  const summaryId = useId();
  // マネージャーは作業者の数だけ行を取る（作業者が居なくても1行）。
  const rows = managers.map((m) => Math.max(1, m.workers?.length ?? 0));
  const totalRows = Math.max(
    3,
    rows.reduce((a, b) => a + b, 0),
  );
  const contentH = totalRows * ROW_H;
  const height = TOP + contentH + PAD + 8;

  const center = (row: number) => TOP + row * ROW_H + ROW_H / 2;
  const clonePt: Point = { x: COL.clone, y: TOP + contentH / 2 };
  const humanPt: Point = { x: COL.left, y: center(0) };
  const dbPt: Point = { x: COL.left, y: TOP + contentH - ROW_H / 2 };

  let cursor = 0;
  const placed = managers.map((m, i) => {
    const start = cursor;
    const span = rows[i] ?? 1;
    cursor += span;
    return {
      manager: m,
      pt: { x: COL.manager, y: TOP + (start + span / 2) * ROW_H } as Point,
      workers: (m.workers ?? []).map((w, j) => ({
        worker: w,
        pt: { x: COL.worker, y: center(start + j) } as Point,
      })),
    };
  });

  const runnerDown = runner.status === 'offline';
  const dbDown = db.status === 'offline';

  return (
    <figure className={cn('w-full', className)}>
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-labelledby={summaryId}
      >
        <defs>
          <filter id="system-topology-glow" x="-200%" y="-200%" width="500%" height="500%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>

        {/* ---- 器 ---- */}
        <Container
          x={COL.left - PAD}
          y={dbPt.y - NODE_H / 2 - HEAD - 4}
          w={NODE_W + PAD * 2}
          h={NODE_H + HEAD + PAD + 4}
          label="db"
          down={dbDown}
        />
        <Container
          x={COL.clone - PAD}
          y={clonePt.y - NODE_H / 2 - HEAD - 4}
          w={NODE_W + PAD * 2}
          h={NODE_H + HEAD + PAD + 4}
          label={daemon?.label ?? 'alteroidd'}
        />
        <Container
          x={COL.manager - PAD}
          y={TOP - HEAD - 4}
          w={COL.worker + NODE_W + PAD - (COL.manager - PAD)}
          h={contentH + HEAD + 4}
          label={runner.label ?? 'manager-runner'}
          down={runnerDown}
        />

        {/* ---- 線（札より先に描いて、札の下へ潜らせる） ---- */}
        {human ? <Edge id="human" d={link(humanPt, clonePt)} flow={human.flow} /> : null}
        <Edge id="db" d={link(dbPt, clonePt)} flow={db.flow} broken={dbDown} reverse />
        {placed.map(({ manager, pt, workers }) => (
          <g key={manager.id}>
            <Edge
              id={`m-${manager.id}`}
              d={link(clonePt, pt)}
              flow={manager.flow}
              broken={runnerDown}
            />
            {workers.map(({ worker, pt: wpt }) => (
              <Edge
                key={worker.id}
                id={`w-${worker.id}`}
                d={link(pt, wpt)}
                flow={worker.flow}
                broken={runnerDown}
              />
            ))}
          </g>
        ))}

        {/* ---- 札 ---- */}
        {human ? (
          <Node
            pt={humanPt}
            icon={User}
            role="人間"
            label={human.label ?? 'あなた'}
            task="Web UI / CLI"
          />
        ) : null}
        <Node
          pt={dbPt}
          icon={Database}
          role="記憶ストア"
          label={db.label ?? 'PostgreSQL'}
          status={db.status}
        />
        <Node
          pt={clonePt}
          icon={Brain}
          role="クローン"
          label={clone.label ?? 'clone'}
          task={clone.task}
          status={clone.status}
        />
        {placed.map(({ manager, pt, workers }) => (
          <g key={manager.id}>
            <Node
              pt={pt}
              icon={Bot}
              role="マネージャー"
              label={manager.label}
              task={manager.task}
              status={manager.status}
            />
            {workers.map(({ worker, pt: wpt }) => (
              <Node
                key={worker.id}
                pt={wpt}
                icon={Hammer}
                role="作業者"
                label={worker.label}
                task={worker.task}
                status={worker.status}
              />
            ))}
          </g>
        ))}
        {managers.length === 0 ? (
          <foreignObject
            x={COL.manager}
            y={center(1) - NODE_H / 2}
            width={COL.worker + NODE_W - COL.manager}
            height={NODE_H}
          >
            <div className="flex h-full items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
              走っているマネージャーはいません
            </div>
          </foreignObject>
        ) : null}
      </svg>
      <figcaption id={summaryId} className="sr-only">
        {summarize({ clone, db, runner, managers })}
      </figcaption>
    </figure>
  );
}

function summarize({
  clone,
  db,
  runner,
  managers,
}: Pick<SystemTopologyProps, 'clone' | 'db' | 'runner' | 'managers'>): string {
  const parts = [
    `クローン: ${STATUS[clone.status].label}${clone.task ? `（${clone.task}）` : ''}`,
    `記憶ストア: ${STATUS[db.status].label}`,
    `manager-runner: ${STATUS[runner.status].label}`,
    ...managers.map((m) => {
      const ws = (m.workers ?? []).map((w) => `${w.label} ${STATUS[w.status].label}`).join('、');
      return `マネージャー ${m.label}: ${STATUS[m.status].label}${ws ? `。作業者 ${ws}` : ''}`;
    }),
  ];
  return parts.join('。');
}

function Container({
  x,
  y,
  w,
  h,
  label,
  down,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  down?: boolean;
}) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={12}
        className={cn('fill-muted/30 stroke-border', down && 'stroke-destructive/70')}
        strokeDasharray={down ? '6 4' : undefined}
      />
      <text
        x={x + 12}
        y={y + 18}
        className="fill-muted-foreground font-mono text-[11px] tracking-wide"
      >
        {label}
        {down ? ' — 未接続' : ''}
      </text>
    </g>
  );
}

function Edge({
  id,
  d,
  flow = 'idle',
  broken,
  reverse,
}: {
  id: string;
  d: string;
  flow?: TopologyFlow;
  broken?: boolean;
  /** 線を描いた向きと「下り」が逆のとき（DB は左にあるが、下りはクローン → DB） */
  reverse?: boolean;
}) {
  const active = !broken && flow !== 'idle';
  const down = flow === 'down' || flow === 'both';
  const up = flow === 'up' || flow === 'both';
  return (
    <g data-edge={id}>
      <path
        d={d}
        fill="none"
        strokeWidth={active ? 2 : 1.5}
        strokeDasharray={broken ? '5 5' : undefined}
        className={cn(
          'stroke-border transition-colors duration-500',
          active && 'stroke-primary/45',
          broken && 'stroke-destructive/60',
        )}
      />
      {active ? (
        <g className="motion-reduce:hidden">
          {down ? <Pulse d={d} backward={!!reverse} tone="down" /> : null}
          {up ? (
            <Pulse d={d} backward={!reverse} tone="up" delay={flow === 'both' ? 0.8 : 0} />
          ) : null}
        </g>
      ) : null}
    </g>
  );
}

/** 線の上を走る光。同じ線に2粒を半周ずらして流し、途切れずに見せる。 */
function Pulse({
  d,
  backward,
  tone,
  delay = 0,
}: {
  d: string;
  backward: boolean;
  tone: 'down' | 'up';
  delay?: number;
}) {
  const dur = 1.6;
  const motion = backward ? { keyPoints: '1;0', keyTimes: '0;1', calcMode: 'linear' as const } : {};
  const color = tone === 'down' ? 'fill-primary' : 'fill-chart-4';
  return (
    <>
      {[0, dur / 2].map((offset) => (
        <g key={offset}>
          <circle r={6} className={cn(color, 'opacity-60')} filter="url(#system-topology-glow)">
            <animateMotion
              dur={`${dur}s`}
              begin={`${delay + offset}s`}
              repeatCount="indefinite"
              path={d}
              {...motion}
            />
          </circle>
          <circle r={2.5} className={color}>
            <animateMotion
              dur={`${dur}s`}
              begin={`${delay + offset}s`}
              repeatCount="indefinite"
              path={d}
              {...motion}
            />
          </circle>
        </g>
      ))}
    </>
  );
}

function Node({
  pt,
  icon: Icon,
  role,
  label,
  task,
  status,
}: {
  pt: Point;
  icon: LucideIcon;
  role: string;
  label: string;
  task?: string;
  status?: TopologyStatus;
}) {
  const s = status ? STATUS[status] : undefined;
  const busy = status === 'running';
  return (
    <foreignObject
      x={pt.x}
      y={pt.y - NODE_H / 2}
      width={NODE_W}
      height={NODE_H}
      className="overflow-visible"
    >
      <div
        className={cn(
          'flex h-full flex-col justify-center gap-1 rounded-md border bg-card px-3 text-card-foreground transition-shadow duration-500',
          busy && 'border-primary/60 shadow-[0_0_18px_-4px_var(--primary)]',
          status === 'waiting' && 'border-warn/60',
          (status === 'error' || status === 'offline') && 'border-destructive/60',
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Icon
            className={cn('size-3.5 shrink-0 text-muted-foreground', busy && 'text-primary')}
            aria-hidden
          />
          <span className="min-w-0 truncate text-[13px] font-medium">{label}</span>
          {s ? (
            <StatusDot tone={s.tone} className="ml-auto shrink-0 text-[11px] text-muted-foreground">
              {s.label}
            </StatusDot>
          ) : null}
        </div>
        <div className="flex min-w-0 items-baseline gap-2 text-[11px] text-muted-foreground">
          <span className="shrink-0">{role}</span>
          {task ? <span className="min-w-0 truncate">{task}</span> : null}
        </div>
      </div>
    </foreignObject>
  );
}
