import {
  fetchAccountUsage,
  type AccountUsage,
  type AccountUsageState,
  type UsageWindow,
} from './usage-snapshot.js';
import type { UsageProbeQuery } from './usage-probe.js';

/**
 * 候補トークンを1本、probe で観測した結果の3値判定。
 *
 * Issue #393 の「回し方」は2値（使える／使えない）で書かれているが、**この関数は
 * 3値目（`undecidable`）を持つ。** 理由は `AccountUsageState` 自身が持つ欠落 —
 * 「まだ取っていない」「取れなかった」「この構成では取れない」を1つの `state` に
 * 混ぜられないので分けてあるのと同じ理由で、**判定材料が足りないことを `unusable`
 * へ丸めない。**
 *
 * ## Issue の記述からのずれ（この PR が請け負っていないこと）
 *
 * Issue #393 の3値の表は「使えない = probe が `rejected` / 認証失敗」と書いているが、
 * **どちらも probe からは観測できない。**
 *
 * - `rejected` は `rate_limit_event` 由来で、それが届くにはターンが要る。だが
 *   `usage-probe.ts` の probe は**プロンプトを1つも送らない**（`idleUsagePrompt` の
 *   doc・`grep -n 'yield が無いことがこの関数の要件そのもの' packages/core/src/usage-probe.ts`）
 *   ので、ターンは1つも回らず `rate_limit_event` は届かない。
 * - 認証失敗は `AccountUsageState` の `state: 'failed'` に落ちるが、そこには
 *   **通信断・締め切りも同じ形で混ざる**（`runUsageProbe` が全失敗を `undefined` へ
 *   畳み、`settleWithin` が rejection を飲むため）。区別する材料がここに無い。
 *
 * **⟹ 認証失敗はこの関数では `undecidable` へ落ちる。** 帰結は「その候補を撒いて
 * みて、本番が拒否したら次へ」であり、**設計の骨（本番の仕事で試さない）を1回ぶん
 * 崩す。** 区別できるようにするには `runUsageProbe` / `settleWithin` が失敗の理由を
 * 持ち帰る形が要り、それはこの PR の範囲ではない。
 */
export type TokenCandidateVerdict =
  | { verdict: 'usable' }
  | { verdict: 'unusable'; reason: string; retryAt?: number }
  | { verdict: 'undecidable'; reason: string };

/**
 * 「使い切っている」と数える閾値。
 *
 * **これは閾値による判定であって、権威ある合図ではない。** 権威ある合図は
 * `rate_limit_event` の `status === 'rejected'` のほうだが、それは probe からは
 * 取れない（上の doc）。この閾値は「probe しか無いときの、保守的な近似」である。
 */
export const EXHAUSTED_UTILIZATION = 100;

function isExhausted(window: UsageWindow): boolean {
  // **`utilization` が付かない枠は「使い切っている」と数えない。** 取れなかった
  // ものを 100 で埋めるのは、`usage-snapshot.ts` の「取れなかったものを 0 にしない」
  // の裏返しの嘘になる。
  return window.utilization !== undefined && window.utilization >= EXHAUSTED_UTILIZATION;
}

/**
 * 課金枠が使えるか。**引数は「取れた」ものだけを受ける** —— `extraUsage` が
 * `undefined`（＝取れなかった）ときにここへ来ないよう、呼ぶ側で分けてある。
 * 取れなかったことを「無い」と読むと、**取れなかったものを事実として使う**ことになる。
 */
function extraUsageUsable(extra: NonNullable<AccountUsage['extraUsage']>): boolean {
  if (!extra.enabled) return false;
  if (extra.utilization !== undefined && extra.utilization >= EXHAUSTED_UTILIZATION) return false;
  return true;
}

/**
 * `AccountUsageState` から3値の判定を出す。
 *
 * **保守的に倒すこと。** 迷ったら `usable` か `undecidable` であって `unusable`
 * にしない — `unusable` は候補を1本飛ばす判断なので、誤ると使えるトークンを
 * 捨てる。判定の規則は次の順に見る。
 *
 * 1. `unknown` → `undecidable`（まだ聞いていない）
 * 2. `failed` → `undecidable`（認証失敗・通信断・締め切りが同じ形で混ざる。上の doc）
 * 3. `unavailable` → `undecidable`（この認証では原理的に枠が取れない。「使えない」ではない）
 * 4. `ok` かつ `windows` が空 → `undecidable`（空は 0% ではなく「取れなかった」）
 * 5. `ok` かつ取れた枠が全部使い切っている **かつ** 課金枠も使えない → `unusable`
 * 6. それ以外の `ok` → `usable`
 */
export function judgeTokenCandidate(state: AccountUsageState): TokenCandidateVerdict {
  if (state.state === 'unknown') {
    return { verdict: 'undecidable', reason: 'まだ observe していない（unknown）' };
  }
  if (state.state === 'failed') {
    return {
      verdict: 'undecidable',
      reason: `probe が失敗した。認証失敗・通信断・締め切りが区別できない形で混ざる（reason: ${state.reason}）`,
    };
  }
  if (state.state === 'unavailable') {
    return {
      verdict: 'undecidable',
      reason: `この認証では原理的に枠が取れない（reason: ${state.reason}）`,
    };
  }

  // state.state === 'ok'
  if (state.usage.windows.length === 0) {
    return {
      verdict: 'undecidable',
      reason: '枠を1つも取れなかった（空は 0% ではなく「取れなかった」）',
    };
  }

  const allWindowsExhausted = state.usage.windows.every(isExhausted);
  if (!allWindowsExhausted) {
    return { verdict: 'usable' };
  }

  // **「取れなかった」を「無い」と読まない。** `extraUsage` が undefined なのは
  // 「課金枠が無い」ではなく「取れなかった」である（`usage-snapshot.ts` の
  // `accountUsageSchema.extraUsage` の doc）。ここを `unusable` へ倒すと、
  // **取れなかったことを根拠に候補を1本捨てる**ことになり、この関数自身が
  // 掲げている「迷ったら unusable にしない」に反する。
  const extra = state.usage.extraUsage;
  if (extra === undefined) {
    return {
      verdict: 'undecidable',
      reason:
        '取れた枠は全部使い切っているが、課金枠が取れなかった' +
        '（取れなかったことを「課金枠が無い」と読まない）',
    };
  }
  if (extraUsageUsable(extra)) {
    return { verdict: 'usable' };
  }

  // 取れた枠が全部使い切られていて、課金枠も使えない。
  const resetTimes = state.usage.windows
    .map((w) => w.resetsAt)
    .filter((v): v is number => v !== undefined);
  const retryAt = resetTimes.length > 0 ? Math.max(...resetTimes) : undefined;

  return {
    verdict: 'unusable',
    reason: '取れた枠がすべて使い切られており、課金枠も使えない',
    ...(retryAt !== undefined ? { retryAt } : {}),
  };
}

/**
 * 候補トークンを1回だけ observe して判定する。
 *
 * **⚠️ `options.token` を、返り値にも例外にもログにも入れないこと。** ここでは
 * `fetchAccountUsage` の `env` へ渡す以外の用途に使わず、保存も再送もしない。
 *
 * **⚠️ この口で候補の認証が実際に通るかは誰も測っていない。** SDK が `Options.env`
 * を持つことと、`sdk.mjs` が `CLAUDE_CODE_OAUTH_TOKEN` を認証 env の一覧に持つこと
 * （`grep -o '.\{40\}CLAUDE_CODE_OAUTH_TOKEN.\{40\}' node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`
 * で当たる）は確かめたが、「その候補として認証される」ところは実測していない
 * （本物のトークンを扱わない枷があるので、実装側からは測れない）。
 *
 * **⚠️ そして「効かなかったとき」の形は2つあり、片方しか安全側へ倒れない。**
 *
 * | 効かなかった形 | この関数はどうなるか |
 * | --- | --- |
 * | 候補の値で**認証できない** | `fetchAccountUsage` が `state: 'failed'` か `'unavailable'` を返し、`judgeTokenCandidate` はどちらも `undecidable` にする ⟹ **安全側** |
 * | `Options.env` が認証に**効かず、器に居る資格でそのまま通る** | `state: 'ok'` が返る。**ただしそれは候補ではなく、いま器が持っている資格のアカウントの枠である** ⟹ **`usable` / `unusable` を自信を持って返すが、対象が違う** |
 *
 * **⟹ 2つ目は `undecidable` へ倒れない。** 「判定できない」ではなく「**別のものを
 * 測って、その答えを返す**」という壊れ方なので、呼ぶ側からは正常な観測と区別が付かない。
 *
 * **⚠️ そして列挙では塞げないことを確かめた**（2026-08-24 観測、`0.3.241`）。
 * `sdk.mjs` は認証に使う env の名前を**複数の群に分けて**持っており
 * （`grep -o 'var LO=\[[^]]*\]' sdk.mjs` で当たる群のほかに
 * `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` / `CLAUDE_CODE_SESSION_ACCESS_TOKEN` /
 * `CLAUDE_CODE_HOST_CREDS_FILE` などが別の群に在る）、**「他の資格を全部落とす」
 * を名前の一覧で書くと、SDK が1つ足すたびに静かに穴が開く。** `AccountUsage` の
 * `tokenSource` で「どの出所で認証したか」を検査することも考えたが、SDK の型は
 * `tokenSource?: string`（自由文字列）で取りうる値を宣言していないので、
 * **こちらも数え上げになる。**
 *
 * **⟹ この口の契約は「候補を観測する」ではなく「候補の env を渡して観測を試みる」
 * である。** 観測した相手が本当に候補だったことは、**いまの SDK からは確かめられない。**
 * 追跡は #429（probe が「何を観測したか」を持ち帰らない）。
 */
export async function probeTokenCandidate(
  queryFn: UsageProbeQuery,
  options: { cwd: string; token: string; signal?: AbortSignal },
): Promise<TokenCandidateVerdict> {
  const state = await fetchAccountUsage(queryFn, {
    cwd: options.cwd,
    signal: options.signal,
    env: { CLAUDE_CODE_OAUTH_TOKEN: options.token },
  });
  return judgeTokenCandidate(state);
}
