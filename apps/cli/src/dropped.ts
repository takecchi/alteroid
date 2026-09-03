import { stdout } from 'node:process';

import {
  describeDroppedTraceEmpty,
  describeDroppedTraceOrigin,
  describeDroppedTraceRetention,
  type DroppedTraceOrigin,
} from '@alteroid/core';

import { createClient } from './client.js';
import { resolveTarget } from './target.js';

/**
 * `alteroid dropped` — 握り潰しの跡（記録・読み出しの失敗の跡。本文は1文字も
 * 含まない）を器の外から読む。
 *
 * 経路は `GET /dropped` の1本だけで（`apps/daemon/src/app.ts`「経路は1本だけに
 * する」）、Web UI の `/dropped` 画面とクローンの MCP 道具 `self_dropped`
 * （`packages/core/src/tools.ts`）も同じ帳面を見る
 * （`packages/core/src/dropped-record.ts`）。
 *
 * **文言は core（`describeDroppedTraceOrigin` 等）に任せ、ここで作り直さない。**
 * 口ごとに違う言葉で同じ状態が出ると、読む側は別の状態だと読む（`runners.ts`
 * と同じ判断）。
 *
 * **「無い」の種類を3つ、混ぜずに言い分ける。判定の基準は「次の一手が変わるか」。**
 *
 * 1. **取りに行けなかった** —— デーモンへ繋がらない・認証で弾かれた・この口を
 *    持たない古いデーモン（404）。**404 は「跡が無い」ではない** —— デーモンの
 *    版が古い、という別の次の一手を指すので、0件とは別の文言にする。
 * 2. **取りに行けたが0件** —— `describeDroppedTraceEmpty()` をそのまま出す。
 *    「無事だった」とは読ませない。
 * 3. **runner の跡はここには出ない** —— `describeDroppedTraceOrigin(origin)` を、
 *    0件のときも件数があるときも常に出す（構造的に見えないものを、黙って0件に
 *    混ぜない）。
 *
 * **繋がらない（ネットワークそのものの失敗）はここで握り潰さない。** `resolveTarget`
 * が返す `note`（未ログイン）だけをここで扱い、それ以外の接続失敗は
 * `runners.ts` / `usage.ts` 等の既存コマンドと同じく、例外をそのまま上（`index.ts`
 * の `program.parseAsync(...).catch(...)`）へ通す。
 */
export async function droppedCommand(): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.dropped.$get();
  if (response.status === 404) {
    stdout.write(
      'このデーモンには GET /dropped が無い（版が古い可能性がある。' +
        'alteroid daemon stop && alteroid chat でデーモンを更新してください）\n',
    );
    return;
  }
  if (!response.ok) {
    stdout.write('握り潰しの跡を読めませんでした\n');
    return;
  }
  stdout.write(`${renderDropped(await response.json())}\n`);
}

/** `GET /dropped` の応答そのまま。 */
export interface DroppedView {
  origin: DroppedTraceOrigin;
  since: string;
  limit: number;
  total: number;
  /** 古い順（末尾が最新）。 */
  traces: readonly string[];
}

/**
 * 帳面を、人間が読める形へ。
 *
 * **出す順序を固定する。**
 * 1. 何の跡を見ているか（`describeDroppedTraceOrigin`。常に出す）
 * 2. 帳面が数え始めた時刻（`since`。CLI の既存の作法どおり ISO 文字列を
 *    そのまま出す——`usage.ts` の `renderUsage` が `台帳の始点: ${since}` と
 *    同じ形で出しているのに合わせる）
 * 3. 件数と保持のしかた（`describeDroppedTraceRetention`）
 * 4. 0件なら `describeDroppedTraceEmpty`、それ以外なら跡そのもの（古い順、全件）
 */
export function renderDropped(view: DroppedView): string {
  const lines: string[] = [
    describeDroppedTraceOrigin(view.origin),
    '',
    `帳面が数え始めた時刻: ${view.since}`,
    `件数: ${view.total}（${describeDroppedTraceRetention(view.limit)}）`,
    '',
  ];
  if (view.total === 0) {
    lines.push(describeDroppedTraceEmpty());
    return lines.join('\n');
  }
  lines.push(...view.traces);
  return lines.join('\n');
}
