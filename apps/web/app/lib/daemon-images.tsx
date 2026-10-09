import { useMemo } from 'react';
import type { ReactNode } from 'react';

import { fetchAttachment, useApiContext } from '@alteroid/swr';
import { DaemonImagesProvider } from '@alteroid/ui';
import type { DaemonImages } from '@alteroid/ui';

/**
 * Markdown の画像の `src` が、いま接続しているデーモンの添付（`<base>/attachments/<id>`）なら id を返す。それ以外は `undefined`。
 * 資格（Bearer）を送ってよいかの線はここだけに置く:
 * - 絶対 URL だけを対象にする。相対パス（`/attachments/<id>`）は含めない: Web の origin とデーモンの origin が別の配置では、
 *   相対パスは Web の origin を指し、デーモンの添付ではない。含めると「別の場所を指す URL に、デーモンの資格で取りに行く」形になるため
 * - origin が接続中の API の base URL の origin と完全に一致すること（scheme・host・port）。userinfo・query・fragment 付きは対象にしない
 * - path が base の path の下の `/attachments/<id>` ちょうどであること（id は英数字・`_`・`-` だけ）
 */
export function matchDaemonAttachmentUrl(src: string, baseUrl: string): string | undefined {
  let target: URL;
  let base: URL;
  try {
    target = new URL(src);
    // 相対の base（既定の `/api`）は、いまの画面の origin で解く
    base = new URL(baseUrl, globalThis.location.href);
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
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : undefined;
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
