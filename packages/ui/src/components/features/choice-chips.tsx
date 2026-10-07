import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

export interface ChoiceChipOption<V extends string> {
  value: V;
  label?: string;
}

export function ChoiceChips<V extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: readonly ChoiceChipOption<V>[];
  value: V;
  onChange: (next: V) => void;
  label: string;
  className?: string;
}) {
  return (
    <RadioGroupPrimitive.Root
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        // 空文字を通さない: 選択の解除に当たるため
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
