import { useEffect, useId, useState } from 'react';

import { Bot, Brain, Database, Hammer, User, type LucideIcon } from 'lucide-react';

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useDisplayText } from '@/lib/display-text';
import { cn } from '@/lib/utils';

import { KeyValueList } from '../key-value-list';
import { StatusDot } from '../status-dot';

import {
  layoutNarrow,
  layoutWide,
  roundedPath,
  type LaidContainer,
  type LaidEdge,
  type LaidNode,
  type NodeKind,
  type TopologyScene,
} from './layout';

export type {
  TopologyDetail,
  TopologyFlow,
  TopologyManager,
  TopologyScene,
  TopologyStatus,
  TopologyWorker,
} from './layout';

export interface SystemTopologyProps extends TopologyScene {
  /**
   * 配置。`auto` は**置かれた枠の幅**で決める（{@link WIDE_MIN_WIDTH} 以上なら `wide`＝左から右、
   * 未満なら `narrow`＝上から下への木）。枠の幅を測れない環境（jsdom）では狭い画面
   * （`useIsMobile`）で決める。見本帳で両方を並べるために外から固定できる。
   */
  layout?: 'auto' | 'wide' | 'narrow';
  className?: string;
}

/**
 * 図の描画幅の上限（CSS px）。**図は viewBox を枠いっぱいに伸ばして描くので、上限が無いと広い画面で
 * 図も文字も枠に比例して大きくなる**（1920px では札の 13px が 18px になっていた）。
 * 上限は「ラップトップ幅（1366px、サイドバーあり）で描かれる大きさ」を基準にした:
 * `wide` は viewBox 幅 1152 に対し 1040px（倍率 約0.9）、`narrow` は viewBox 幅 360 の等倍。
 * 上限を超えた枠の余りは**中央に置く**（左に寄せると、広い画面で片側だけ空く）。
 */
const WIDE_MAX_WIDTH = 1040;
const NARROW_MAX_WIDTH = 360;
/**
 * `auto` で `wide` にする枠の最小幅。`wide`（viewBox 幅 1152）をこれ未満に縮めると倍率が
 * 0.8 を割り、11px の文字が 9px を下回って読めなくなる。それより狭い枠は木（`narrow`）へ倒す。
 */
export const WIDE_MIN_WIDTH = 920;

/** 要素の実測の幅（CSS px）。測れない環境（`ResizeObserver` が無い）では 0 のまま。 */
function useMeasuredWidth(): [React.RefCallback<HTMLElement>, number] {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (node === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, width];
}

const STATUS = {
  idle: { tone: 'neutral', label: '待機' },
  // 走る・走らないの無い対象（記憶ストア・runner の器）が繋がっている。
  ok: { tone: 'ok', label: '正常' },
  // 確かめられない。**待機・正常とは別の札にする**（確かめたように読ませない）。
  unknown: { tone: 'neutral', label: '不明' },
  running: { tone: 'accent', label: '実行中' },
  // 人間の返事待ち・利用枠の上限など、**自分では進めない**止まり方の総称。理由は札の task と
  // 詳細に出す（「承認待ち」と固定すると、利用枠で止まったクローンまで承認待ちに読める）。
  waiting: { tone: 'warn', label: '止まっている' },
  error: { tone: 'danger', label: '失敗' },
  offline: { tone: 'danger', label: '未接続' },
} as const;

const KIND: Record<NodeKind, { icon: LucideIcon; role: string }> = {
  human: { icon: User, role: '人間' },
  db: { icon: Database, role: '記憶ストア' },
  clone: { icon: Brain, role: 'クローン' },
  manager: { icon: Bot, role: 'マネージャー' },
  worker: { icon: Hammer, role: '作業者' },
};

/**
 * 稼働状況の図。**いま誰が何をしていて、どの線を指示と報告が行き来しているか**を1枚で見せる。
 *
 * 器（デーモン・manager-runner・DB）を枠で、層（人間・クローン・マネージャー・作業者）を
 * 札で描き、線の上を流れる光で「いま動いている経路」を言う。下りの光（指示）は
 * `primary`、上りの光（報告・確認）は `chart-4` の色で、向きでも色でも見分けられる。
 *
 * - **光は飾りであって、情報の本体ではない。** 動いている線は光が無くても線の色で分かり、
 *   札には状態の文言が在る。`prefers-reduced-motion` のときは光だけを消す
 * - 器が `offline` のとき、そこへ向かう線は破線の `destructive` にして光を流さない
 *   （届いていない経路に「流れている」絵を出さない）
 * - **札に触れるとその札の線だけを強調し、押すと詳細を出す。** 広い画面は札の横の
 *   Popover（地図を覆わない — 光が流れ続けたまま、別の札へ乗り換えられる）、狭い画面は
 *   下から出るシート（Popover を置く横の余白が無い）
 * - 読み上げには、図の代わりに層ごとの状態の一覧を渡す。札はボタンとして焦点が当たる
 */
export function SystemTopology({ layout = 'auto', className, ...rawScene }: SystemTopologyProps) {
  const { body } = useDisplayText();
  const scene = redactScene(rawScene, body);
  const summaryId = useId();
  const isMobile = useIsMobile();
  const [frameRef, frameWidth] = useMeasuredWidth();
  // 札の押下の出し方（下からのシート）は画面の狭さで、配置（木か横か）は枠の幅で決める。
  const sheet = layout === 'narrow' || (layout === 'auto' && isMobile);
  const narrow =
    layout === 'auto' && frameWidth > 0
      ? frameWidth < WIDE_MIN_WIDTH
      : layout === 'narrow' || sheet;
  const laid = narrow ? layoutNarrow(scene) : layoutWide(scene);

  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const focus = hovered ?? selected;
  const focusEdges = new Set(laid.nodes.find((n) => n.key === focus)?.edges ?? []);
  const selectedNode = laid.nodes.find((n) => n.key === selected);

  return (
    <div ref={frameRef} className="w-full min-w-0">
      <figure
        className={cn('mx-auto w-full', className)}
        style={{ maxWidth: narrow ? NARROW_MAX_WIDTH : WIDE_MAX_WIDTH }}
      >
        <svg
          viewBox={`0 0 ${laid.width} ${laid.height}`}
          className="h-auto w-full"
          role="img"
          aria-labelledby={summaryId}
        >
          <defs>
            <filter id="system-topology-glow" x="-200%" y="-200%" width="500%" height="500%">
              <feGaussianBlur stdDeviation="3" />
            </filter>
          </defs>

          {laid.containers.map((c) => (
            <Container key={c.key} container={c} />
          ))}

          {/* 線は札より先に描いて、札の下へ潜らせる */}
          {laid.edges.map((e) => (
            <Edge key={e.key} edge={e} dim={focus !== null && !focusEdges.has(e.key)} />
          ))}

          {laid.nodes.map((n) => (
            <Node
              key={n.key}
              node={n}
              selected={selected === n.key}
              popover={!sheet}
              onHover={(on) => setHovered(on ? n.key : null)}
              onSelect={() => setSelected((cur) => (cur === n.key ? null : n.key))}
              onClose={() => setSelected(null)}
            />
          ))}

          {laid.empty ? (
            <foreignObject
              x={laid.empty.x}
              y={laid.empty.y}
              width={laid.empty.w}
              height={laid.empty.h}
            >
              <div className="flex h-full items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
                走っているマネージャーはいません
              </div>
            </foreignObject>
          ) : null}
        </svg>
        <figcaption id={summaryId} className="sr-only">
          {summarize(scene)}
        </figcaption>

        {sheet ? (
          <Sheet
            open={selectedNode !== undefined}
            onOpenChange={(open) => !open && setSelected(null)}
          >
            <SheetContent
              side="bottom"
              className="max-h-[80dvh] gap-0 overflow-y-auto pb-[var(--safe-bottom)]"
            >
              {selectedNode ? (
                <>
                  <SheetHeader className="pb-2">
                    <SheetTitle className="flex items-center gap-2">
                      <NodeIcon node={selectedNode} />
                      {selectedNode.label}
                    </SheetTitle>
                  </SheetHeader>
                  <div className="px-4 pb-6">
                    <NodeDetail node={selectedNode} />
                  </div>
                </>
              ) : null}
            </SheetContent>
          </Sheet>
        ) : null}
      </figure>
    </div>
  );
}

/**
 * 自由文（依頼の抜粋・返事待ちの要旨・道具名）を、描画の直前に伏せ字へ通す
 * （`@/lib/display-text`。データそのものは書き換えない）。**名前（`label`）・id・時刻は
 * 通さない**（id や sha を壊さない）。
 */
function redactScene(scene: TopologyScene, body: (text: string) => string): TopologyScene {
  const details = (rows: TopologyScene['clone']['details']) =>
    rows?.map((row) => (row.mono ? row : { ...row, value: body(row.value) }));
  const text = (value: string | undefined) => (value === undefined ? undefined : body(value));
  return {
    ...scene,
    clone: { ...scene.clone, task: text(scene.clone.task), details: details(scene.clone.details) },
    db: { ...scene.db, task: text(scene.db.task), details: details(scene.db.details) },
    managers: scene.managers.map((manager) => ({
      ...manager,
      task: text(manager.task),
      details: details(manager.details),
      workers: manager.workers?.map((worker) => ({
        ...worker,
        task: text(worker.task),
        details: details(worker.details),
      })),
    })),
  };
}

function summarize({ clone, db, runner, managers }: TopologyScene): string {
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
  container: { key, box, label, state, labelAlign },
}: {
  container: LaidContainer;
}) {
  const down = state === 'offline';
  const unknown = state === 'unknown';
  return (
    <g data-container={key} data-state={state}>
      <rect
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        rx={12}
        className={cn(
          'fill-muted/30 stroke-border',
          down && 'stroke-destructive/70',
          unknown && 'stroke-muted-foreground/60',
        )}
        strokeDasharray={down || unknown ? '6 4' : undefined}
      />
      <text
        x={labelAlign === 'end' ? box.x + box.w - 12 : box.x + 12}
        textAnchor={labelAlign}
        y={box.y + 18}
        className="fill-muted-foreground font-mono text-[11px] tracking-wide"
      >
        {label}
        {down ? ' — 未接続' : unknown ? ' — 不明' : ''}
      </text>
    </g>
  );
}

function Edge({ edge, dim }: { edge: LaidEdge; dim: boolean }) {
  const { flow, broken, reverse } = edge;
  const d = roundedPath(edge.points);
  const active = !broken && flow !== 'idle';
  const down = flow === 'down' || flow === 'both';
  const up = flow === 'up' || flow === 'both';
  return (
    <g data-edge={edge.key} className={cn('transition-opacity duration-300', dim && 'opacity-20')}>
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
          {down ? <Pulse d={d} backward={reverse} tone="down" /> : null}
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

function NodeIcon({ node, className }: { node: LaidNode; className?: string }) {
  const Icon = KIND[node.kind].icon;
  return <Icon className={cn('size-3.5 shrink-0 text-muted-foreground', className)} aria-hidden />;
}

/** 札を押したときの中身。Popover とシートで共通。 */
function NodeDetail({ node }: { node: LaidNode }) {
  const s = node.status ? STATUS[node.status] : undefined;
  return (
    <KeyValueList
      labelWidth="6rem"
      items={[
        { label: '層', value: KIND[node.kind].role },
        ...(s ? [{ label: '状態', value: <StatusDot tone={s.tone}>{s.label}</StatusDot> }] : []),
        ...(node.task ? [{ label: 'いま', value: node.task }] : []),
        ...(node.details ?? []).map((d) => ({ label: d.label, value: d.value, mono: d.mono })),
      ]}
    />
  );
}

function Node({
  node,
  selected,
  popover,
  onHover,
  onSelect,
  onClose,
}: {
  node: LaidNode;
  selected: boolean;
  /** 広い画面では札の横に Popover を出す。狭い画面ではシートを親が出すので出さない */
  popover: boolean;
  onHover: (on: boolean) => void;
  onSelect: () => void;
  onClose: () => void;
}) {
  const { box, status } = node;
  const s = status ? STATUS[status] : undefined;
  const busy = status === 'running';
  const card = (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      aria-expanded={selected}
      aria-label={`${KIND[node.kind].role} ${node.label}${s ? ` ${s.label}` : ''}`}
      className={cn(
        'flex size-full cursor-pointer flex-col justify-center gap-1 rounded-md border bg-card px-3 text-left text-card-foreground outline-none transition-[box-shadow,border-color] duration-300',
        'hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring',
        busy && 'border-primary/60 shadow-[0_0_18px_-4px_var(--primary)]',
        status === 'waiting' && 'border-warn/60',
        status === 'unknown' && 'border-dashed',
        (status === 'error' || status === 'offline') && 'border-destructive/60',
        selected && 'ring-2 ring-primary',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <NodeIcon node={node} className={cn(busy && 'text-primary')} />
        <span className="min-w-0 truncate text-[13px] font-medium">{node.label}</span>
        {s ? (
          <StatusDot tone={s.tone} className="ml-auto shrink-0 text-[11px] text-muted-foreground">
            {s.label}
          </StatusDot>
        ) : null}
      </span>
      <span className="flex min-w-0 items-baseline gap-2 text-[11px] text-muted-foreground">
        <span className="shrink-0">{KIND[node.kind].role}</span>
        {node.task ? <span className="min-w-0 truncate">{node.task}</span> : null}
      </span>
    </button>
  );

  return (
    <foreignObject x={box.x} y={box.y} width={box.w} height={box.h} className="overflow-visible">
      {popover ? (
        <Popover open={selected} onOpenChange={(open) => !open && onClose()}>
          <PopoverAnchor asChild>{card}</PopoverAnchor>
          <PopoverContent
            side="right"
            align="start"
            className="w-80"
            // 別の札を押したときは、閉じる → 開くではなく乗り換えにする（親の onSelect が先に走る）
            onInteractOutside={(e) => {
              if ((e.target as Element | null)?.closest?.('[aria-expanded]')) e.preventDefault();
            }}
          >
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <NodeIcon node={node} />
              {node.label}
            </div>
            <NodeDetail node={node} />
          </PopoverContent>
        </Popover>
      ) : (
        card
      )}
    </foreignObject>
  );
}
