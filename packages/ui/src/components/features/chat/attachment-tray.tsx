import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Button } from '../../common';

export interface ComposerAttachment {
  key: string;
  name: string;
  sizeLabel: string;
  preview?: Blob;
}

function Thumbnail({ blob, name }: { blob: Blob; name: string }) {
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const created = URL.createObjectURL(blob);
    // state を経由せず DOM へ直接書く: effect の中の setState は連鎖描画になるため
    if (image.current !== null) image.current.src = created;
    return () => URL.revokeObjectURL(created);
  }, [blob]);
  return (
    <img ref={image} alt={`${name} の縮小表示`} className="size-8 shrink-0 rounded object-cover" />
  );
}

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
    <ul aria-label="添付" className="mb-2 flex max-h-[30dvh] flex-wrap gap-2 overflow-y-auto">
      {attachments.map((item) => (
        <li
          key={item.key}
          className="flex max-w-full items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-xs"
        >
          {item.preview !== undefined && <Thumbnail blob={item.preview} name={item.name} />}
          <span className="min-w-0 truncate" title={item.name}>
            {item.name}
          </span>
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
