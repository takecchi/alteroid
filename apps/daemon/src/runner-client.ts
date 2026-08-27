import type {
  RunnerAnswerCommand,
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerEvent,
  RunnerManagerState,
  RunnerPlacementResources,
  RunnerResumeCommand,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerRevisionReport,
  RunnerSetCredentialsCommand,
  RunnerStartCommand,
} from '@alteroid/core';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';

import { RUNNER_CALL_DEADLINE_MS, RunnerUnknownError, settleWithinDeadline } from './deadline.js';

import {
  DEFAULT_SSE_HEARTBEAT_MS,
  RunnerHttpError,
  buildRevisionSchema,
  reasonOf,
  reportRunnerRevision,
  runnerCredentialFingerprintSchema,
  runnerProfileFingerprintSchema,
  runnerProfileResultSchema,
  runnerAnswerResultSchema,
  runnerEventSchema,
  runnerExecutionResourcesSchema,
  runnerManagerStateSchema,
  runnerPlacementResourcesSchema,
} from '@alteroid/core';

// **失敗の種別は口の定義（`@alteroid/core`）が持つ。** この経路だけの都合にすると、
// 同じ判断をインプロセスの runner 側で作り直すことになる。
export { RunnerHttpError } from '@alteroid/core';
export { RUNNER_CALL_DEADLINE_MS, RunnerUnknownError } from './deadline.js';

/**
 * 「期限内に応答が返らなかった」ことの報告。**日誌へ届けるためだけにある。**
 *
 * ここで分類を終わらせないこと。**この報告が言えるのは「返らなかった」だけ**で、
 * 失敗も死亡も「届かなかった」も言えない（{@link RunnerUnknownError}）。
 */
export interface RunnerUnknownReport {
  method: string;
  path: string;
  waitedMs: number;
  /**
   * `expired` = 期限が切れた（＝不明になった）。
   * `late` = 不明と言ったあとで**遅れて応答が返ってきた**（＝不明が解けた）。
   */
  phase: 'expired' | 'late';
  /** `late` のときだけ: 遅れて返ってきた応答が成功だったか。 */
  ok?: boolean;
  /** `late` で失敗だったときの中身。 */
  error?: unknown;
}

/**
 * **降りてきた出来事を、跡なしで捨てないための報告。**
 *
 * SSE のフレームは2つの形で捨てられていた。どちらも跡がゼロで、
 * **届いていないことを観測できる場所が1つも無かった。**
 *
 * 1. `JSON.parse` が投げる（`reason: 'unparsable'`）— 構造が無いので `type` も取れない
 * 2. `runnerEventSchema.safeParse` が失敗する（`reason: 'unknown-shape'`）—
 *    **構文としては正しい JSON で、`type` は読めることが多い**
 *
 * **2つ目のほうが重い。** runner が新しい種類の出来事を出し始めても、
 * デーモンのスキーマが知らなければ黙って消える。**次に runner 側へイベントを1つ
 * 足した人が、それが届かないことに気づけない。**
 *
 * **`onUnknown` を借りない。** あちらは「こちらが投げた呼びが期限内に返らなかった」
 * で、主語が違う（こちらは「向こうから降りてきたものを解釈できなかった」）。
 * 形（上の層が届け先を選ぶコールバック）だけを揃えてある。
 *
 * **本文は載せない。** ここへ来るフレームにはマネージャーの報告が入りうる
 * （テスト出力に `GH_TOKEN` が全文で出た前例がある。`railway/setup.test.ts`
 * の差分アサーション、#52）。載せるのは `type` とバイト数だけである。
 */
export type RunnerDroppedEventReport =
  | {
      /** **その `type` の初出。その場で1行出す。** */
      phase: 'first';
      reason: 'unparsable' | 'unknown-shape';
      /** 読めた `type`。JSON にならなかったフレームでは付かない。 */
      type?: string;
      /** そのフレームのバイト数。**取れない `type` の代わりに 0 を置かない。** */
      bytes: number;
    }
  | {
      /** 接続を閉じるときのまとめ。**量はここでしか出ない。** */
      phase: 'closed';
      dropped: { key: string; count: number }[];
    };

/**
 * 挑み直しの間隔の既定値（基準・上限）。
 *
 * **正本は `packages/core/src/runner-protocol.ts` の `REGISTRY_RETRY_BASE_MS` /
 * `REGISTRY_RETRY_MAX_MS`（名簿側の再接続）である。** あちらは export されて
 * いないので値だけをこちらへ写している — import できる関係ではなく、**形を
 * 揃えているだけ**である。名簿側とこの口は層が違うだけで、あるべき挙動
 * （待てば直るので回数では諦めず、間隔だけを伸ばして頭打ちにする）は同じ。
 */
const RUNNER_STREAM_RETRY_BASE_MS = 1_000;
const RUNNER_STREAM_RETRY_MAX_MS = 30_000;

/**
 * 接続を「持続した」とみなす閾値（#274）。**新しいマジックナンバーを置かない**——
 * 既にシステムに在る量（{@link DEFAULT_SSE_HEARTBEAT_MS}）の2倍として導く。
 *
 * **なぜ2倍か。** heartbeat の間隔を1回以上またいで生きていた接続は、相手が
 * 生きていたことを実際に示している——またげたのは heartbeat（`packages/core/
 * src/sse-heartbeat.ts` の {@link DEFAULT_SSE_HEARTBEAT_MS} 間隔で runner が送る
 * コメント行）が届いていたからである。1倍（heartbeat の間隔そのもの）では
 * 「1回も届かないうちに閾値へ達する」余地が残り、「またいだ」と言い切れない。
 * 2倍にすれば、閾値に達した時点で少なくとも1回分の間隔をまたいでいることが
 * 保証される。
 *
 * この判定はフレームの中身（`: hb` かどうか）を一切見ない——`#read` が
 * `reader.read()` から中身を受け取ったという事実だけを使う（下の `#pump` の
 * doc）。heartbeat の実装が変わっても、閾値の意味は変わらない。
 *
 * **この値が {@link RUNNER_STREAM_RETRY_MAX_MS}（30000ms）と一致するのは
 * 傍証であって、この閾値を選んだ理由そのものではない。** Issue #274 が挙げた
 * 2つの根拠（バックオフの上限を超えること／heartbeat を複数回受けること）が
 * たまたま同じ値に落ちているだけである。`packages/core/src/sse-heartbeat.
 * test.ts` の `DEFAULT_SSE_HEARTBEAT_MS * 2 <= 30_000` という既存の歯とも
 * 整合する。
 */
const CONNECTION_HEALTHY_THRESHOLD_MS = DEFAULT_SSE_HEARTBEAT_MS * 2;

/**
 * **無音のまま固着した `/events` を切るまでの長さ**（#323）。ここも新しい
 * マジックナンバーを置かない —— {@link DEFAULT_SSE_HEARTBEAT_MS} の3倍として導く。
 *
 * ## なぜこれが要るか
 *
 * **`/events` だけが、返らない相手を見切る仕組みを1つも持っていなかった。**
 * 制御面（`hello` / `ping` / `GET /managers` …）は全部 {@link #call} を経由して
 * {@link RUNNER_CALL_DEADLINE_MS} が掛かるが、`/events` は `connect()` が
 * `void this.#pump(...)` として切り離す背景タスクの中に在り、`#stream` の
 * `await this.#fetch(...)` にも `#read` の `for(;;) await reader.read()` にも
 * 期限が無い。**解決も棄却もしない `read()` は `#pump` を丸ごと止める** ——
 * `#pump` は自分の中に再接続ループを持っているので、**そのループごと止まり、
 * バックオフは一度も回らない。**
 *
 * 名簿の生存確認（`runner-protocol.ts` の `#probe`）はこれを検出できない ——
 * あれが叩く `/health` は {@link #call} 系の**別の接続**で、そちらが答え続けて
 * いる限り `entry.alive` は動かない。**見張る対象と壊れる対象が別の接続に
 * なっている。**
 *
 * **いま無音を切っているのは、トランスポートの既定値だけである。しかも片方に
 * しか無い。**
 *
 * | 経路 | 無音を切るもの |
 * | --- | --- |
 * | TCP（`http://runner:4518`） | undici の既定 `bodyTimeout`＝300000ms（`apps/runner/src/app.ts` の `/events` の doc に実測が在る） |
 * | Unix ソケット（`unix:/run/alteroid/runner.sock`） | **無い。**{@link requestOverSocket} は素の `node:http` で、`timeout` も `res.setTimeout` も置いていない |
 *
 * TCP keepalive も当てにできない —— `index.ts` の {@link TCP_KEEPALIVE_DELAY_MS} は
 * デーモンが**受ける**側の設定で、この口（デーモンが**繋ぎに行く**側）には
 * 張っていない。そもそも Unix ソケットに TCP は無いので、OS が生死を確かめに
 * 行く経路が原理的に存在しない。
 *
 * ## これは「静かな接続を時間で切る」ではない
 *
 * `index.ts` の {@link TCP_KEEPALIVE_DELAY_MS} の doc は `server.timeout` を
 * 入れない理由として「掃除したいのは**死んだ接続**であって**静かな接続**では
 * ない——静かなことを理由に切るのは、長時間つないでおく能力を削ることになる
 * （north_star 禁止2）」と書いている。**その線はここでも守っている。**
 *
 * 違うのは**相手が黙る自由を持つかどうか**である。あちらはデーモンが受ける
 * 側の全経路が対象で、heartbeat を持たない経路が将来増えれば「イベントが
 * 来ないだけの健全な長時間接続」を切ってしまう。**こちらは `/events` ただ1本
 * で、相手（runner）は接続のたびに無条件で `startSseHeartbeat` を回す**
 * （`apps/runner/src/app.ts` の `/events`。`hello` を書いた直後、分岐無しに開始
 * する）。**＝ この経路の健全な接続は、契約として無音にならない。** だから
 * ここでの無音は「静か」ではなく「死んでいる」の観測である。
 *
 * ## なぜ3倍か
 *
 * runner は {@link DEFAULT_SSE_HEARTBEAT_MS} ごとにコメント行を書く。
 *
 * - **2倍（＝{@link CONNECTION_HEALTHY_THRESHOLD_MS} と同じ30秒）では狭い。**
 *   heartbeat が1回遅れただけの健全な接続を切る（GC・輻輳で起こりうる）
 * - **3倍なら、heartbeat が1回まるごと落ちても耐え、続けて落ちたら切る。**
 *   この閾値が名指ししている性質はそれである
 * - 副次的に {@link CONNECTION_HEALTHY_THRESHOLD_MS} より厳密に大きいので、
 *   「持続した」の判定窓が「無音」の判定窓より先に閉じる。2つの判定が競合しない
 *
 * **60000ms（＝{@link RUNNER_CALL_DEADLINE_MS} と同じ長さ）にする案は退けた。**
 * 「制御面と同じ期限を `/events` にも」と読める見た目の良さがあるが、**それは
 * 偶然の一致であって理由ではない**（{@link CONNECTION_HEALTHY_THRESHOLD_MS} の
 * doc が同じ罠について書いているのと同じ形）。しかも掛かり方が違う —— あちらは
 * **呼び出し1回の全体**に対する期限、こちらは**バイトとバイトの間隔**である。
 * 同じ数にすると、読む人がその違いを消して読む。
 *
 * **300000ms（undici の既定値）に揃える案も退けた。** 揃えると Unix ソケット側
 * だけ「既定値を写した数」になり、**なぜその数なのかがこのシステムの中から
 * 導けなくなる。**
 */
const RUNNER_STREAM_SILENCE_TIMEOUT_MS = DEFAULT_SSE_HEARTBEAT_MS * 3;

/**
 * 無音の見張りのタイマー。**`setTimeout` を `unref` して張り、取り消す口を返す。**
 *
 * `unref` は {@link defaultSleep} と同じ理由 —— 見張りは「接続が在るあいだ回る」
 * ものであって、止めたはずのデーモンの終了を引き延ばすものではない。
 */
function defaultSetTimer(ms: number, onFire: () => void): () => void {
  const timer = setTimeout(onFire, ms);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
  };
}

/** `setTimeout` を `unref` して待つ（既定の `sleepFn`）。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // 名簿側の #scheduleOpen と同じ理由: 挑み直しの待ちで、止めたはずの
    // デーモンの終了を引き延ばさない。
    timer.unref?.();
  });
}

/**
 * manager-runner への HTTP の口（roadmap M4）。
 *
 * **繋ぎに行くのはこちら（デーモン）だけである。** runner はデーモンの所在も鍵も
 * 知らない。逆向きのコールバック URL を足すと、runner の中のマネージャーがその
 * 経路でデーモンの API（＝記憶）へ届くようになる（architecture.md「非対称な可視性」）。
 */
export interface HttpRunnerOptions {
  /** `http://runner:4518` か `unix:/run/alteroid/runner.sock`。 */
  baseUrl: string;
  /**
   * 制御面の合鍵。**デーモンだけが素の値を持つ。**
   *
   * runner 側にあるのは sha256 だけなので、runner の中で走るマネージャーが
   * `/proc/1/environ` を読めたとしても、この鍵は作れない。鍵が無ければ
   * `POST /managers/:id/answers` は通らない — マネージャーが自分宛の許可確認に
   * 自分で `allow` を返す経路を塞ぐ、いちばん内側の一枚である。
   */
  token: string;
  /** 主にテスト用。既定はグローバルの `fetch`（Unix ソケットなら node:http）。 */
  fetchFn?: typeof fetch;
  /**
   * ストリームが切れたときに待つ**基準**のミリ秒（既定 1000）。
   *
   * **名前は変えていないが意味は変わっている。** 以前は毎回この値を固定で
   * 待っていたが、いまは失敗するたびに倍々に伸びる列の出発点（＝基準）で
   * あり、繋ぎ直せたらここへ戻る。上限は `retryMaxDelayMs`。
   */
  retryDelayMs?: number;
  /**
   * バックオフの上限ミリ秒（既定 30000。`packages/core` の名簿側と同じ値）。
   *
   * **回数では諦めない。** 上限は「秒間に何度も叩かない」ための頭打ちであって、
   * 挑み直しをやめる制限ではない（諦めた先に残るのは、宛先を失ったまま誰にも
   * 知らされないデーモンである）。
   */
  retryMaxDelayMs?: number;
  /**
   * 挑み直しの待ちを差し替える口。**主にテスト用**（`fetchFn` と同じ作法）。
   * 既定は `setTimeout`（`unref` 済み）で実際に待つ。
   */
  sleepFn?: (ms: number) => Promise<void>;
  /**
   * 現在時刻を差し替える口。**主にテスト用**（`sleepFn` / `fetchFn` と同じ
   * 位置づけ——外から差し替えられる依存であって、本体に「テスト中か」の
   * 分岐は作らない）。既定は `Date.now`。
   *
   * 接続が {@link CONNECTION_HEALTHY_THRESHOLD_MS} だけ持続したかを測るのに使う
   * （`#pump` の doc）。実時間を待たずに決定的なテストを書くための口であり、
   * `vi.useFakeTimers()` は使わない（このファイルの既存の作法を踏襲する）。
   */
  nowFn?: () => number;
  /**
   * `/events` が無音のまま何 ms 続いたら切るか（既定
   * {@link RUNNER_STREAM_SILENCE_TIMEOUT_MS}）。**主にテスト用。**
   *
   * **運用でここを縮めないこと。** 縮めると heartbeat の遅れだけで健全な接続を
   * 切り始め、切るたびに runner が `hello` を書き直して `#reattach` が走る
   * （`apps/runner/src/app.ts` の `/events` の doc）。
   */
  silenceTimeoutMs?: number;
  /**
   * 無音の見張りのタイマーを差し替える口。**主にテスト用**（`sleepFn` /
   * `nowFn` と同じ位置づけ——外から差し替えられる依存であって、本体に
   * 「テスト中か」の分岐は作らない）。既定は {@link defaultSetTimer}。
   *
   * **`sleepFn` を流用しなかったのは、取り消せる必要があるからである。**
   * `sleepFn` が返すのは解決を待つだけの Promise で、途中でやめる口が無い ——
   * 読むたびに新しい `sleepFn` を張る形にすると、バイトが来るたびに取り消せない
   * タイマーが1つ積まれる。ここは `ms` と発火時の処理を受け取り、**取り消す
   * 関数を返す**形にしてある。
   *
   * `vi.useFakeTimers()` は使わない（このファイルの既存の作法を踏襲する。
   * `nowFn` の doc）。
   */
  setTimerFn?: (ms: number, onFire: () => void) => () => void;
  /**
   * 制御面の応答を待つ期限（既定 {@link RUNNER_CALL_DEADLINE_MS}）。**主にテスト用。**
   *
   * 運用でここを縮めないこと。**期限は「返らない」を掴むためのもので、「遅い」を
   * 打ち切るためのものではない**（`deadline.ts` の doc）。
   */
  deadlineMs?: number;
  /**
   * 期限が切れたこと（と、そのあと遅れて返ってきたこと）の受け口。
   *
   * **ここを繋がないと「不明」が誰にも届かない。** デーモンは日誌へ落とす
   * （`index.ts`）。runner-client 自身は日誌を知らない — 誰に知らせるかを選ぶのは
   * 上の層の仕事である。
   */
  onUnknown?: (report: RunnerUnknownReport) => void;
  /**
   * **解釈できずに捨てたフレーム**の受け口（{@link RunnerDroppedEventReport}）。
   *
   * **ここを繋がないと、捨てたことが誰にも届かない。** `onUnknown` と同じで、
   * runner-client 自身は日誌を知らない——誰に知らせるかを選ぶのは上の層である。
   */
  onDroppedEvent?: (report: RunnerDroppedEventReport) => void;
}

/**
 * 期限切れの宛先がマネージャー1本を指しているか（指しているならその id）。
 *
 * **日誌へ載せるかどうかの分かれ目である。** マネージャー宛の操作（`send` /
 * `stop` / `answer` / `resume` / `transcript`）の不明は、クローンの委譲そのものの
 * 話なので日誌へ残す。器の生死や設定の押し込み（`/health` / `/credentials` /
 * `/profile` / `GET /managers`）は**既に別の経路が持っている** — 名簿の生存判定と
 * `GET /runners`、`Pool.abort` の `sessionGone === undefined`（「止まったかは未確認」）
 * である。そこを日誌へも流すと**同じ契約が2つになる**うえ、黙って死んだ器へ挑み
 * 直すたびに1行増えて、`journal_read` の窓から本物の記録を押し出す。
 */
export function managerIdOfRunnerPath(path: string): string | undefined {
  const match = /^\/managers\/([^/?]+)/.exec(path);
  if (match?.[1] === undefined) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // 壊れた符号化でも宛先の判定だけはできる（素のまま返す）
    return match[1];
  }
}

/**
 * 「不明」を日誌の1行にする。**この行を読む人はこの PR を読んでいない。**
 *
 * だから**言えること／言えないことを行の中に書く。** 期限切れは「失敗した」でも
 * 「runner が死んだ」でもないので、そう読めない文にしないと、読んだ側が勝手に
 * 断定へ畳む（再送すれば二重に実行され、引き取らせれば同じマネージャーが2台で
 * 走る）。
 *
 * **後から解けたことも同じ形で残す。** 「不明」だけが残って解決が残らないと、
 * 日誌を辿った人は永久に不明のままだと読む。
 */
/** `type` として載せてよい長さの上限。**自由文を持ち込ませない。** */
const DROPPED_TYPE_LIMIT = 64;

/**
 * 捨てたフレームから `type` だけを取り出す。**本文は取らない。**
 *
 * JSON として読めていれば `type` は文字列であることが多い（`runnerEventSchema` は
 * `type` の判別共用体である）。**読めなければ付けない** —— 「取れなかった」を
 * `'(不明)'` のような値にすると、それが `type` の1つとして数えられてしまう。
 */
function typeOf(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = (raw as { type?: unknown }).type;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.replaceAll(/\s+/gu, ' ').slice(0, DROPPED_TYPE_LIMIT);
}

/**
 * 捨てたフレームの報告を1行に畳む。**本文は載らない。**
 *
 * `describeRunnerUnknown` と同じ役で、**日誌へ出す文字列を作る場所を1つにする**
 * ためにここに置く（呼ぶのは `index.ts`）。
 */
export function describeRunnerDropped(report: RunnerDroppedEventReport): string {
  if (report.phase === 'closed') {
    const detail = report.dropped.map(({ key, count }) => `${key}×${count}`).join(' / ');
    return `runner から降りてきた出来事を解釈できずに捨てた（この接続の合計）: ${detail}`;
  }
  const what =
    report.reason === 'unparsable' ? 'JSON として読めなかった' : 'こちらのスキーマに合わなかった';
  const type = report.type === undefined ? '（type も読めない）' : `type=${report.type}`;
  return `runner から降りてきた出来事を解釈できずに捨てた（初出）: ${what} ${type} bytes=${report.bytes}`;
}

export function describeRunnerUnknown(report: RunnerUnknownReport): string {
  const managerId = managerIdOfRunnerPath(report.path);
  // 委譲1本の話なら id を前置する。日誌の他の行（`manager.ts` の `#journal`）と
  // 同じ形にしておくと、マネージャーの記録を追う grep が1本で済む。
  const head = managerId === undefined ? '' : `[${managerId}] `;
  const where = `${report.method} ${report.path}`;
  const waited = `${String(report.waitedMs)}ms`;
  if (report.phase === 'late') {
    return report.ok === true
      ? `${head}runner の ${where} が、期限（${waited}）を過ぎてから成功で返った。` +
          '**不明は解けた**（あの操作は届いていて、応答だけが遅れていた）。'
      : `${head}runner の ${where} が、期限（${waited}）を過ぎてから失敗で返った: ${String(report.error)}。` +
          '**不明は解けた**（届いたかどうかはこの失敗の中身で決まる）。';
  }
  return (
    `${head}runner の ${where} が ${waited} 以内に応答を返さなかった。**言えるのはそれだけである** — ` +
    '届いたかどうかは分かっていない。失敗とは限らないので同じ操作を送り直すと二重に実行され、' +
    'runner が死んだとも限らないので別の runner へ引き取らせると同じマネージャーが2台で走る。' +
    '待つのをやめただけで、runner 側の実行は止めていない（遅れて返ってきたらこの日誌に続きが載る）。'
  );
}

/** `unix:/path/to.sock` を取り出す（無ければ TCP）。 */
function socketPathOf(baseUrl: string): string | null {
  const match = /^unix:(?:\/\/)?(.+)$/.exec(baseUrl);
  return match?.[1] ?? null;
}

/** 接続して runner_id を確かめてから使う（宛先を台帳に残すため）。 */
export async function createHttpRunner(options: HttpRunnerOptions): Promise<RunnerClient> {
  const client = new HttpRunner(options);
  await client.hello();
  return client;
}

interface HealthBody {
  runnerId?: unknown;
  instanceId?: unknown;
  workspacePath?: unknown;
  credentials?: unknown;
  profile?: unknown;
  managers?: unknown;
  resources?: unknown;
  revision?: unknown;
  /**
   * まだデーモンへ送り出せていない出来事の件数（#358）。**この欄がここに
   * 無かったせいで、runner 側が正しい値を返しても読まれずに落ちていた**
   * （`resources()` は `body.managers` と同じく `/health` 直下から拾う——
   * `body.resources` の中身ではない。`apps/runner/src/app.ts` の `/health`
   * が実際に置く場所に合わせてある）。
   *
   * **`identity()` もここから同じ欄を拾う（#358 案b）。** 新しい欄は足して
   * いない——`resources()` が既に読んでいたものを、heartbeat が定期的に叩く
   * `identity()` からも読めるようにしただけである。
   */
  pendingEvents?: unknown;
  /** 未送出のうち、いちばん古いものが積まれた時刻（#358）。同上の理由で足す。 */
  oldestPendingAt?: unknown;
}

/**
 * `/health` の `revision` を `RunnerRevisionReport` へ畳む。
 *
 * **形が壊れていても `unknown` に倒す。** ネットワーク越しの入力（runner の版・
 * 改造された応答）を信用しない側なので、`.safeParse` に落ちても投げない —
 * 「訊けたが分からない」と同じ扱いにする。`revision` フィールド自体が無い
 * 古い runner（この機能より前の版）も同じ経路を通る。
 */
function revisionReportOf(value: unknown): RunnerRevisionReport {
  const parsed = buildRevisionSchema.safeParse(value);
  if (!parsed.success) return { status: 'unknown' };
  return reportRunnerRevision(parsed.data);
}

/** 指紋の配列だけを取り出す（値は runner も返さないし、こちらも持たない）。 */
function fingerprintsOf(value: unknown): RunnerCredentialFingerprint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = runnerCredentialFingerprintSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * `failure.cause` から、1行に畳んだ本文と `code`（無ければ空文字）を取り出す。
 * `cause` が無い／`failure` が `Error` でなければ `undefined`。
 *
 * **`String(failure)` は `cause` を落とす**——`Error.prototype.toString()`
 * （`TypeError` もこれを継承する）は `name: message` しか返さない。Node 22 の
 * 素の `fetch`（内蔵 undici）は streaming 中の切断を `TypeError: terminated`
 * として投げ、**本当の理由は `cause` に入る**（実測で確認した2系統: `cause`
 * が `SocketError`／`cause.code === 'UND_ERR_SOCKET'` なら下の TCP が本当に
 * 切れた、`cause` が `BodyTimeoutError`／`cause.code === 'UND_ERR_BODY_TIMEOUT'`
 * なら undici 既定の無通信タイムアウト（既定 300000ms）が発火した）。**この2つは
 * `String(err)` では区別できず、区別できるのは `cause.code` だけ。**
 *
 * **`reasonOf`（`packages/core/src/dropped-record.ts`）は「畳む」部分だけ借りて、
 * `code` の取り出しはここに置く。** `reasonOf` 自体は変えない —— あちらは
 * 「ドライバの例外がクエリのパラメータを裏口から持ち込む経路から記録の自由文を
 * 守る」契約を持ち、`dropped-record.ts` 経由の他の呼び出し元（日誌・記録の
 * 記録失敗）がその契約に依存している。ここで足したいのは undici の固定語彙
 * （`cause.code`）であって、契約の中身が違うので、共有関数を広げず専用の
 * 畳み方をここに置く。
 *
 * `cause` は型定義上 `unknown`。無い／`Error` でない／入れ子になっている、
 * どれでも例外を投げない（`cause.cause` へは踏み込まない——1段目だけで十分）。
 * `code` の判定はここ1か所に置く（ログの付記・間引きの見分け、両方がここを通す）。
 */
function causeInfoOf(failure: unknown): { text: string; code: string } | undefined {
  if (!(failure instanceof Error) || failure.cause === undefined) return undefined;
  const cause = failure.cause;
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
      ? cause.code
      : '';
  return { text: reasonOf(cause), code };
}

/** ログ本文へ足す付記（`cause=... code=...`。`cause` が無ければ空文字）。 */
function causeSuffixOf(info: ReturnType<typeof causeInfoOf>): string {
  if (info === undefined) return '';
  return ` cause=${info.text}${info.code === '' ? '' : ` code=${info.code}`}`;
}

class HttpRunner implements RunnerClient {
  runnerId = 'runner-primary';
  workspacePath = '';
  /**
   * `hello()` が読んだ版。**`runnerId` / `workspacePath` と同じ応答から拾う
   * だけで、新しい往復は増やさない。** `body.revision` フィールド自体が無い
   * （古い runner）間は `undefined` のまま——`RunnerClient.revision` の doc
   * 参照。
   */
  revision?: RunnerRevisionReport;
  /**
   * `hello()` が読んだ「いま応えているプロセス」。**`revision` と同じ応答から拾う
   * だけで、新しい往復は増やさない**（roadmap M5 PR4）。
   *
   * 接続の瞬間から名簿がこの値を持つので、直後に走る引き取りが**判定材料を持たない
   * まま動く窓**が無くなる（`RunnerClient.instanceId` の doc）。名乗らない runner では
   * `undefined` のまま。
   */
  instanceId?: string;
  readonly #baseUrl: string;
  /**
   * ログの名乗りに出す URL。**`options.baseUrl` の原文**——`#baseUrl` とは
   * わざと別に持つ。
   *
   * `#baseUrl` は unix ソケットのとき、コンストラクタで `'http://runner'`
   * （ホスト名が使われないダミー）へ書き換えられる。そのままログへ出すと、
   * unix ソケットで繋ぐ runner がすべて同じ文字列で名乗ることになり、
   * どの器の行かを分ける識別子として機能しない。**識別子には常に本物の
   * 宛先を出す**——`index.ts` の `runnerSeeds()` が `label: url` に積むのも
   * 同じ原文（`parseRunnerUrls` が返す、空白と重複だけを落として書かれた
   * まま使う値）なので、ここを揃えておくと同じ runner を指す行が
   * `onSwap` / `onLost` の行とこのファイルの行とで同じ文字列になる。
   */
  readonly #displayBaseUrl: string;
  readonly #socketPath: string | null;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #sleepFn: (ms: number) => Promise<void>;
  readonly #nowFn: () => number;
  readonly #deadlineMs: number;
  readonly #silenceTimeoutMs: number;
  readonly #setTimerFn: (ms: number, onFire: () => void) => () => void;
  readonly #onUnknown: ((report: RunnerUnknownReport) => void) | undefined;
  readonly #onDroppedEvent: ((report: RunnerDroppedEventReport) => void) | undefined;
  #controller: AbortController | null = null;
  #closed = false;
  /** 次に失敗したときに待つ長さ。失敗のたびに倍々に伸び、成功で基準へ戻る。 */
  #nextDelayMs: number;
  /** 直前の接続が失敗していて、まだ繋ぎ直せていないか。 */
  #backingOff = false;
  /**
   * 直前に stderr へ書いた待ち時間。同じ値のときは書き直さない。
   *
   * **⚠️ この dedup は「一度も健全にならない」区間の可視性を下げる。** 待ち幅が
   * 上限（30000ms）へ張り付いたまま失敗し続けると、以後は最初の1行しか
   * 出ない——同じ間隔で切れ続ける沈黙と「直った」（`繋ぎ直せた` の行が出る）
   * が、ログの不在だけでは見分けが付かない。**このファイルを次に触るときは
   * この行で立ち止まること**（#308）。この PR（#274）では直していない。
   */
  #lastLoggedDelayMs: number | null = null;
  /**
   * 直前に stderr へ書いた cause の見分け（{@link causeInfoOf} が返す `code`）。
   *
   * **待ち時間の間引きに横並びで効かせる。** 待ち時間だけを見ていると、
   * バックオフが頭打ち（`retryMaxMs`）で張り付いたまま失敗が続く間、
   * `cause.code` が別物（例: `UND_ERR_SOCKET` → `UND_ERR_BODY_TIMEOUT`）へ
   * 切り替わっても書かれない——だが本番でどちらが起きているかを見分けたい
   * のがこの付記そのものの目的なので、張り付いた区間こそ見えてほしい。
   * `code` が無い失敗どうしは区別しない（{@link causeInfoOf} の doc）ので、
   * この項目が無くても既存の間引き（待ち時間ベース）の挙動は変わらない。
   */
  #lastLoggedCauseCode = '';
  /**
   * 直前の接続で受け取れた、いちばん新しい SSE フレームの `id`（#275）。
   *
   * **`RunnerEvent`（JSON の中身）には一切載らない。** runner 側
   * （`apps/runner/src/app.ts` の `Outbox`）が `writeSSE` の `id` フィールド
   * にだけ乗せる連番で、ここではその値をフレームから直に読む——
   * `runnerEventSchema` を経由しない、配送層だけで完結する値である。
   *
   * **1バイトも受け取れていなければ `null`。** 次に `/events` を開くとき
   * （{@link #stream}）、`null` でなければ `Last-Event-ID` ヘッダへ乗せる。
   * runner はそれより新しく「渡したはず」だった分を控え（`Outbox.sentSince`）
   * から読み返す——`await stream.writeSSE()` が例外を投げずに正常返却した
   * のに相手には届いていなかった1件（無音切断。Issue #275 本文）を拾う
   * ための唯一の入口である。
   *
   * **runner が入れ替わっても壊れない。** 新しい runner の連番も1から
   * 数え直す（`Outbox` の doc）ので、古い（高い）値を申告しても
   * `sentSince` は単に何も返さない——「復元できない」へ倒れるだけで、
   * 今後配られる分を取りこぼす方向には効かない。だから instanceId で
   * 突き合わせて破棄する、といった手当ては意図的に入れていない。
   */
  #lastEventId: number | null = null;
  /**
   * `hello()` が `/health` から実際に `runnerId` を受け取ったか。
   *
   * **`this.runnerId` の既定値（`'runner-primary'`）は、一度も接続できて
   * いない段階から入っている。** この既定値をそのままログへ出すと、取れて
   * いない値が取れた値の顔をして出る（AGENTS.md「取れない軸に 0 の行を
   * 作る」と同じ形）。だから「聞けたか」は `runnerId` そのものではなく、
   * この別のフラグで持つ——`hello()` が空文字でない `body.runnerId` を
   * 読めたときだけ立てる。
   *
   * **`#describeSelf`（`#pump` の2行）はこの private フィールドを直に読む。**
   * {@link runnerIdKnown} は同じ値を `HttpRunner` の外（`onSwap` / `onLost` /
   * `GET /runners`）から読める形に引き上げた口で、実装は増やしていない（#330）。
   */
  #runnerIdKnown = false;

  /**
   * {@link #runnerIdKnown} を `RunnerClient` の外から読める形にした口（#330）。
   *
   * `onSwap` / `onLost` / `GET /runners`（`packages/core/src/runner-protocol.ts`
   * の `heardRunnerIdOf`）はこれを見て、聞けていない `runnerId` を出さない。
   * `#pump` が書く2行（{@link #describeSelf}）が#274/#309で既に持っていた
   * 判定を、他の出口からも使える形にしただけで、判定そのもの（`hello()` が
   * 空文字でない `body.runnerId` を読めたときだけ立てる）は変えていない。
   */
  get runnerIdKnown(): boolean {
    return this.#runnerIdKnown;
  }

  /**
   * `hello()` が `/health` から実際に `workspacePath` を受け取ったか（#389）。
   *
   * **`this.workspacePath` の既定値（`''`）は、一度も接続できていない段階から
   * 入っている。** `runnerId` の既定値 `'runner-primary'` と違って*それらしい
   * 名前*ではないぶん、「空の作業ディレクトリ」と「まだ聞けていない」が同じ
   * 見た目になる——`#runnerIdKnown` と同じ理由で、この別のフラグで持つ。
   * **判定は値（`=== ''`）で代用しない**——本当に空文字を名乗る runner と、
   * 一度も聞けていない runner を区別するのがこのフラグの役目そのものである。
   * `hello()` が `body.workspacePath` を文字列として読めたときだけ立てる
   * （空文字列であっても、型が合っていれば「聞けた」——`runnerId` は空文字を
   * 「聞けていない」として弾くが、`workspacePath` は弾かない。理由は
   * {@link hello} 内の分岐に書いてある）。
   */
  #workspacePathKnown = false;

  /**
   * {@link #workspacePathKnown} を `RunnerClient` の外から読める形にした口
   * （#389。{@link runnerIdKnown} と同じ作法）。
   *
   * `GET /runners`（`packages/core/src/runner-protocol.ts` の
   * `heardWorkspacePathOf`）はこれを見て、聞けていない `workspacePath` を
   * 出さない。`onSwap` / `onLost` は `workspacePath` をそもそも運ばないので
   * （`RunnerRegistryOptions` の型に欄が無い）、この口を読むのは `entries()`
   * だけである——`runnerId` の3出口とはここが違う。
   */
  get workspacePathKnown(): boolean {
    return this.#workspacePathKnown;
  }

  constructor(options: HttpRunnerOptions) {
    this.#socketPath = socketPathOf(options.baseUrl);
    this.#displayBaseUrl = options.baseUrl;
    // ソケットのときも URL の形は要る（ホスト名は使われない）
    this.#baseUrl =
      this.#socketPath === null ? options.baseUrl.replace(/\/$/, '') : 'http://runner';
    this.#token = options.token;
    this.#fetch = options.fetchFn ?? ((input, init) => this.#send(input, init));
    this.#retryBaseMs = options.retryDelayMs ?? RUNNER_STREAM_RETRY_BASE_MS;
    this.#retryMaxMs = options.retryMaxDelayMs ?? RUNNER_STREAM_RETRY_MAX_MS;
    this.#sleepFn = options.sleepFn ?? defaultSleep;
    this.#nowFn = options.nowFn ?? Date.now;
    this.#nextDelayMs = this.#retryBaseMs;
    this.#deadlineMs = options.deadlineMs ?? RUNNER_CALL_DEADLINE_MS;
    this.#silenceTimeoutMs = options.silenceTimeoutMs ?? RUNNER_STREAM_SILENCE_TIMEOUT_MS;
    this.#setTimerFn = options.setTimerFn ?? defaultSetTimer;
    this.#onUnknown = options.onUnknown;
    this.#onDroppedEvent = options.onDroppedEvent;
  }

  /**
   * Unix ソケット越しにも喋れる送信口。
   *
   * グローバルの `fetch` はソケットへ繋げないので、ソケットのときだけ node:http を
   * 使う。**ソケットにするのは、マネージャーと同じ器の中に TCP の口を開けない
   * ため**である（開いていれば `curl 127.0.0.1` の宛先になる）。
   */
  #send(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (this.#socketPath === null) return fetch(input, init);
    const url = new URL(typeof input === 'string' ? input : input.toString());
    return requestOverSocket(this.#socketPath, url, init ?? {});
  }

  /** 名乗りを聞く。ここで得た runner_id が `manager_id → runner_id` の宛先になる。 */
  async hello(): Promise<void> {
    const response = await this.#call('GET', '/health');
    const body = (await response.json()) as HealthBody;
    if (typeof body.runnerId === 'string' && body.runnerId.length > 0) {
      this.runnerId = body.runnerId;
      this.#runnerIdKnown = true;
    }
    // **空文字を「聞けていない」とは弾かない。** `runnerId` は空文字を弾く
    // （空文字の宛先名はそもそも意味を持たない）が、`workspacePath` は
    // 本当に空の作業ディレクトリを名乗る runner がありうる——弾くと、その
    // 相手と「一度も聞けていない」相手が `''` という同じ値に潰れて区別が
    // 消える。だからここは型（`typeof === 'string'`）だけを見る。
    if (typeof body.workspacePath === 'string') {
      this.workspacePath = body.workspacePath;
      this.#workspacePathKnown = true;
    }
    // **`revision` フィールド自体が無ければ触らない**（`undefined` のまま）。
    // 古い runner（この機能より前の版）は「まだ何も言っていない」として扱い、
    // 名簿は `unheard` のまま保つ——`revisionReportOf(undefined)` を無条件で
    // 呼ぶと、フィールド不在の runner まで `unknown` へ倒れてしまい、
    // 「訊けたが分からない」と「そもそも報告する口が無い」が区別できなくなる。
    if (body.revision !== undefined) {
      this.revision = revisionReportOf(body.revision);
    }
    // **同じ応答から `instanceId` も拾う。** 空文字は「名乗っていない」と同じ扱いに
    // する（名乗らない runner との区別が無いので、値として持たない）。
    if (typeof body.instanceId === 'string' && body.instanceId.length > 0) {
      this.instanceId = body.instanceId;
    }
  }

  /**
   * 生きているかを聞く。**既存の `/health` を叩くだけ**で、新しい口は足さない。
   *
   * `hello()` と違って**名乗りの中身は取らない**。器が入れ替わって別の runner_id を
   * 返してきたとき、それは「同じ宛先が生きている」ではなく「走っていた仕事ごと
   * 入れ替わった」であり、ここで黙って runnerId を書き換えると台帳の鎖
   * （`manager_id → runner_id`）が音もなく繋ぎ変わる。ここで見るのは生死だけである。
   *
   * 本文は読み捨てる（読まずに放ると、10秒ごとに繋ぎが積み上がる）。
   */
  async ping(options?: { signal?: AbortSignal }): Promise<void> {
    const response = await this.#call('GET', '/health', undefined, options?.signal);
    await response.text().catch(() => '');
  }

  /**
   * 名乗りの中身を**読むが採らない**（roadmap M5 PR4 の判定材料）。
   *
   * 叩く先は `ping()` と同じ `GET /health` で、新しい口は足していない。違うのは
   * 本文を読むことだけである。**それでも `this.runnerId` / `this.workspacePath` は
   * 書き換えない** — 書き換えれば台帳の鎖（`manager_id → runner_id`）が音もなく
   * 繋ぎ変わる（`ping()` の項に書いてある元の理由）。ここが返すのは判定の材料で
   * あって、採用する値ではない。
   *
   * **`instanceId` を返さない runner とも繋がる。** そのときは `undefined` のままで、
   * 名簿は入れ替えを判定しない（「入れ替わっていない」とは読まない）。
   *
   * **`revision` は常に返す（`known` か `unknown`）。** `instanceId` と違って
   * 省略できる情報ではない ——「応答は返ってきたのに版の状態が分からない」を
   * 作らないことで、名簿の側は「一度も名乗りを聞けていない」（`unheard`）と
   * 混同せずに済む。
   *
   * **`pendingEvents` / `oldestPendingAt` も同じ応答から拾う（#358 案b）。**
   * `resources()` が読んでいるのとまったく同じ2欄で、**検証の作法も同じにする**
   * ——`runnerPlacementResourcesSchema.shape` を1つずつ `safeParse` する。まとめて
   * 弾くと、この2欄の形が崩れただけで `runnerId` / `instanceId` / `revision` まで
   * 道連れになる（`resources()` の doc「材料は1つずつ検証する」と同じ理由）。
   * 宣言していない形・古い runner（欄自体が無い）はここで静かに省かれる——
   * 「取れなかった」であって「0」ではない。
   */
  async identity(options?: { signal?: AbortSignal }): Promise<
    | {
        runnerId?: string;
        instanceId?: string;
        revision: RunnerRevisionReport;
        pendingEvents?: number;
        oldestPendingAt?: string;
      }
    | undefined
  > {
    const response = await this.#call('GET', '/health', undefined, options?.signal);
    const body = (await response.json()) as HealthBody;
    const pendingEvents = runnerPlacementResourcesSchema.shape.pendingEvents.safeParse(
      body.pendingEvents,
    );
    const oldestPendingAt = runnerPlacementResourcesSchema.shape.oldestPendingAt.safeParse(
      body.oldestPendingAt,
    );
    return {
      ...(typeof body.runnerId === 'string' && body.runnerId.length > 0
        ? { runnerId: body.runnerId }
        : {}),
      ...(typeof body.instanceId === 'string' && body.instanceId.length > 0
        ? { instanceId: body.instanceId }
        : {}),
      revision: revisionReportOf(body.revision),
      ...(pendingEvents.success && pendingEvents.data !== undefined
        ? { pendingEvents: pendingEvents.data }
        : {}),
      ...(oldestPendingAt.success && oldestPendingAt.data !== undefined
        ? { oldestPendingAt: oldestPendingAt.data }
        : {}),
    };
  }
  /**
   * 配置の材料を渡す。**既存の `/health` を叩くだけ**で、新しい口は足さない
   * （`credentials()` / `profile()` と同じ作法である）。
   *
   * `ping()` と違って本文を読むが、**採るのは資源だけである。** `runnerId` /
   * `workspacePath` はここで採らない — 器が入れ替わったときに台帳の鎖
   * （`manager_id → runner_id`）が黙って繋ぎ変わるのを避けるためで、`ping()` に
   * 書いてある理由と同じである。だから資源を `ping()` に相乗りさせず、別の口にした。
   *
   * **宣言していない形は捨てる**（zod）。`resources` を返さない古い runner は
   * `managers` だけを名乗り、**それで不利にはならない**（埋めるのは配置側である）。
   * 材料は1つずつ検証する — まとめて弾くと、`cpu` の形が崩れただけで `managers` まで
   * 落ち、資源を報告できる器が「何も報告しない器」に見える。
   */
  async resources(options?: { signal?: AbortSignal }): Promise<RunnerPlacementResources> {
    const response = await this.#call('GET', '/health', undefined, options?.signal);
    const body = (await response.json()) as HealthBody;
    const parsed = runnerExecutionResourcesSchema.safeParse(body.resources ?? {});
    const managers = runnerPlacementResourcesSchema.shape.managers.safeParse(body.managers);
    // **`managers` と同じ扱い**（#358）——`/health` 直下から1つずつ検証する。
    // まとめて弾くと、`resources` の形が崩れただけで `pendingEvents` /
    // `oldestPendingAt` まで落ち、値を出している runner が「何も報告しない器」
    // に見える。
    const pendingEvents = runnerPlacementResourcesSchema.shape.pendingEvents.safeParse(
      body.pendingEvents,
    );
    const oldestPendingAt = runnerPlacementResourcesSchema.shape.oldestPendingAt.safeParse(
      body.oldestPendingAt,
    );
    return {
      ...(parsed.success ? parsed.data : {}),
      ...(managers.success && managers.data !== undefined ? { managers: managers.data } : {}),
      ...(pendingEvents.success && pendingEvents.data !== undefined
        ? { pendingEvents: pendingEvents.data }
        : {}),
      ...(oldestPendingAt.success && oldestPendingAt.data !== undefined
        ? { oldestPendingAt: oldestPendingAt.data }
        : {}),
    };
  }

  /**
   * イベントの受け取り。切れたら繋ぎ直す。
   *
   * **繋がっていない間の出来事は runner 側に溜まる**（Outbox）。ここで諦めると、
   * 誰も答えられない確認が runner に残り、マネージャーが永久に止まる。
   */
  async connect(onEvent: (event: RunnerEvent) => void): Promise<void> {
    void this.#pump(onEvent);
  }

  /**
   * `#pump` が書く2行が名乗る宛先。**`runner (<url>[ / <runnerId>])` の形**
   * ——`index.ts` の `onSwap` / `onLost` が書く行と同じ組み立てである。
   *
   * **URL は常に本物を出す**（{@link #displayBaseUrl} の doc）。**`runnerId` は
   * `/health` から実際に受け取れたとき（{@link #runnerIdKnown}）だけ出す**——
   * 受け取れていなければ `this.runnerId` は一度も接続できていない段階からの
   * 既定値 `'runner-primary'` なので、それをそのまま出すと取れていない値が
   * 取れた値の顔をして出る。
   *
   * **なぜこの識別子が要るか（#274）。** 本番には runner が複数台あり、
   * それぞれ独立した stream と独立した backoff 状態を持つ。この2行
   * （切断・再接続）が runner を名乗らないと、`16000ms → 4000ms` のような
   * 待ちの下降が「1台でリセットが起きた証拠」なのか「単に別の台の行」
   * なのかが、ログからは判定できない。同時刻に並ぶ2行が「2台の同時
   * タイムアウト」なのか「1台の二重記録」なのかも同様に分けられない。
   * この PR（#309）が売っている契約（接続が持続してからリセットする）は
   * runner ごとに成立する条件なので、ログも runner ごとに読めなければ
   * 本番でその契約が踏めているかを検証できない。
   */
  #describeSelf(): string {
    return `runner (${this.#displayBaseUrl}${this.#runnerIdKnown ? ` / ${this.runnerId}` : ''})`;
  }

  /**
   * 切れたら挑み直す。**間隔は固定ではなく、失敗が続くほど倍々に伸びて
   * `retryMaxMs` で頭打ちになる**（`packages/core` の名簿側の再接続と同じ形）。
   *
   * **リセットの契機は「接続が {@link CONNECTION_HEALTHY_THRESHOLD_MS} だけ
   * 持続したうえで、相手からバイトが届いた」時点である**（#274）。
   *
   * **なぜ「繋がった時点」ではないか。** 以前の doc の意図はいまも生きている
   * ——「繋がった」（`#stream()` が応答を受け取った直後）でリセットすると、
   * 開いた直後に毎回すぐ死ぬ相手を相手にしたとき失敗のたびに基準へ戻って
   * しまい、指数バックオフが一度も進まない（`packages/core` の `#open` は
   * まさに「繋がった」時点でリセットしており、ここではその弱さを引き継がない）。
   * **開いてすぐ壊れる接続は `CONNECTION_HEALTHY_THRESHOLD_MS` に届かないので、
   * バックオフは意図どおり登り続ける。**
   *
   * **なぜ「一度でも出来事が届いたら」ではないか。** runner は `/events` を
   * 開いた直後に、無条件で `hello` を書く（`apps/runner/src/app.ts`、
   * `for (;;)` ループに入る前）。だから「何か届いた」は「繋がった」とほぼ
   * 同義であり、上と同じ問題をそのまま作り直す。**この条件は一度提案され、
   * `hello` の現物を読んで撤回された**——同じ道を二度通らないようにここへ
   * 残す。
   *
   * **なぜ「経過時間だけ」ではないか。** runner の event loop が詰まって
   * ソケットだけ開いている場合、バイトは1つも来ないのに接続は undici の
   * `bodyTimeout`（既定 300000ms）まで生き延びる。**時間が経ったことは、
   * 相手が生きている証拠にならない。証拠は相手が何かを寄越したことである。**
   * 純粋な経過時間だけでリセットすると、その死んだ接続を「繋ぎ直せた」と
   * 書いてしまう——「たまたま切れなかった」を「健全だった」と読む嘘の観測が
   * 入る。**だから判定は「閾値を超えた後に、`reader.read()` が中身を返した
   * 瞬間」であり、`#read` はフレームの中身（`data:` かコメント行かなど）を
   * 一切見ない。** heartbeat の実装が変わっても、この判定は変わらない
   * （`CONNECTION_HEALTHY_THRESHOLD_MS` の doc を参照）。
   *
   * この「持続した」判定と、失敗そのもの（例外が投げられたか）は別の軸である
   * ——持続した接続がその後に例外で終わっても、持続した事実は消えない
   * （次のバックオフは基準から始まる）。
   *
   * ログは**初回と、待ち時間が変わったときだけ**書く（同じ行を毎回吐かない）。
   * 加えて、**「繋ぎ直せた」はリセットと同じ条件（持続した）で書く** ——
   * 繋がるたびに書くと「繋がった」と「回復した」が同じ記号に化ける。
   *
   * **書く時点は「健全と判定した瞬間」であり、「接続が終わった後」ではない。**
   * 持続した接続はそのまま生き続けることが多い——定常状態では `#stream()` が
   * 何時間も終わらない。終了を待って書く形だと、「繋ぎ直せた」は**次に接続が
   * 切れたときまで出ず、しかも直後の「切れました」とセットでしか読めない**。
   * 回復が過去形でしか報告されず、#274 がいちばん見たい場面（繋がったまま
   * 長く生きている接続）でこの行が出ない。**だから `markHealthy`（下の
   * `#stream` へ渡すコールバック）自身の中で、健全と判定した瞬間に書く。**
   * これで「出ないことは一度も回復していないことを意味する」が、接続がまだ
   * 生きている間も含めて成立する。
   *
   * `markHealthy` は同じ接続の中で複数回呼ばれうる（冪等——`#stream` の doc）。
   * ここでは `#backingOff` を見てから倒す形にしているので、2回目以降の
   * 呼び出しでは `#backingOff` が既に `false` になっており、**1接続につき
   * 最大1行に保たれる。**
   */
  async #pump(onEvent: (event: RunnerEvent) => void): Promise<void> {
    while (!this.#closed) {
      let failed = false;
      let failure: unknown;
      let healthy = false;
      try {
        await this.#stream(onEvent, () => {
          healthy = true;
          // **健全と判定した瞬間に書く。** `#stream()` がまだ終わっていなくても
          // （＝接続がまだ生きていても）ここへ来る——`#pump` の doc を参照。
          // **stdout へ書く。** 回復は正常な出来事なので、`tokenRotationStream`
          // の doc が確定させた「正常は stdout・異常は stderr」の割り当てに
          // 従う（#420）——規則そのものはここでは論じ直さない。
          if (this.#backingOff) {
            process.stdout.write(`alteroidd: ${this.#describeSelf()} のストリームに繋ぎ直せた\n`);
            this.#backingOff = false;
          }
        });
      } catch (error) {
        if (this.#closed) return;
        failed = true;
        failure = error;
      }
      if (this.#closed) return;

      const waitMs = healthy ? this.#retryBaseMs : this.#nextDelayMs;

      if (failed) {
        this.#backingOff = true;
        // **ログが書けないことを理由に再接続をやめない**（#323）。ここは
        // `#stream` を包む `catch` の**外側**なので、投げれば `#pump` ごと死ぬ
        // ——そして死ねば、この runner へ二度と繋ぎ直されない（下の
        // `#neverEscapes` の doc）。`process.stderr.write` は宛先が壊れていれば
        // 投げうる（`ERR_STREAM_DESTROYED` / EPIPE）。
        this.#neverEscapes(() => {
          const causeInfo = causeInfoOf(failure);
          const causeCode = causeInfo?.code ?? '';
          if (this.#lastLoggedDelayMs !== waitMs || this.#lastLoggedCauseCode !== causeCode) {
            process.stderr.write(
              `alteroidd: ${this.#describeSelf()} のストリームが切れました: ${reasonOf(failure)}${causeSuffixOf(causeInfo)}（次は${waitMs}ms後に再試行）\n`,
            );
            this.#lastLoggedDelayMs = waitMs;
            this.#lastLoggedCauseCode = causeCode;
          }
        });
      } else if (healthy) {
        this.#lastLoggedDelayMs = null;
        this.#lastLoggedCauseCode = '';
      }

      // 次に使う値を決める。持続した(healthy)なら基準へ戻す。そうでなければ
      // (失敗でも、閾値未満で終わった「静かな」接続でも) 倍々に伸ばして頭打ち。
      this.#nextDelayMs = healthy ? this.#retryBaseMs : Math.min(waitMs * 2, this.#retryMaxMs);

      // **差し替えられた待ちが投げても、`#pump` を殺さない**（#323）。ただし
      // **待たずに回り続けもしない** —— それは秒間に何度も runner を叩く形に
      // なる。既定の待ち（{@link defaultSleep}）へ落として、間隔だけは守る。
      try {
        await this.#sleepFn(waitMs);
      } catch {
        await defaultSleep(waitMs);
      }
    }
  }

  /**
   * **`#pump` の周回を殺しうる処理を包む**（#323）。
   *
   * `#pump` は `connect()` が `void this.#pump(onEvent)` として切り離す背景
   * タスクである。**ここから例外が抜けると、ループが終わって二度と戻らない。**
   * しかも `packages/core/src/manager.ts` の `ManagerPool#connectTo` は
   * `#connections` に持った promise の有無で二度目の `connect()` を弾き、旗が
   * 外れるのは `.catch()` のときだけ —— **`connect()` は中身が fire-and-forget
   * なので既に成功として解決しており、旗は永久に立ったままになる。**
   *
   * **＝ `#read` の固着とまったく同じ症状（この runner へ再接続が一度も試され
   * ない）を、別の枝から作る。** #323 が請け負った穴はその症状そのものなので、
   * 枝を1つだけ塞いで終わりにしない。
   *
   * **握り潰した先を報告しない**のは意図である —— ここで包んでいるのは
   * 「知らせる」処理そのもの（stderr への1行）で、その宛先が壊れているから
   * 例外になっている。**別の宛先を新しく作ると、壊れ方が1つ増えるだけである。**
   */
  #neverEscapes(body: () => void): void {
    try {
      body();
    } catch {
      // 何もしない（doc を参照）。
    }
  }

  /**
   * 1本ぶんの `/events`。**開こうとした瞬間から、無音の見張りが張られている。**
   *
   * 見張りの中身は {@link RUNNER_STREAM_SILENCE_TIMEOUT_MS} の doc に在る。ここに
   * 書くのは**掛ける範囲**である。
   *
   * **`fetch()` の前に張る。** 固着は本文を読み始めてからだけではなく、応答
   * ヘッダが返る前にも起こる —— Unix ソケット経路（{@link requestOverSocket}）は
   * 素の `node:http` で期限を持たないので、相手が accept だけして何も書かなければ
   * `await this.#fetch(...)` がそのまま無限に待つ。**`#read` の中だけを見張ると、
   * そこへ到達しない固着がまるごと残る。**
   *
   * **切ったことは例外にして投げる。`abort()` の効き方に賭けない。**
   * `controller.abort()` の後に `reader.read()` が棄却で終わるか `done` で
   * 正常終了するかは経路によって違いうる（TCP は `fetch` の `signal`、Unix
   * ソケットは `req.destroy()`）。**どちらでも `#pump` が「失敗」として扱える
   * よう、旗を見て自分で投げ直す** —— 正常終了として返すと `#pump` は失敗と
   * 数えず、`切れました` の行も出ない（固着が起きたことがログから消える）。
   */
  async #stream(onEvent: (event: RunnerEvent) => void, markHealthy: () => void): Promise<void> {
    const controller = new AbortController();
    this.#controller = controller;

    /**
     * 最後にこの接続からバイトを受け取った時刻。**まだ1バイトも来ていなければ
     * `null`。**
     *
     * **ここで `#nowFn()` を呼ばないのは意図である。** このファイルの既存の歯は
     * `nowFn` が**何回目の呼び出しか**で値を返す形の足場を使っており
     * （`runner-client.test.ts` の `nowFnAtExactThreshold`。1回目＝`connectedAt`
     * が0、以降が閾値）、ここで1回呼ぶとその番号が全部ずれて、**測っている
     * 対象とは無関係に足場のほうが壊れる。** 見張りが「まだ1バイトも来て
     * いない」を表すのに時刻は要らない —— `null` で足りる。
     */
    let lastByteAt: number | null = null;
    /** 見張りが切ったか。**例外の出所を `#pump` へ正しく伝えるために持つ。** */
    let silent = false;
    /**
     * 生きている見張りタイマーを取り消す口。**入れ物に包んでいるのは型の
     * 都合である** —— 素の `let` にすると、代入が `armWatchdog` の中（＝閉包の
     * 中）でしか起きないため、TypeScript の絞り込みが `finally` の時点でも
     * `null` のままだと判断して `never` になる（実測: TS2349）。
     */
    const watchdog: { cancel: (() => void) | null } = { cancel: null };
    /**
     * 見張りを張る（張り直す）。
     *
     * **バイトが届くたびにタイマーを作り直さない。** 発火したときに「最後の
     * バイトからどれだけ経ったか」を {@link #nowFn} で測り直し、まだ窓の中なら
     * **残りぶんだけ張り直す。** これで生きているタイマーは常に1本で、
     * 流量に関係なく一定である（フレームごとに `clearTimeout`+`setTimeout` を
     * 回す形は、忙しいストリームでその回数ぶんの仕事になる）。
     */
    const armWatchdog = (ms: number): void => {
      watchdog.cancel = this.#setTimerFn(ms, () => {
        // **1バイトも来ていなければ、測るまでもなく無音である。**
        if (lastByteAt !== null) {
          const idleMs = this.#nowFn() - lastByteAt;
          if (idleMs < this.#silenceTimeoutMs) {
            armWatchdog(this.#silenceTimeoutMs - idleMs);
            return;
          }
        }
        silent = true;
        controller.abort();
      });
    };
    /** 無音で切ったことを示す例外。**「繋げない」とは別の形で名乗る。** */
    const silenceFailure = (): Error =>
      new Error(
        `runner の /events が ${String(this.#silenceTimeoutMs)}ms のあいだ無音だった（heartbeat が途絶えた）`,
      );

    armWatchdog(this.#silenceTimeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}/events`, {
        headers: {
          accept: 'text/event-stream',
          authorization: `Bearer ${this.#token}`,
          // **無音切断からの復元（#275）。** 前回の接続で受け取れた最後の
          // 連番を申告する——初回接続（`#lastEventId === null`）ではヘッダ
          // 自体を付けない（`#lastEventId` の doc）。
          ...(this.#lastEventId === null ? {} : { 'last-event-id': String(this.#lastEventId) }),
        },
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) {
        throw new Error(`runner の /events に繋げない (${response.status})`);
      }

      // **「接続してから」の起点。** ここから `CONNECTION_HEALTHY_THRESHOLD_MS`
      // だけ経ってからバイトが届いたら、その接続を持続したとみなす（`#pump` の
      // doc）。
      const connectedAt = this.#nowFn();
      const reader = response.body.getReader();
      /**
       * この接続で捨てたフレームの数（種別ごと）。**接続1本ぶんである。**
       *
       * 器が入れ替われば数え直す——プロセス単位で畳むと、新しい runner が同じ
       * `type` を出し始めたときに「前に見たから」で黙る。
       */
      const dropped = new Map<string, number>();
      /** 閉じるときに、量をまとめて1行。**存在は初出が既に出している。** */
      const summarize = (): void => {
        if (dropped.size === 0) return;
        this.#onDroppedEvent?.({
          phase: 'closed',
          dropped: [...dropped].map(([key, count]) => ({ key, count })),
        });
      };

      try {
        await this.#read(reader, onEvent, dropped, () => {
          // **バイトの中身は一切見ない。** `reader.read()` が中身を返したという
          // 事実だけを使う（`#pump` の doc）。閾値を跨いだ後は何度呼ばれても
          // 結果は変わらない——`markHealthy` は冪等である。
          //
          // **無音の見張りの窓も、同じ1つの事実で張り直す**（#323）——
          // heartbeat のフレームかどうかは見ない。runner の heartbeat の実装が
          // 変わっても、この判定は変わらない。
          //
          // **`#nowFn()` の呼び出しは1バイトにつき1回のまま**（#323 で増やして
          // いない）。増やすと `nowFnAtExactThreshold` 型の足場が壊れる
          // ——`lastByteAt` の doc を参照。
          const now = this.#nowFn();
          lastByteAt = now;
          if (now - connectedAt >= CONNECTION_HEALTHY_THRESHOLD_MS) markHealthy();
        });
      } finally {
        // **例外で抜けても量を出す。** ただしプロセスごと落ちたときは走らない
        // ——だから存在のほうは初出で先に出してある。
        summarize();
      }
      // `abort()` が `done` として畳まれた経路。**黙って正常終了にしない。**
      if (silent) throw silenceFailure();
    } catch (error) {
      // `abort()` が棄却として現れた経路。**`AbortError` のままにしない** ——
      // `#pump` が stderr へ書く `切れました` の行が「何が起きたか」を名乗れなくなる。
      if (silent) throw silenceFailure();
      throw error;
    } finally {
      watchdog.cancel?.();
    }
  }

  /**
   * ストリームを読み続ける。**捨てたフレームは `dropped` に数える。**
   */
  async #read(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onEvent: (event: RunnerEvent) => void,
    dropped: Map<string, number>,
    onBytes: () => void,
  ): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      onBytes();
      buffer += decoder.decode(value, { stream: true });

      // SSE のフレームは空行区切り。`data:` 行だけを拾う。
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = frame.split('\n');
        const data = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');

        /**
         * **`id:` は `data:` と独立に読む**（#275）。JSON（`data`）の中身とは
         * 無関係な、配送層だけの値——runner 側（`apps/runner/src/app.ts` の
         * `Outbox`）が `writeSSE` の `id` フィールドに乗せる連番をここで拾い、
         * `#lastEventId` を進める。**受け取れたかどうかだけを見る。**
         * `data` がスキーマに合わなかった／壊れていた場合でも、フレーム自体
         * は届いているので進めてよい——同じフレームを取り直しても同じ結果に
         * しかならない。
         */
        const idLine = lines.find((line) => line.startsWith('id:'));
        if (idLine !== undefined) {
          const seq = Number(idLine.slice(3).trim());
          if (
            Number.isInteger(seq) &&
            seq >= 0 &&
            (this.#lastEventId === null || seq > this.#lastEventId)
          ) {
            this.#lastEventId = seq;
          }
        }

        if (data.length > 0) {
          try {
            const raw: unknown = JSON.parse(data);
            const parsed = runnerEventSchema.safeParse(raw);
            if (parsed.success) onEvent(parsed.data);
            // **スキーマに合わなかったぶんを黙って落とさない。** ここが
            // 「気づく主体が誰も居ない」形だった —— runner が新しい種類の
            // 出来事を出し始めても、`if` が偽になるだけで跡が残らない。
            else this.#noteDropped(dropped, 'unknown-shape', typeOf(raw), data.length);
          } catch {
            // 壊れた1フレームでストリームごと落とさない。**ただし黙って捨てない。**
            // 構造が無いので `type` は取れない —— **取れないものを 0 として積まない**
            // ので、ここではバイト数だけを渡す。
            this.#noteDropped(dropped, 'unparsable', undefined, data.length);
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  }

  /**
   * 捨てた1フレームを数える。**初出だけその場で1行、量はまとめて後で。**
   *
   * 初出を即座に出すのは、**閉じるときのまとめだけでは足りない**からである——
   * デーモンが拾われない例外で死ぬと閉じる処理は走らないので、`type` の存在
   * そのものが失われる。**失ってよいのは量で、存在ではない。**
   *
   * そして初出だけにすることで、壊れたストリームが跡でログを埋めない
   * （同じ `type` は2度目以降1行も書かない）。
   *
   * **範囲は接続1本である。** プロセス単位で畳むと、器が入れ替わって新しい
   * runner が同じ `type` を出し始めたときに「前に見たから」で黙る——それは
   * まさにここで塞いでいる穴の再発である。
   *
   * **これは有界ではない。** 接続が繰り返し張り直されるあいだ、初出は接続ごとに
   * 出る。`#pump` の待ちが倍々に伸びるのは**失敗したときだけ**で、ストリームが
   * 正常に閉じた場合は常に基準値（{@link RUNNER_STREAM_RETRY_BASE_MS}）へ戻る
   * ——**正常終了を繰り返す runner に対しては律速が掛からない。**
   */
  #noteDropped(
    dropped: Map<string, number>,
    reason: 'unparsable' | 'unknown-shape',
    type: string | undefined,
    bytes: number,
  ): void {
    const key = type === undefined ? reason : `${reason}:${type}`;
    const seen = dropped.get(key) ?? 0;
    dropped.set(key, seen + 1);
    if (seen > 0) return;
    this.#onDroppedEvent?.({
      phase: 'first',
      reason,
      ...(type === undefined ? {} : { type }),
      bytes,
    });
  }

  /**
   * マネージャーを起こす。**この1つだけ期限を付けていない。**
   *
   * 付けると、期限切れ（＝不明）が呼ぶ側で**確定的な失敗**に化ける。
   * `packages/core/src/manager.ts` の `Pool.start` は `runner.start()` が投げたら
   * `#records.delete(managerId)` して投げ直す実装で、`#persist` はその後にあるから
   * 台帳にも1行も残らない。`Pool.list()` は `#records` と台帳しか見ない（runner へは
   * 訊かない）ので、**runner 側で走り出していても `manager_list` から消える** —
   * 止める手も残らない。「黙って失われる」であり、無期限に待つより悪い。
   *
   * 直すには呼ぶ側（`packages/core`）が「不明」を運べる必要がある。ここに期限だけを
   * 先に足すと、その日まで消える委譲が出る。**だから待つ方を選んでいる。**
   */
  async start(command: RunnerStartCommand): Promise<void> {
    await this.#callWithoutDeadline('POST', '/managers', command);
  }

  async resume(command: RunnerResumeCommand): Promise<void> {
    await this.#call('POST', `/managers/${encodeURIComponent(command.managerId)}/resume`, command);
  }

  async send(managerId: string, text: string): Promise<void> {
    await this.#call('POST', `/managers/${encodeURIComponent(managerId)}/messages`, { text });
  }

  async answer(managerId: string, answer: RunnerAnswerCommand): Promise<RunnerAnswerOutcome> {
    const response = await this.#call(
      'POST',
      `/managers/${encodeURIComponent(managerId)}/answers`,
      answer,
    );
    const body = (await response.json()) as { ok?: unknown; decision?: unknown };
    // **`managers` / `pendingEvents`（#358）と同じ扱い**——1つずつ検証する。
    // まとめて弾くと、`ok` の形が崩れただけで `decision` まで落ちる。
    const decision = runnerAnswerResultSchema.shape.decision.safeParse(body.decision);
    return {
      delivered: body.ok === true,
      // **欠けた回を allow/deny の既定値へ倒さない（#322）。** ローリング
      // 再デプロイの窓では、まだこの変更前の runner が `decision` を持たない
      // 応答を返す——そのときは欄そのものを省く（`RunnerAnswerOutcome` の doc）。
      ...(decision.success && decision.data !== undefined ? { decision: decision.data } : {}),
    };
  }

  async stop(managerId: string): Promise<void> {
    await this.#call('DELETE', `/managers/${encodeURIComponent(managerId)}`);
  }

  async list(): Promise<RunnerManagerState[]> {
    const response = await this.#call('GET', '/managers');
    const body = (await response.json()) as { managers?: unknown };
    if (!Array.isArray(body.managers)) return [];
    return body.managers.flatMap((entry) => {
      const parsed = runnerManagerStateSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    const response = await this.#call('GET', '/health');
    const body = (await response.json()) as HealthBody;
    return fingerprintsOf(body.credentials);
  }

  /**
   * 鍵を差し替える。**器は作り直さない。**
   *
   * 走行中のマネージャーにも、器（ファイル）越しに次の `git` / `gh` 呼び出しから
   * 届く。ここが無いと鍵の更新に再デプロイが要り、そのたびに走っている仕事が死ぬ。
   */
  async setCredentials(
    credentials: RunnerSetCredentialsCommand['credentials'],
  ): Promise<RunnerCredentialFingerprint[]> {
    const response = await this.#call('POST', '/credentials', { credentials });
    const body = (await response.json()) as { credentials?: unknown };
    return fingerprintsOf(body.credentials);
  }

  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    const response = await this.#call('GET', '/health');
    const body = (await response.json()) as HealthBody;
    const parsed = runnerProfileFingerprintSchema.safeParse(body.profile);
    return parsed.success ? parsed.data : undefined;
  }

  /**
   * 実行環境プロファイルを差し替える。**器は作り直さない。**
   *
   * これから起こす仕事には即座に効く。走行中の仕事へ届くのは `gh` シムが
   * ファイルを読み直す経路だけである（`profile.ts`）。runner はこれを自分で
   * 取りに行けない（記憶ストアの鍵を持たないため）ので、**繋ぎ直しのたびに
   * 降ろし直すのはデーモンの責任**である。
   */
  async setProfile(script: string): Promise<RunnerProfileResult> {
    const response = await this.#call('POST', '/profile', { script });
    const parsed = runnerProfileResultSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : { ok: false, error: 'runner の応答を読めなかった' };
  }

  /**
   * 走行中セッションの生ログ。**取れなければ `null`**（呼ぶ側は退避済みへ降りる）。
   *
   * 期限切れもここでは `null` になる。**`null` は「無い」ではなく「取れなかった」**で、
   * それはこの口が前からそう答えている（404 も接続断も `null` である）。期限切れが
   * 潰れないよう、不明そのものは `onUnknown` から日誌へ出る。
   */
  async transcript(managerId: string): Promise<string | null> {
    try {
      const response = await this.#call(
        'GET',
        `/managers/${encodeURIComponent(managerId)}/transcript`,
      );
      return await response.text();
    } catch {
      return null;
    }
  }

  /**
   * ストリームを閉じるだけ。**runner のマネージャーは止めない。**
   * デーモンの都合（再起動・更新）で、走っている人の仕事を殺さない。
   */
  async close(): Promise<void> {
    this.#closed = true;
    this.#controller?.abort();
    this.#controller = null;
  }

  /**
   * 期限付きで叩く。**この経路を通る限り、応答を無期限に待つことは無い。**
   *
   * 期限が切れたら {@link RunnerUnknownError} を投げる。**投げるのは「返らなかった」
   * であって「失敗した」ではない** — `RunnerHttpError` の系列にわざと乗せていない
   * （あちらは status を持つ＝相手が答えた証拠である）。
   *
   * **相手は止めない。** ここで `AbortController` を作らないのは意図で、期限は
   * 待つのをやめるためだけにある（`deadline.ts`）。だから投げた要求はそのまま走り、
   * 遅れて返ってきたら `late` として報告する（本文は読み捨てて繋ぎを畳む）。
   *
   * **諦める回数の上限は持たない。** ここが決めるのは「いつ不明と言うか」だけで、
   * 挑み直すかどうかは呼ぶ側（名簿・クローン）が決める。
   */
  async #call(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const waitedMs = this.#deadlineMs;
    const settled = await settleWithinDeadline(
      this.#callWithoutDeadline(method, path, body, signal),
      waitedMs,
      (late) => {
        // 遅れて返ってきた本文は読み捨てる（読まずに放ると繋ぎが積み上がる）。
        if (late.ok) void late.value.text().catch(() => '');
        this.#onUnknown?.({
          method,
          path,
          waitedMs,
          phase: 'late',
          ok: late.ok,
          ...(late.ok ? {} : { error: late.error }),
        });
      },
    );
    if (settled.outcome === 'settled') return settled.value;
    if (settled.outcome === 'failed') throw settled.error;
    this.#onUnknown?.({ method, path, waitedMs, phase: 'expired' });
    throw new RunnerUnknownError({ method, path, waitedMs });
  }

  /**
   * 期限を付けずに叩く。**呼んでよいのは `start()` だけである**（その理由は
   * `start()` の doc）。増やすときは「期限切れが呼ぶ側で何に化けるか」を先に見る。
   */
  async #callWithoutDeadline(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // 名簿の probe 期限で中断されたら、繋ぎもそこで畳む（返らない繋ぎを残さない）。
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new RunnerHttpError(
        `runner ${method} ${path} が失敗した (${response.status}) ${detail}`,
        response.status,
      );
    }
    return response;
  }
}

/** node:http で Unix ソケットへ投げ、`fetch` と同じ形の応答に均す。 */
function requestOverSocket(socketPath: string, url: URL, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = new Headers(init.headers ?? {});
    const outgoing: Record<string, string> = {};
    headers.forEach((value, key) => {
      outgoing[key] = value;
    });

    const req = httpRequest(
      {
        socketPath,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers: outgoing,
      },
      (res) => {
        // 本文はそのまま流す（SSE は開いたまま読み続ける）
        const body = Readable.toWeb(res) as ReadableStream<Uint8Array>;
        resolve(
          new Response(body, {
            status: res.statusCode ?? 500,
            headers: Object.entries(res.headers).flatMap(([key, value]) =>
              typeof value === 'string' ? [[key, value] as [string, string]] : [],
            ),
          }),
        );
      },
    );

    req.on('error', reject);
    const signal = init.signal;
    if (signal) signal.addEventListener('abort', () => req.destroy(), { once: true });
    if (typeof init.body === 'string') req.write(init.body);
    req.end();
  });
}
