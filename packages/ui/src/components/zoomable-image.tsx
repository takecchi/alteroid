import { useState } from 'react';

import { DialogContent, Dialog, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

/**
 * `blob:` URL を作らず・解放もしない: 持ち主は呼び出し側で、発言の添付は画面から外れたときに呼び出し側が revoke するため。
 * 複数枚の左右送りを作らない: バンドル予算が約 10 KB しか無いため。
 */
export function ZoomableImage({
  src,
  alt,
  title,
  className,
}: {
  src: string;
  alt: string;
  title?: string;
  className?: string;
}) {
  // boolean にしない: src が変わったとき（添付の再取得で blob: が替わる）に effect で戻す手間を避けるため
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (failedSrc === src) {
    // 壊れた画像を拡大の窓へ渡さない: 窓の中の画像も原寸リンクも同じ src で壊れるため
    const label = alt === '' ? '画像' : `画像: ${alt}`;
    return (
      <span className="text-sm text-muted-foreground">
        {src === '' ? (
          <span>{label}</span>
        ) : (
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {label}
          </a>
        )}
        （画像を読み込めなかった）
      </span>
    );
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          title={title}
          className="block max-w-full cursor-zoom-in rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <img src={src} alt={alt} className={className} onError={() => setFailedSrc(src)} />
        </button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="w-fit max-w-[calc(100%-2rem)] sm:max-w-[min(96vw,64rem)]"
      >
        <DialogTitle className="sr-only">{alt === '' ? '画像' : alt}</DialogTitle>
        <img
          src={src}
          alt={alt}
          className="mx-auto max-h-[75vh] max-w-full rounded-md object-contain"
        />
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          原寸を新しいタブで開く
        </a>
      </DialogContent>
    </Dialog>
  );
}
