import { randomUUID } from 'node:crypto';

import {
  buildEnvToken,
  credentialOf,
  isEnvToken,
  markTokenUnusable,
  tokenAvailabilityAt,
  type TokenCredential,
  type ActiveAgentToken,
  type AgentToken,
  type TokenRotationSettings,
} from './token-pool.js';
import {
  cooldownUntilFrom,
  decideTokenRotation,
  observationFreshness,
  selectNextToken,
  type ObservationFreshness,
  type TokenRotationSignal,
  type TokenSelection,
} from './token-rotation.js';
import type { JournalEntryInput } from './schema.js';
import type { RateLimitFacts, UsageLimitNotice } from './usage-limits.js';
import type { TokenCandidateVerdict } from './token-candidate.js';
import type { Stores } from './store.js';

/**
 * 回し手（Issue #393 PR3）。**デーモンの中の1本。**
 *
 * **クローンでもマネージャーでも runner でもない。** 枠に当たった瞬間、クローンは
 * ターンを回さない（`clone.ts` の `#usageBlocked` が立って受信箱の合図が保持される）
 * ので、**切替をクローンの判断に委ねる設計はいちばん要るときにいちばん動かない。**
 *
 * ## 撒く先は外から渡す（{@link TokenSpreadPort}）
 *
 * runner へ降ろす経路は `apps/daemon` に在り、クローンの `#childEnv()` は
 * `clone.ts` に在る。**core がそのどちらにも依存しない形にしてある** ——
 * `agent-ports.ts` と同じ理由で、境界を1ターンぶんの操作に引く。
 *
 * ## 直列化
 *
 * **書く操作はすべて1本の列を通る**（`profile-service.ts` / `token-pool-service.ts`
 * と同じ形）。支出上限に当たったとき走行中のマネージャーが2本同時に同じ文言を
 * 返した実測があり（`usage-limits.ts` の doc）、**並列に回すとプールを一気に食う。**
 * 世代の照合（{@link observationFreshness}）と合わせて二重に塞いである——照合だけだと
 * 「読んでから書くまで」の隙間に2本目が入る。
 */

/** 撒いた先1つぶんの結果。**「撒いた」と「効いた」は別である。** */
export interface TokenSpreadResult {
  /** 撒く先の名前（日誌に出る。`runner-primary` / `clone` など）。 */
  target: string;
  ok: boolean;
  /** 失敗した理由。**トークンの値を含めないこと。** */
  error?: string;
}

/**
 * 現役を撒く口。**core の外（デーモン）が実装する。**
 *
 * **⚠️ 撒いた先が「新しいトークンで走っている」ことは、この口では確かめられない。**
 * env はプロセス起動時に凍るので、**走っているマネージャーにも走っているクローンの
 * セッションにも届かない**（`credentials.ts` / `profile.ts` の doc が同じ境界を
 * 何度も書いている）。ここが `ok` を返すのは「置いた」までである。
 *
 * ⟹ **「撒いた」を「回った」として観測しないこと**（Issue #393 の地雷）。
 * 回ったことの権威ある証拠は、次のターンが成功することだけである。
 */
export interface TokenSpreadPort {
  /**
   * `generation` も渡す。**撒く先が「どの世代の鍵を持っているか」を名乗れないと、
   * 世代の照合（{@link observationFreshness}）が成立しない** — クローンは
   * セッションを起こす瞬間にこれを捕まえて、そのセッションの観測へ添える。
   */
  spread(token: { id: string; generation: number } & TokenCredential): Promise<TokenSpreadResult[]>;
}

/** 候補を1本試す口（PR2 の `probeTokenCandidate` を包んで渡す）。 */
export interface TokenProbePort {
  probe(
    token: { id: string } & TokenCredential,
  ): Promise<
    | { verdict: 'usable' }
    | { verdict: 'unusable'; reason: string; retryAt?: number }
    | { verdict: 'undecidable'; reason: string }
  >;
}

/** 回した / 回さなかった結果。**日誌へそのまま出せる形にしてある。** */
export type TokenRotationOutcome =
  | {
      kind: 'ignored';
      signal: TokenRotationSignal;
      freshness: ObservationFreshness;
      /**
       * `freshness` が `stale` のとき、**いまの現役に対して何件目の取りこぼしか**
       * （この1件を含む）。それ以外では付かない。
       *
       * **これは計器であって、挙動を分岐させる値ではない。** 捨てる判断は
       * {@link observationFreshness} が既にしていて、この数はその判断が**何回
       * 効いたか**を後から数えられるようにするためだけに在る。
       *
       * **なぜ数が要るか。** `stale` は「1回の当たりでマネージャーの数だけ届く」
       * ので全件を日誌へ出すと埋まるが、**1件も出さないと「届いていない」と
       * 見分けが付かない**——2026-08-25 の2時間40分の停止では日誌が0件で、
       * **観測が届かなかったのか `stale` で捨てられたのかを、後から誰も言えなかった。**
       * 数を持たせて間引いて出すのは、その2つを分けるためである（間引き方は
       * {@link describeTokenRotation}）。
       */
      staleRun?: number;
      why: string;
    }
  | {
      kind: 'rotated';
      /** 降りたトークンの id。**まだ一度も指名していなければ無い。** */
      fromTokenId?: string;
      toTokenId: string;
      toLabel: string;
      generation: number;
      signal: TokenRotationSignal;
      freshness: ObservationFreshness;
      /** 撒いた先ごとの結果。**「撒いた」であって「効いた」ではない。** */
      spread: TokenSpreadResult[];
      why: string;
    }
  | {
      kind: 'exhausted';
      /** いちばん早く戻るもの。**無いことがある**（プールが空・全部外された）。 */
      earliest?: { tokenId: string; label: string; cooldownUntil: number };
      /**
       * **候補を試し切る前に打ち切ったか**（Issue #393）。付くのは
       * `'budget'`（壁時計の持ち時間を使い切った）のときだけである。
       *
       * **これが無いときの `exhausted` は「試し切って、どれも駄目だった」を意味する。**
       * 付いているときは**まだ試していない候補が残っている** —— 両者を同じ顔にすると、
       * 「全部だめ」と「時間切れ」が出力から区別できなくなる。
       *
       * **⚠️ 日誌の `event` はどちらも `exhausted` である。** あちらは
       * `schema.ts` の `z.enum` 5値で、増やすと外向きの面（`openapi.json`）が動く。
       * ⟹ **構造の側はまだ粗い。** 区別が要るなら `text` を読むこと
       * （{@link describeTokenRotation} が打ち切りを言い分けている）。
       */
      stoppedBy?: 'budget';
      signal: TokenRotationSignal;
      freshness: ObservationFreshness;
      why: string;
    };

export interface TokenRotatorObservation {
  notice?: UsageLimitNotice;
  facts?: RateLimitFacts;
  transition?: 'entered_overage' | 'rejected';
  /**
   * その観測が**どのトークンで走っていたときのものか**。
   *
   * **省略できるようにしてあるのは、身元を運べない検知点が実在するからである**
   * ——省略された観測は {@link observationFreshness} が `unknown` を返し、
   * この回し手は**効かせる側へ倒す**（飲み込むほうが悪い。あちらの doc）。
   * 倒した事実は `freshness` として結果に残る。
   */
  observedBy?: { tokenId?: string; generation?: number };
}

export interface TokenRotatorOptions {
  stores: Stores;
  probe: TokenProbePort;
  spread: TokenSpreadPort;
  /** 現在時刻。テストで固定するため。 */
  now?: () => Date;
  /**
   * 器の環境変数（`CLAUDE_CODE_OAUTH_TOKEN`）が置かれているか（Issue #393）。
   *
   * **値そのものを受けない。** core は正本を持つが、**器の環境変数は器のもの**で
   * あって記憶ストアの正本ではない——値を持ち込むと「どちらが正か」が2つになる。
   * 要るのは「指す先が在るか」だけである。
   */
  hasEnvToken?: () => boolean;
  /** 新しい行の id を作る。テストで固定するため。 */
  newId?: () => string;
}

/**
 * 起動時の引き取りの結果（Issue #393 PR3）。**回した結果とは別の型にしてある。**
 *
 * 同じ型に畳むと、日誌から「回った」と「起動時に戻しただけ」が区別できなくなる
 * ——前者は枠に当たった証拠だが、後者は何も起きていない。
 */
export type TokenRestoreOutcome =
  | { kind: 'none'; why: string }
  | {
      kind: 'restored';
      tokenId: string;
      label: string;
      /** **増やさない。** 引き取りは回転ではないので、保存されていた値のまま。 */
      generation: number;
      /** 撒き直した相手が冷却中だったか。**撒くことは変えず、事実だけ返す。** */
      cooling: boolean;
      spread: TokenSpreadResult[];
      why: string;
    }
  | { kind: 'dangling'; tokenId: string; why: string }
  | { kind: 'withheld'; tokenId: string; label: string; why: string };

export interface TokenRotator {
  /**
   * 観測を1つ受ける。**回すかどうかもここが決める。**
   *
   * 呼ぶ側（クローンの `#noteUsageNotice` と `ManagerPool#onEvent`）は判定を持たない
   * ——6つの検知点が同じ1本へ合流する形にしてあるのが、この設計の骨である。
   */
  observe(observation: TokenRotatorObservation): Promise<TokenRotationOutcome>;
  /**
   * **起動時に1度だけ**、記憶ストアが「現役」と言っているトークンを撒き直す。
   *
   * ## なぜ要るか
   *
   * 撒いた先（runner の env・クローンの箱）は**プロセスと一緒に消える**が、現役の
   * 指名は記憶ストアに残る。⟹ これが無いと、デーモンを再起動した直後は**器の
   * 環境変数のトークンが走っているのに、記憶ストアは別のトークンを現役だと思って
   * いる**という食い違いが残る。その状態で枠に当たると、**走ってもいないトークンを
   * 冷却へ入れて**候補を1本無駄に飛ばす。
   *
   * ## 引き取りは回転ではない
   *
   * - **世代を増やさない**（増やすと、まだ有効な観測が `stale` として捨てられる）
   * - **記憶ストアへ書かない**（`updatedAt` が動くと「変わっていないのに変わった」になる）
   * - **候補を選び直さない。** 現役が冷却中でも**そのまま撒く** — 選び直すのは枠に
   *   当たったときだけであり、**起動を新しい契機にしない**（Issue #393 が挙げる
   *   契機は枠の2つだけである）。冷却中だったことは `cooling` で返す
   *
   * ## 4つの結果を畳まない
   *
   * | 結果 | 何が起きたか | この後どうなるか |
   * | --- | --- | --- |
   * | `none` | 一度も回していない | 器の環境変数がそのまま効く |
   * | `restored` | 撒き直した | 記憶ストアと実際が揃う |
   * | `dangling` | 指名の先の行が消えている | 環境変数が効く。**次に枠へ当たれば直る** |
   * | `withheld` | 人間がその行を外した / 失効している | 同上 |
   *
   * **`dangling` と `withheld` では撒かない。** 人間が外したものを起動時に戻すのは、
   * **人間の判断を実装が黙って覆すこと**である。食い違いは残るが、次の当たりで
   * 回し手が正しい候補へ移る（消えた / 外された id は候補から外れる）——だから
   * `why` に出して見えるようにするだけにしてある。
   */
  restore(): Promise<TokenRestoreOutcome>;
  /**
   * 器の環境変数を指す行が無ければ足す（Issue #393）。**起動時に1度だけ。**
   *
   * ## なぜ要るか
   *
   * 器の環境変数のトークンには、これまでプールの行が無かった。⟹ **それが枠に
   * 当たっても、いつ・何と言われたかがどこにも残らない。** 回し手は現役の行を
   * 冷却へ入れるが、環境変数は行を持たないので入れる先が無い。**最初に止まった
   * 1本だけが台帳から消える**——しかもそれは、たいてい人間が最初に踏む1本である。
   *
   * ## 人間が書いた行ではなく、事実の射影である
   *
   * 器に環境変数が置かれているという事実を1行として表しているだけなので、
   * **消しても次の起動で戻る。** 「もう使わない」を表したいなら
   * `alteroid token disable`（{@link AgentToken.disabledAt}）を使う——そちらは
   * 人間の判断なので戻らない（この関数は行が在れば何もしない）。
   *
   * ## ⚠️ プールが空なら足さない
   *
   * **受け入れ基準7（プールが空の既定構成の挙動を1文字も変えない）を字義どおり
   * 守るためである。** 人間が1本も登録していない＝プールを使うと決めていない器で、
   * 記憶ストアに行が生えて日誌に線が増えるのは、たとえ挙動が同じでも「1文字も
   * 変えない」ではない。**人間が1本でも登録した時点で**環境変数の行が生える。
   *
   * **環境変数が置かれていなければ足さない**（指す先が無いので）。
   */
  ensureEnvToken(): Promise<TokenEnsureEnvOutcome>;
}

/** {@link TokenRotator.ensureEnvToken} の結果。**足したかどうかを畳まない。** */
export type TokenEnsureEnvOutcome =
  | { kind: 'added'; tokenId: string; why: string }
  | { kind: 'exists'; tokenId: string }
  | { kind: 'skipped'; why: string };

/**
 * 1回の観測で、候補を試すことに使ってよい壁時計の持ち時間（ミリ秒）。
 *
 * **件数ではなく時間で切る。** 件数の上限は**占有する時間を縛らない** ——
 * probe は1本あたり最大 `USAGE_PROBE_TIMEOUT_MS`（20秒）待つので、
 * 「3本まで」は「最悪60秒まで」であって、守りたいものを守っていない。
 *
 * **何を守っているか。** `observe` は `serial()` の1本の列を通るので、ここで
 * 止まっているあいだ**他の観測が全部待たされる** —— 枠に当たった知らせが列の
 * 後ろで待つ、という形になる。
 *
 * **1本目は必ず試す。** 判定は「選んでから、probe を始める前」に見るので、
 * 経過が 0 の初回はここで止まらない。**持ち時間を 0 にしても、1本は試す。**
 *
 * **打ち切ったことは黙らない**（`TokenRotationOutcome` の `stoppedBy`）。
 * 黙って打ち切ると「候補を全部試した」と「時間切れでやめた」が出力から
 * 区別できなくなる。
 */
export const CANDIDATE_SWEEP_BUDGET_MS = 60_000;

export function createTokenRotator(options: TokenRotatorOptions): TokenRotator {
  const { stores, probe, spread } = options;
  const now = options.now ?? (() => new Date());
  const hasEnvToken = options.hasEnvToken ?? (() => false);
  const newId = options.newId ?? (() => randomUUID());

  /**
   * いまの現役に対して、`stale` で捨てた観測が続けて何件になったか。
   *
   * **鍵は「現役の身元」である**（id と世代の両方）——世代だけだと、同じ世代の
   * まま指名が変わったときに数え続けてしまう。回れば鍵が変わるので、数は自然に
   * 1 から数え直しになる。**明示的に消す経路を持たない**のはそのためである。
   *
   * **プロセスの寿命でしか持たない。** 記憶ストアへは書かない——これは「いま
   * 走っているデーモンが何回捨てたか」の計器であって、事実の記録ではない
   * （事実の側は日誌に出る）。
   */
  let staleRun: { key: string; count: number } | null = null;

  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work, work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * 降りるトークンを冷却へ入れて保存する。
   *
   * **選ぶより先に保存する。** 選んでから保存する順にすると、保存が落ちたときに
   * 「降りたはずのものが記録の上ではまだ健在」という版が残る——次の観測で同じ
   * トークンがまた選ばれる。
   *
   * **`resetsAt` が権威ある期限である**（`cooldownUntilFrom`）。取れなければ設定の
   * 既定へ倒す——**この関数の中に既定を持たない。**
   */
  async function coolDown(
    tokens: readonly AgentToken[],
    outgoingId: string,
    settings: TokenRotationSettings,
    observation: TokenRotatorObservation,
  ): Promise<AgentToken[]> {
    const at = now().toISOString();
    const resetsAt = cooldownUntilFrom(observation.facts);
    return stores.tokens.replace(
      tokens.map((token) =>
        token.id === outgoingId
          ? markTokenUnusable(token, {
              at,
              // **文言をそのまま残す。** 無いときは印を文言の代わりにしない
              // ——観測できたものだけを書く（`TokenFailureObservation.message`）。
              message: observation.notice?.text ?? '枠から追い返された（文言は届いていない）',
              ...(resetsAt === undefined ? {} : { resetsAt }),
              fallbackCooldownMs: settings.cooldownMs,
            })
          : token,
      ),
    );
  }

  return {
    ensureEnvToken: () =>
      serial(async () => {
        const tokens = await stores.tokens.list();
        // **プールが空なら足さない**（受け入れ基準7。この関数の doc）。
        if (tokens.length === 0) {
          return {
            kind: 'skipped' as const,
            why: 'プールが空（人間がまだ1本も登録していない器では、行を作らない）',
          };
        }
        const existing = tokens.find(isEnvToken);
        // **人間が外した行でも「在る」である。** 外した判断を無視して足し直さない。
        if (existing !== undefined) return { kind: 'exists' as const, tokenId: existing.id };
        if (!hasEnvToken()) {
          return {
            kind: 'skipped' as const,
            why: '器に CLAUDE_CODE_OAUTH_TOKEN が置かれていない（指す先が無い）',
          };
        }

        const row = buildEnvToken(tokens, { id: newId(), at: now().toISOString() });
        // **既存の行に触らない。** `buildEnvToken` が既存より小さい `order` を
        // 選ぶので、振り直しが要らない（振り直すと全行の `updatedAt` が動く）。
        await stores.tokens.replace([row, ...tokens]);
        return {
          kind: 'added' as const,
          tokenId: row.id,
          why: '器の環境変数を指す行をプールへ足した（枠に当たったときに記録が残るようになる）',
        };
      }),

    // **同じ列を通す。** 引き取りと観測が並ぶと、撒き直しの途中に回転が割り込んで
    // 「古い方を後から撒く」が起きる。
    restore: () =>
      serial(async () => {
        const [tokens, active] = await Promise.all([
          stores.tokens.list(),
          stores.tokens.readActive(),
        ]);

        if (active === null) {
          return {
            kind: 'none' as const,
            why: 'まだ一度も回していない（器の環境変数がそのまま効く）',
          };
        }

        const row = tokens.find((token) => token.id === active.tokenId);
        if (row === undefined) {
          // **記憶ストアへ書いて直さない。** 次の当たりで回し手が正しい候補へ移る
          // ので、ここで消すのは「見えなくする」だけの操作になる。
          return {
            kind: 'dangling' as const,
            tokenId: active.tokenId,
            why: '現役として記録された行がプールに無い（人間が消した）。器の環境変数が効いたままである',
          };
        }

        const availability = tokenAvailabilityAt(row, now().getTime());
        if (availability === 'disabled' || availability === 'invalidated') {
          // **人間が外したものを起動時に戻さない。**
          return {
            kind: 'withheld' as const,
            tokenId: row.id,
            label: row.label,
            why:
              availability === 'disabled'
                ? `現役として記録された「${row.label}」は人間が外している。撒き直さない（器の環境変数が効いたままである）`
                : `現役として記録された「${row.label}」は失効している。撒き直さない（器の環境変数が効いたままである）`,
          };
        }

        const cooling = availability === 'cooling';
        const spreadResults = await spread.spread({
          id: row.id,
          // **保存されていた世代をそのまま渡す。** ここで増やすと、まだ有効な
          // 観測が `stale` として捨てられる。
          generation: active.generation,
          ...credentialOf(row),
        });
        return {
          kind: 'restored' as const,
          tokenId: row.id,
          label: row.label,
          generation: active.generation,
          cooling,
          spread: spreadResults,
          why: cooling
            ? `現役の「${row.label}」を撒き直した。**ただし冷却中である**（次に枠へ当たれば回し手が次の候補へ移す）`
            : `現役の「${row.label}」を撒き直した`,
        };
      }),

    observe: (observation: TokenRotatorObservation) =>
      serial(async () => {
        const [tokens, settings, active] = await Promise.all([
          stores.tokens.list(),
          stores.tokens.readSettings(),
          stores.tokens.readActive(),
        ]);

        const freshness = observationFreshness(active, observation.observedBy ?? {});
        const decision = decideTokenRotation(settings.rotateOn, observation);

        // **遅れて届いた通知は、判定より先に捨てる。** 判定が「回す」でも、
        // それは*前の現役*についての話である。
        if (freshness === 'stale') {
          // **捨てた回数を数える。捨てる判断そのものは変えない。** ここで足して
          // いるのは「その判断が何回効いたか」だけである（{@link staleRun}）。
          const key = active === null ? 'none' : `${active.tokenId}#${String(active.generation)}`;
          staleRun = staleRun?.key === key ? { key, count: staleRun.count + 1 } : { key, count: 1 };
          return {
            kind: 'ignored' as const,
            signal: decision.signal,
            freshness,
            staleRun: staleRun.count,
            why: 'もう回した後の通知（世代が合わない）',
          };
        }

        if (!decision.rotate) {
          return {
            kind: 'ignored' as const,
            signal: decision.signal,
            freshness,
            why: decision.why,
          };
        }

        // **プールが空なら何もしない。** 器の環境変数1本きりの既定の構成が
        // ここへ来ても、記録も撒きも起こらない（受け入れ基準7）。
        if (tokens.length === 0) {
          return {
            kind: 'exhausted' as const,
            signal: decision.signal,
            freshness,
            why: 'プールにトークンが1本も無い（器の環境変数だけの構成。回す先が無い）',
          };
        }

        // 降りるトークン。**まだ指名していなければ、降りるものは無い**——
        // その場合は冷却へ入れる相手も居ないので、選ぶだけになる。
        const outgoingId = active?.tokenId;
        const afterCoolDown =
          outgoingId === undefined
            ? tokens
            : await coolDown(tokens, outgoingId, settings, observation);

        // **候補を1本ずつ試す（Issue #393「回し方」の 2〜4 の繰り返し）。**
        //
        // Issue 本文は逐語で「`使えない` → **2 へ戻って次の候補**」と書いている。
        // ここが1本で打ち切っていたので、**候補が残っていても `exhausted`（＝全層が
        // 止まる、の顔）になっていた。**
        //
        // **外すのは記録ではなく、その場の集合である。** 冷却の印を配列へ反映した
        // だけでは次の周でまた選ばれうる —— `resetsAt` が既に過去なら印を付けた
        // 直後でも `ready` に見える（`markTokenUnusable` の doc: 過去の値を未来へ
        // 丸めない）。
        const tried = new Set<string>();
        if (outgoingId !== undefined) tried.add(outgoingId);
        const sweepStartedAt = now().getTime();

        // **冷却の印はここに積むだけで、まだ保存しない**（保存はループの後で1回）。
        let sweptTokens = afterCoolDown;
        const unusableLabels: string[] = [];
        let chosen: { token: AgentToken; verdict: TokenCandidateVerdict } | undefined;
        let ranOut: Extract<TokenSelection, { kind: 'none' }> | undefined;
        let stoppedByBudget = false;

        for (;;) {
          const selection = selectNextToken(sweptTokens, {
            at: now().getTime(),
            exclude: [...tried],
          });
          if (selection.kind === 'none') {
            ranOut = selection;
            break;
          }
          // **持ち時間は「選んでから、probe を始める前」に見る。** 初回は経過が 0 なので
          // 必ず1本は試す（`CANDIDATE_SWEEP_BUDGET_MS` の doc）。
          if (now().getTime() - sweepStartedAt >= CANDIDATE_SWEEP_BUDGET_MS) {
            stoppedByBudget = true;
            break;
          }
          tried.add(selection.token.id);

          // **候補を本番の仕事で試さない**（Issue #393 の設計の骨）。推論が走らない
          // probe で確かめる。3値のうち `unusable` だけが候補を1本飛ばす。
          const verdict = await probe.probe({
            id: selection.token.id,
            ...credentialOf(selection.token),
          });
          if (verdict.verdict !== 'unusable') {
            chosen = { token: selection.token, verdict };
            break;
          }

          // **飛ばした候補も冷却へ入れる。** 入れないと次の観測で同じものが
          // 最初の候補として選ばれ、probe を毎回焼く。
          const at = now().toISOString();
          sweptTokens = sweptTokens.map((token) =>
            token.id === selection.token.id
              ? markTokenUnusable(token, {
                  at,
                  message: verdict.reason,
                  ...(verdict.retryAt === undefined ? {} : { resetsAt: verdict.retryAt }),
                  fallbackCooldownMs: settings.cooldownMs,
                })
              : token,
          );
          unusableLabels.push(selection.token.label);
        }

        // **冷却の印は、ここで1回だけ保存する。**
        //
        // **周ごとに保存すると、途中で落ちたときに「一部の候補にだけ冷却が付いて、
        // 結果は誰にも届かない」版が残る** —— 保存の失敗はこの関数の外まで投げ、
        // 呼ぶ側は跡を1行残してそのターンを捨てる（再送も再試行も無い）。
        //
        // **無駄と嘘を分ける。** まとめて1回にすると、落ちたときは印が丸ごと残らず、
        // 次の観測が同じ候補をもう一度 probe する —— **それは無駄なだけで、記憶ストア
        // と現実をずらさない。** 一部だけ残るほうは、ずらす。
        //
        // **回す前に保存する。** ここで落ちたら回さない —— `writeActive` が落ちた
        // ときと同じ倒れ方である（`it('撒く前に正本を書く（保存が落ちたら撒かない）')`
        // が固定している形）。
        if (unusableLabels.length > 0) await stores.tokens.replace(sweptTokens);

        if (chosen === undefined) {
          const skipped =
            unusableLabels.length === 0
              ? ''
              : `。試した候補「${unusableLabels.join('」「')}」はどれも使えなかった`;
          return {
            kind: 'exhausted' as const,
            // **打ち切ったときは `earliest` を出さない。** 出せる材料が無い
            // （まだ試していない候補は冷却中ではないので、`selectNextToken` の
            // 見立てが取れていない）。**無いものを埋めない。**
            ...(stoppedByBudget || ranOut?.earliest === undefined
              ? {}
              : { earliest: ranOut.earliest }),
            ...(stoppedByBudget ? { stoppedBy: 'budget' as const } : {}),
            signal: decision.signal,
            freshness,
            // **試した後は `selectNextToken` の文言をそのまま使わない。** あちらは
            // 「プールが空、または降りた1本しか無い」と書く —— **試して外した分も
            // 「無い」に見えているだけ**なので、そのまま出すと**候補が4本在ったのに
            // 「プールが空」と読める行**になる。
            why: stoppedByBudget
              ? `候補を試す持ち時間（${String(CANDIDATE_SWEEP_BUDGET_MS)}ms）を使い切った${skipped}`
              : unusableLabels.length > 0
                ? `試せる候補を使い切った${skipped}`
                : (ranOut?.why ?? '候補が無い'),
          };
        }

        const selection = { token: chosen.token };
        const verdict = chosen.verdict;

        // `undecidable` は**撒く側へ倒す**（Issue #393「回し方」の3値）。判定でき
        // ないことを理由に候補を捨てない。
        const generation = (active?.generation ?? 0) + 1;
        const rotatedAt = now().toISOString();

        // **正本を先に書く。** 撒いてから保存する順にすると、保存が落ちたときに
        // 「誰も成功と言っていない版を1層だけが使う」が残る（`profile-service.ts`
        // が同じ失敗をして直した形）。
        const nextActive: ActiveAgentToken = {
          tokenId: selection.token.id,
          generation,
          rotatedAt,
        };
        await stores.tokens.writeActive(nextActive);

        const spreadResults = await spread.spread({
          id: selection.token.id,
          generation,
          ...credentialOf(selection.token),
        });

        return {
          kind: 'rotated' as const,
          ...(outgoingId === undefined ? {} : { fromTokenId: outgoingId }),
          toTokenId: selection.token.id,
          toLabel: selection.token.label,
          generation,
          signal: decision.signal,
          freshness,
          spread: spreadResults,
          why:
            verdict.verdict === 'usable'
              ? `${decision.why}。候補「${selection.token.label}」は観測できた`
              : `${decision.why}。候補「${selection.token.label}」は判定できなかったので撒いて本番で確かめる（${verdict.reason}）`,
        };
      }),
  };
}

// ---------------------------------------------------------------------------
// 日誌へ出す（Issue #393 PR5）
// ---------------------------------------------------------------------------

/**
 * 撒いた先の結果を1行に畳む。**失敗した先を落とさない。**
 *
 * 「2台のうち1台だけ落ちた」を消さないために、**成功だけを数えて `2/3` のように
 * 書かない** —— どれが落ちたのかが読めなくなる。落ちた先は名前と理由をそのまま出す。
 */
function describeSpread(results: readonly TokenSpreadResult[]): string {
  if (results.length === 0) return '撒いた先: 無し';
  const failed = results.filter((result) => !result.ok);
  const ok = results.filter((result) => result.ok).map((result) => result.target);
  const parts: string[] = [];
  if (ok.length > 0) parts.push(`置けた: ${ok.join(', ')}`);
  for (const result of failed) {
    parts.push(`**置けなかった: ${result.target}**（${result.error ?? '理由不明'}）`);
  }
  return parts.join(' / ');
}

/**
 * 回した / 回せなかった結果を、日誌の1行にする。**出さないときは `null`。**
 *
 * ## 何を出さないか
 *
 * - **世代が合わない通知（`stale`）の2件目以降** —— 同じ当たりでマネージャーの数だけ
 *   届くので、全件出すと1回の当たりで日誌が何行も埋まる。**間引いて出す**——
 *   初出と、以降は10の冪（10件目・100件目…）だけ。数は `staleRun` が運ぶ
 *
 *   **⚠️ かつてここは1件も出していなかった。それをやめた理由を残す。**
 *   `stale` は「本物の当たりを飲み込む」側の倒し方で、しかも
 *   {@link observationFreshness} の doc 自身が「**見えない**（何も起きないので）」と
 *   書いている。**実際に見えなくなった**——2026-08-25T22:03Z からの2時間40分、
 *   マネージャー層が全滅しているあいだ日誌は0件で、**観測が回し手へ届かなかったのか、
 *   届いて `stale` で捨てられたのかを、後から誰も言えなかった。** 間引きは
 *   「埋まる」を避けるためのもので、**0件にすることは、その2つを見分ける手段を
 *   捨てることだった**
 * - **`signal` が `none`（回す材料が何も無い観測）** —— 毎ターン届く `rate_limit_event`
 *   がここへ落ちるので、出すと日誌が枠の状態で埋まる
 *
 * **⚠️ それ以外は出す。** 「回さないと決めた」も記録である（受け入れ基準8:
 * 回した事実・回せなかった事実が日誌に残る）——設定が `off` のあいだに何回止まったか、
 * `org_policy` で何回見送ったかは、後から効いてくる。
 *
 * ## 値を出さない
 *
 * {@link TokenRotationOutcome} は**そもそも値を持たない型**なので、ここで書き
 * 忘れる余地が無い。出るのは `label` と `id` と、SDK が出した文言だけである。
 *
 * ## 文言はそのまま
 *
 * 当たった文言は呼ぶ側が `notice.text` として添える。**言い換えないこと**
 * （Issue #393「当たった文言は言い換えずそのまま残す」）——人間が claude.ai と
 * 突き合わせられる形であることと、`limitRecoveryOf` の分類が効くことの両方が
 * ここに乗っている。
 */
/**
 * 間引いて出す位置か。**初出（1件目）と、以降は10の冪だけ。**
 *
 * **件数で上限を切らない**（`AGENTS.md` の地雷「一覧の上限を件数だけで決める」と
 * 同じ向き）——上限だと、越えた先が丸ごと見えなくなる。10の冪なら**桁が上がる
 * たびに1行出る**ので、「まだ続いている」ことと「どれくらい続いたか」が両方残る。
 *
 * **落としたことは出力に書く**（呼ぶ側が「これは連番ではない」と添える）。
 * 黙って間引くと、読み手には全件出ているように見える。
 */
function isThinnedMilestone(count: number): boolean {
  if (count === 1) return true;
  if (count < 10) return false;
  // 10 / 100 / 1000 … だけ。**浮動小数の対数を使わない**（`Math.log10(1000)` が
  // 2.9999… になる器が在り、桁が上がった回だけ静かに出なくなる）。
  for (let milestone = 10; milestone <= count; milestone *= 10) {
    if (milestone === count) return true;
  }
  return false;
}

export function describeTokenRotation(
  outcome: TokenRotationOutcome,
  observed?: { noticeText?: string },
): string | null {
  const tail = observed?.noticeText === undefined ? '' : `\n当たった文言: ${observed.noticeText}`;

  if (outcome.kind === 'ignored') {
    if (outcome.freshness === 'stale') {
      const run = outcome.staleRun;
      // **数が無ければ出さない**（この分岐へ数を付けない呼び方が在れば、そちらは
      // 従来どおり黙る）。**数を 1 で埋めない**——埋めると「初出」が捏造される。
      if (run === undefined || !isThinnedMilestone(run)) return null;
      return (
        `認証トークン: 回さなかった（${outcome.signal}）。${outcome.why}。` +
        `いまの現役に対して${String(run)}件目である（**捨てた側の計器**。` +
        '初出と10の冪だけ出しているので、これは連番ではない)' +
        tail
      );
    }
    if (outcome.signal === 'none') return null;
    return `認証トークン: 回さなかった（${outcome.signal}）。${outcome.why}${tail}`;
  }

  if (outcome.kind === 'exhausted') {
    // **打ち切ったときに「戻る見込みが1本も無い」と言わない。** 既定の文言は
    // 「試し切って、どれも戻る見込みが無かった」を意味する —— 持ち時間で
    // 打ち切った回にそれを出すと、**まだ試していない候補が在るのに「1本も無い」と
    // 言う**ことになる（`stoppedBy` の doc）。
    const earliest =
      outcome.stoppedBy === 'budget'
        ? '**まだ試していない候補が残っている**（戻る見込みは測っていない）'
        : outcome.earliest === undefined
          ? '**戻る見込みの立っている候補が1本も無い**'
          : `いちばん早く戻るのは「${outcome.earliest.label}」（${new Date(outcome.earliest.cooldownUntil).toISOString()}）`;
    return `認証トークン: **回せなかった**（${outcome.signal}）。${outcome.why}。${earliest}${tail}`;
  }

  const from = outcome.fromTokenId === undefined ? '（指名なし）' : outcome.fromTokenId;
  return (
    `認証トークン: **回した**（${outcome.signal} / 世代 ${String(outcome.generation)}）。` +
    `${from} → 「${outcome.toLabel}」（id ${outcome.toTokenId}）。${outcome.why}\n` +
    `${describeSpread(outcome.spread)}\n` +
    '**⚠️ 撒いたのであって、回ったのではない** — 走行中のセッションには届かない。' +
    `回ったことの証拠は次のターンが成功することだけである${tail}`
  );
}

/**
 * 起動時の引き取りを、日誌の1行にする。**出さないときは `null`。**
 *
 * **`none`（一度も回していない）は出さない。** 既定の構成では毎回の起動で出る
 * ことになり、意味のある行が埋もれる。
 */
export function describeTokenRestore(outcome: TokenRestoreOutcome): string | null {
  if (outcome.kind === 'none') return null;
  if (outcome.kind === 'restored') {
    return (
      `認証トークン: 起動時に現役を撒き直した（世代 ${String(outcome.generation)}、増やしていない）。` +
      `「${outcome.label}」（id ${outcome.tokenId}）${outcome.cooling ? '。**冷却中である**' : ''}\n` +
      describeSpread(outcome.spread)
    );
  }
  return `認証トークン: 起動時に撒き直せなかった。${outcome.why}`;
}

/**
 * 認証トークンの日誌エントリ（追記の入力の形）。
 *
 * **`JournalEntryInput` をそのまま返さない。** あちらは全種別の union なので、
 * 呼ぶ側が `entry.text` を読めない（`text` を持たない種別が混ざっている）。
 * stderr へ出す1行はこの `text` そのものなので、**union へ広げると呼ぶ側が
 * 文言を自分で組み直すことになり、日誌と stderr で言い方が分かれる。**
 */
export type TokenRotationEntry = Extract<JournalEntryInput, { type: 'token_rotation' }>;

/**
 * 回した / 回さなかったを**日誌の1件**にする。**出さないときは `null`。**
 *
 * **出す・出さないの判定は {@link describeTokenRotation} 1つに任せる。** ここで
 * もう一度書くと、stderr には出るのに日誌には出ない（あるいは逆）という食い違いが
 * 静かに生まれる —— そして「出なかった」は、出ていないので気づけない。
 *
 * **`exchange` ではなく専用の種別を使う理由**は `schema.ts` の `token_rotation` の
 * doc に在る（`exchange` は53箇所が書く雑多入れで、絞る先が無い）。
 */
export function tokenRotationEntry(
  outcome: TokenRotationOutcome,
  observed?: { noticeText?: string },
): TokenRotationEntry | null {
  const text = describeTokenRotation(outcome, observed);
  if (text === null) return null;
  const common = {
    type: 'token_rotation' as const,
    signal: outcome.signal,
    freshness: outcome.freshness,
    ...(observed?.noticeText === undefined ? {} : { noticeText: observed.noticeText }),
    text,
  };
  if (outcome.kind === 'rotated') {
    return {
      ...common,
      event: 'rotated',
      tokenId: outcome.toTokenId,
      label: outcome.toLabel,
      ...(outcome.fromTokenId === undefined ? {} : { fromTokenId: outcome.fromTokenId }),
      generation: outcome.generation,
    };
  }
  if (outcome.kind === 'exhausted') {
    return {
      ...common,
      // **打ち切りを `exhausted` と名乗らせない。** `exhausted` は「候補が無い ＝
      // 全層が止まる」で、`earliestAt` が無ければ「戻る見込みの立つ候補が1本も無い」
      // を意味する（`schema.ts` の doc）。**打ち切った回は候補がまだ残っている。**
      event: outcome.stoppedBy === 'budget' ? 'sweep_stopped' : 'exhausted',
      // **無いことを埋めない。** 「戻る見込みの立っている候補が1本も無い」と
      // 「すぐ戻る」を同じ形にしない（`earliest` の doc）。
      ...(outcome.earliest === undefined
        ? {}
        : {
            tokenId: outcome.earliest.tokenId,
            label: outcome.earliest.label,
            earliestAt: new Date(outcome.earliest.cooldownUntil).toISOString(),
          }),
    };
  }
  return { ...common, event: 'not_rotated' };
}

/**
 * 起動時の引き取りを**日誌の1件**にする。**出さないときは `null`。**
 *
 * 判定を {@link describeTokenRestore} に任せる理由は {@link tokenRotationEntry} と
 * 同じである。
 */
export function tokenRestoreEntry(outcome: TokenRestoreOutcome): TokenRotationEntry | null {
  const text = describeTokenRestore(outcome);
  if (text === null) return null;
  if (outcome.kind === 'restored') {
    return {
      type: 'token_rotation',
      event: 'restored',
      tokenId: outcome.tokenId,
      label: outcome.label,
      // **増えていない**（引き取りは回転ではない。`TokenRestoreOutcome` の doc）。
      generation: outcome.generation,
      text,
    };
  }
  // `dangling` / `withheld` / `failed`。**`tokenId` は在れば載せる** —— どの指名が
  // 撒けなかったのかは、次に何を確かめるかを決める材料である。
  return {
    type: 'token_rotation',
    event: 'restore_failed',
    ...('tokenId' in outcome ? { tokenId: outcome.tokenId } : {}),
    ...('label' in outcome ? { label: outcome.label } : {}),
    text,
  };
}
