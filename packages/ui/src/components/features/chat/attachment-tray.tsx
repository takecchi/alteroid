import { X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '../../common';

/** 入力欄に並べる、送る前の添付1つ。 */
export interface ComposerAttachment {
  key: string;
  name: string;
  /** 読み上げ・表示用の大きさ（呼ぶ側が整える。例: `1.2 MB`）。 */
  sizeLabel: string;
  /** 縮小表示してよい画像なら、その中身。それ以外は `undefined`。 */
  preview?: Blob;
}

function Thumbnail({ blob, name }: { blob: Blob; name: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const created = URL.createObjectURL(blob);
    setUrl(created);
    // 後片付け: 外したとき・画面を離れたときに blob: URL を解放する。
    return () => URL.revokeObjectURL(created);
  }, [blob]);
  if (url === undefined) return <span className="size-8 shrink-0 rounded bg-muted" aria-hidden />;
  return (
    <img src={url} alt={`${name} の縮小表示`} className="size-8 shrink-0 rounded object-cover" />
  );
}

/**
 * 送る前の添付を並べるチップ。名前・大きさ・外すボタン、画像なら縮小表示。
 * **添付があるときだけ読み込む**（`ChatComposer` が `React.lazy` で取る。バンドル予算のため）。
 */
export default function AttachmentTray({
  attachments,
  onRemove,
  disabled = false,
}: {
  attachments: readonly ComposerAttachment[];
  onRemove?: (key: string) => void;
  disabled?: boolean;
}) {
  return (
    <ul aria-label="添付" className="mb-2 flex flex-wrap gap-2">
      {attachments.map((item) => (
        <li
          key={item.key}
          className="flex max-w-full items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-xs"
        >
          {item.preview !== undefined && <Thumbnail blob={item.preview} name={item.name} />}
          <span className="min-w-0 truncate">{item.name}</span>
          <span className="shrink-0 text-muted-foreground" data-numeric>
            {item.sizeLabel}
          </span>
          {onRemove !== undefined && (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              aria-label={`${item.name} を外す`}
              onClick={() => onRemove(item.key)}
            >
              <X className="size-3.5" aria-hidden />
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
