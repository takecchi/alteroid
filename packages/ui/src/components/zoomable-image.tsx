import { DialogContent, Dialog, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

/**
 * 押すと大きく見られる画像（#3811）。
 *
 * - 小さい画像は `<button>` で包む。キーボードで開け、閉じるとフォーカスは
 *   この button へ戻る（Radix の Dialog が返す）。代替テキストは `alt` のまま
 *   button の名前になる
 * - 開いた窓は画面に収まる大きさで出す。Esc・外側・右上の ✕ で閉じる
 * - 原寸は新しいタブで開くリンクにした（窓の中でスクロールさせる作りは足さない）。
 *   `blob:` URL は呼び出し側が持ち主で、**ここでは作らず・解放もしない**
 *   （発言の添付は画面から外れたときに呼び出し側が revoke する）
 * - 複数枚の左右送りは作らない（予算が約 10 KB しか無い。1 枚ずつ開き直せる）
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
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          title={title}
          className="block max-w-full cursor-zoom-in rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <img src={src} alt={alt} className={className} />
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
