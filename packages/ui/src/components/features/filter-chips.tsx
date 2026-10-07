import { X } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface FilterChipOption<V extends string> {
  value: V;
  label?: string;
  // 取れないなら渡さない: 0 を作らないため
  count?: number;
}

// `onToggle` / `onClear` を持つ: 正本が URL のとき、再描画が挟まらない連打では `onChange` に渡る描画時の値が古いため
export function FilterChips<V extends string>({
  options,
  selected,
  onChange,
  onToggle,
  onClear,
  label,
  clearLabel = '解除',
  className,
}: {
  options: readonly FilterChipOption<V>[];
  selected: readonly V[];
  onChange?: (next: V[]) => void;
  onToggle?: (value: V) => void;
  onClear?: () => void;
  label: string;
  clearLabel?: string;
  className?: string;
}) {
  const toggle = (value: V) => {
    if (onToggle) onToggle(value);
    else
      onChange?.(
        selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value],
      );
  };
  const clear = () => {
    if (onClear) onClear();
    else onChange?.([]);
  };

  return (
    <div
      role="group"
      aria-label={label}
      className={cn('flex flex-wrap items-center gap-1.5', className)}
    >
      {options.map((option) => {
        const on = selected.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(option.value)}
            className={cn(
              'inline-flex min-h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] pointer-coarse:min-h-11 transition-colors',
              on
                ? 'border-primary bg-primary/15 text-foreground'
                : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground',
            )}
          >
            {option.label ?? option.value}
            {option.count !== undefined && (
              <span className="text-muted-foreground tabular-nums">{option.count}</span>
            )}
          </button>
        );
      })}
      {selected.length > 0 && (
        <button
          type="button"
          onClick={clear}
          className="inline-flex min-h-7 items-center gap-1 rounded-md px-2 text-[11px] pointer-coarse:min-h-11 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" aria-hidden />
          {clearLabel}
        </button>
      )}
    </div>
  );
}
