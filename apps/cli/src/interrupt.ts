import { stdout } from 'node:process';

import { createClient } from './client.js';
import { describeAuthFailure, resolveTarget } from './target.js';

/**
 * `alteroid interrupt` — いま走っているクローンのターンを止める（#1398 c23-1）。
 *
 * 経路は `POST /clone/interrupt` の1本だけである。それまで人間が走行中のクローンの
 * ターンを止める口は、HTTP・CLI・Web UI のどこにも無かった。止めるのはいまの
 * ターンだけで、セッション（会話の続き）と受信箱はそのまま残る。
 *
 * 応答の3値（`interrupted` / `idle` / `unsupported`）を言い分ける —— 「止めるものが
 * 無かった」を「止めた」と言わない。
 *
 * **失敗は例外で上へ通す（＝終了コードが 0 でなくなる）。** ここは走行中のクローンの
 * ターンを止める副作用のある操作なので、`reset.ts` / `access.ts` / `token.ts` と
 * 同じく、401/403/5xx のどれでも握り潰さない（#1621。以前はここで `stdout.write`
 * して正常 return していたため、認証切れやデーモンの内部エラーでも終了コードが
 * 0 になり、スクリプトや cron から失敗を検知できなかった——`inbox.ts` の
 * `inboxRemoveCommand` が同じ理由を書いている（逐語は
 * `grep -Fn -- 'は全部この形である' apps/cli/src/inbox.ts`）。
 *
 * **401/403 は `describeAuthFailure` に判定を委ねる。** `/clone/interrupt` の資格は
 * `authenticate` だけ（`requireOperator` / `requireOwner` は付いていない —
 * `/chat/:conversationId/end` と同じ強さ。`apps/daemon/src/app.ts` の
 * `POST /clone/interrupt` の doc「資格は `/chat/:conversationId/end` と同じ」）
 * ので、403 の理由はほぼ必ず未許可——`forbiddenKindOf` を呼ばずに `kind` 省略
 * （既定 `'unknown'`）でここへ丸投げしてよい（`chat.ts` / `inbox.ts` と同じ判断。
 * `target.ts` の `describeAuthFailure` の doc）。
 *
 * **`target.note`（未ログイン）の分岐はそのまま残す。** `reset.ts` / `access.ts` /
 * `token.ts` はこの分岐を持たない独自の `request()` ヘルパを使っているが、
 * ここは `inboxRemoveCommand`（`inbox.ts`）と同じく `createClient` を使う形なので、
 * より構造の近いそちらに揃えてある——`inboxRemoveCommand` も「未ログインなら
 * note を出して return、それ以外は throw」という同じ2段構えである。
 */
export async function interruptCommand(): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.clone.interrupt.$post();
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(`クローンのターンを止められませんでした（HTTP ${String(response.status)}）`);
  }
  stdout.write(`${describeInterruptOutcome((await response.json()).outcome)}\n`);
}

/** 応答の3値を人間の言葉にする。 */
export function describeInterruptOutcome(outcome: 'interrupted' | 'idle' | 'unsupported'): string {
  switch (outcome) {
    case 'interrupted':
      return 'いま走っていたクローンのターンを止めた。会話の続きと受信箱はそのまま残る（次の合図で次のターンが始まる）。';
    case 'idle':
      return '走っているターンは無かった（止めるものが無い）。';
    case 'unsupported':
      return 'このデーモンのクローンは、ターンを止める口を持っていない。';
  }
}
