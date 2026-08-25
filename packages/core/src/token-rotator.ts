import {
  markTokenUnusable,
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
  spread(token: { id: string; value: string; generation: number }): Promise<TokenSpreadResult[]>;
}

/** 候補を1本試す口（PR2 の `probeTokenCandidate` を包んで渡す）。 */
export interface TokenProbePort {
  probe(token: {
    id: string;
    value: string;
  }): Promise<
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
}

export interface TokenRotator {
  /**
   * 観測を1つ受ける。**回すかどうかもここが決める。**
   *
   * 呼ぶ側（クローンの `#noteUsageNotice` と `ManagerPool#onEvent`）は判定を持たない
   * ——6つの検知点が同じ1本へ合流する形にしてあるのが、この設計の骨である。
   */
  observe(observation: TokenRotatorObservation): Promise<TokenRotationOutcome>;
}

export function createTokenRotator(options: TokenRotatorOptions): TokenRotator {
  const { stores, probe, spread } = options;
  const now = options.now ?? (() => new Date());

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
          value: selection.token.value,
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
          value: selection.token.value,
          generation,
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
