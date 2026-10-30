import { useEffect, useState } from 'react';

import { fetchAttachment, useApi } from '@alteroid/swr';

export type AttachmentObjectUrl = { url: string } | { error: unknown } | undefined;

/**
 * 添付の中身を取り、`blob:` URL にして返す。取れるまで・`enabled` が偽のあいだは `undefined`。
 * `<img src>` に URL を直接入れない: Bearer を運べないので、fetch した `Blob` を `blob:` URL にする。
 * 片付け（アンマウント・id や `enabled` の変化）の後に届いた中身では URL を作らない: 作ると誰も解放しない。
 * 作った URL は片付けで解放し、返す値も `undefined` へ戻す: 解放済みの URL を次の id の間も見せ続けない。
 */
export function useAttachmentObjectUrl(attachmentId: string, enabled = true): AttachmentObjectUrl {
  const api = useApi();
  const [state, setState] = useState<AttachmentObjectUrl>();
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let created: string | undefined;
    fetchAttachment(api, attachmentId, { signal: controller.signal }).then(
      (blob) => {
        if (controller.signal.aborted) return;
        created = URL.createObjectURL(blob);
        setState({ url: created });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ error });
      },
    );
    return () => {
      controller.abort();
      if (created !== undefined) URL.revokeObjectURL(created);
      setState(undefined);
    };
  }, [api, attachmentId, enabled]);
  return state;
}
