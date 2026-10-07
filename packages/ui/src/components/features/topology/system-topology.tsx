import { useEffect, useId, useState } from 'react';

import { Bot, Brain, Database, Hammer, Plug, User, type LucideIcon } from 'lucide-react';

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useDisplayText } from '@/lib/display-text';
import { cn } from '@/lib/utils';

import { AgentModelTag } from '../agent-model-tag';
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
  type TopologyAgent,
  type TopologyScene,
} from './layout';

export type {
  TopologyAgent,
  TopologyDetail,
  TopologyExternal,
  TopologyFlow,
  TopologyManager,
  TopologyScene,
  TopologyStatus,
  TopologyWorker,
} from './layout';

export interface SystemTopologyProps extends TopologyScene {
  layout?: 'auto' | 'wide' | 'narrow';
  className?: string;
}

// 描画幅に上限を置く: 図は viewBox を枠いっぱいに伸ばすので、上限が無いと広い画面で図も文字も大きくなるため
const WIDE_MAX_WIDTH = 1152;
const NARROW_MAX_WIDTH = 360;
// これ未満は narrow へ倒す: wide を縮めると倍率が 0.8 を割り、11px の文字が読めなくなるため
export const WIDE_MIN_WIDTH = 920;

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
  // 「完了待ち」とは別の札にする: 待っているのは動いている途中のため
  idle: { tone: 'neutral', label: '仕事なし' },
  ok: { tone: 'ok', label: '正常' },
  // 待機・正常とは別の札にする: 確かめたように読ませないため
  unknown: { tone: 'neutral', label: '不明' },
  running: { tone: 'accent', label: '実行中' },
  awaiting: { tone: 'accent', label: '完了待ち' },
  // 「承認待ち」と固定しない: 利用枠で止まったクローンまで承認待ちに読めるため
  waiting: { tone: 'warn', label: '止まっている' },
  error: { tone: 'danger', label: '失敗' },
  offline: { tone: 'danger', label: '未接続' },
} as const;

const KIND: Record<NodeKind, { icon: LucideIcon; role: string }> = {
  human: { icon: User, role: '人間' },
  external: { icon: Plug, role: '外部サービス' },
  db: { icon: Database, role: '記憶ストア' },
  clone: { icon: Brain, role: 'クローン' },
  manager: { icon: Bot, role: 'マネージャー' },
  worker: { icon: Hammer, role: '作業者' },
};

// 広い画面は Popover、狭い画面はシートで詳細を出す: 狭い画面には Popover を置く横の余白が無いため
export function SystemTopology({ layout = 'auto', className, ...rawScene }: SystemTopologyProps) {
  const { body } = useDisplayText();
  const scene = redactScene(rawScene, body);
  const summaryId = useId();
  const isMobile = useIsMobile();
  const [frameRef, frameWidth] = useMeasuredWidth();
  const sheet = layout === 'narrow' || (layout === 'auto' && isMobile);
  const narrow =
    layout === 'auto' && frameWidth > 0
      ? frameWidth < WIDE_MIN_WIDTH
      : layout === 'narrow' || sheet;
  const laid = narrow ? layoutNarrow(scene) : layoutWide(scene);
  const unreadable = rawScene.unreadableCount ?? 0;

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

          {/* 線は札より先に描く: 札の下へ潜らせるため */}
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

          {laid.containers.map((c) =>
            c.empty ? (
              <EmptyNote key={`empty-${c.key}`} box={c.empty} text={emptyText(false, unreadable)} />
            ) : null,
          )}
          {laid.empty ? <EmptyNote box={laid.empty} text={emptyText(true, unreadable)} /> : null}
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

// 名前（`label`）・id・時刻は伏せ字に通さない: id や sha を壊さないため
function redactScene(scene: TopologyScene, body: (text: string) => string): TopologyScene {
  const details = (rows: TopologyScene['clone']['details']) =>
    rows?.map((row) => (row.mono ? row : { ...row, value: body(row.value) }));
  const text = (value: string | undefined) => (value === undefined ? undefined : body(value));
  return {
    ...scene,
    clone: { ...scene.clone, task: text(scene.clone.task), details: details(scene.clone.details) },
    db: { ...scene.db, task: text(scene.db.task), details: details(scene.db.details) },
    ...(scene.externals === undefined
      ? {}
      : {
          externals: scene.externals.map((external) => ({
            ...external,
            task: text(external.task),
            details: details(external.details),
          })),
        }),
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

function emptyText(noRunners: boolean, unreadable: number): string {
  if (unreadable > 0)
    return `読めたマネージャーはいません（読めない行が ${unreadable} 件ある。居ないとは限らない）`;
  return noRunners ? '稼働中の器（runner）はありません' : '走っているマネージャーはいません';
}

function EmptyNote({ box, text }: { box: LaidContainer['box']; text: string }) {
  return (
    <foreignObject x={box.x} y={box.y} width={box.w} height={box.h}>
      <div className="flex h-full items-center justify-center rounded-md border border-dashed px-2 text-center text-xs text-muted-foreground">
        {text}
      </div>
    </foreignObject>
  );
}

function summarize({ clone, db, runners, managers, externals }: TopologyScene): string {
  const parts = [
    `クローン: ${STATUS[clone.status].label}${clone.task ? `（${clone.task}）` : ''}${agentSummary(clone.agent)}`,
    // 外部サービスは状態を言わない: 観測していないため
    ...(externals ?? []).map(
      (x) =>
        `外部サービス ${x.label}${x.task ? `（${x.task}）` : ''}${x.flow === 'down' ? '。いま呼ばれた' : ''}`,
    ),
    `記憶ストア: ${STATUS[db.status].label}`,
    runners.length === 0
      ? '稼働中の器（runner）: なし'
      : `runner: ${runners.map((r) => `${r.label} ${STATUS[r.status].label}`).join('、')}`,
    ...managers.map((m) => {
      const ws = (m.workers ?? [])
        .map((w) => `${w.label} ${STATUS[w.status].label}${agentSummary(w.agent)}`)
        .join('、');
      const why = m.status === 'waiting' && m.task ? `（${m.task}）` : '';
      const agent = m.group === true ? '' : agentSummary(m.agent);
      return `マネージャー ${m.label}: ${STATUS[m.status].label}${why}${agent}${ws ? `。作業者 ${ws}` : ''}`;
    }),
  ];
  return parts.join('。');
}

function agentSummary(agent: TopologyAgent | undefined): string {
  return `（モデル ${agent?.model ?? '不明'}）`;
}

const CONTAINER_HINT: Record<string, string> = {
  db: '記憶の置き場（db）',
  daemon: 'alteroid 本体（alteroidd）',
};

function Container({
  container: { key, box, label, state, labelAlign },
}: {
  container: LaidContainer;
}) {
  const down = state === 'offline';
  const unknown = state === 'unknown';
  return (
    <g data-container={key} data-state={state}>
      {CONTAINER_HINT[key] ? <title>{CONTAINER_HINT[key]}</title> : null}
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

const UNKNOWN_AGENT = '不明（名乗りを受けていない）';

function NodeDetail({ node }: { node: LaidNode }) {
  const s = node.status ? STATUS[node.status] : undefined;
  return (
    <KeyValueList
      labelWidth="6rem"
      items={[
        { label: '層', value: KIND[node.kind].role },
        ...(s ? [{ label: '状態', value: <StatusDot tone={s.tone}>{s.label}</StatusDot> }] : []),
        ...(node.task ? [{ label: 'いま', value: node.task }] : []),
        ...(node.agent === undefined
          ? []
          : [
              {
                label: 'モデル',
                value: node.agent.model ?? UNKNOWN_AGENT,
                mono: Boolean(node.agent.model),
              },
            ]),
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
  popover: boolean;
  onHover: (on: boolean) => void;
  onSelect: () => void;
  onClose: () => void;
}) {
  const { box, status } = node;
  const s = status ? STATUS[status] : undefined;
  const busy = status === 'running' || status === 'awaiting';
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
        {node.agent === undefined ? null : (
          <AgentModelTag model={node.agent.model} className="max-w-[45%] shrink self-center" />
        )}
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
            // 別の札を押したときは、閉じる → 開くではなく乗り換えにする
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
