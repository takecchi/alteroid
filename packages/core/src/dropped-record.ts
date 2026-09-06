import { writeSync } from 'node:fs';

import type { RunnerEvent } from './runner-protocol.js';
import type { InboxEvent, JournalEntryInput } from './schema.js';

/**
 * 記録の書き込みに失敗したことを stderr へ1行だけ残す。
 *
 * **握り潰しをやめるのではない。跡だけを残す。** 記録できないことでセッションを
 * 殺すべきではない（文脈を失う方が高くつく）。だが跡がどこにも無いと、
 * **日誌が判別器として静かに嘘をつく** — 「日誌にマーカーが無い」が
 * 「その処理を通らなかった」と読めてしまい、実際には「通ったが書けなかった」
 * だった、という取り違えが起きる。しかも一番書けなくなりやすいのは片付けの
 * 途中（ストアを閉じた後）＝一番調べたい時間帯である。
 *
 * **本文は出さない。** ここへ渡ってくる記録には、マネージャーの報告
 * （＝外の世界から拾ってきた任意の文字列）がそのまま入る。過去に `GH_TOKEN` が
 * テスト出力（`railway/setup.test.ts` の差分アサーション）へ全文で出た事故が
 * あり（#52）、書けなかった本文を丸ごとログへ吐くと
 * **日誌にすら入らなかった秘密がホスティング先のログには残る**という逆転が起きる。
 * 日誌はまだ持ち主しか読まないが、stderr は器の外へ出ていく。
 *
 * **足りないと思っても本文を足さないこと。** ここは「何が起きたか」を掘るための
 * 跡であって、落ちた記録の代わりではない。中身が要るなら、ストアが書ける状態に
 * 戻してから読む。
 *
 * @param what 何を記録し損ねたか（固定文言。呼び出し側が書く）
 * @param detail 本文を含まない見分け（`journalEntryShape` などで作る）
 */
export function noteDroppedRecord(what: string, detail: string, error: unknown): void {
  const tail = detail === '' ? '' : `（${detail}）`;
  note(`${what}を記録できませんでした${tail}: ${reasonOf(error)}`);
}

/**
 * 記録の**読み出し**に失敗したことを stderr へ1行だけ残す。
 *
 * **書けなかった側（`noteDroppedRecord`）と対になる。** あちらの理由がそのまま
 * こちらにも効く —「跡がどこにも無いと、**『無い』が『通らなかった』と読める**」。
 * 読み出しではその取り違えがもう一段悪くなる: 読めなかったことが跡に残らないと、
 * 呼び出し側は**預かっていない**と読み、下流はそれを**恒久の結論**（終端状態・
 * 自動再試行の打ち切り・存在の否定を含む文言）に変える。
 *
 * **`noteDroppedRecord` を流用しないのは、あれが「記録できませんでした」と
 * 書くからである。** 読み出しの失敗にその文を当てると、跡そのものが何が起きたかを
 * 取り違えさせる（この関数が防ごうとしているものと同じ形になる）。
 *
 * **本文は出さない。** 理由は `noteDroppedRecord` と同じで、ここへ渡ってくる
 * 記録には外の世界から拾ってきた任意の文字列が入る（#52）。
 *
 * @param what 何を読み出し損ねたか（固定文言。呼び出し側が書く）
 * @param detail 本文を含まない見分け
 */
export function noteUnreadableRecord(what: string, detail: string, error: unknown): void {
  const tail = detail === '' ? '' : `（${detail}）`;
  note(`${what}を読み出せませんでした${tail}: ${reasonOf(error)}`);
}

/**
 * 読み出そうとした記録の**取得元そのものを一度も受け取っていない**ことを
 * stderr へ1行だけ残す。
 *
 * **`noteUnreadableRecord` を流用しないのは、あれが「読み出そうとしたが
 * 失敗した」ときの跡だからである。** ここはまだ読み出しを試みてすらいない
 * ——取得元（例: フックが渡すファイルパス）が一度も届いていない状態で、
 * 疑うべき先は `noteUnreadableRecord` の側（ディスク・権限）とは違う。
 * **計器の配線**（呼ぶはずの hook・通知が来ていない）を疑うべき状況で、
 * 同じ文言に潰すと読む側はディスクを疑いに行き、的を外す。逆にディスクの
 * 障害をこちらの文言で報告すると、今度は配線を疑いに行って的を外す
 * ——`noteManagerIdCollision` の doc が言う「取り違えさせる」と同じ形の害が
 * 双方向に起きる。
 *
 * **本文は出さない。** 理由は `noteDroppedRecord` / `noteUnreadableRecord` と
 * 同じ（#52）。
 *
 * @param what 何の取得元が届いていないか（固定文言。呼び出し側が書く）
 * @param detail 本文を含まない見分け
 */
export function noteMissingRecordSource(what: string, detail: string): void {
  const tail = detail === '' ? '' : `（${detail}）`;
  note(`${what}の取得元を一度も受け取っていません${tail}`);
}

/**
 * 発行した id が既に使われていて、引き直したことを stderr へ1行だけ残す（#238）。
 *
 * **`noteDroppedRecord` を流用しないのは、あれが「記録できませんでした」と
 * 書くからである。** id の衝突は「記録できなかった」でも「読み出せなかった」
 * でもない第三の状況 — 発行しようとした id に、いま走っている別の委譲の記録が
 * **既に在った**、というものである。そこにこの2つの文を当てると、跡そのものが
 * 何が起きたかを取り違えさせる（この2関数が防ごうとしているものと同じ形になる）。
 *
 * **本文は出さない。** 理由は `noteDroppedRecord` / `noteUnreadableRecord` と
 * 同じで、ここへ渡ってくる値には外の世界から拾ってきた任意の文字列は入らない
 * が（`managerId` はこちらが発行した id）、跡を残す口を1つに揃えるという
 * このファイルの作法（`note()`）に従う。
 *
 * @param managerId 衝突した（＝既に `#records` に在った）id。こちらが発行した
 *   id であって自由文ではないので、そのまま載せてよい。
 * @param attempt 何回目の発行でこの衝突が起きたか（1始まり）。
 */
export function noteManagerIdCollision(managerId: string, attempt: number): void {
  note(
    `managerId の発行が衝突したので引き直しました（managerId=${tag(managerId)} attempt=${attempt}）`,
  );
}

/**
 * `#retire()`（`manager.ts`）が、空でない「握り潰した報告」の在庫
 * （`WithheldReportMemory`）を積んだまま像を畳んだことを stderr へ1行だけ
 * 残す。
 *
 * **`noteDroppedRecord` を流用しないのは、これが失敗ではないからである。**
 * `#retire()` がここへ来るのは「もうこの委譲は走らない」という正常な終端
 * 判定の結果で、書き込みや読み出しが失敗したわけではない——`noteManagerIdCollision`
 * と同じ「第三の状況」で、専用の文言を持つ。
 *
 * **`abort()`（R4 の `stopped`）経由の呼び出しは、同じ事実を
 * `ManagerAbortResult.detail` と日誌（`type: 'exchange'`）へも既に書いている
 * ので、ここは重ねての跡になる。** それでも `#retire()` 自身に置くのは、
 * `#retire()` の呼び出し元が `abort()` の他にも複数あり（`manager.ts` の
 * `#retire()` の JSDoc）、そちらは同じ事実を能動的には出していないからである
 * ——`#retire()` 自身に置けば、呼び出し元がどれであっても同じ1行が漏れなく
 * 残る（`abort()` の側にだけ置くと、他の呼び出し元でこの状態が起きたときに
 * 跡が1つも残らない）。
 *
 * **本文（`lastText`）は出さない。** 理由は `noteDroppedRecord` と同じで、
 * ここへ渡ってくる `count` / `firstAt` / `lastAt` はこちらが管理する数値と
 * 時刻だけであり、`managerId` はこちらが発行した id である——自由文は
 * 1つも混ざらない。
 *
 * @param managerId どの委譲か（こちらが発行した id）。
 * @param count 捨てた本数。
 * @param firstAt 最初に積んだ時刻（ISO 8601）。
 * @param lastAt 最後に積んだ時刻（ISO 8601）。
 */
export function noteWithheldReportsDiscarded(
  managerId: string,
  count: number,
  firstAt: string,
  lastAt: string,
): void {
  note(
    `握り潰した報告を配らずに捨てました（managerId=${tag(managerId)} count=${String(count)} ` +
      `firstAt=${firstAt} lastAt=${lastAt}）`,
  );
}

/**
 * **背景で起こした処理**（`void f()` の形で切り離したもの）が例外で終わったことを
 * stderr へ1行だけ残す（#438 案D）。
 *
 * **落ち方は1ビットも変えない。** 呼び出し側はこの跡を出した後、受け取った例外を
 * **そのまま投げ直す** —— 投げ直した先は未処理の拒否になり、今日と同じように
 * Node 既定のスタックが出てプロセスが死ぬ（実測は `uncaught-net.ts` の表）。
 * **ここが足すのは「どこで」だけである。**
 *
 * **なぜ「どこで」だけで足りるのか。** プロセス全体の網（`uncaught-net.ts`）は
 * 例外を1行に畳めるが、**どの背景処理から来たのかは言えない** —— `reasonOf` が
 * 出すのは例外の1行目だけで、`void` で切り離した時点で呼び出し元の文脈は
 * スタックにしか残らない。#438 が言う「落ちたことを追えない」は、**回数**の話と
 * **出所**の話の両方であり、網は前者、この跡は後者を埋める。
 *
 * **⚠️ ここで握り潰さないこと。** 「跡を残したのだから続けてよい」は成り立たない。
 * この repo の復旧機構は**プロセスの消滅を契機に組んである**（起動時の
 * `#restoreJobs` が `runner.list()` の実物から状態を作り直し、`#restoreUnread` が
 * 未読を配り直す）。生き残ったまま握り潰すと、**その復旧経路が一度も起動しない。**
 * 握り潰してよい先例（`runner-client.ts` の `#neverEscapes`）が覆っているのは
 * **跡を残す処理そのものの失敗**であって、本筋の処理ではない。
 *
 * @param what どの背景処理か（固定文言。呼び出し側が書く）
 * @param detail 本文を含まない見分け（**値を誰が決めるか**で選ぶ。このファイルの
 *   `journalEntryShape` と同じ基準 —— 列挙値とこちらが発行した id は載せてよく、
 *   外から来た自由文は載せない）。無ければ空文字。
 */
export function noteBackgroundFailure(what: string, detail: string, error: unknown): void {
  const tail = detail === '' ? '' : `（${detail}）`;
  note(`${what}が例外で終わりました${tail}: ${reasonOf(error)}`);
}

/**
 * 日誌の読み出し（`storage-fs` / `storage-pg` の `list()` / `get()`）が
 * スキーマに合わない行を飛ばすときの理由。**`unparsable`** は構造すら持たない
 * （fs 版の `JSON.parse` が投げた）。**`unknown-shape`** は構造としては正しい
 * JSON（または pg が既に jsonb として解いた値）だが `journalEntrySchema` に
 * 合わない。`apps/daemon/src/runner-client.ts` の `RunnerDroppedEventReport`
 * と同じ2分（Issue #224）。
 */
export type DroppedJournalRowReason = 'unparsable' | 'unknown-shape';

/**
 * 読めなかった日誌の行から、本文を含まずに安全に取り出せる `type` らしき
 * 文字列。取れるのは、値がオブジェクトで `type` キーが空でない文字列である
 * ときだけ。
 *
 * **取れなければ `undefined` を返す（埋め草を置かない）。** `'（不明）'` の
 * ような固定文字列を代わりに置くと、それ自体が `type` の1種として
 * `noteDroppedJournalRow` に数えられてしまい、「型が分からない行が本当に
 * 何種類あるか」を覆い隠す。
 *
 * **本文はここへ来ない。** 見るのは `journalEntrySchema` の判別子である
 * `type` フィールドだけで、`decision` / `exchange` などの自由文フィールドには
 * 一切触れない。
 */
export function journalRowType(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = (raw as { type?: unknown }).type;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return tag(value);
}

/**
 * 日誌の読み出しでスキーマに合わない行を1件、**飛ばすが跡には残す**
 * （Issue #224）。`runner-client.ts` の `#noteDropped` と同じ形——
 * **同じ種別（`reason` と `type` の組）は、この呼び出しで最初の1回だけその場で
 * 1行 stderr へ出す。** 量は `noteDroppedJournalRowsSummary` が呼び出しの
 * 終わりでまとめて出す。壊れた行が大量にあるとき行ごとに出すと、それ自体が
 * 二次被害になる（跡でログを埋める）。
 *
 * **`dropped` は呼び出し1回ぶんのローカルな `Map` である。** `JournalStore`
 * のインスタンスへ状態を持たせない——`list()` / `get()` はどちらも1回の
 * 呼び出しの中でループが完結するので、呼び出し側のローカル変数で足りる。
 * プロセス単位で畳むと、器が入れ替わって新しい書き手が同じ種別を吐き始めても
 * 「前に見たから」で黙る、という同じ穴を作る（`#noteDropped` の doc）。
 *
 * **本文は載せない。** 載せてよいのは `journalRowType` で安全に取れた
 * `type` とバイト数だけ——日誌の行にはマネージャーの報告が入りうる
 * （テスト出力に `GH_TOKEN` が全文で出た前例がある。`railway/setup.test.ts`
 * の差分アサーション、#52）。**`safeParse` が返す
 * `error.message` はここへ渡さないこと。** 検証に失敗した値そのものを引用
 * することがあり、確かめずに跡へ流すと同じ事故になる。
 *
 * @param dropped 呼び出し1回ぶんの `Map<種別, 件数>`。
 * @param reason {@link DroppedJournalRowReason}。
 * @param type `journalRowType` で取れた `type`（取れなければ `undefined`）。
 * @param bytes その行のバイト数。**取れない `type` の代わりに 0 を置かない
 *   のと同じ理由で、常に実測を渡すこと。**
 */
export function noteDroppedJournalRow(
  dropped: Map<string, number>,
  reason: DroppedJournalRowReason,
  type: string | undefined,
  bytes: number,
): void {
  const key = type === undefined ? reason : `${reason}:${type}`;
  const seen = dropped.get(key) ?? 0;
  dropped.set(key, seen + 1);
  if (seen > 0) return;
  const what =
    reason === 'unparsable' ? 'JSON として読めなかった' : 'こちらのスキーマに合わなかった';
  const typeText = type === undefined ? '（type も読めない）' : `type=${type}`;
  note(`日誌の行を読み出せずに飛ばした（初出）: ${what} ${typeText} bytes=${bytes}`);
}

/**
 * SDK が失敗として出した1回を、**枠の文言としては分類できなかった**ことを
 * stderr へ残す（Issue #393）。
 *
 * ## なぜ要るか — 回し手が原理的に聞けない失敗が在る
 *
 * 回し手（`TokenRotator`）の入口は `usage_notice` / `rate_limit` の2つだけで、
 * **`classifyUsageNotice` が分類できなかった失敗は、そのどちらにもならない。**
 * ⟹ マネージャーがそれで落ち続けても、**プールは何も検知しない。** 資格
 * （`CLAUDE_CODE_OAUTH_TOKEN`）が1つも無い器で起こしたときがこの形である。
 *
 * **「無音」ではない** —— 落ちた理由は `closed` の `report` としてクローンの
 * 受信箱へ届く（`manager.ts` の逐語 `if (event.status === 'failed') this.#emit(`）。
 * 見えていないのは**回し手が何をしたか**の側だけである。ここが数えるのは
 * 「回し手が聞けなかった回数」であって、失敗そのものの記録ではない。
 *
 * **なぜ日誌ではなく stderr か。** 日誌へ出すには回し手の `signal`
 * （`schema.ts` の `z.enum` 7値）に「分類できなかった」を足すことになり、
 * **跡を残すためだけに外向きの面を広げることになる**（`noteDroppedInboxEvent`
 * の doc と同じ判断）。**まず数を取る。** 日誌へ上げる価値が在るかは、数が
 * 出てから決まる。
 *
 * ## 何を載せるか
 *
 * **`text` を載せない。** あれは SDK が出した文言そのままで、マネージャーの
 * 報告が混ざりうる（テスト出力に `GH_TOKEN` が全文で出た前例がある。
 * `railway/setup.test.ts` の差分アサーション、#52）。
 * 載せるのは `via` と `code` だけである —— どちらも**値を決めるのが SDK か
 * こちら**で、外から来た自由文ではない（判定基準は `noteDroppedInboxEvent` の
 * doc と同じ「値を誰が決めるか」）。
 *
 * **同じ組は、この帳面で最初の1回だけその場で出す。** 量は
 * {@link noteUnclassifiedFailuresSummary} が終わりでまとめて出す —— 失敗が
 * 続くときに毎回出すと、跡それ自体がログを埋める。
 *
 * @param seen セッション1本ぶんの `Map<種別, 件数>`。**プロセス単位で畳まない**
 *   （畳むと、器が入れ替わって新しい失敗が始まっても「前に見たから」で黙る）。
 */
export function noteUnclassifiedFailure(
  seen: Map<string, number>,
  managerId: string,
  via: string,
  code: string,
): void {
  const key = `${via}:${code}`;
  const count = seen.get(key) ?? 0;
  seen.set(key, count + 1);
  if (count > 0) return;
  note(
    `SDK の失敗を枠の文言として分類できなかった（初出。**回し手には届かない**）: ` +
      `manager=${managerId} via=${via} code=${code}`,
  );
}

/**
 * {@link noteUnclassifiedFailure} で溜めた件数を、セッションの終わりで1行に
 * まとめて出す。**1件も無ければ何も出さない。**
 *
 * **セッションの終わり口は1本ではない。2本ある** —— `RunnerSession#finish()` と
 * `RunnerSession#stop()` で、**後者は `#finish` を通らない**（器の入れ替えと
 * `manager_stop` がそちらである）。**両方で呼ぶこと。** 1つ忘れると、その経路だけ
 * 量が跡に出ない（初出の1行は出ているので存在は残るが、量が失われる）。
 *
 * **同じ穴を `#closeWorkerWaitWindow` が先に踏んでいる** —— `stop()` の中に
 * 逐語で「この経路は `#finish` を通らないので、ここで閉じないと開いたままの
 * 区間が黙って消える」と書いてある。**同じクラスの落とし穴なので、同じ場所に
 * 並べてある。**
 */
export function noteUnclassifiedFailuresSummary(
  seen: Map<string, number>,
  managerId: string,
): void {
  if (seen.size === 0) return;
  const detail = [...seen.entries()].map(([key, count]) => `${key}×${count}`).join(' / ');
  note(
    `SDK の失敗を枠の文言として分類できなかった（このセッションの合計）: ` +
      `manager=${managerId} ${detail}`,
  );
}

/**
 * `noteDroppedJournalRow` で溜めた件数を、呼び出しの終わりで1行にまとめて
 * 出す。**何も飛ばしていなければ何も出さない。**
 *
 * `list()` / `get()` の**すべての**返り口（`return` / `throw` の手前）で
 * これを呼ぶこと——早期 return を1つ忘れると、その経路だけ量が跡に出ない
 * （初出の1行は既に出ているので存在は残るが、量が失われる）。
 */
export function noteDroppedJournalRowsSummary(dropped: Map<string, number>): void {
  if (dropped.size === 0) return;
  const detail = [...dropped.entries()].map(([key, count]) => `${key}×${count}`).join(' / ');
  note(`日誌の行を読み出せずに飛ばした（この呼び出しの合計）: ${detail}`);
}

/**
 * 受信箱が閉じた後に届いた合図を、このプロセスでは処理しなかったことを
 * stderr へ1行だけ残す。
 *
 * **「捨てた」とは書かない。** かつてはここで本当に捨てていて、その根拠は
 * 「処理しようとすると『未読の永続化』という別の設計になる」だった。その設計は
 * いま在るので、呼び出し側（`Clone#post`）は器へ残してから来る。
 *
 * **それでも「残した」とも書かない。** この窓の後半ではストアが既に閉じており、
 * 書き込みは落ちうる。落ちたことは `noteDroppedRecord` が別の行で言うので、
 * ここが断言すると**書けなかった回だけ跡が静かに嘘をつく**（1行目は「次の起動へ
 * 回した」、2行目は「書けなかった」で、後から読む者は前者を信じる）。この行が
 * 主張するのは**このプロセスでは処理しなかった**という、観測できたことだけである。
 *
 * **なぜ日誌ではなく stderr か。** `post` は同期で、返り値を持たない。日誌へ
 * 書くなら fire-and-forget にならざるを得ないが、**捨てが起きる窓（`stop()` →
 * `storage.close()` → `process.exit(0)`）はその約束が果たされる前にプロセスが
 * 消える窓そのもの**である。しかもその窓の後半ではストアが既に閉じており、
 * 日誌への追記は失敗して結局 `noteDroppedRecord` の stderr へ落ちる。**跡を
 * 残すために、跡が残らないことのある経路を選ばない。** 同期で1行書けば、窓の
 * どこで捨てても同じ跡になる。
 *
 * **日誌の型を足して解かないこと。** 「捨てた」は既存のどの型でもなく、
 * `journalEntrySchema` を広げると `JOURNAL_ENTRY_TYPES` 経由で `openapi.json`
 * ＝外向きの API 面が動く。跡を残すためだけに外へ出す面を広げない。
 *
 * **見分けは呼び出し側に選ばせない。** ここへ来る合図には人間の発言・webhook の
 * 本文・マネージャーの報告が入る（テスト出力に `GH_TOKEN` が全文で出た前例が
 * ある。`railway/setup.test.ts` の差分アサーション、#52）。何を載せてよいかの
 * 判断は `inboxEventShape` の1か所に閉じる。
 */
export function noteDroppedInboxEvent(event: InboxEvent): void {
  note(
    `受信箱を閉じた後に届いた合図はこのプロセスでは処理しませんでした` +
      `（器へ残せていれば次の起動で配り直されます）: ${inboxEventShape(event)}`,
  );
}

/**
 * runner から届いた合図から、本文を含まない見分けだけを取り出す（#438 案D）。
 *
 * **ここだけ `journalEntryShape` / `inboxEventShape` と作りが違う。** あの2つは
 * 型ごとの網羅 `switch` で、**新しい型が増えたら書き手に判断を強制する**形になって
 * いる。ここは逆に、**載せてよい2つだけを名指しする許可制**にしてある。
 *
 * **理由は、この関数の使われ方である。** ここは記録の跡ではなく**落ちた場所の跡**で、
 * 要るのは「どの合図で落ちたか」だけである。`RunnerEvent` はいま17種あり、網羅
 * `switch` にすると型が増えるたびに17→18の分岐が生え、**そのたびに「この型なら
 * これくらい載せてよいだろう」という判断が1つずつ増える。** 許可制なら、型が
 * 増えても載るものは増えない —— **漏れうる面が構造として広がらない。**
 *
 * **載せる2つ**: `type`（`runnerEventSchema` の discriminator ＝ 列挙値）と、
 * 在れば `managerId`（こちらが発行した id）。**判定基準はこのファイルの他と同じで、
 * 「自由文かどうか」ではなく「値を誰が決めるか」である。** `report` の `text`・
 * `ask` の要旨・`closed` の `reason` は外から来るので載せない（長さも出さない ——
 * 跡に要るのは出所であって、中身の量ではない）。
 */
export function runnerEventShape(event: RunnerEvent): string {
  const owner = 'managerId' in event ? ` managerId=${tag(event.managerId)}` : '';
  return `type=${tag(event.type)}${owner}`;
}

/**
 * 受信箱の合図から、本文を含まない見分けだけを取り出す。
 *
 * **判定の基準は `journalEntryShape` と同じ**（「自由文かどうか」ではなく
 * 「値を誰が決めるか」）。したがって `external` の `source` は
 * `POST /events/:source` の URL パスセグメント＝外の送り元が決める値なので、
 * 名前に見えても長さだけにする。逆に `managerId` / `approvalId` はこちらが
 * 発行した id、`kind` / `reason`（`distill`）は列挙値なので載せてよい。
 *
 * `human_message` の `conversationId` は呼び出し側が指定できる値であり、
 * `journalEntryShape` の `exchange` も載せていない。**同じ値の扱いを2か所で
 * 変えないこと。**
 */
export function inboxEventShape(event: InboxEvent): string {
  switch (event.type) {
    case 'human_message':
      return `human_message ${size(event.text)}`;
    case 'human_answer':
      return `human_answer approvalId=${tag(event.approvalId)} ${size(event.answer, 'answer')}`;
    case 'distill':
      return `distill reason=${tag(event.reason)}`;
    // `kind` は `scheduleKindSchema`（英小文字・数字・. _ - の64字以内）で、
    // 仕込んだのは持ち主かクローンである。`memory_update` の `slug` と同じ扱い。
    case 'timer':
      return (
        `timer kind=${tag(event.kind)}` +
        (event.cause === undefined ? '' : ` cause=${tag(event.cause)}`) +
        (event.target === undefined ? '' : ` target=${tag(event.target)}`)
      );
    // `payload` は webhook の本文そのもの。**長さも出さない** — 長さを得るには
    // 一度 JSON へ畳む必要があり、畳んだ文字列が跡へ載る事故が入りやすい。
    case 'external':
      return `external ${size(event.source, 'source')} payload=${event.payload === undefined ? 'none' : 'yes'}`;
    case 'self_initiative':
      return `self_initiative ${size(event.reason)}`;
    case 'manager_message':
      return (
        `manager_message managerId=${tag(event.managerId)} kind=${tag(event.kind)}` +
        (event.requestId === undefined ? '' : ` requestId=${tag(event.requestId)}`) +
        ` ${size(event.text)}`
      );
  }
}

/**
 * stderr へ1行書く。
 *
 * **時刻は自分で付ける**（ホスティング先が付ける時刻に頼らない。付かない先が
 * ある）。跡を出す口をここ1本にしてあるのは、本文を出さないという判断が
 * このファイルの外へ散らないようにするためである。
 *
 * **`process.stderr.write` ではなく `writeStderrSync`（fd 2 への `fs.writeSync`）
 * を通す。** `process.stderr.write` は fd がパイプのとき POSIX 上は非同期で、
 * `stop()` → `storage.close()` → `process.exit(0)` のような「書いた直後に
 * プロセスが消える窓」では、書いたはずの行がバッファに残ったまま失われる
 * （Node 公式ドキュメント `doc/api/process.md`: "including I/O operations to
 * `process.stdout` and `process.stderr`" は `process.exit()` に巻き込まれる、
 * "Pipes (and sockets): … asynchronous on POSIX"）。**このファイルの docstring
 * が言う「同期で1行書けば、窓のどこで捨てても同じ跡になる」という約束は、
 * `process.stderr.write` では成り立たない。** `fs.writeSync` に替えるとこの
 * 約束が戻る（#248）。
 */
function note(text: string): void {
  notePrefixed('alteroid', text);
}

/**
 * 直近の跡（`note()` が書いた行）を、器の中から読み戻すための帳面（#242）。
 *
 * **上限つきの帳面である。無制限の列挙を新しく作らない**（#409 が指摘した
 * 欠陥をここで繰り返さない——`RecentMap`（`recent.ts`）と同じ「溢れたら古い側
 * から押し出す」形にしてある）。プロセスが生きているあいだだけの記憶で、
 * 再起動・デプロイの入れ替えをまたいで残す仕組みは持たない。**持たせるなら
 * 日誌と同じ「壊れても消えない」約束が要り、それは journal の役目である**
 * （このファイルの冒頭 doc「日誌はまだ持ち主しか読まないが、stderr は器の外へ
 * 出ていく」の逆を持ち込まない——ここは stderr の写しであって、日誌の代わりでは
 * ない）。
 *
 * **`alteroidd:` / `alteroid-runner:`（`noteUncaught` が使う接頭辞）はここへは
 * 乗らない。** 乗るのは `note()` が書く `alteroid:` の行だけである
 * （`notePrefixed` の `prefix === 'alteroid'` 判定）——#242 が塞ぐのは
 * **クローン自身が残した跡**であって、デーモン／runner のプロセス全体の網では
 * ない（あちらは Railway 経由で人間からは既に読めている。#242 のコメントの
 * 実測）。
 *
 * **本文は乗らない。** ここへ積むのは `note()` に渡された時点で既に
 * 本文を含まない1行（`noteDroppedRecord` 等の doc が言う「本文は出さない」）
 * なので、帳面の側で新たに漉す必要は無い。
 */
export const RECENT_TRACE_LIMIT = 200;
const recentTraces: string[] = [];

function rememberTrace(line: string): void {
  recentTraces.push(line);
  if (recentTraces.length > RECENT_TRACE_LIMIT) recentTraces.shift();
}

/**
 * 直近の跡を古い順で返す（末尾がいちばん新しい）。`self_dropped`（`tools.ts`）
 * の材料。**控えを返す**——呼び手が触っても帳面そのものは動かない
 * （`RecentMap.entries()` と同じ形）。
 */
export function recentDroppedTraces(): readonly string[] {
  return [...recentTraces];
}

/**
 * テスト専用: 帳面を空にする（`setStderrSinkForTesting` と対）。
 *
 * 帳面はプロセス（＝テストファイル）の生存中ずっと1つを共有するので、
 * 前のテストが積んだ行を次のテストが数え違えないよう、断言の前に呼ぶこと。
 *
 * **{@link droppedTraceLedgerSince} も同時に取り直す。** 帳面を空にしたのに
 * 「数え始めた時刻」だけ古いままだと、`describeDroppedTraceEmpty()` が言う
 * 「この帳面はプロセスの生存中だけの記憶」という説明と時刻が食い違って
 * 見える——空にする＝新しい生存区間が始まる、という意味を時刻にも持たせる。
 */
export function clearRecentTracesForTesting(): void {
  recentTraces.length = 0;
  ledgerSince = new Date().toISOString();
}

/**
 * 帳面（{@link recentDroppedTraces}）がどのプロセスの跡を持っているかを表す。
 *
 * **いまは `'daemon'` の1値しか無い。** 供給元は1本——`recentDroppedTraces()`
 * が読むのはデーモンのプロセスの中だけである。**デーモンとクローンは同一
 * プロセスで動く**（`apps/daemon/src/index.ts` の `createClone(...)` と
 * `createApp({ clone, ... })`、`serve({ fetch: app.fetch, ... })` が同じ
 * 関数スコープにある）ので、クローンが `note()` 経由で残す跡も、デーモンの
 * HTTP ハンドラから見えるこの帳面も、同じ1本の台帳を指す。
 *
 * **runner はここに現れない。** runner は別プロセス（別 bin
 * `alteroid-runner`）で動いており、この帳面はプロセス内メモリなので、runner
 * が `note()` 相当の跡を残しても daemon 側のこの帳面からは原理的に読めない
 * （読めるようにするには runner からデーモンへ跡を運ぶ経路そのものを新設する
 * 必要があり、それは別の変更である）。**⟹ runner がこの型へ値を足さない
 * 限り、`'daemon'` は「デーモン (クローン込み) の跡だけ」と言い切れる。** 値を
 * 足すときは、runner 側の実装と同時にここへ増やすこと——増やさなければ、
 * この型がそのまま安全側の境界になる。
 */
export type DroppedTraceOrigin = 'daemon';

/**
 * 帳面が何の跡を持っているかを一言で言う（#242 の HTTP 面。
 * `apps/daemon/src/app.ts` の `GET /dropped` と `self_dropped`（`tools.ts`）
 * の両方が使う共有の生成元）。
 *
 * **字面は core とここ1箇所だけではない。** `apps/web` は `@alteroid/core`
 * の**値** import が禁じられている（`eslint.config.js` の
 * `no-restricted-imports`。理由は#294/#306の事故）ので、Web 側はこの文字列を
 * 自前に複製することになる。**揃っていることは規約ではなく歯（テストの
 * 文字列一致）で守る**——先例は `describeSessionMissingKind`（`digest.ts`）と
 * その複製 `describeSessionMissingKindNote`
 * （`apps/web/app/routes/managers.tsx`）で、`apps/web/app/routes/managers.test.tsx`
 * が2つの文字列としての等しさを直接測る（テストファイルは値 import の禁止
 * から明示的に外してある）。**このファイルの文言を直すときは、Web 側の
 * 複製が在れば必ず一緒に見ること。**
 *
 * **`undefined` は空文字にする（「不明」と書かない）。** 由来を持たない印は、
 * この欄が足される前の版のデーモンが立てたものだけである——そこへ新しい語を
 * 出すと、実際には1つしかない区別が2つに見える（`describeSessionMissingKind`
 * の doc と同じ理由）。
 *
 * **型の網羅性で塞いだうえで、実行時の倒れ先も足す**（AGENTS.md「型で塞いだ
 * 分岐にも、実行時の倒れ先の歯を足す」）。デーモンと読み手（CLI・Web の
 * 複製）は別デプロイなので版がずれうる——デーモンが先に2値目の
 * `DroppedTraceOrigin` を返し、読み手側の型定義がまだ1値のまま、という順序が
 * 実在しうる。`default` 節は `never` 型の変数へ代入するだけで、**その値を
 * そのまま画面に出さない**（#285 で実際に踏まれた間違い——`never` 型の変数を
 * 本文として描いてしまい、画面に分岐キーの生の値が出た——と同じ形を作らない）。
 */
export function describeDroppedTraceOrigin(origin: DroppedTraceOrigin | undefined): string {
  switch (origin) {
    case 'daemon':
      return (
        'デーモンのプロセス（クローンを含む）が残した跡だけである。' +
        '別プロセスの runner が残した跡はここには出ない。'
      );
    case undefined:
      return '';
    default: {
      const unreachable: never = origin;
      void unreachable;
      return '';
    }
  }
}

/**
 * 跡が0件だったときの読み方を一言で言う。
 *
 * **「無事だった」とは読ませない。** この帳面はプロセスの生存中だけの記憶で、
 * 再起動・デプロイの入れ替えをまたいで残らない——0件は「握り潰しが1件も
 * 無かった」ことを意味しない（直前の再起動までに何件落としていても、この
 * 帳面には何も残らない）。
 *
 * **時刻は埋め込まない。** CLI・HTTP・MCP・Web の各面は時刻の整形方法が
 * 違う（人間可読へ直す関数がそれぞれ別）ので、ここへ埋め込むと
 * {@link describeDroppedTraceOrigin} と同じ「2箇所で揃える」字面一致の歯が、
 * 面ごとの時刻整形の違いだけで壊れる。**帳面が数え始めた時刻を出したい面は、
 * この文の隣に自分で {@link droppedTraceLedgerSince} を描くこと。**
 */
export function describeDroppedTraceEmpty(): string {
  return (
    'このプロセスではまだ跡（記録・読み出しの握り潰し）が1件も残っていない。' +
    '0件は「握り潰しが1件も無かった」ことを意味しない —— ' +
    'この帳面はプロセスの生存中だけの記憶で、再起動・デプロイの入れ替えで消える。'
  );
}

/**
 * 帳面の保持のしかた（上限で古い側から押し出される・それより古い分の在り処）
 * を一言で言う。
 *
 * @param limit `RECENT_TRACE_LIMIT` をそのまま渡すこと。**値をここへ焼き
 *   込まない**——呼び出し側から渡させることで、上限が動いたときにここも
 *   一緒に動く（`self_dropped` の `limit` 引数の説明文と同じ形）。
 */
export function describeDroppedTraceRetention(limit: number): string {
  return (
    `直近 ${limit} 件までしか持たず、溢れた古い側から押し出される。` +
    'それより古い分はこの帳面の中には無く、器の外の stderr を見るしかない。'
  );
}

/**
 * この帳面が数え始めた時刻（ISO 8601、UTC）。モジュール読み込み時
 * （＝プロセス起動時）に1度だけ決める。
 *
 * **{@link clearRecentTracesForTesting} が呼ばれたら取り直す。** テストが
 * 帳面を空にしたのに「数え始めた時刻」だけ前のテストの起動時刻のままだと、
 * `describeDroppedTraceEmpty()` が言う「プロセスの生存中だけの記憶」という
 * 説明と矛盾して見える。
 */
let ledgerSince = new Date().toISOString();

export function droppedTraceLedgerSince(): string {
  return ledgerSince;
}

/**
 * 接頭辞を呼び出し側から受け取って1行書く。
 *
 * **`note()` と同じ口である**（`stderrSink` を通るのはここ1本のまま）。分けて
 * あるのは、`note()` が `alteroid:` を焼き込んでいるからで、**プロセス全体の網
 * （`uncaught-net.ts`）は app ごとに別の接頭辞を出す**必要があるためである ——
 * daemon は `alteroidd:`、runner は `alteroid-runner:`（`.onError` の先例が
 * `apps/runner/src/app.ts` に在る）。**接頭辞が app ごとに違うのは、跡を読む者が
 * どちらのプロセスが落ちたのかを1行目で見分けられるようにするためである。**
 *
 * **`note()` が出す行は1文字も変えていない。** `prefix === 'alteroid'` の
 * ときだけ {@link rememberTrace} で帳面へも積む（#242）——`alteroidd:` /
 * `alteroid-runner:` は積まない（上の doc）。
 */
function notePrefixed(prefix: string, text: string): void {
  const line = `${prefix}: ${new Date().toISOString()} ${text}`;
  if (prefix === 'alteroid') rememberTrace(line);
  stderrSink(`${line}\n`);
}

/**
 * 未捕捉の例外・未処理の Promise 拒否を**観測した**ことを stderr へ1行だけ残す
 * （#438）。
 *
 * **⚠️ この行は「プロセスが落ちる」と書かない。書かせないこと。** 呼び元
 * （`uncaught-net.ts`）が使う `uncaughtExceptionMonitor` は、**誰かが
 * `process.on('uncaughtException')` を登録していれば、落ちないまま発火する。**
 * いまこの repo にその登録は無いが、それは配線の事実であってこの関数の保証では
 * ない。断言すると、**登録された日にこの行だけが静かに嘘をつく。**
 *
 * **これは `noteDroppedInboxEvent` と同じ判断である**（あちらの doc の逐語:
 * 「**それでも「残した」とも書かない。**…この行が主張するのは**このプロセスでは
 * 処理しなかった**という、観測できたことだけである」）。ここが主張するのも
 * **観測できたことだけ** —— 「未捕捉の例外が起きた」であって「だから死ぬ」では
 * ない。**死んだかどうかは、この行の後に Node 既定のスタックが続くかで読める。**
 *
 * **文言を `origin` で分けるのは、このファイルが `noteDroppedRecord` /
 * `noteUnreadableRecord` / `noteManagerIdCollision` を分けているのと同じ理由で
 * ある** —— 違う出来事に同じ文を当てると、**跡そのものが何が起きたかを取り違え
 * させる。**
 *
 * **⚠️ 「本文は出しません」とは書かない。** `.onError` の先例
 * （`apps/daemon/src/app.ts` / `apps/runner/src/app.ts`）はそう書いているが、
 * **あちらには出さずに済ませた本文が別に在る**（リクエスト本文）。**未捕捉の例外
 * には、それが無い** —— 例外の `message` そのものが理由なので、`reasonOf` は
 * **理由として message を出す**（あの関数の doc の逐語:「**理由だけは出す。**
 * 『書けなかった』しか残らない行を読んだ者にできることは、ストアを一から疑うこと
 * しかない」）。ここで「本文は出しません」と書くと、**在りもしない守りを名乗る**
 * ことになる —— このファイルが繰り返し避けている「跡そのものが嘘をつく」形である。
 *
 * **実際に効いている守りは2つで、どちらも `reasonOf` が持っている。**
 *
 * 1. **1行目だけ**を取る —— ドライバの例外は失敗したクエリのパラメータを**次の行**へ
 *    添えてくることがある（`reasonOf` の doc に `drizzle-orm@0.45.2` の実測が在る）。
 * 2. **200字で切る。**
 *
 * **そして、この行が漏らしうるものは、いま既に漏れているものの部分集合である。**
 * `uncaught-net.ts` は Node 既定の出力を止めないので、**同じ `message` は同じ
 * stderr へ、スタックごと必ず出る。** ⟹ この行は器のログの漏洩面を1バイトも
 * 広げない（**狭めもしない** —— 狭めるには既定の出力を止めるしかなく、それは
 * `uncaught-net.ts` が捨てた道である）。
 *
 * 素の `String(error)` は書かない。**スタックも載せない** —— 載せると `reasonOf` を
 * 通す意味が消える。
 *
 * @param prefix app ごとの接頭辞（`alteroidd` / `alteroid-runner`）。**末尾の
 *   コロンは付けない**（`notePrefixed` が付ける）。
 * @param origin Node が渡す出所（`uncaughtException` / `unhandledRejection`）。
 * @param error 観測した例外・拒否の理由。
 */
export function noteUncaught(prefix: string, origin: string, error: unknown): void {
  notePrefixed(prefix, `${describeUncaughtOrigin(origin)}を観測しました: ${reasonOf(error)}`);
}

/**
 * `uncaughtExceptionMonitor` の `origin` を、跡に書く言葉へ直す。
 *
 * **知らない値を既知の2つのどちらかへ倒さない。** Node の型はいま2値だが、
 * 倒すと「判別できない」が黙って片方に化ける（`AGENTS.md`「**『判定できない』と
 * いう3つ目の状態を持つ。** 2値にすると、判定できない場合がどちらかへ黙って
 * 倒れる」）。**`origin` は Node が決める値なので `tag()` に通してそのまま載せて
 * よい** —— このファイルの判定基準は「自由文かどうか」ではなく「**値を誰が
 * 決めるか**」である。
 */
function describeUncaughtOrigin(origin: string): string {
  switch (origin) {
    case 'uncaughtException':
      return '未捕捉の例外';
    case 'unhandledRejection':
      return '未処理の Promise 拒否';
    default:
      return `出所を判別できないエラー（origin=${tag(origin)}）`;
  }
}

/**
 * fd 2（stderr）へ、1行を同期で・全部書き終わるまで書く。
 *
 * **3つの但し書きがある（#248 で確かめた）。**
 *
 * 1. **fd 2 は非ブロッキングで、部分書き込みが起きる。** `fs.writeSync` は
 *    例外を投げずに返り値（実際に書けたバイト数）が減るだけなので、**返り値を
 *    見て書き切るまでループする**必要がある。1行の大きさなら（読み手が居る
 *    限り）部分書き込みは起きなかったが、「起きなかった」は「起きない」では
 *    ない——パイプが埋まっているときは危険が起きる。
 * 2. **読み手が消えていると `EPIPE` を投げる。** 跡を書くためだけの関数が
 *    例外で本筋（呼び出し元のターン）を殺してはいけないので、**投げたら
 *    黙って諦める**（跡は残らないが、握り潰しはしない——という判断はこの
 *    関数の外の話であって、ここでは「投げない」だけを守る）。
 * 3. **本番のコンテナで同じ挙動かは確かめていない。** 手元の器（`node
 *    v22.23.2`）で stderr をパイプへ繋いだ実測に基づく。
 */
export function writeStderrSync(line: string): void {
  const buffer = Buffer.from(line, 'utf8');
  let offset = 0;
  try {
    while (offset < buffer.length) {
      offset += writeSync(2, buffer, offset, buffer.length - offset);
    }
  } catch {
    // 読み手が消えている（EPIPE）等。跡のために本筋を殺さない。
  }
}

/**
 * `note()` が実際に書き込む先。**既定は `writeStderrSync`（本番と同じ経路）。**
 *
 * `fs.writeSync(2, …)` は `process.stderr.write` の差し替え（`testing.ts` の
 * `captureStderr`）を通らないので、テストだけがここを差し替えて観測する。
 * `captureStderr` 以外から呼ばないこと——本番の配線には出てこない。
 */
let stderrSink: (line: string) => void = writeStderrSync;

/**
 * テスト専用: `note()` の書き込み先を差し替える／戻す。
 *
 * **本番の書き込み方法（`writeStderrSync`）自体は1文字も変えていない。**
 * `captureStderr` が `finally` で必ず `null` を渡して戻すこと（戻し忘れると
 * 以降のテストの跡が消えたように見える）。
 */
export function setStderrSinkForTesting(sink: ((line: string) => void) | null): void {
  stderrSink = sink ?? writeStderrSync;
}

/**
 * 日誌エントリから、本文を含まない見分けだけを取り出す。
 *
 * 出すのは**書き手（＝この実装）が選んだ列挙値と id** だけである。自由文
 * （`text` / `decision` / `grounds` / `question` / `answer` / `summary` / `body` /
 * `input`）は入れない — 秘密が載りうるのはそこだからである。**長さはどの自由文に
 * ついても出す**（「空だった」と「書けなかった」の区別が付く。型によって出したり
 * 出さなかったりすると、跡の読み方が型ごとに変わる）。
 *
 * **判定は「自由文かどうか」ではなく「値を誰が決めるか」で行うこと。**
 * `tool_use` の `actor` / `tool` は SDK と runner が確定する値なので載せてよい。
 * 対して `external_event` の `source` は、**`POST /events/:source` の URL
 * パスセグメント**である＝外部の送り元が決める値なので、名前に見えても載せない。
 * ここを「本文（`summary`）ではないから」で通すと、#52 と同じ形が縮小して残る。
 *
 * **本文から id 相当を拾い出さないこと。** `[mgr-xxx]` のような目印は本文の先頭に
 * 入っているが、そこを切り出す規則を1つ認めると「本文は出さない」が
 * 「本文は原則出さない」に変わる。どのマネージャーだったかは時刻で突き合わせる。
 */
export function journalEntryShape(entry: JournalEntryInput): string {
  switch (entry.type) {
    case 'exchange':
      return `exchange with=${tag(entry.with)} role=${tag(entry.role)} ${size(entry.text)}`;
    case 'decision':
      return `decision ${size(entry.decision, 'decision')} ${size(entry.grounds, 'grounds')}`;
    case 'escalation':
      return (
        `escalation approvalId=${tag(entry.approvalId)}` +
        (entry.managerId === undefined ? '' : ` managerId=${tag(entry.managerId)}`) +
        ` ${size(entry.question, 'question')}` +
        (entry.answer === undefined ? '' : ` ${size(entry.answer, 'answer')}`)
      );
    case 'tool_use':
      return `tool_use actor=${tag(entry.actor)} tool=${tag(entry.tool)}`;
    case 'memory_update':
      return (
        `memory_update slug=${tag(entry.slug)} cause=${tag(entry.cause)}` +
        (entry.action === undefined ? '' : ` action=${tag(entry.action)}`) +
        ` ${size(entry.summary)}`
      );
    case 'daily_report':
      return `daily_report date=${tag(entry.date)} ${size(entry.body)}`;
    // `source` は外から来る値なので、名前であっても長さだけにする（上の doc 参照）。
    case 'external_event':
      return `external_event ${size(entry.source, 'source')} ${size(entry.summary)}`;
    // **全フィールドが runner 自身の数え上げ（整数・列挙値）で、自由文が1つも
    // 無い。** 値を決めるのは runner であって外の世界ではないので、`size()` へ
    // 逃がさず数値をそのまま載せてよい（`tool_use` の `actor`/`tool` と同じ判定
    // 基準 — 「自由文かどうか」ではなく「値を誰が決めるか」）。
    case 'worker_wait':
      return (
        `worker_wait tasks=${entry.tasks} turns=${entry.turns} ` +
        `toolless=${entry.toolless} settled=${entry.settled}`
      );
    // `layer` / `site` は列挙値、`managerId` はこちらが発行した id、`sessionId`
    // は SDK が決める値だが id である（`worker_wait` と同じ判定基準）。
    // **`models` の内訳（トークン数・costUsd）は SDK が数え上げた数値であって
    // 自由文ではないので、モデル id ごとの件数だけ載せる** — キーであるモデル
    // id は列挙に近い固定の語彙（`claude-opus-5` 等）であり、値は数値なので
    // 自由文を経由して秘密が混ざる経路が無い。それでも中身の数値までは
    // 載せない（跡はここまでで十分 — どのモデルで何件かが分かれば、ストアが
    // 書ける状態に戻してから読める）。
    case 'turn_usage':
      return (
        `turn_usage layer=${tag(entry.layer)} site=${tag(entry.site)} ` +
        `managerId=${tag(entry.managerId)} models=${Object.keys(entry.models).length}` +
        (entry.reset === undefined ? '' : ' reset=yes')
      );
    // **同じ判定基準（値を誰が決めるか）で3つに分かれる。**
    //
    // - 載せる: `event` / `signal` / `freshness` は列挙値、`generation` は整数、
    //   `tokenId` / `fromTokenId` は**こちらが発行した id**（`managerId` と同じ）、
    //   `earliestAt` はこちらが計算した時刻
    // - 長さだけ: **`label` は人間が付けた自由文である**（`add --label` でそのまま
    //   入る）。id に見えるものと並んでいるが、決めるのは外側なので `external_event`
    //   の `source` と同じ扱いにする
    // - 長さだけ: `noticeText` と `text` も自由文（前者は provider の英文、後者は
    //   その両方を含む整形済みの行）
    //
    // **⚠️ トークンの値はこのエントリに存在しない**（`schema.ts` の
    // `token_rotation` の doc）。ここで落とす心配をする対象がそもそも無い。
    case 'token_rotation':
      return (
        `token_rotation event=${tag(entry.event)}` +
        (entry.signal === undefined ? '' : ` signal=${tag(entry.signal)}`) +
        (entry.freshness === undefined ? '' : ` freshness=${tag(entry.freshness)}`) +
        (entry.tokenId === undefined ? '' : ` tokenId=${tag(entry.tokenId)}`) +
        (entry.fromTokenId === undefined ? '' : ` fromTokenId=${tag(entry.fromTokenId)}`) +
        (entry.generation === undefined ? '' : ` generation=${entry.generation}`) +
        (entry.earliestAt === undefined ? '' : ` earliestAt=${tag(entry.earliestAt)}`) +
        (entry.label === undefined ? '' : ` ${size(entry.label, 'label')}`) +
        (entry.noticeText === undefined ? '' : ` ${size(entry.noticeText, 'noticeText')}`) +
        ` ${size(entry.text)}`
      );
    // **全欄が runner 自身の数え上げ（`agentId` は SDK が決める id、
    // `agentType` は `.claude/agents/*.md` で定義された小さい語彙、
    // `ownedTaskCount`/`sessionTaskCount`/`wakeupCount` は整数、`outcome` は
    // 列挙値）で、自由文は `text` の1つだけ。** `agentId` は `managerId` /
    // `sessionId` と同じ判定基準（「値を誰が決めるか」）で id としてそのまま
    // 載せてよい。`agentType` はサブエージェントの種類名で、値を決めるのは
    // このリポジトリ（`.claude/agents/` にどんな作業者を定義するか）であって
    // 外部の入力ではないので、`turn_usage` のモデル id と同じ扱いで
    // `tag()` に載せる。
    case 'subagent_stall':
      return (
        `subagent_stall agentId=${tag(entry.agentId)}` +
        (entry.agentType === undefined ? '' : ` agentType=${tag(entry.agentType)}`) +
        ` ownedTaskCount=${entry.ownedTaskCount} sessionTaskCount=${entry.sessionTaskCount}` +
        ` wakeupCount=${entry.wakeupCount} outcome=${tag(entry.outcome)}` +
        ` ${size(entry.text)}`
      );
  }
}

/** 1行に収まる長さの上限（理由の側）。 */
const REASON_LIMIT = 200;

/** id や列挙値として載せてよい長さの上限。 */
const TAG_LIMIT = 64;

/**
 * 失敗の理由を1行に畳む。
 *
 * **理由だけは出す。** 「書けなかった」しか残らない行を読んだ者にできることは、
 * ストアを一から疑うことしかない。ただしドライバの例外は失敗したクエリの
 * パラメータを添えてくることがある（＝本文が裏口から戻ってくる）ので、
 * **1行目だけ・長さも切る**。
 *
 * **記録の失敗をログへ出すところは、すべてここを通すこと。** 素の
 * `String(error)` を1か所でも残すと、その1か所だけストア実装に無防備なまま
 * 置き去りになる（そして誰も気づかない）。
 *
 * **⚠️ これは仮想の危険ではない。実測（2026-08-24 観測）:** `drizzle-orm@0.45.2`
 * の `PgPreparedQuery` は失敗したクエリを `DrizzleQueryError` で包み直し、その
 * `message` は `Failed query: <sql>` の**次の行**に `params: <束縛パラメータ>` を
 * 置く。PGlite に当てて確かめたところ、insert の失敗で列の値がそのまま並んだ。
 *
 * **⚠️ そして、いまここで値が落ちているのはその「2行目」という位置のおかげで
 * あって、設計上の保証ではない。** ドライバが改行の位置を変えれば破れる——それは
 * こちらが制御していない。**⟹ 応答へ返す本文の安全を、この関数に肩代わりさせない
 * こと。** 返してよい例外かどうかは型で分ける（例: `token-pool.ts` の
 * `TokenPoolInputError`）。ここが受け持つのは stderr へ残す跡の側だけである。
 */
export function reasonOf(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return clip(text.split('\n', 1)[0] ?? '', REASON_LIMIT);
}

/** 列挙値・id を1行に収める（改行を持ち込ませない）。 */
function tag(value: string): string {
  return clip(value.replaceAll(/\s+/gu, ' '), TAG_LIMIT);
}

/**
 * 自由文の長さだけを出す。
 *
 * 名前を付けられるようにしてあるのは、1つの型に自由文が2つ以上あるときに
 * `chars=0 chars=0` が何と何なのか分からなくなるからである。
 */
function size(text: string, name?: string): string {
  return `${name === undefined ? '' : `${name}.`}chars=${text.length}`;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
