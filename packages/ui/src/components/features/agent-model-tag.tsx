import { cn } from '@/lib/utils';

export interface AgentModelTagProps {
  model?: string | undefined;
  className?: string;
}

// 推測ではなく固定値: 層（クローン・マネージャー・作業者）は常に Claude で動く（2026-10-07 の決定）。provider の prop は持たない
const LAYER_AGENT_NAME = 'Claude';

const UNKNOWN = '不明';
const UNKNOWN_FULL = '不明（名乗りを受けていない）';

// 主色を使わない: 光る色は主色だけで、区別は文字で言う
export function AgentModelTag({ model, className }: AgentModelTagProps) {
  const sentence =
    model === undefined
      ? `モデル: ${UNKNOWN_FULL}`
      : `モデル: ${model}（層は ${LAYER_AGENT_NAME} で動く）`;
  return (
    <span
      title={sentence}
      aria-label={sentence}
      className={cn(
        'inline-flex max-w-full min-w-0 items-center gap-1 rounded-4xl border border-border bg-muted/40 px-1.5 font-mono text-[10px] leading-4 text-muted-foreground',
        model === undefined && 'border-dashed',
        className,
      )}
    >
      {model === undefined ? (
        UNKNOWN
      ) : (
        <>
          <span className="shrink-0 font-medium text-foreground/80">{LAYER_AGENT_NAME}</span>
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate">{model}</span>
        </>
      )}
    </span>
  );
}
