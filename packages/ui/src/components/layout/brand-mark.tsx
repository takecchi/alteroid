import { useId } from 'react';

import { cn } from '@/lib/utils';

/**
 * alteroid の印（記号＋名前）。
 *
 * **記号は「人間」と「その写し（クローン）」の2つの輪である。** 実線の輪が人間、
 * 少しずらして重ねた破線の輪がクローン——`docs/north_star.md` の「クローンは
 * 人間の代替」をそのまま形にしてある。重なった部分だけを主色で塗る
 * （価値観を写し取った部分）。
 *
 * 名前は `font-display`（Michroma）の小文字。**大文字にしない** — 製品名の綴りが
 * 小文字である。
 */
export function BrandMark({
  withWordmark = true,
  className,
}: {
  /** 記号だけにする（狭い帯・アイコンの代わり）。 */
  withWordmark?: boolean;
  className?: string;
}) {
  // 同じ画面に2つ以上出る（上端の帯とドロワーの中など）ので、id は固定にしない。
  // `useId` は `:r1:` の形で返すので、`url(#…)` に載せられる文字だけにする。
  const clipId = `alteroid-mark-clone-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <span className={cn('inline-flex items-center gap-2 text-foreground', className)}>
      <svg
        viewBox="0 0 24 24"
        className="size-5 shrink-0"
        aria-hidden
        focusable="false"
        fill="none"
      >
        <defs>
          <clipPath id={clipId}>
            <circle cx="14.5" cy="12" r="6.5" />
          </clipPath>
        </defs>
        {/* 重なり（写し取った部分）。 */}
        <circle cx="9.5" cy="12" r="6.5" clipPath={`url(#${clipId})`} className="fill-primary" />
        <circle cx="9.5" cy="12" r="6.5" className="stroke-foreground" strokeWidth="1.5" />
        <circle
          cx="14.5"
          cy="12"
          r="6.5"
          className="stroke-primary"
          strokeWidth="1.5"
          strokeDasharray="2.2 1.8"
        />
      </svg>
      {withWordmark && (
        <span className="font-display text-[13px] leading-none tracking-[0.08em]">alteroid</span>
      )}
    </span>
  );
}
