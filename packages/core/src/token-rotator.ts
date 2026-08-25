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
} from './token-rotation.js';
import type { RateLimitFacts, UsageLimitNotice } from './usage-limits.js';
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

export function createTokenRotator(options: TokenRotatorOptions): TokenRotator {
  const { stores, probe, spread } = options;
  const now = options.now ?? (() => new Date());
  const hasEnvToken = options.hasEnvToken ?? (() => false);
  const newId = options.newId ?? (() => randomUUID());

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
          return {
            kind: 'ignored' as const,
            signal: decision.signal,
            freshness,
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

        const selection = selectNextToken(afterCoolDown, {
          at: now().getTime(),
          ...(outgoingId === undefined ? {} : { exclude: outgoingId }),
        });

        if (selection.kind === 'none') {
          return {
            kind: 'exhausted' as const,
            ...(selection.earliest === undefined ? {} : { earliest: selection.earliest }),
            signal: decision.signal,
            freshness,
            why: selection.why,
          };
        }

        // **候補を本番の仕事で試さない**（Issue #393 の設計の骨）。推論が走らない
        // probe で確かめる。3値のうち `unusable` だけが候補を1本飛ばす。
        const verdict = await probe.probe({
          id: selection.token.id,
          ...credentialOf(selection.token),
        });
        if (verdict.verdict === 'unusable') {
          // **飛ばした候補も冷却へ入れる。** 入れないと次の観測で同じものが
          // 最初の候補として選ばれ、probe を毎回焼く。
          const at = now().toISOString();
          await stores.tokens.replace(
            afterCoolDown.map((token) =>
              token.id === selection.token.id
                ? markTokenUnusable(token, {
                    at,
                    message: verdict.reason,
                    ...(verdict.retryAt === undefined ? {} : { resetsAt: verdict.retryAt }),
                    fallbackCooldownMs: settings.cooldownMs,
                  })
                : token,
            ),
          );
          return {
            kind: 'exhausted' as const,
            signal: decision.signal,
            freshness,
            why: `候補「${selection.token.label}」も使えなかった（${verdict.reason}）`,
          };
        }

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
 * - **世代が合わない通知（`stale`）** —— 同じ当たりでマネージャーの数だけ届くので、
 *   出すと1回の当たりで日誌が何行も埋まる。**捨てたこと自体は結果として返っている**
 *   ので、必要ならそちらを見る
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
export function describeTokenRotation(
  outcome: TokenRotationOutcome,
  observed?: { noticeText?: string },
): string | null {
  const tail = observed?.noticeText === undefined ? '' : `\n当たった文言: ${observed.noticeText}`;

  if (outcome.kind === 'ignored') {
    if (outcome.freshness === 'stale') return null;
    if (outcome.signal === 'none') return null;
    return `認証トークン: 回さなかった（${outcome.signal}）。${outcome.why}${tail}`;
  }

  if (outcome.kind === 'exhausted') {
    const earliest =
      outcome.earliest === undefined
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
