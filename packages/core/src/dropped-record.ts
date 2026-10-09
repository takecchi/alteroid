import { writeSync } from 'node:fs';

import { collapseErrorCause } from './error-cause.js';
import { codePointBoundary } from './excerpt.js';
import type { RunnerEvent } from './runner-protocol.js';
import type { InboxEvent, JournalEntryInput, PendingApproval } from './schema.js';

/**
 * 記録の書き込みに失敗したことを stderr へ1行だけ残す。
 *
 * 握り潰しは続けるが跡は残す: 跡が無いと「日誌にマーカーが無い」が「その処理を通らなかった」と読め、
 * 実際には「通ったが書けなかった」だった、という取り違えが起きる。
 *
 * 本文は出さない・足さない: 渡ってくる記録には外から拾った任意の文字列が入り、日誌にすら入らなかった
 * 秘密がホスティング先のログには残る逆転になる（stderr は器の外へ出ていく）。
 */
export function noteDroppedRecord(what: string, detail: string, error: unknown): void {
  const tail = detail === '' ? '' : `（${detail}）`;
  note(`${what}を記録できませんでした${tail}: ${reasonOf(error)}`);
}

/**
 * 未読の合図を、拾い直しが尽きたあともストアへ書けなかったことを stderr へ1行残す。
 * `canQueue: true` の経路専用。`canQueue: false` は {@link noteInboxEventLost}。
 *
 * `noteDroppedRecord` を流用しない: 合図は失われておらず、このプロセスが生きているあいだは配達される
 * （失うのは配達前に器が入れ替わったときだけ）。その生死の分かれ目が「記録できませんでした」では伝わらない。
 * 「失ってはいない」は `post()` が直後に必ず `#inbox.push` する経路でしか成り立たないので、
 * 片付けの窓では使わない。
 */
export function noteInboxEventKeptInMemoryOnly(detail: string, error: unknown): void {
  const tail = detail === '' ? '' : `（${detail}）`;
  note(
    `未読の合図をストアへ書けませんでした${tail}: ${reasonOf(error)}。` +
      'ただし失ってはいない —— メモリの待ち行列には残っており、このプロセスが' +
      '生きているあいだは配達される。器が入れ替われば（再起動・デプロイ）、' +
      'この合図は失われる。',
  );
}

/**
 * 未読の合図を、拾い直しが尽きたあともストアへ書けず、待ち行列にも一度も積まれなかったことを
 * stderr へ1行残す（`canQueue: false`。`post()` の片付けの窓）。
 *
 * `noteInboxEventKeptInMemoryOnly` を流用しない: あちらの「失ってはいない」をこの経路に使うと
 * 本当は失われているのに楽観的に読める。
 */
export function noteInboxEventLost(detail: string, error: unknown): void {
  const tail = detail === '' ? '' : `（${detail}）`;
  note(
    `未読の合図をストアへ書けませんでした${tail}: ${reasonOf(error)}。` +
      'この合図は失われた —— 受信箱を閉じた後の片付けの窓では ' +
      '`#inbox.push` を一度も通らないため、メモリの待ち行列にも載っていない。',
  );
}

/**
 * 受信箱へ書けなかった合図を、受理せずに呼び手へ失敗を返したことを stderr へ1行残す。
 *
 * メモリの待ち行列には積まない: 積むと、失敗を受けた相手の送り直しと二重に届く。
 * 呼び手は失敗を知っていて送り直せるので「失った」でもなく、専用の文言を持つ。
 */
export function noteInboxEventRefused(detail: string, error: unknown): void {
  const tail = detail === '' ? '' : `（${detail}）`;
  note(
    `合図を受信箱へ書けなかったので受理しなかった${tail}: ${reasonOf(error)}。` +
      '呼び手へは失敗を返した。メモリの待ち行列にも積んでいない（送り直しと二重に届くのを避けるため）。',
  );
}

/**
 * 記録の読み出しに失敗したことを stderr へ1行だけ残す。
 *
 * `noteDroppedRecord` を流用しない: 「記録できませんでした」を読み出しの失敗に当てると跡自体が取り違えを生む。
 * 読めなかったことが跡に残らないと、下流は「預かっていない」と読んで恒久の結論（終端状態・自動再試行の打ち切り）に変える。
 */
export function noteUnreadableRecord(what: string, detail: string, error: unknown): void {
  const tail = detail === '' ? '' : `（${detail}）`;
  note(`${what}を読み出せませんでした${tail}: ${reasonOf(error)}`);
}

/**
 * 読み出そうとした記録の取得元そのものを一度も受け取っていないことを stderr へ1行だけ残す。
 *
 * `noteUnreadableRecord` を流用しない: ここは計器の配線（呼ぶはずの hook・通知が来ていない）を疑う状況で、
 * 同じ文言に潰すと読む側はディスクを疑いに行って的を外す。逆も同じ。
 */
export function noteMissingRecordSource(what: string, detail: string): void {
  const tail = detail === '' ? '' : `（${detail}）`;
  note(`${what}の取得元を一度も受け取っていません${tail}`);
}

/**
 * runner の委譲一覧（`GET /managers`）のうち、こちらのスキーマに合わずに飛ばした要素を stderr へ1行残す。
 *
 * 失敗の記録ではなく判定を誤りうることの跡: 飛ばした委譲は Pool から見て「runner に居ない」側に落ち、
 * 待っていた確認が捨てられうる。値は載せない: `safeParse` の値や `error.message` は検証に失敗した値を引用しうる。
 */
export function noteDroppedRunnerManagers(
  runner: string,
  dropped: readonly { managerId: string | undefined; fields: readonly string[] }[],
): void {
  const items = dropped
    .map(
      ({ managerId, fields }) =>
        `managerId=${managerId === undefined ? '（読めない）' : tag(managerId)} ` +
        `欄=${fields.length === 0 ? '（不明）' : fields.map(tag).join(',')}`,
    )
    .join(' / ');
  note(
    `${tag(runner)} の委譲一覧で、こちらのスキーマに合わない ${dropped.length} 件を飛ばした` +
      `（この委譲は runner に居ないと判定されうる。版ずれを疑うこと）: ${items}`,
  );
}

/**
 * 畳み始めた runner の最後の出来事を、待ち切れずに閉じへ倒したことを stderr へ1行だけ残す。
 *
 * どの出来事が実際に落ちたかはこちらから分からないので、落ちた可能性のある種別と委譲の id を名指しする。本文は出さない。
 */
export function noteRunnerFarewellGaveUp(
  runnerId: string,
  reason: 'stream-open' | 'events-unsettled',
  managerIds: readonly string[],
): void {
  note(
    `runner ${tag(runnerId)} が畳み始めたあとの最後の出来事（archive / shutdown_unpushed_work）を、` +
      `上限までに受け取り切れなかった（${reason}）。この runner で走っていた委譲 ` +
      `${managerIds.length === 0 ? '（デーモンは把握していない）' : managerIds.map(tag).join(',')} の` +
      `生ログ・未 push の観測が台帳に届いていない可能性がある`,
  );
}

/**
 * 発行した id が既に使われていて、引き直したことを stderr へ1行だけ残す。
 *
 * `noteDroppedRecord` / `noteUnreadableRecord` を流用しない: 記録できなかったのでも読み出せなかったのでもなく、
 * 文言を当てると跡自体が取り違えを生む。
 */
export function noteManagerIdCollision(managerId: string, attempt: number): void {
  note(
    `managerId の発行が衝突したので引き直しました（managerId=${tag(managerId)} attempt=${attempt}）`,
  );
}

/**
 * `#retire()` が、空でない「握り潰した報告」の在庫を積んだまま像を畳んだことを stderr へ1行だけ残す。
 *
 * `noteDroppedRecord` を流用しない: 失敗ではなく正常な終端判定の結果である。
 * `abort()` 経由は同じ事実を日誌にも書いていて重なるが、`#retire()` の呼び出し元は他にも複数あるので
 * 呼び元によらず1行残るよう `#retire()` 自身に置く。本文（`lastText`）は出さない。
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
 * `abort()` が「止めた」と確かめた後に `send()` 側の resume が runner へ届いてしまい、畳み直しが
 * `'stopped'` 以外を返したことを stderr へ1行だけ残す。
 *
 * 失敗ではなく、台帳には `status: 'stopped'` が書けているのに runner 側で畳み直しを確かめられなかった、
 * という食い違いの跡。`noteDroppedRecord` を流用すると、書けなかったのは記録ではなく停止確認なので取り違えを生む。
 */
export function noteResumeAfterStopFoldFailed(managerId: string, outcome: string): void {
  note(
    `止められた後に resume したセッションを畳めなかった` +
      `（managerId=${tag(managerId)} outcome=${tag(outcome)}）。` +
      '台帳の status は stopped のままだが、runner 側で本当に畳めたかは未確認——' +
      '手で確かめること。',
  );
}

/**
 * `void f()` で切り離した背景処理が例外で終わったことを stderr へ1行だけ残す。
 *
 * ここで握り潰さない: 呼び出し側はこの跡の後に例外をそのまま投げ直す。この repo の復旧機構は
 * プロセスの消滅を契機に組んである（`#restoreJobs` / `#restoreUnread`）ので、生き残ったまま握り潰すと
 * その復旧経路が一度も起動しない。この跡が足すのは「どの背景処理か」だけ（プロセス全体の網は出所を言えない）。
 *
 * @param detail 本文を含まない見分け（値を誰が決めるかで選ぶ。`journalEntryShape` と同じ基準）。無ければ空文字。
 */
export function noteBackgroundFailure(what: string, detail: string, error: unknown): void {
  const tail = detail === '' ? '' : `（${detail}）`;
  note(`${what}が例外で終わりました${tail}: ${reasonOf(error)}`);
}

/** 日誌の読み出しが行を飛ばす理由。`unparsable` は構造すら持たず、`unknown-shape` は JSON としては正しいがスキーマに合わない。 */
export type DroppedJournalRowReason = 'unparsable' | 'unknown-shape';

/**
 * 読めなかった日誌の行から、本文を含まずに安全に取り出せる `type` らしき文字列。
 *
 * 取れなければ `undefined` を返す（埋め草を置かない）: `'（不明）'` のような固定文字列を置くと
 * それ自体が `type` の1種として数えられ、型が分からない行の実数を覆い隠す。
 */
export function journalRowType(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = (raw as { type?: unknown }).type;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return tag(value);
}

/**
 * 日誌の読み出しでスキーマに合わない行を1件、飛ばすが跡には残す。
 * 同じ種別（`reason` と `type` の組）は、この呼び出しで最初の1回だけその場で出す（跡でログを埋めない）。
 *
 * `dropped` は呼び出し1回ぶんのローカルな `Map`: プロセス単位で畳むと、器が入れ替わって新しい書き手が
 * 同じ種別を吐き始めても「前に見たから」で黙る。
 * `safeParse` の `error.message` は渡さない: 検証に失敗した値そのものを引用することがある。
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
 * SDK が失敗として出した1回を、枠の文言としては分類できなかったことを stderr へ残す。
 * 同じ組は、この帳面で最初の1回だけその場で出し、量は {@link noteUnclassifiedFailuresSummary} が出す。
 *
 * 回し手は `classifyUsageNotice` が分類できなかった失敗を聞けず、プールは何も検知しない。
 * 日誌ではなく stderr: 日誌へ出すには回し手の `signal` の enum に足すことになり、跡のためだけに外向きの面が広がる。
 *
 * `text` は載せない: SDK の文言そのままでマネージャーの報告が混ざりうる。載せるのは値を決めるのが
 * SDK かこちらの `via` と `code` だけ。
 *
 * @param seen セッション1本ぶんの `Map<種別, 件数>`。プロセス単位で畳まない（器が入れ替わった後の新しい失敗が「前に見た」で黙る）。
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
 * {@link noteUnclassifiedFailure} で溜めた件数を、セッションの終わりで1行にまとめて出す。
 *
 * セッションの終わり口は `RunnerSession#finish()` と `#stop()` の2本で、後者は `#finish` を通らない。
 * 両方で呼ぶこと（忘れた経路は量が跡に出ない）。
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
 * `noteDroppedJournalRow` で溜めた件数を、呼び出しの終わりで1行にまとめて出す。
 *
 * `list()` / `get()` のすべての返り口（`return` / `throw` の手前）で呼ぶこと。早期 return を忘れると
 * その経路だけ量が跡に出ない。
 */
export function noteDroppedJournalRowsSummary(dropped: Map<string, number>): void {
  if (dropped.size === 0) return;
  const detail = [...dropped.entries()].map(([key, count]) => `${key}×${count}`).join(' / ');
  note(`日誌の行を読み出せずに飛ばした（この呼び出しの合計）: ${detail}`);
}

/**
 * 受信箱が閉じた後に届いた合図を、このプロセスでは処理しなかったことを stderr へ1行だけ残す。
 *
 * 「捨てた」とも「残した」とも書かない: 呼び出し側は器へ残してから来るが、窓の後半ではストアが既に閉じていて
 * 書き込みは落ちうる（落ちたことは `noteDroppedRecord` が別の行で言う）。断言すると書けなかった回だけ
 * 跡が静かに嘘をつくので、観測できた「このプロセスでは処理しなかった」だけを主張する。
 *
 * 日誌ではなく stderr: `post` は同期で、捨てが起きる窓（`stop()` → `storage.close()` → `process.exit(0)`）は
 * fire-and-forget の約束が果たされる前にプロセスが消える窓そのもの。日誌の型を足して解かない:
 * `journalEntrySchema` を広げると `openapi.json` の外向きの面が動く。
 *
 * 見分けは呼び出し側に選ばせない: 合図には人間の発言・webhook の本文・マネージャーの報告が入るので、
 * 何を載せてよいかの判断は `inboxEventShape` の1か所に閉じる。
 */
export function noteDroppedInboxEvent(event: InboxEvent): void {
  note(
    `受信箱を閉じた後に届いた合図はこのプロセスでは処理しませんでした` +
      `（器へ残せていれば次の起動で配り直されます）: ${inboxEventShape(event)}`,
  );
}

/**
 * 同じ `human_answer` 合図の id を、同じプロセスの中で2回目は処理しなかったことを stderr へ1行残す。
 *
 * `noteDroppedRecord` は使わない: 畳んだこと自体が正常な結果なので、失敗と読める文言を被せない。
 */
export function noteDuplicateHumanAnswer(event: InboxEvent): void {
  note(
    `同じ human_answer の id を2回目は処理しなかった（二重配達を畳んだ。issue #1977）: ${inboxEventShape(event)}`,
  );
}

/**
 * runner から届いた合図から、本文を含まない見分けだけを取り出す。
 *
 * `journalEntryShape` / `inboxEventShape` と違い、網羅 `switch` ではなく載せてよい2つ（`type` と在れば `managerId`）だけを
 * 名指しする許可制にしてある: 網羅にすると型が増えるたびに「どれだけ載せてよいか」の判断が増え、漏れうる面が広がる。
 * `report` の `text` などは外から来るので載せない（長さも出さない）。
 */
export function runnerEventShape(event: RunnerEvent): string {
  const owner = 'managerId' in event ? ` managerId=${tag(event.managerId)}` : '';
  return `type=${tag(event.type)}${owner}`;
}

/**
 * 受信箱の合図から、本文を含まない見分けだけを取り出す。
 *
 * 判定の基準は `journalEntryShape` と同じ（自由文かどうかではなく値を誰が決めるか）。`external` の `source` は
 * `POST /events/:source` の URL パスセグメント＝外の送り元が決める値なので、名前に見えても長さだけにする。
 * `human_message` の `conversationId` は呼び出し側が指定できる値であり、`journalEntryShape` の `exchange` も
 * 載せていない。**同じ値の扱いを2か所で変えないこと。**
 */
export function inboxEventShape(event: InboxEvent): string {
  switch (event.type) {
    case 'human_message':
      return `human_message ${size(event.text)}`;
    case 'human_answer':
      return `human_answer approvalId=${tag(event.approvalId)} ${size(event.answer, 'answer')}`;
    case 'distill':
      return `distill reason=${tag(event.reason)}`;
    case 'timer':
      return (
        `timer kind=${tag(event.kind)}` +
        (event.cause === undefined ? '' : ` cause=${tag(event.cause)}`) +
        (event.target === undefined ? '' : ` target=${tag(event.target)}`)
      );
    // `payload` は webhook の本文そのもの。長さも出さない: 長さを得るには一度 JSON へ畳む必要があり、畳んだ文字列が跡へ載る事故が入りやすい。
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
 * stderr へ1行書く。跡を出す口をここ1本にして、本文を出さないという判断がこのファイルの外へ散らないようにする。
 *
 * `process.stderr.write` ではなく `writeStderrSync`（fd 2 への `fs.writeSync`）を通す: fd がパイプのとき
 * `process.stderr.write` は POSIX 上で非同期で、`stop()` → `storage.close()` → `process.exit(0)` のような
 * 書いた直後にプロセスが消える窓では、行がバッファに残ったまま失われる。
 */
function note(text: string): void {
  notePrefixed('alteroid', text);
}

/**
 * 直近の跡（`note()` が書いた行）を、器の中から読み戻すための帳面。
 *
 * 無制限の列挙を作らない: 溢れたら古い側から押し出す（`RecentMap` と同じ形）。プロセスの生存中だけの記憶で、
 * 再起動をまたいで残すなら日誌と同じ「壊れても消えない」約束が要り、それは journal の役目である。
 * `alteroidd:` / `alteroid-runner:`（`noteUncaught` の接頭辞）は乗せない: 塞ぐのはクローン自身が残した跡だけ。
 */
export const RECENT_TRACE_LIMIT = 200;
const recentTraces: string[] = [];

function rememberTrace(line: string): void {
  recentTraces.push(line);
  if (recentTraces.length > RECENT_TRACE_LIMIT) recentTraces.shift();
}

/** 直近の跡を古い順で返す（末尾がいちばん新しい）。控えを返すので、呼び手が触っても帳面は動かない。 */
export function recentDroppedTraces(): readonly string[] {
  return [...recentTraces];
}

/**
 * テスト専用: 帳面を空にする。{@link droppedTraceLedgerSince} も取り直す:
 * 空にしたのに「数え始めた時刻」だけ古いままだと、`describeDroppedTraceEmpty()` の説明と食い違って見える。
 */
export function clearRecentTracesForTesting(): void {
  recentTraces.length = 0;
  ledgerSince = new Date().toISOString();
}

/**
 * 帳面（{@link recentDroppedTraces}）がどのプロセスの跡を持っているかを表す。
 *
 * runner は別プロセスでこの帳面からは読めないので、runner がこの型へ値を足さない限り `'daemon'` は
 * 「デーモン（クローン込み）の跡だけ」と言い切れる。値を足すときは runner 側の実装と同時に増やすこと。
 */
export type DroppedTraceOrigin = 'daemon';

/**
 * 帳面が何の跡を持っているかを一言で言う（`GET /dropped` と `self_dropped` の共有の生成元）。
 *
 * `apps/web` は `@alteroid/core` の値 import が禁じられていて、この文字列を自前に複製する。揃っていることは
 * テストの文字列一致で守る（先例: `describeSessionMissingKind` と `describeSessionMissingKindNote`）ので、
 * 文言を直すときは Web 側の複製も見ること。
 *
 * `undefined` は空文字にする（「不明」と書かない）: 由来を持たない印は欄が足される前の版のデーモンが立てたものだけで、
 * 新しい語を出すと実際には1つしかない区別が2つに見える。
 *
 * `default` 節の実行時の倒れ先は、デーモンと読み手が別デプロイで版がずれうるため。`never` 型の値は画面に出さない。
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
 * 「無事だった」とは読ませない: 帳面はプロセスの生存中だけの記憶で、再起動をまたいで残らない。
 * 時刻は埋め込まない: 面ごとに時刻の整形が違い、{@link describeDroppedTraceOrigin} と同じ字面一致の歯が壊れる。
 * 数え始めた時刻を出したい面は {@link droppedTraceLedgerSince} を自分で描くこと。
 */
export function describeDroppedTraceEmpty(): string {
  return (
    'このプロセスではまだ跡（記録・読み出しの握り潰し）が1件も残っていない。' +
    '0件は「握り潰しが1件も無かった」ことを意味しない —— ' +
    'この帳面はプロセスの生存中だけの記憶で、再起動・デプロイの入れ替えで消える。'
  );
}

/**
 * 帳面の保持のしかた（上限で古い側から押し出される・それより古い分の在り処）を一言で言う。
 *
 * @param limit `RECENT_TRACE_LIMIT` をそのまま渡すこと。値をここへ焼き込まない（上限が動いたときに一緒に動く）。
 */
export function describeDroppedTraceRetention(limit: number): string {
  return (
    `直近 ${limit} 件までしか持たず、溢れた古い側から押し出される。` +
    'それより古い分はこの帳面の中には無く、器の外の stderr を見るしかない。'
  );
}

/** この帳面が数え始めた時刻（ISO 8601、UTC）。{@link clearRecentTracesForTesting} が呼ばれたら取り直す。 */
let ledgerSince = new Date().toISOString();

export function droppedTraceLedgerSince(): string {
  return ledgerSince;
}

/**
 * 接頭辞を呼び出し側から受け取って1行書く。`note()` と同じ口（`stderrSink` を通るのはここ1本）。
 *
 * 分けてあるのは、`note()` が `alteroid:` を焼き込んでいる一方で、プロセス全体の網（`uncaught-net.ts`）は
 * どちらのプロセスが落ちたかを1行目で見分けられるよう app ごとに別の接頭辞（`alteroidd:` / `alteroid-runner:`）を出すため。
 * 帳面へ積むのは `prefix === 'alteroid'` のときだけ。
 */
function notePrefixed(prefix: string, text: string): void {
  const line = `${prefix}: ${new Date().toISOString()} ${text}`;
  if (prefix === 'alteroid') rememberTrace(line);
  stderrSink(`${line}\n`);
}

/**
 * 未捕捉の例外・未処理の Promise 拒否を観測したことを stderr へ1行だけ残す。
 *
 * 「プロセスが落ちる」と書かない: `uncaughtExceptionMonitor` は `process.on('uncaughtException')` が
 * 登録されていれば落ちないまま発火する。いまその登録は無いが配線の事実であって保証ではなく、断言すると
 * 登録された日にこの行だけが静かに嘘をつく。主張するのは観測できたことだけ。
 *
 * 「本文は出しません」とも書かない: 例外の `message` そのものが理由なので `reasonOf` は message を出す。
 * 実際に効いている守りは `reasonOf` の1行目だけ・200字切りの2つで、スタックは載せない。
 * この行が漏らしうるものは、`uncaught-net.ts` が Node 既定の出力を止めないので既に stderr へ出ているものの部分集合である。
 *
 * @param prefix app ごとの接頭辞（`alteroidd` / `alteroid-runner`）。末尾のコロンは付けない（`notePrefixed` が付ける）。
 */
export function noteUncaught(prefix: string, origin: string, error: unknown): void {
  notePrefixed(prefix, `${describeUncaughtOrigin(origin)}を観測しました: ${reasonOf(error)}`);
}

/**
 * `uncaughtExceptionMonitor` の `origin` を、跡に書く言葉へ直す。
 *
 * 知らない値を既知の2つのどちらかへ倒さない: 「判別できない」が黙って片方に化ける。
 * `origin` は Node が決める値なので `tag()` に通してそのまま載せてよい。
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
 * fd 2 は非ブロッキングで部分書き込みが起きる（`fs.writeSync` は例外ではなく返り値が減る）ので、
 * 書き切るまでループする。読み手が消えていると `EPIPE` を投げるが、跡のために本筋を殺さないよう黙って諦める。
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
 * `note()` が実際に書き込む先。`fs.writeSync(2, …)` は `process.stderr.write` の差し替えを通らないので、
 * テストだけがここを差し替えて観測する。`captureStderr` 以外から呼ばないこと。
 */
let stderrSink: (line: string) => void = writeStderrSync;

/** テスト専用: `note()` の書き込み先を差し替える／戻す。`captureStderr` が `finally` で必ず `null` を渡して戻すこと。 */
export function setStderrSinkForTesting(sink: ((line: string) => void) | null): void {
  stderrSink = sink ?? writeStderrSync;
}

/**
 * 日誌エントリから、本文を含まない見分けだけを取り出す。
 *
 * 出すのは書き手（＝この実装）が選んだ列挙値と id だけ。自由文は入れず、長さはどの自由文についても出す
 * （型によって出したり出さなかったりすると、跡の読み方が型ごとに変わる）。
 *
 * 入れ子オブジェクト（`contextUsage` のような構造を持つ欄）の中へは踏み込まない: 入れ子の中に新しい自由文が
 * 増えてもこの関数の判定は知らない。増やすときは、その入れ子を持つ `case` の側で個別に決める。
 * 「入れ子は全部同じ規則で再帰的に判定する」としないのは、SDK 由来の入れ子ほど既定を「出ない」側に置きたく、
 * alteroid 自身が決める入れ子（`inbox_flow` 等）は件数だけを出すというように、入れ子ごとに判断が違うため。
 *
 * **唯一の例外は `tool_use` の `input` である。長さも出さない。**
 * 1. `input` は `z.unknown().optional()` で `.length` を持たず、長さを出すには `JSON.stringify` が要る。
 *    日誌への書き込みが既に失敗した後の経路で循環参照や巨大構造の直列化を走らせると、跡を残す仕組み自身を落としに行く。
 * 2. `input` はツール引数そのもの（シェル行など）で、最も秘密が載りうる。
 *
 * 判定は「自由文かどうか」ではなく「値を誰が決めるか」で行う。`external_event` の `source` は
 * `POST /events/:source` の URL パスセグメント＝外部が決める値なので、名前に見えても載せない。
 *
 * 本文から id 相当（`[mgr-xxx]` など）を拾い出さない: 切り出す規則を1つ認めると「本文は出さない」が「原則出さない」に変わる。
 */
export function journalEntryShape(entry: JournalEntryInput): string {
  switch (entry.type) {
    case 'exchange':
      return (
        `exchange with=${tag(entry.with)} role=${tag(entry.role)} ${size(entry.text)}` +
        (entry.approvalId === undefined ? '' : ` approvalId=${tag(entry.approvalId)}`) +
        (entry.managerId === undefined ? '' : ` managerId=${tag(entry.managerId)}`) +
        (entry.answeredApprovalId === undefined
          ? ''
          : ` answeredApprovalId=${tag(entry.answeredApprovalId)}`)
      );
    case 'decision':
      return (
        `decision ${size(entry.decision, 'decision')} ${size(entry.grounds, 'grounds')}` +
        (entry.answeredApprovalId === undefined
          ? ''
          : ` answeredApprovalId=${tag(entry.answeredApprovalId)}`)
      );
    case 'escalation':
      return (
        `escalation approvalId=${tag(entry.approvalId)}` +
        (entry.managerId === undefined ? '' : ` managerId=${tag(entry.managerId)}`) +
        ` ${size(entry.question, 'question')}` +
        (entry.answer === undefined ? '' : ` ${size(entry.answer, 'answer')}`) +
        (entry.withdrawnReason === undefined
          ? ''
          : ` ${size(entry.withdrawnReason, 'withdrawnReason')}`)
      );
    // `error` は SDK・道具・MCP サーバが書く自由文なので `size()` へ逃がす。`outcome` は列挙値。
    case 'tool_use':
      return (
        `tool_use actor=${tag(entry.actor)} tool=${tag(entry.tool)}` +
        (entry.outcome === undefined ? '' : ` outcome=${tag(entry.outcome)}`) +
        (entry.error === undefined ? '' : ` ${size(entry.error, 'error')}`) +
        (entry.answeredApprovalId === undefined
          ? ''
          : ` answeredApprovalId=${tag(entry.answeredApprovalId)}`)
      );
    case 'memory_update':
      return (
        `memory_update slug=${tag(entry.slug)} cause=${tag(entry.cause)}` +
        (entry.action === undefined ? '' : ` action=${tag(entry.action)}`) +
        ` ${size(entry.summary)}` +
        (entry.answeredApprovalId === undefined
          ? ''
          : ` answeredApprovalId=${tag(entry.answeredApprovalId)}`)
      );
    // `unavailable` は自由文だが、この欄の有無に機構上の意味がある（`isWrittenDailyReport` が本物の日報かを判定する）
    // ので、有無が跡から読めるよう長さだけ載せる。
    case 'daily_report':
      return (
        `daily_report date=${tag(entry.date)} ${size(entry.body)}` +
        (entry.unavailable === undefined ? '' : ` ${size(entry.unavailable, 'unavailable')}`)
      );
    // `source` は外から来る値なので、名前であっても長さだけにする。
    case 'external_event':
      return `external_event ${size(entry.source, 'source')} ${size(entry.summary)}`;
    // 全フィールドが runner 自身の数え上げ（整数・列挙値）で自由文が無いので、`size()` へ逃がさず数値をそのまま載せる。
    case 'worker_wait':
      return (
        `worker_wait openedAt=${tag(entry.openedAt)} tasks=${entry.tasks} turns=${entry.turns} ` +
        `byCause.input=${entry.byCause.input} byCause.notification=${entry.byCause.notification} ` +
        `byCause.continuation=${entry.byCause.continuation} toolless=${entry.toolless} ` +
        `notifications=${entry.notifications} submits=${entry.submits}` +
        (entry.sources === undefined ? '' : ` sources=${Object.keys(entry.sources).length}`) +
        ` settled=${entry.settled}`
      );
    // `models` はモデル id ごとの件数だけ載せ、中身の数値までは載せない。
    // `contextUsage` には下の `case 'context_usage'` と同じ判断が掛かる（理由はそちらに1箇所だけ書く）。
    case 'turn_usage':
      return (
        `turn_usage layer=${tag(entry.layer)} site=${tag(entry.site)} ` +
        `managerId=${tag(entry.managerId)}` +
        (entry.sessionId === undefined ? '' : ` sessionId=${tag(entry.sessionId)}`) +
        ` models=${Object.keys(entry.models).length}` +
        (entry.reset === undefined ? '' : ' reset=yes')
      );
    // `label` は人間が付けた自由文（`add --label` でそのまま入る）で、id に見えても決めるのは外側なので長さだけにする。
    // `noticeText` と `text` も自由文。トークンの値はこのエントリに存在しない。
    case 'token_rotation':
      return (
        `token_rotation event=${tag(entry.event)}` +
        (entry.signal === undefined ? '' : ` signal=${tag(entry.signal)}`) +
        (entry.reason === undefined ? '' : ` reason=${tag(entry.reason)}`) +
        (entry.freshness === undefined ? '' : ` freshness=${tag(entry.freshness)}`) +
        (entry.tokenId === undefined ? '' : ` tokenId=${tag(entry.tokenId)}`) +
        (entry.fromTokenId === undefined ? '' : ` fromTokenId=${tag(entry.fromTokenId)}`) +
        (entry.generation === undefined ? '' : ` generation=${entry.generation}`) +
        (entry.earliestAt === undefined ? '' : ` earliestAt=${tag(entry.earliestAt)}`) +
        (entry.cooldownSource === undefined ? '' : ` cooldownSource=${tag(entry.cooldownSource)}`) +
        (entry.recoveredSource === undefined
          ? ''
          : ` recoveredSource=${tag(entry.recoveredSource)}`) +
        (entry.label === undefined ? '' : ` ${size(entry.label, 'label')}`) +
        (entry.noticeText === undefined ? '' : ` ${size(entry.noticeText, 'noticeText')}`) +
        ` ${size(entry.text)}`
      );
    case 'subagent_stall':
      return (
        `subagent_stall agentId=${tag(entry.agentId)}` +
        (entry.agentType === undefined ? '' : ` agentType=${tag(entry.agentType)}`) +
        ` ownedTaskCount=${entry.ownedTaskCount} sessionTaskCount=${entry.sessionTaskCount}` +
        ` wakeupCount=${entry.wakeupCount} outcome=${tag(entry.outcome)}` +
        ` ${size(entry.text)}`
      );
    // `contextUsage` は入れ子のどの階層も跡へ出さない。
    //
    // 中の自由文（`error` / `categories[].name` / `categories[].kind`）は値を決めるのが SDK 側で、載せてよい側に来ない。
    // `error` は「伏せ字済み」ではない: 通している `redactEnvSecrets` は `env` の値の完全一致置換だけで、
    // 値が変形されて出てきた場合までは塞げない。
    //
    // 跡の行き先は stderr＝器の外なので非対称: 出さない→出すは後から広げられるが、逆は戻せない。
    // `size()` で長さだけ出す案は、日誌への書き込みが既に失敗した後の経路で得が小さく採らなかった（禁止ではない。
    // 実際に掘れなかった実例が出たら広げてよい）。
    case 'context_usage':
      return (
        `context_usage layer=${tag(entry.layer)} site=${tag(entry.site)} ` +
        `managerId=${tag(entry.managerId)}` +
        (entry.sessionId === undefined ? '' : ` sessionId=${tag(entry.sessionId)}`) +
        ` turnSucceeded=${entry.turnSucceeded}`
      );
    // 自由文を持たない（残りは全部数）ので、他の型のように長さだけに削らず、総数と滞留までそのまま出す。
    case 'inbox_flow':
      return (
        `inbox_flow windowStartedAt=${tag(entry.windowStartedAt)} ` +
        `arrived=${entry.arrived.total} delivered=${entry.delivered.total} ` +
        `settled=${entry.settled.total} pending=${entry.pending.count}` +
        (entry.pending.oldestAt === undefined
          ? ''
          : ` pendingOldestAt=${tag(entry.pending.oldestAt)}`) +
        (entry.retained === undefined
          ? ''
          : ` retainedUnread=${entry.retained.unread} ` +
            `retainedRedelivered=${entry.retained.redelivered} ` +
            `retainedRedeliveredClosed=${entry.retained.redeliveredClosed} ` +
            `retainedPendingCollapse=${entry.retained.pendingCollapse}`)
      );
    // `observedBy` / `repo` / `query` / `reason` は観測した側が名乗る自由文でデーモンは値を確かめられないので出さない。
    case 'github_observation':
      return entry.result.status === 'ok'
        ? `github_observation status=ok openIssues=${entry.result.openIssues} ` +
            `openPulls=${entry.result.openPulls} truncated=${entry.result.truncated}`
        : 'github_observation status=failed';
    // `deletedConversationId` / `deletedBy` は出さない（`exchange.conversationId` を出さないのと同じ判断）。
    case 'conversation_deleted':
      return `conversation_deleted hiddenCount=${entry.hiddenCount}`;
  }
}

/**
 * 承認待ち（`PendingApproval`）の、本文を含まない見分け。
 *
 * `journalEntryShape` の `escalation` と対: 後段（journal 側）が落ちたときの見分けはあちらが持ち、
 * ここは前段（`putApproval`）が落ちて journal エントリがまだ無いときのためにある。
 */
export function approvalShape(approval: PendingApproval): string {
  return (
    `escalation approvalId=${tag(approval.id)}` +
    (approval.jobId === undefined ? '' : ` managerId=${tag(approval.jobId)}`) +
    (approval.requestId === undefined ? '' : ` requestId=${tag(approval.requestId)}`) +
    ` ${size(approval.question, 'question')}` +
    (approval.context === undefined ? '' : ` ${size(approval.context, 'context')}`)
  );
}

/** id や列挙値として載せてよい長さの上限。 */
const TAG_LIMIT = 64;

/**
 * 失敗の理由を1行に畳む。記録の失敗をログへ出すところは、すべてここを通すこと
 * （素の `String(error)` を1か所でも残すと、その1か所だけ無防備になる）。
 *
 * 理由は出すが、1行目だけ・長さも切る: ドライバの例外は失敗したクエリのパラメータを添えてくることがある。
 * `drizzle-orm@0.45.2` の `DrizzleQueryError` は `message` の次の行に `params: <束縛パラメータ>` を置き、
 * PGlite の insert の失敗で列の値がそのまま並んだ（実測）。
 *
 * その「2行目」に値が落ちているのはドライバの都合であって設計上の保証ではない。
 * ⟹ 応答へ返す本文の安全を、この関数に肩代わりさせないこと。返してよい例外かどうかは型で分ける
 * （例: `token-pool.ts` の `TokenPoolInputError`）。
 *
 * 外へ出す例外の文は `reasonOf` か `redactErrorText`（`denial-input-head.ts`）のどちらかを通す。
 * 文を変えたくない・全文が要るなら後者。`scripts/stderr-error-through-reasonof.test.ts` がこの規則の破れを機械で見る。
 */
export function reasonOf(error: unknown): string {
  return collapseErrorCause(error);
}

/** 列挙値・id を1行に収める（改行を持ち込ませない）。 */
function tag(value: string): string {
  return clip(value.replaceAll(/\s+/gu, ' '), TAG_LIMIT);
}

/** 自由文の長さだけを出す。名前を付けられるのは、自由文が2つ以上ある型で `chars=0 chars=0` が何と何か分からなくなるため。 */
function size(text: string, name?: string): string {
  return `${name === undefined ? '' : `${name}.`}chars=${text.length}`;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, codePointBoundary(text, limit))}…` : text;
}

/**
 * クローンの再開素材（`FsSessionRegistry` / `PgSessionRegistry` の4欄）を、ファイルが無い・行が無い以外の理由で
 * 読めなかったことを stderr へ1行だけ残す。
 *
 * `noteDroppedRecord`（書き込み失敗の文言）にも `noteUnreadableRecord` にも寄せない: この行だけが
 * 「無かった」と「読めなかった」を区別できる。呼び出し側は ENOENT・該当行なしのときは呼ばないので、
 * この行が出ていれば「在ったのに読めなかった」で、出ていなければ `null` は「無かった」を意味する。
 * 「無い」として扱ったので起動は止めていないことも行に書く（読み手が起動停止と取り違えない）。
 * 例外は投げない: 呼び出し側はこの後も `null` を返す。握り潰しをやめて起動しなくなるのが最悪の着地。
 */
export function noteSessionMaterialUnreadable(what: string, error: unknown): void {
  note(
    `${what}を読み出せませんでした: ${reasonOf(error)}。` +
      '「無い」として扱ったので起動は止めていない —— ' +
      'ただし本当に無かったのか読めなかっただけなのかを区別できるのは、この行だけである。',
  );
}

/**
 * クローンのセッション id を器へ控えられなかったことを stderr へ1行残す。
 *
 * `noteDroppedRecord` を流用しない: 帰結が2段に分かれ、どちらか一方だけを言うと必ず誤って読まれる。
 * 1. いま走っているセッションは失っていない（控えを読むのは `#ensureQuery` が `#query === null` のときだけ）。
 * 2. 器が入れ替われば resume されず新しいセッションが始まる。しかもその始まり方は
 *    初回起動や意図して捨てた（`setCloneSessionId(null)`）場合と同じ `null` で、正常な経路として通る。
 *    この行だけがその3つを区別する材料を持つ。
 *
 * 投げない: 控えに失敗したことでセッションそのものを殺してはいけない。セッション id そのものは載せない。
 */
export function noteCloneSessionIdNotRecorded(error: unknown): void {
  note(
    `クローンのセッション id を控えられませんでした: ${reasonOf(error)}。` +
      'いま走っているセッションは失っていない —— このプロセスが生きているあいだは' +
      'そのまま続く。器が入れ替われば（再起動・デプロイ）、このセッションは ' +
      'resume されず新しいセッションが始まる。⟹ 次の起動では resume 素材が' +
      '「無い」ように見えるが、それは初回だからでも意図して捨てたからでもない。',
  );
}
