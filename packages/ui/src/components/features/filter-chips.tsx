import { X } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface FilterChipOption<V extends string> {
  value: V;
  label?: string;
  /** 件数（分かるときだけ）。取れないなら渡さない — 0 を作らない。 */
  count?: number;
}

/**
 * 絞り込みのチップの帯（日誌の種別・マネージャーの状態）。複数を選べる。
 *
 * - 押すたびに選択を入れ替える。**何も選んでいない＝全部**（呼ぶ側の約束）
 * - 選んでいるチップは主色の縁と面。**`aria-pressed` でも言う**（色だけにしない）
 * - 1つでも選んでいれば「解除」を出す
 * - 並びは `options` の順のまま（呼ぶ側が正本の順で渡す）
 *
 * 選択の正本は呼ぶ側が持つ（画面では URL のクエリ）。
 */
export function FilterChips<V extends string>({
  options,
  selected,
  onChange,
  label,
  clearLabel = '解除',
  className,
}: {
  options: readonly FilterChipOption<V>[];
  selected: readonly V[];
  onChange: (next: V[]) => void;
  /** 帯の読み上げの名前（「種別で絞り込む」など）。 */
  label: string;
  clearLabel?: string;
  className?: string;
}) {
  const toggle = (value: V) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);

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
              'inline-flex min-h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] transition-colors',
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
          onClick={() => onChange([])}
          className="inline-flex min-h-7 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" aria-hidden />
          {clearLabel}
        </button>
      )}
    </div>
  );
}
