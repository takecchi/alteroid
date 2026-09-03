import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import type { BuildRevision, RunnerEvent, RunnerHost } from '@alteroid/core';
import {
  DEFAULT_SSE_HEARTBEAT_MS,
  readExecutionResources,
  reasonOf,
  resolveBuildRevision,
  startSseHeartbeat,
  RunnerFenceError,
  runnerAnswerCommandSchema,
  runnerMessageCommandSchema,
  runnerResumeCommandSchema,
  runnerSetCredentialsCommandSchema,
  runnerSetProfileCommandSchema,
  runnerStartCommandSchema,
} from '@alteroid/core';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { streamSSE } from 'hono/streaming';

import { TaskBreakdownReader } from './tasks.js';

/**
 * manager-runner の HTTP API（roadmap M4）。
 *
 * **叩くのはデーモンだけである。** runner はデーモンの所在も鍵も知らない —
 * 出来事は「デーモンが開いたストリーム」を流れ落ちる（`GET /events`）。逆向きの
 * コールバックを足すと、runner の中の子プロセス（＝マネージャー）がその経路で
 * 記憶へ届けるようになる（docs/architecture.md「非対称な可視性」）。
 *
 * ここに判断は無い。許可してよい行為の一覧も、確認の要否の設定も持たない。
 * それらはクローンが記憶を根拠に決めるものである（PRD「権限境界」）。
 */
export interface RunnerAppDeps {
  host: RunnerHost;
  /** デーモンが繋いでいない間の出来事を溜める箱。 */
  outbox: Outbox;
  /**
   * 制御面の合鍵の **sha256（16進）**。デーモンだけが元の値を持つ。
   *
   * **なぜハッシュだけを持つのか。** マネージャーは runner の中で走る子プロセスで
   * あり、素の鍵を runner の環境変数に置けば `/proc/1/environ` から読める。読めた
   * 瞬間、マネージャーは `POST /managers/:id/answers` で**自分宛の許可確認に自分で
   * allow を返せる** — クローンも人間も通らずに権限境界を迂回できる。
   * ハッシュしか無ければ、読めても鍵は作れない。
   *
   * これは能力の制限ではなく、制御面の本人確認である（north_star 禁止2の「実行環境の
   * 境界」）。マネージャーの道具は1つも減っていない。
   */
  tokenSha256: string;
  /**
   * 自分の版。**既定は `resolveBuildRevision()`（実際にビルドで焼かれた値）。**
   *
   * 渡すのはテストだけである——このプロセスが実際に何で焼かれたかは
   * `CANON_REVISION`（ビルド時に固定）に支配されるので、「焼き込みが無かった
   * ら `/health` が null をそのまま返すか」を確かめるには、実行中のプロセスの
   * 焼き込み状態とは独立に差し替えられる口が要る。本番の起動経路
   * （`apps/runner/src/index.ts`）はこの引数を渡さない。
   *
   * **この項目は焼き込みが無かった場合を再現するためだけに在る。本番の経路は
   * どこからも渡さない。**（これは「渡してよい設定」ではない。渡す実装が現れたら、
   * それは本番の形が変わったということである。）
   *
   * **内部に閉じていない。** `RunnerAppDeps` は `apps/runner/src/index.ts` から
   * export されている（`@alteroid/runner` の公開面）ので、この項目もワークスペース
   * 内の daemon 等から見える（`private: true` で npm へは publish されない）。
   */
  revision?: BuildRevision;
  /**
   * `GET /events` の heartbeat の間隔（ms）。省略時は `DEFAULT_SSE_HEARTBEAT_MS`
   * （`@alteroid/core` の `sse-heartbeat.ts`）。**環境変数は増やさない** ——
   * デーモン側の `AppDeps.sseHeartbeatMs` と同じ理由で、テストで短くする以外に
   * 差し替える理由が無い。
   */
  sseHeartbeatMs?: number;
  /**
   * タスクの state 別内訳を測るリーダー（#315 の可視化）。**主にテスト用。**
   *
   * 既定は `new TaskBreakdownReader()`（実物の `/proc` を読む）。`revision` と
   * 同じ DI の形——本番の起動経路（`apps/runner/src/index.ts`）はこの引数を
   * 渡さない。テストは偽の `/proc`（一時ディレクトリ）を指すリーダーを注入して
   * 固定値を確かめる。
   */
  taskBreakdownReader?: TaskBreakdownReader;
}

const AUTH_SCHEME = /^Bearer\s+(.+)$/i;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** 一致の判定は長さを揃えて定数時間で（総当たりに時間の手がかりを与えない）。 */
function matches(header: string | undefined, expectedHex: string): boolean {
  const token = AUTH_SCHEME.exec(header ?? '')?.[1];
  if (token === undefined) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== 32) return false;
  return timingSafeEqual(sha256(token), expected);
}

/**
 * 受け口が閉じている間の出来事を落とさないための箱。
 *
 * デーモンが再起動している最中にも、マネージャーは手を動かし、確認を投げてくる。
 * ここで捨てると**誰も答えられない待ちが runner に残る**（マネージャーは永久に
 * 止まる）。だから溜めて、繋がった順に流す。
 *
 * 溜める量に上限を置かないのは、上限＝取りこぼしだからである。器の資源が尽きる
 * ときは実行環境の限界として現れるべきで、記録を先に捨てる設計にしない。
 */
/**
 * 「まだデーモンへ送り出せていない」量（#358）。**溜まり場は2つ在る**——
 * {@link Outbox} 自身の待ち行列と、購読側（`GET /events` のハンドラ）が
 * 抱えている分である。{@link Outbox.pending} はその合計を答える。
 */
export interface OutboxPending {
  /** 件数。 */
  count: number;
  /** いちばん古いものが積まれた時刻（ISO 8601）。1件も無ければ `undefined`。 */
  oldestAt?: string;
}

/**
 * `outbox.push()` が返す連番（#275）。**プロセスの寿命の間だけ単調増加する**
 * ——runner が入れ替われば1から数え直す（`INSTANCE_ID` と同じ寿命）。
 *
 * **SSE のフレームの `id` フィールドにしか使わない。** `RunnerEvent`（`@alteroid/
 * core` の `runnerEventSchema`）には一切載せない——JSON の中身を変えずに
 * 「取りこぼしの手当て」を配送層だけで完結させるためである（`packages/core/src/
 * runner-protocol.ts` は人間が差分を読む線であり、触らずに済むならそのほうが
 * 望ましいという判断）。
 */
export type OutboxSeq = number;

/**
 * `#queue` に残っている分の、種別・managerId ごとの内訳1行（#634）。
 *
 * **`#queue` だけの内訳である。** 購読側（`GET /events` ハンドラのローカル
 * `queue` と書きかけの1件）が抱えている分はここには出ない——`#probe` が
 * 返すのは件数と最古時刻だけで、中身（`RunnerEvent` そのもの）を持たない
 * ためである（`Outbox.pending` の doc）。取れないものを取れた顔で出さない
 * （AGENTS.md の地雷表）。
 */
export interface OutboxPendingGroup {
  /** `RunnerEvent.type`。 */
  type: string;
  /** `hello` 以外は必ず持つ。`hello` だけ managerId が無い。 */
  managerId?: string;
  count: number;
  /** この組の中でいちばん古い `queuedAt`。 */
  oldestAt: string;
}

/**
 * 畳む直前に「何を失うのか」を名指しするための、`Outbox` の1回分のスナップ
 * ショット（#634）。`OutboxPending`（`/health` が返す合計だけの形）とは別に
 * 用意する——`/health` の応答は増やさない（wire は1バイトも増えない。
 * `describeForShutdown()` は runner プロセスの内側だけで完結する）。
 */
export interface OutboxShutdownSnapshot {
  /**
   * `#queue`（まだ一度も listener へ渡していない分）。listener が付いて
   * いる間は常に空——`push()` は listener が居ればそのまま渡すので、
   * ここには積まれない（`Outbox.pending` の doc の表と同じ非対称）。
   */
  queue: {
    count: number;
    /** 1件も無ければ省く。 */
    oldestAt?: string;
    groups: OutboxPendingGroup[];
  };
  /**
   * 購読側（`GET /events` ハンドラ）の状態（#634）。**3つを言い分ける**——
   * コーディネーターの指摘: 直す前は「一度も購読が無い」と「購読されていた
   * が、いま切れている」が同じ `null` になり、後者にまで「該当なし」という
   * 正しくない断定を書いていた。これは #628 が `never-connected` と `down`
   * を分けたのと同じ軸で、しかも今回いちばん知りたいこと（脚が落ちたまま
   * 畳んだのか、そもそも一度も繋がらなかったのか）そのものである。
   *
   * - `'never-subscribed'`: `attach()` が一度も呼ばれていない。そもそも
   *   尋ねる相手が存在しない
   * - `'subscribed'`: いま購読されている（`#listener` が付いている）。
   *   `#probe` が渡されていれば件数・最古時刻を添える——渡されていなければ
   *   （`attach()` の `pending` 引数を省いた呼び出し）添えない。**0件と
   *   「取れない」を混同しない**
   * - `'detached'`: 過去に購読されたことがあるが、いまは切れている。
   *   **件数は取れない**（`detach()` の時点で `#probe` も外れるので、
   *   推測で埋めない——0を書くと「何も失っていない」と読めてしまう。
   *   `AGENTS.md`「取れない軸に0の行を作る」と同じ理由）
   */
  subscriber:
    | { status: 'never-subscribed' }
    | { status: 'subscribed'; count?: number; oldestAt?: string }
    | { status: 'detached' };
}

export class Outbox {
  readonly #queue: { event: RunnerEvent; queuedAt: string; seq: OutboxSeq }[] = [];
  #listener: ((event: RunnerEvent, seq: OutboxSeq) => void) | null = null;
  /**
   * 購読側が抱えている分を数える口（#358）。**購読が始まったときだけ在る。**
   *
   * これが無いと {@link pending} は「要るときにだけ 0 を返す」計器になる
   * （{@link pending} の doc）。
   */
  #probe: (() => OutboxPending) | null = null;
  /**
   * `attach()` が一度でも呼ばれたか（#634）。**一度立てたら戻さない**——
   * `#listener` / `#probe` は detach で `null` に戻るが、こちらは「過去に
   * 購読されたことがあるか」という別の軸なので、detach では動かさない。
   * `describeForShutdown()` が「一度も購読が無い」と「購読されていたが、
   * いま切れている」を区別するための唯一の材料である。
   */
  #everSubscribed = false;
  readonly #now: () => string;
  #nextSeq: OutboxSeq = 1;

  /**
   * 「`writeSSE` が例外を投げずに返った」出来事の控え（#275）。**上限あり**
   * ——`#queue`（まだ一度も渡していない分）が上限を置かない理由（取りこぼし）
   * とはここは違う。ここに積むのは**一度は渡した**分の予備で、上限に当たって
   * 古い方から捨てても、直す前の挙動（無条件に消える）より悪くはならない。
   *
   * hono の `write()`（`hono/dist/utils/stream.js`）は死んだ接続へ書いても
   * `catch {}` で例外を外へ出さない——runner 側からは「成功した」としか見えない
   * （Issue #275 本文）。だから `writeSSE` が返った直後の1件は、本当に相手へ
   * 届いたのか runner には確認できない。**確認できない代わりに、一定件数だけ
   * 手元に残し**、次に張られた接続が `Last-Event-ID` を名乗ったら
   * {@link sentSince} で読み返して配り直す。
   */
  readonly #sent: { event: RunnerEvent; queuedAt: string; seq: OutboxSeq }[] = [];

  /** 控え（{@link #sent}）に残す上限件数。 */
  static readonly SENT_HISTORY_LIMIT = 1000;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.#now = now;
  }

  /** 割り振った連番を返す（#275）。呼び出し側が `id`（SSE フレーム）へそのまま使う。 */
  push(event: RunnerEvent): OutboxSeq {
    const seq = this.#nextSeq++;
    if (this.#listener !== null) {
      this.#listener(event, seq);
      return seq;
    }
    this.#queue.push({ event, queuedAt: this.#now(), seq });
    return seq;
  }

  /**
   * 購読を開始する。溜まっていた分を先に流してから、以後は直接渡す。
   *
   * `pending` は**購読側が抱えている分を数える口**である（#358）。渡さなくても
   * 動くが、**渡さなければ購読中の滞留が {@link pending} から消える。**
   */
  attach(
    listener: (event: RunnerEvent, seq: OutboxSeq) => void,
    pending?: () => OutboxPending,
  ): () => void {
    while (this.#queue.length > 0) {
      const item = this.#queue.shift();
      if (item !== undefined) listener(item.event, item.seq);
    }
    this.#listener = listener;
    this.#probe = pending ?? null;
    this.#everSubscribed = true;
    return () => {
      if (this.#listener !== listener) return;
      this.#listener = null;
      this.#probe = null;
    };
  }

  /**
   * `writeSSE` が例外を投げずに返った直後に呼ぶ（#275）。**この呼び出しが、
   * 無音切断の唯一の手当てである。**
   *
   * 呼ぶのは「相手に本当に届いたことが確認できた」からではない——確認できて
   * いないからこそ、次の接続の申告（`Last-Event-ID`）に賭けて一定量を手元に
   * 残す。上限は {@link SENT_HISTORY_LIMIT}。古い方から捨てる。
   */
  recordSent(event: RunnerEvent, seq: OutboxSeq, queuedAt: string): void {
    this.#sent.push({ event, seq, queuedAt });
    while (this.#sent.length > Outbox.SENT_HISTORY_LIMIT) this.#sent.shift();
  }

  /**
   * `lastEventId` より新しく「渡したはず」だった分を、古い順に返す（#275）。
   *
   * **`lastEventId` が控えの最古の連番より小さい場合、その間の分は復元でき
   * ない**（{@link SENT_HISTORY_LIMIT} を超えて捨てられているため）。この
   * 関数はその欠落を検知しない——黙って「残っている分だけ」を返す。呼び出し側
   * （`/events`）もそれ以上のことはしない: 直す前の挙動（無条件に消える）より
   * 悪くはならない、という上限の設計そのものである。
   */
  sentSince(lastEventId: OutboxSeq): { event: RunnerEvent; queuedAt: string; seq: OutboxSeq }[] {
    return this.#sent.filter((item) => item.seq > lastEventId);
  }

  /**
   * まだデーモンへ送り出せていない件数。**購読側が抱えている分も含む**（#358）。
   *
   * ## なぜ合算なのか（ここを分けると計器が嘘をつく）
   *
   * {@link push} は listener が付いていれば `#queue` に積まず、**そのまま購読側へ
   * 渡す。** だから `#queue` の長さだけを数えると:
   *
   * | 状況 | listener | 溜まる場所 | `#queue.length` |
   * | --- | --- | --- | --- |
   * | デーモンが繋いでいない | 付いていない | `#queue` | 正しく N |
   * | **デーモンが繋がったまま読まなくなった** | **付いたまま** | **購読側** | **0** |
   *
   * **下の行が #323 である。** デーモンの `#pump` が固着しても runner から見た
   * 接続は開いたままなので `detach()` は呼ばれず、listener は付いたままになる。
   * **＝ あの4時間、この値はずっと 0 だった。** 「報告が出たのに配られていない」を
   * 見えるようにするのがこの値の役目なのに、**いちばん要る場面でだけ 0 を返す**
   * 計器だった（AGENTS.md「静かに失敗する道具」）。
   */
  get pending(): number {
    return this.#queue.length + (this.#probe?.().count ?? 0);
  }

  /**
   * まだ送り出せていないもののうち、いちばん古いものが積まれた時刻（#358）。
   *
   * **「マネージャーが報告を生成した時刻」ではない。** runner がこの箱へ積んだ
   * 時刻である —— 取れないものを取れた顔で出さない（AGENTS.md の地雷表）。
   */
  get oldestPendingAt(): string | undefined {
    const mine = this.#queue[0]?.queuedAt;
    const theirs = this.#probe?.().oldestAt;
    // 片方しか埋まらないのが普通だが（listener が付いていれば `#queue` は空）、
    // **どちらが古いかで決める。** 「片方は空のはず」を前提にしない。
    if (mine === undefined) return theirs;
    if (theirs === undefined) return mine;
    return theirs < mine ? theirs : mine;
  }

  /**
   * いま listener（`GET /events` の購読）が付いているか（#634）。
   *
   * **畳む経路が「待ってよいか」を決めるための材料。** 脚が繋がっていなければ
   * 待っても誰も引き取らない——`#queue` に積まれたままの分は、次にデーモンが
   * 繋ぎ直すまで動かない。無条件に待つと、器の焼き直しのたびに shutdown が
   * 延びる（listener が一度も付かない = デーモン側が既に落ちている、という
   * ありふれた場合を含む）。
   */
  get subscribed(): boolean {
    return this.#listener !== null;
  }

  /**
   * 畳む直前に「何が残っているか」を名指しするための1回分のスナップショット
   * （#634。`OutboxShutdownSnapshot` の doc）。
   *
   * **`#queue` は種別・managerId ごとに集計できる**（中身の `RunnerEvent` を
   * 直接持っているため）。**購読側（`#probe`）は集計できない**（件数と最古
   * 時刻しか返してこない——`Outbox.pending` の doc）。取れない内訳を推測で
   * 埋めない。
   */
  describeForShutdown(): OutboxShutdownSnapshot {
    const groups = new Map<string, OutboxPendingGroup>();
    for (const item of this.#queue) {
      const managerId = 'managerId' in item.event ? item.event.managerId : undefined;
      const key = `${item.event.type} ${managerId ?? ''}`;
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, {
          type: item.event.type,
          ...(managerId === undefined ? {} : { managerId }),
          count: 1,
          oldestAt: item.queuedAt,
        });
      } else {
        existing.count += 1;
        if (item.queuedAt < existing.oldestAt) existing.oldestAt = item.queuedAt;
      }
    }
    const probed = this.#probe?.();
    // **3状態を作る（#634）。** `#listener` の有無で「いま購読されている」を
    // 先に見て、外れていれば `#everSubscribed` で「一度も無い」と「切れた」を
    // 分ける——detach で戻るのは `#listener` / `#probe` だけで、
    // `#everSubscribed` は戻らない（`#everSubscribed` の doc）。
    const subscriber: OutboxShutdownSnapshot['subscriber'] =
      this.#listener !== null
        ? {
            status: 'subscribed',
            ...(probed === undefined
              ? {}
              : {
                  count: probed.count,
                  ...(probed.oldestAt === undefined ? {} : { oldestAt: probed.oldestAt }),
                }),
          }
        : this.#everSubscribed
          ? { status: 'detached' }
          : { status: 'never-subscribed' };
    return {
      queue: {
        count: this.#queue.length,
        ...(this.#queue[0] === undefined ? {} : { oldestAt: this.#queue[0].queuedAt }),
        groups: [...groups.values()],
      },
      subscriber,
    };
  }
}

/**
 * {@link Outbox.describeForShutdown} の結果を、stderr へ書く1つの文字列へ
 * 畳む（#634）。**`shutdown()`（`apps/runner/src/index.ts`）から呼ぶ。** 呼ぶのは
 * `waitForOutboxDrain` で待てるだけ待った**後**——このプロセスは、これを
 * 書いた直後に `process.exit(0)` する（`drainAndReportOutbox` の呼び出し
 * 順）。それより後にこのイベントループが回ることは無い。
 *
 * **「残っている」ではなく「失われる」と書く。** `Outbox` はプロセス内
 * メモリだけで、ディスクにも DB にも無い（このファイルに実装がある——確かめ
 * るには `Outbox` クラスの永続化コードを探せばよい。無い）。**この関数が
 * 呼ばれる時点で残っているものは、この後どの道 process.exit(0) と一緒に
 * 消える**——「残っている」だけだと「後で届く」とも読めてしまう
 * （依頼者第一基準:「失われたなら、失われたことが分かること」）。
 *
 * **何も残っていない、かつ購読側の状態が完全に分かっているときだけ `null`。**
 * 呼び出し側はこのとき何も書かない——「残っていない」は書く価値の無い行
 * ではなく、書かないことそのものが答えである（毎回の shutdown で1行増える
 * と、それ自体がログを埋める）。**購読が過去にあって、いま切れている
 * （`subscriber.status === 'detached'`）ときは、`#queue` が0件でも黙らない**
 * ——切れた側で何件失っているかはここからは分からず、0件だったと決めつける
 * と静かに失敗する（依頼者第4基準）。
 *
 * **`archive` を含む種別・managerId を必ず名指しする。** #628 の調査が
 * 指した穴そのもの——`#shipArchive()` は `report` / `ask` と同じ1本の脚
 * （`emit`）を通るので、脚が落ちたまま畳むと生ログの退避（アーカイブ）も
 * 他の出来事と同じ箱の中で静かに消える。件数だけでは「何が」失われたのかが
 * 分からない。
 */
export function formatOutboxShutdownReport(snapshot: OutboxShutdownSnapshot): string | null {
  const subscriberKnownCount =
    snapshot.subscriber.status === 'subscribed' ? (snapshot.subscriber.count ?? 0) : 0;
  // **購読が切れた後は、そちら側の件数を0とみなさない。** `#probe` はもう
  // 呼べないので、購読側に何も残っていなかったことを示す材料が無い
  // （`OutboxShutdownSnapshot.subscriber` の doc）。
  const subscriberUnknown = snapshot.subscriber.status === 'detached';
  const total = snapshot.queue.count + subscriberKnownCount;
  if (total === 0 && !subscriberUnknown) return null;

  const oldestCandidates = [
    snapshot.queue.oldestAt,
    snapshot.subscriber.status === 'subscribed' ? snapshot.subscriber.oldestAt : undefined,
  ].filter((value): value is string => value !== undefined);
  oldestCandidates.sort();
  const oldest = oldestCandidates[0];

  const lines = [
    total > 0
      ? `alteroid-runner: 畳む直前の出来事が ${total} 件、このプロセスの終了と一緒に失われる` +
        `${oldest === undefined ? '' : `（最古 ${oldest}）`}。Outbox はプロセス内メモリだけで、` +
        'ディスクにも DB にも無い——この直後に process.exit(0) するので、これより後は無い。' +
        `${
          subscriberUnknown
            ? ' 購読側が過去に抱えていた分は件数不明——それとは別に、さらに失われている可能性がある。'
            : ''
        }`
      : 'alteroid-runner: 畳む直前、自分の待ち行列（#queue）に残っているものは無いが、' +
        '過去に購読されていた接続がいま切れており、そちら側で何件失っていたかはここからは' +
        '分からない（0件だったとは言い切れない）。',
  ];

  if (snapshot.queue.groups.length === 0) {
    lines.push('  自分の待ち行列（#queue）: 0件。');
  } else {
    lines.push('  自分の待ち行列（#queue）の内訳:');
    for (const group of snapshot.queue.groups) {
      lines.push(
        `    type=${group.type}` +
          `${group.managerId === undefined ? '' : ` managerId=${group.managerId}`}` +
          ` count=${group.count} oldest=${group.oldestAt}`,
      );
    }
  }

  lines.push(describeSubscriberLine(snapshot.subscriber));

  return `${lines.join('\n')}\n`;
}

/**
 * 購読側（`GET /events` ハンドラのローカル `queue` と書きかけの1件）の行を
 * 組み立てる（#634。3状態——`OutboxShutdownSnapshot.subscriber` の doc）。
 *
 * **`'subscribed'` の内訳は取れないことを、取れないと読める字で出す**
 * ——`#probe` が返すのは件数と最古時刻までで、`Outbox.describeForShutdown`
 * の doc のとおり `#queue` のような種別・managerId ごとの集計は持たない。
 *
 * **`'detached'` は件数そのものが無い**（`#probe` はもう呼べない）——0を
 * 書くと「何も失っていない」と誤読される。**`'never-subscribed'` とは
 * 文面をはっきり分ける**（`never-connected` と `down` を分けた #628 と
 * 同じ理由）。
 */
function describeSubscriberLine(subscriber: OutboxShutdownSnapshot['subscriber']): string {
  switch (subscriber.status) {
    case 'never-subscribed':
      return '  購読側が抱えている分: 購読が一度も無いので該当なし。';
    case 'detached':
      return (
        '  購読側が抱えている分: 過去に購読されていたが、いま切れている' +
        '（件数は取れない——0件だったとは言い切れない）。'
      );
    case 'subscribed': {
      const oldest = subscriber.oldestAt === undefined ? '' : `（最古 ${subscriber.oldestAt}。`;
      const closing = subscriber.oldestAt === undefined ? '（' : '';
      const count = subscriber.count ?? '不明';
      return `  購読側が抱えている分: ${count} 件${oldest}${closing}内訳は取れない）。`;
    }
    default: {
      const unreachable: never = subscriber;
      return `  購読側が抱えている分: 判定できない（未知の状態 ${JSON.stringify(unreachable)}）。`;
    }
  }
}

/**
 * このプロセスの識別子。**モジュールの読み込みで1回だけ作る。**
 *
 * `createRunnerApp` の中で作らないのは、テストが同じプロセスで app を作り直す
 * ことがあり、そのたびに変わると「器が入れ替わった」と読めてしまうからである。
 * 表しているのは**プロセスの同一性**であって app の同一性ではない。
 */
const INSTANCE_ID = randomUUID();

export function createRunnerApp(deps: RunnerAppDeps) {
  const { host, outbox } = deps;
  const sseHeartbeatMs = deps.sseHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
  // **プロセスの生存期間ぶん1回だけ解決する**（`INSTANCE_ID` と同じ理由——
  // 焼き込み・実行時の環境変数はどちらもプロセスの寿命の間に変わらない）。
  const revision = deps.revision ?? resolveBuildRevision();
  const taskBreakdownReader = deps.taskBreakdownReader ?? new TaskBreakdownReader();

  /**
   * 制御面の門番。**runner の中から叩けても、鍵が無ければ通らない。**
   *
   * ここを外すと、マネージャーが `curl` で自分の `requestId` を調べ、自分に
   * `allow` を返せる（権限境界の完全な迂回）。
   */
  const control = createMiddleware(async (c, next) => {
    if (!matches(c.req.header('authorization'), deps.tokenSha256)) {
      return c.json({ error: 'unauthorized' as const }, 401);
    }
    /**
     * **認証を通った呼びだけが貸し出し期限の時計を進める。**
     *
     * `/livez` はここを通らない（無認証）。認証前にここへ置くと、誰でも
     * `GET /livez` を叩くだけで貸し出し期限を延ばせてしまい、自己失効
     * （`RunnerHostOptions.enforceLease`）がまるごと機能しなくなる。
     */
    host.noteDaemonContact();
    await next();
  });

  const app = new Hono()
    /**
     * Hono の既定のエラーハンドラを、本文を出さない規律に合わせて置き換える
     * （Issue #249）。
     *
     * **応答（500 / `Internal Server Error`）と `HTTPException` の分岐
     * （`getResponse()` を返す枝）は既定と同じに保つ。** 変えるのは
     * `console.error(err)` の枝だけである。デーモン側（`apps/daemon/src/
     * app.ts` の `createApp` 冒頭）と同じ判断で、実物（`hono@4.13.1`、
     * `node_modules/.pnpm/hono@4.13.1/node_modules/hono/dist/hono-base.js`
     * の `errorHandler`）の逐語も同じくそちらに引いてある。
     *
     * ここが踏む実例は `/managers/:id/resume` の `throw error`（`RunnerFenceError`
     * 以外）である——世代の古い resume 以外の失敗は、これまで Hono の既定
     * ハンドラを未捕捉のまま抜けていた。
     */
    .onError((err, c) => {
      if ('getResponse' in err) {
        const res = err.getResponse();
        return c.newResponse(res.body, res);
      }
      process.stderr.write(
        `alteroid-runner: HTTP 経路で例外を捕まえました（本文は出しません）: ${reasonOf(err)}\n`,
      );
      return c.text('Internal Server Error', 500);
    })
    /** 器の生存確認だけ。制御面の情報は何も返さない（だから鍵を要求しない）。 */
    .get('/livez', (c) => c.json({ ok: true }))

    .use('/health', control)
    .use('/events', control)
    .use('/managers', control)
    .use('/managers/*', control)
    .use('/credentials', control)
    .use('/profile', control)

    .get('/health', async (c) => {
      /**
       * タスクの state 別内訳（#315 の可視化）。**`readExecutionResources` 自体は
       * 変えない** ——これは兄弟として `resources` へ合流させるだけの値で、
       * `pids` の中へは入れない（`runnerExecutionResourcesSchema` の `tasks` の
       * doc）。`undefined`（`/proc` が無い環境）なら欄ごと出さない。
       */
      const tasks = await taskBreakdownReader.read();
      const resources = {
        ...(await readExecutionResources()),
        ...(tasks === undefined ? {} : { tasks }),
      };
      return c.json({
        ok: true,
        runnerId: host.runnerId,
        /**
         * **いまこの名前に応えているプロセスがどれか**（roadmap M5 PR4 の判定材料）。
         *
         * `runnerId` は宛先の名前で、器を作り直しても同じである（台帳の鎖
         * `manager_id → runner_id` がそれで繋がっている）。だからこの値だけでは
         * 「新しいコンテナが応え始めた」ことを誰も観測できず、名簿は器の入れ替えと
         * 単なる回復を区別できなかった（roadmap 受け入れ基準6）。
         *
         * **安定させないこと。** ここは起動ごとに変わることが唯一の役目である
         * （`runnerId` の別名を作るのではない）。ファイルや環境変数から読んで
         * 引き継ぐ形にした瞬間、入れ替えが見えなくなる。
         *
         * **秘密ではない。** 制御面の内側だけに出る値だが、伏せる理由も無い
         * （持っていても何もできない乱数である）。
         */
        instanceId: INSTANCE_ID,
        workspacePath: host.workspacePath,
        managers: host.list().length,
        pendingEvents: outbox.pending,
        /**
         * まだデーモンへ送り出せていない出来事のうち、いちばん古いものが積まれた
         * 時刻（#358）。1件も無ければ出さない——**0 件のときに値を作らない**
         * （AGENTS.md「取れない軸に 0 の行を作る」）。
         */
        ...(outbox.oldestPendingAt === undefined
          ? {}
          : { oldestPendingAt: outbox.oldestPendingAt }),
        /**
         * 実行環境の資源（roadmap M5 PR3）。**「収容能力」ではない。**
         *
         * ここに出るのは観測値だけである。「あと何本置けるか」は runner も答えない
         * — それは定員であって、配置の判断は名簿の側（`select`）にある
         * （north_star 禁止2 / `runnerExecutionResourcesSchema`）。
         *
         * **`os` の値を出さない。** ホストの数を名乗ると、同じホストに並んだ runner が
         * 全部同じ数を報告し、資源で選んでいるつもりで登録順に選ぶことになる
         * （実測は `readExecutionResources`）。
         */
        resources,
        /**
         * いま配っている鍵の**指紋だけ**。値は決して出さない。
         *
         * これが無いと、人間が置いた鍵とマネージャーが握っている鍵が同じかどうかを
         * 誰も確かめられず、「鍵の権限が足りない」のか「鍵が届いていない」のかを
         * 切り分けられない。実際にその切り分けができずに一晩溶けたことがある。
         */
        credentials: host.credentials(),
        /** 置いてある実行環境プロファイルの**指紋だけ**。本文は出さない。 */
        profile: host.profile(),
        /**
         * 自分がどのコミットで走っているか。
         *
         * **デーモンと runner は別 Service で別々にビルド・デプロイされる**
         * （`railway/daemon.json` / `railway/runner.json`）。同じ `main` から
         * 起こしていても、デプロイのタイミングがずれれば別コミットで走る窓が
         * できる——その窓でだけ壊れるものは、両者が自分の版を名乗れて初めて
         * 見つかる。デーモンはこれを heartbeat（`identity()`）で拾い、名簿の
         * `RunnerEntry.revision` へ運ぶ（`packages/core/src/runner-protocol.ts`）。
         *
         * **取れなければ全項目 `null`。** プレースホルダは作らない
         * （`resolveBuildRevision` の doc）。
         */
        revision,
      });
    })

    /**
     * 鍵の差し替え。**制御面なので、runner の中のマネージャーからは叩けない。**
     *
     * ここが叩けてしまうと、マネージャーは自分に配られる鍵を自分で書き換えられる。
     * 門番（`control`）を外さないこと。
     */
    .post('/credentials', zValidator('json', runnerSetCredentialsCommandSchema), async (c) => {
      const fingerprints = await host.setCredentials(c.req.valid('json').credentials);
      return c.json({ ok: true, credentials: fingerprints });
    })

    /**
     * 実行環境プロファイル（`.zprofile` 相当）の差し替え。
     *
     * **鍵の差し替えと同じく制御面である。** マネージャーが叩けると、自分に効く
     * 環境をも自分で書き換えられる（門番を外さないこと）。
     *
     * **置く前に評価する。** 構文を間違えたスクリプトを `BASH_ENV` に載せると、
     * 以後すべてのコマンドが壊れた環境で走り、原因はどこにも出ない。壊れていれば
     * 置かずに理由を返す（前のものが残る）。
     */
    .get('/profile', (c) => c.json({ ok: true, profile: host.profile() }))
    .post('/profile', zValidator('json', runnerSetProfileCommandSchema), async (c) => {
      const result = await host.setProfile(c.req.valid('json').script);
      return c.json(result);
    })

    /**
     * 出来事のストリーム。**接続を張るのはデーモン側**である。
     *
     * 1本だけが購読する前提（デーモンは1つ）。繋ぎ直しのたびに、溜まっていた分から
     * 流し直す。
     *
     * **heartbeat が要る。** この経路は `hello` を1回書いたあと、`outbox` に何か
     * 積まれるまで文字通り1バイトも流れない —— マネージャーが黙っていれば無音は
     * いくらでも続く。読む側（デーモン）は Node 内蔵の `fetch`（undici）で、
     * その既定 `bodyTimeout` は 300000ms である。**無音が5分続くと必ず切れる**
     * （実測: `TypeError: terminated` / `cause.code = UND_ERR_BODY_TIMEOUT` /
     * `elapsed_ms = 300826`）。undici のタイマーは**1バイトでも届けば延長される**
     * ので、コメント行の heartbeat で塞げる。
     *
     * 切れると runner は繋ぎ直しのたびに `hello` を書き、デーモンはそれを全部
     * `#reattach` へ通す（`packages/core/src/manager.ts`）ので、**5分ごとの切断は
     * そのまま5分ごとの `#reattach` になる。** 塞ぐのはその両方である。
     *
     * **`Last-Event-ID` を受け取る（#275）。** `writeSSE` が例外を投げずに正常
     * 返却したのに相手には届いていなかった1件（無音切断）を、outbox の控え
     * （`Outbox.sentSince`）から読み返して配り直す。詳細は `Outbox` の doc。
     */
    .get('/events', (c) =>
      streamSSE(c, async (stream) => {
        const queue: { event: RunnerEvent; queuedAt: string; seq: OutboxSeq }[] = [];
        let wake: (() => void) | null = null;
        let closed = false;

        /**
         * **`writeSSE` の途中で止まっている1件**（#358）。
         *
         * 固着はまさにここで起きる —— 相手が読まなくなった接続では
         * `await stream.writeSSE(...)` が返らない。**`queue` から出た後なので、
         * ここで持たないとどこにも数えられない。**
         */
        let writing: { event: RunnerEvent; queuedAt: string; seq: OutboxSeq } | null = null;

        /**
         * **無音切断からの復元（#275）。** デーモンは繋ぎ直すとき、直前までに
         * 受け取れた最後の連番を `Last-Event-ID` ヘッダへ乗せてくる
         * （`apps/daemon/src/runner-client.ts`）。runner はそれより新しく
         * 「渡したはず」だった分を outbox の控え（{@link Outbox.sentSince}）
         * から読み返し、この接続の `queue` の先頭へ積む——`await
         * stream.writeSSE()` が例外を投げずに正常返却したのに相手には届いて
         * いなかった1件が、跡なく消える窓を塞ぐ（Issue #275 本文）。
         *
         * **申告が無い（初回接続）か、数値として読めないときは何もしない。**
         * 壊れた申告を理由にストリームを開けないより、控えを読まずに普段
         * どおり始めるほうを選ぶ——`sentSince` を呼ばなければ実害は無い
         * （控えは outbox 側に残ったままで、次の正しい申告を待てる）。
         *
         * **`queue` へ積む段階では、まだ outbox の通常の待ち行列（まだ一度も
         * 渡していない分）を読んでいない。** 下の `outbox.attach(...)` が
         * それを同期的に流し込むのはこの後——だから並び順は「控え（古い）→
         * 通常の待ち行列（新しい）」のまま保たれる。
         */
        const lastEventIdHeader = c.req.header('Last-Event-ID');
        if (lastEventIdHeader !== undefined) {
          const lastEventId = Number(lastEventIdHeader);
          if (Number.isInteger(lastEventId) && lastEventId >= 0) {
            for (const item of outbox.sentSince(lastEventId)) queue.push(item);
          }
        }

        const detach = outbox.attach(
          (event, seq) => {
            queue.push({ event, queuedAt: new Date().toISOString(), seq });
            wake?.();
          },
          // **この口を渡さないと、購読中の滞留が `outbox.pending` から消える**
          // （`Outbox.pending` の doc）。
          () => {
            // 書きかけの1件がいちばん古い（`queue` より先に出たものだから）。
            const oldest = writing ?? queue[0];
            return {
              count: queue.length + (writing === null ? 0 : 1),
              ...(oldest === undefined ? {} : { oldestAt: oldest.queuedAt }),
            };
          },
        );
        stream.onAbort(() => {
          closed = true;
          wake?.();
        });

        await stream.writeSSE({
          event: 'hello',
          data: JSON.stringify({ type: 'hello', runnerId: host.runnerId }),
        });

        // heartbeat は SSE のコメント行を流す（読む側は読み捨てる —— デーモンの
        // `#read` は `data:` で始まる行だけを拾うので、跡にも数えられない）。
        // 死んだ接続の掃除の契機でもある（詳細は `@alteroid/core` の `sse-heartbeat.ts`）。
        const stopHeartbeat = startSseHeartbeat(stream, sseHeartbeatMs, () => wake?.());

        try {
          for (;;) {
            if (closed || stream.aborted || stream.closed) break;
            const item = queue.shift();
            if (item === undefined) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              wake = null;
              continue;
            }
            // **書き終わるまで手放さない**（#358）。`queue` から出た瞬間に忘れると、
            // まさに固着している1件が数え上げから消える。
            writing = item;
            // **`id` に連番を乗せる**（#275）。JSON の中身（`RunnerEvent`）は
            // 変えない——SSE のフレーム側だけで完結させる（`OutboxSeq` の doc）。
            await stream.writeSSE({
              event: item.event.type,
              data: JSON.stringify(item.event),
              id: String(item.seq),
            });
            // **投げずに返った直後、控えへ積む**（#275）。hono の `write()`
            // （`hono/dist/utils/stream.js`）は死んだ接続へ書いても例外を出さ
            // ない——ここに来たからといって相手に届いたとは限らない。届いた
            // かどうかを runner 側では確認できないので、一定量だけ手元に
            // 残し、次の接続の `Last-Event-ID` に賭ける（`Outbox.recordSent`
            // の doc）。
            outbox.recordSent(item.event, item.seq, item.queuedAt);
            // **`finally` で消さない。** 投げたときは `writing` に残したまま抜け、
            // 下の `finally` が箱へ戻す —— そうしないと、書けなかった1件だけが
            // 静かに失われる（この `finally` の意図は「流し切れなかった分は箱へ
            // 戻す」であって、書けなかった分を捨てることではない）。
            writing = null;
          }
        } finally {
          // **タイマーを先に止める。** 止めないと、ストリームが終わった後も
          // 15秒ごとに死んだ相手へ書き続ける（`write()` は例外を出さないので
          // 残っていても壊れて見えない）。
          stopHeartbeat();
          detach();
          // 流し切れなかった分は箱へ戻す（次に繋がったときに届く）。
          // **書きかけの1件も戻す**（#358）—— 書けたかどうかは分からないので、
          // 落とすより二重に届くほうを選ぶ（#206 が指す冪等化は別の穴である）。
          if (writing !== null) outbox.push(writing.event);
          for (const item of queue) outbox.push(item.event);
        }
      }),
    )

    .get('/managers', (c) => c.json({ managers: host.list() }))

    .post('/managers', zValidator('json', runnerStartCommandSchema), async (c) => {
      await host.start(c.req.valid('json'));
      return c.json({ ok: true });
    })

    /** 中断されたセッションの続きへ戻す（生ログはデーモンが持ってくる）。 */
    .post('/managers/:id/resume', zValidator('json', runnerResumeCommandSchema), async (c) => {
      const command = c.req.valid('json');
      if (command.managerId !== c.req.param('id')) {
        return c.json({ error: 'manager_id が経路と本文で食い違っている' as const }, 400);
      }
      try {
        await host.resume(command);
      } catch (error) {
        /*
         * **世代が古い resume は 409、Hono の既定 500 に落とさない。**
         *
         * `isRetryableRunnerError`（`runner-protocol.ts`）は 5xx を「待てば直る」に
         * 分類する。500 のままだと、遅れて届いた古い世代の命令が「一時的な失敗」と
         * 誤解され、デーモン側の再試行が同じ古い命令を延々と投げ直す——本来は
         * 「同じものを投げ直しても同じ答えが返る」側（4xx）である。
         */
        if (error instanceof RunnerFenceError) {
          return c.json(
            { error: 'fenced' as const, expected: error.expected, given: error.given },
            409,
          );
        }
        throw error;
      }
      return c.json({ ok: true });
    })

    .post('/managers/:id/messages', zValidator('json', runnerMessageCommandSchema), async (c) => {
      const delivered = await host.send(c.req.param('id'), c.req.valid('json').text);
      if (!delivered) return c.json({ error: 'not found' as const }, 404);
      return c.json({ ok: true });
    })

    /**
     * 止まっていた確認への回答。宛先は `requestId` で指す（推測しない）。
     *
     * **`decision` は 0 件のときキーごと省く（#322）。** `outcome.decision` が
     * 無い（=届いていない）ときに `decision: undefined` を書くと、JSON では
     * キー自体が消えるので実害は無いが、`runnerAnswerResultSchema` の doc が
     * 言う「report する欄そのものを持たない」を意図どおりに保つため、明示的に
     * 省く（`pendingEvents`/`oldestPendingAt` と同じ作法。#358）。
     */
    .post('/managers/:id/answers', zValidator('json', runnerAnswerCommandSchema), async (c) => {
      const outcome = await host.answer(c.req.param('id'), c.req.valid('json'));
      return c.json({
        ok: outcome.delivered,
        ...(outcome.decision === undefined ? {} : { decision: outcome.decision }),
      });
    })

    .delete('/managers/:id', async (c) => {
      await host.stop(c.req.param('id'));
      return c.json({ ok: true });
    })

    /** 走行中セッションの生ログ（可観測性の最下段へ降りる入口）。 */
    .get('/managers/:id/transcript', async (c) => {
      const body = await host.transcript(c.req.param('id'));
      if (body === null) return c.json({ error: 'not found' as const }, 404);
      return c.text(body);
    });

  return app;
}

export type RunnerAppType = ReturnType<typeof createRunnerApp>;
