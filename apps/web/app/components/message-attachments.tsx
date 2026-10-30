import { useState } from 'react';

import { fetchAttachment, useApi } from '@alteroid/swr';
import { formatBytes, isPreviewableImage } from '@alteroid/logic';
import type { MessageAttachment } from '@alteroid/logic';
import { Button, ZoomableImage } from '@alteroid/ui';

import { describeAttachmentFailure } from '~/lib/error-text';
import { saveBlob } from '~/lib/save-blob';
import { useAttachmentObjectUrl } from '~/lib/use-attachment-object-url';

/**
 * `React.lazy` で読み込む（`routes/chat.tsx`）: バンドル予算 1.125 MiB のため、最初の読み込みへ入れない。
 * 画像は `blob:` URL にして出す（取り方は `useAttachmentObjectUrl`）。
 */
export default function MessageAttachments({
  attachments,
}: {
  attachments: readonly MessageAttachment[];
}) {
  return (
    <ul aria-label="添付" className="flex max-w-full min-w-0 flex-wrap gap-2 sm:max-w-[46rem]">
      {attachments.map((attachment) => (
        <li key={attachment.id} className="min-w-0 max-w-full">
          {isPreviewableImage(attachment.mediaType) ? (
            <ImageAttachment attachment={attachment} />
          ) : (
            <FileAttachment attachment={attachment} />
          )}
        </li>
      ))}
    </ul>
  );
}

function describe(error: unknown): string {
  return describeAttachmentFailure(error, '取り出せなかった: ');
}

function ImageAttachment({ attachment }: { attachment: MessageAttachment }) {
  const state = useAttachmentObjectUrl(attachment.id);
  if (state === undefined) {
    return (
      <span className="block size-24 animate-pulse rounded-md bg-muted" role="status">
        <span className="sr-only">{attachment.name} を読み込み中</span>
      </span>
    );
  }
  if ('error' in state) {
    return (
      <span
        role="alert"
        className="block max-w-full min-w-0 rounded-md border border-border px-2 py-1 text-xs break-words"
      >
        {attachment.name}: {describe(state.error)}
      </span>
    );
  }
  return (
    <ZoomableImage
      src={state.url}
      alt={attachment.name}
      title={`${attachment.name}（${formatBytes(attachment.size)}）`}
      className="max-h-48 max-w-full rounded-md border border-border object-contain"
    />
  );
}

function FileAttachment({ attachment }: { attachment: MessageAttachment }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const download = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const blob = await fetchAttachment(api, attachment.id);
      saveBlob(blob, attachment.name);
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-card px-3 py-2 text-xs">
      <span className="font-medium break-all">{attachment.name}</span>
      <span className="text-muted-foreground" data-numeric>
        {attachment.mediaType} / {formatBytes(attachment.size)}
      </span>
      <Button
        size="sm"
        loading={busy}
        aria-label={`${attachment.name} をダウンロード`}
        onClick={() => void download()}
      >
        ダウンロード
      </Button>
      {error !== undefined && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
