import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

export interface ChoiceChipOption<V extends string> {
  value: V;
  label?: string;
}

/**
 * 単一選択のチップの帯（進捗の窓 24時間 / 7日 / 30日 など）。
 *
 * - 常にちょうど1つが選ばれている。**「解除」は無い**。選んでいるものをもう一度押しても
 *   選択は外れず、`onChange` も呼ばない
 * - `role="radiogroup"` と各チップの `role="radio"` / `aria-checked`（色だけにしない）。
 *   矢印キーで隣へ動き、動いた先が選ばれる（ラジオグループの作法。Radix の RadioGroup）
 * - 見た目は `FilterChips` の Twin Plate と揃える（主色の縁と面）
 * - `value` が `options` に無い値でも落ちない。どれも選ばれていない見た目になり、
 *   Tab では先頭のチップに入れる。押せば `onChange` が呼ばれて選び直せる
 *
 * 選択の正本は呼ぶ側が持つ（制御コンポーネント）。
 * 複数を選べる絞り込みは `FilterChips`。
 */
export function ChoiceChips<V extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: readonly ChoiceChipOption<V>[];
  /** いま選ばれている値。 */
  value: V;
  /** 別のチップが選ばれたときだけ呼ぶ（選択中を押しても呼ばない）。 */
  onChange: (next: V) => void;
  /** 帯の読み上げの名前（「集計の窓」など）。必須。 */
  label: string;
  className?: string;
}) {
  return (
    <RadioGroupPrimitive.Root
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        // Radix は選び直しのときだけ呼ぶが、空文字は選択の解除に当たるので通さない。
        const option = options.find((o) => o.value === next);
        if (option) onChange(option.value);
      }}
      orientation="horizontal"
      className={cn('flex flex-wrap items-center gap-1.5', className)}
    >
      {options.map((option) => (
        <RadioGroupPrimitive.Item
          key={option.value}
          value={option.value}
          className={cn(
            'inline-flex min-h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] pointer-coarse:min-h-11 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
            'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground',
            'data-[state=checked]:border-primary data-[state=checked]:bg-primary/15 data-[state=checked]:text-foreground',
          )}
        >
          {option.label ?? option.value}
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  );
}
