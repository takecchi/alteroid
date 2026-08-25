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
 * 報告経路へ全文で出た事故があり（#52）、書けなかった本文を丸ごとログへ吐くと
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
 * （報告本文に `GH_TOKEN` が全文で出た前例がある。#52）。**`safeParse` が返す
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
 * 本文・マネージャーの報告が入る（報告本文に `GH_TOKEN` が全文で出た前例が
 * ある。#52）。何を載せてよいかの判断は `inboxEventShape` の1か所に閉じる。
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
 * 接頭辞を呼び出し側から受け取って1行書く。
 *
 * **`note()` と同じ口である**（`stderrSink` を通るのはここ1本のまま）。分けて
 * あるのは、`note()` が `alteroid:` を焼き込んでいるからで、**プロセス全体の網
 * （`uncaught-net.ts`）は app ごとに別の接頭辞を出す**必要があるためである ——
 * daemon は `alteroidd:`、runner は `alteroid-runner:`（`.onError` の先例が
 * `apps/runner/src/app.ts` に在る）。**接頭辞が app ごとに違うのは、跡を読む者が
 * どちらのプロセスが落ちたのかを1行目で見分けられるようにするためである。**
 *
 * **`note()` が出す行は1文字も変えていない。**
 */
function notePrefixed(prefix: string, text: string): void {
  stderrSink(`${prefix}: ${new Date().toISOString()} ${text}\n`);
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
