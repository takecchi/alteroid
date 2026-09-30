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
 *
 * **押した時点の正本から次を作りたい呼び手のために、`onToggle` / `onClear` を省略可能で
 * 持つ。** `onChange` は描画時の `selected` から作った次の配列を渡す。正本が URL のとき、
 * 再描画が挟まらない連打では描画時の値が古い。`onToggle(value)` / `onClear()` を渡すと、
 * 対応する操作では `onChange` の代わりにそれが呼ばれる（呼び手が `setSearchParams` の
 * 関数形の中で今の値を読み直して入れ替える）。渡さなければ従来どおり `onChange`。
 */
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
  /** `onToggle` / `onClear` を渡した操作では呼ばれない。 */
  onChange?: (next: V[]) => void;
  /** 省略可。チップを押したとき、`onChange` の代わりに押された1つを渡す。 */
  onToggle?: (value: V) => void;
  /** 省略可。「解除」を押したとき、`onChange([])` の代わりに呼ぶ。 */
  onClear?: () => void;
  /** 帯の読み上げの名前（「種別で絞り込む」など）。 */
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
          onClick={clear}
          className="inline-flex min-h-7 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" aria-hidden />
          {clearLabel}
        </button>
      )}
    </div>
  );
}
