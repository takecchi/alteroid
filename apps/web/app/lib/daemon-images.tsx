import { useMemo } from 'react';
import type { ReactNode } from 'react';

import { fetchAttachment, useApiContext } from '@alteroid/swr';
import { DaemonImagesProvider } from '@alteroid/ui';
import type { DaemonImages } from '@alteroid/ui';

/**
 * Markdown の画像の `src` が、いま接続しているデーモンの添付（`<base>/attachments/<id>`）なら id を返す。それ以外は `undefined`。
 * 資格（Bearer）を送ってよいかの線はここだけに置く:
 * - 絶対 URL に加え、`/attachments/<id>` と `attachments/<id>` の相対パスも、デーモンの base の下のものとして扱う:
 *   取りに行く先は `src` ではなく接続中の base URL と id から組むので、資格がよそへ行く経路にならない。
 *   相対パスは base の path と連結して絶対 URL にしてから、下の確認を絶対 URL と同じに通す。`/home/x.png`・`./x.png` など他の相対パスは対象にしない
 * - origin が接続中の API の base URL の origin と完全に一致すること（scheme・host・port）。userinfo・query・fragment 付きは対象にしない
 * - path が base の path の下の `/attachments/<id>` ちょうどであること（id は英数字・`_`・`-` だけ）
 */
export function matchDaemonAttachmentUrl(src: string, baseUrl: string): string | undefined {
  let target: URL;
  let base: URL;
  try {
    // 相対の base（既定の `/api`）は、いまの画面の origin で解く
    base = new URL(baseUrl, globalThis.location.href);
    const relative = /^\/?attachments\/(.*)$/s.exec(src);
    target =
      relative === null
        ? new URL(src)
        : new URL(base.pathname.replace(/\/+$/, '') + '/attachments/' + relative[1], base);
  } catch {
    return undefined;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return undefined;
  if (target.origin !== base.origin) return undefined;
  if (target.username !== '' || target.password !== '') return undefined;
  if (target.search !== '' || target.hash !== '') return undefined;
  const prefix = base.pathname.replace(/\/+$/, '');
  if (!target.pathname.startsWith(prefix + '/attachments/')) return undefined;
  const id = target.pathname.slice(prefix.length + '/attachments/'.length);
  // `limits` は id ではなく上限を返す経路（`GET /attachments/limits`）: 資格を付けて取りに行く意味が無い
  return /^[A-Za-z0-9_-]+$/.test(id) && id !== 'limits' ? id : undefined;
}

export function WebDaemonImagesProvider({ children }: { children: ReactNode }) {
  const { client, baseUrl } = useApiContext();
  // 値の同一性を保つ: 変わると Markdown の画像が取り直しになるため
  const value = useMemo<DaemonImages>(
    () => ({
      match: (src) => matchDaemonAttachmentUrl(src, baseUrl),
      // 取る先は `src` ではなく client（= 接続中の base URL）と id から組む: `src` の host へ資格が行く経路を作らない
      fetch: (id, signal) => fetchAttachment(client, id, { signal }),
    }),
    [client, baseUrl],
  );
  return <DaemonImagesProvider value={value}>{children}</DaemonImagesProvider>;
}
