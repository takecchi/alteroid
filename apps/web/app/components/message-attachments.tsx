import { useEffect, useState } from 'react';

import { AttachmentGoneError, fetchAttachment, useApi } from '@alteroid/swr';
import { formatBytes, isPreviewableImage, redactError } from '@alteroid/logic';
import type { MessageAttachment } from '@alteroid/logic';
import { Button } from '@alteroid/ui';

/**
 * 発言に添えられた添付を、本文の下に出す。
 *
 * **このファイルは `React.lazy` で読み込む**（`routes/chat.tsx`。添付のある発言が
 * 画面に出たときだけ。バンドル予算 1.125 MiB のため、最初の読み込みへ入れない）。
 *
 * - 中身は **Bearer 付きの fetch**（`fetchAttachment`）で取る。`<img src>` に URL を直接
 *   入れても Bearer を運べないので、`Blob` → `blob:` URL にして縮小表示する
 * - 画像以外は「名前・種類・大きさ」とダウンロードのボタン（押したときに取り、`a[download]` で保存）
 * - 404（消えた・期限切れ）は「取り出せない」と出す
 */
export default function MessageAttachments({
  attachments,
}: {
  attachments: readonly MessageAttachment[];
}) {
  return (
    <ul aria-label="添付" className="flex max-w-[46rem] flex-wrap gap-2">
      {attachments.map((attachment) => (
        <li key={attachment.id}>
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
  return error instanceof AttachmentGoneError
    ? '取り出せない（期限切れの可能性）'
    : `取り出せなかった: ${redactError(error instanceof Error ? error.message : String(error))}`;
}

function ImageAttachment({ attachment }: { attachment: MessageAttachment }) {
  const api = useApi();
  const [state, setState] = useState<{ url: string } | { error: string } | undefined>();
  useEffect(() => {
    const controller = new AbortController();
    let created: string | undefined;
    fetchAttachment(api, attachment.id, { signal: controller.signal }).then(
      (blob) => {
        created = URL.createObjectURL(blob);
        setState({ url: created });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ error: describe(error) });
      },
    );
    return () => {
      controller.abort();
      // 後片付け: 画面から外れたら blob: URL を解放する。
      if (created !== undefined) URL.revokeObjectURL(created);
    };
  }, [api, attachment.id]);
  if (state === undefined) {
    return (
      <span className="block size-24 animate-pulse rounded-md bg-muted" role="status">
        <span className="sr-only">{attachment.name} を読み込み中</span>
      </span>
    );
  }
  if ('error' in state) {
    return (
      <span role="alert" className="block rounded-md border border-border px-2 py-1 text-xs">
        {attachment.name}: {state.error}
      </span>
    );
  }
  return (
    <img
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
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = attachment.name;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
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
