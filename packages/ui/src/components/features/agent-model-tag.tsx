import { cn } from '@/lib/utils';

export interface AgentModelTagProps {
  provider?: string | undefined;
  model?: string | undefined;
  className?: string;
}

const PROVIDER_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

const UNKNOWN = '不明';
const UNKNOWN_FULL = '不明（名乗りを受けていない）';

function providerName(provider: string): string {
  return Object.hasOwn(PROVIDER_NAMES, provider) ? PROVIDER_NAMES[provider]! : provider;
}

// provider ごとに色を変えない: 光る色は主色だけで、区別は文字で言う
export function AgentModelTag({ provider, model, className }: AgentModelTagProps) {
  const sentence = `provider: ${provider ?? UNKNOWN_FULL} / モデル: ${model ?? UNKNOWN_FULL}`;
  const neither = provider === undefined && model === undefined;
  return (
    <span
      title={sentence}
      aria-label={sentence}
      className={cn(
        'inline-flex max-w-full min-w-0 items-center gap-1 rounded-4xl border border-border bg-muted/40 px-1.5 font-mono text-[10px] leading-4 text-muted-foreground',
        neither && 'border-dashed',
        className,
      )}
    >
      {neither ? (
        UNKNOWN
      ) : (
        <>
          <span className="shrink-0 font-medium text-foreground/80">
            {provider === undefined ? UNKNOWN : providerName(provider)}
          </span>
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate">{model ?? UNKNOWN}</span>
        </>
      )}
    </span>
  );
}
