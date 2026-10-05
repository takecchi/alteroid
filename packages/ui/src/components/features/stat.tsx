import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

const TONES = {
  neutral: 'text-foreground',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-destructive',
  accent: 'text-primary',
} as const;

/**
 * 1つの量（今日の費用・承認待ちの件数・稼働中の数）。
 *
 * 数字は本文の書体（`font-sans`、IBM Plex Sans JP）の太さ500・`tabular-nums` で出す。
 * **`font-display`（Michroma）は使わない** — 0 と O が同じ形で見分けられず、件数・金額・
 * id を読み違える（#2843）。装飾の書体はブランドの印（`brand-mark`）だけに残す。
 *
 * **取れなかった量に 0 を出さないこと。** `value` に `—` などを渡し、`hint` で
 * 取れない理由を書く（AGENTS.md の地雷「取れない軸に 0 の行を作る」）。
 */
export function Stat({
  label,
  value,
  unit,
  hint,
  tone = 'neutral',
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  /** 値の後ろに小さく添える単位（件・USD）。 */
  unit?: ReactNode;
  hint?: ReactNode;
  tone?: keyof typeof TONES;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1.5 flex items-baseline gap-1.5">
        <span
          data-numeric
          className={cn('text-2xl leading-none font-medium tabular-nums', TONES[tone])}
        >
          {value}
        </span>
        {unit !== undefined && <span className="text-xs text-muted-foreground">{unit}</span>}
      </p>
      {hint !== undefined && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
