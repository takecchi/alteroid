/**
 * `Bash` の門（`bash-wait-guard.ts`）が、弾く形に当たったときの扱い（issue #2884）。
 *
 * マネージャーは Claude Code であり、クローンはそれを使う人間である（オーナーの回答
 * 2026-10-05）。人間は Claude Code で、確認に上がってきた操作を自分の判断で許可できる。
 * だから門も、**上がらずに止めて誰も開けられない**形にしない。
 *
 * - `ask`（既定）: 確認に上げる。`PreToolUse` の `permissionDecision: 'ask'` として返し、
 *   SDK が `canUseTool` へ流す。クローンは `manager_send` の `decision` で許可できる
 *   （マネージャー本体でも作業者でも同じ。`real-cli-pre-tool-use-ask.test.ts` が本物の本体で固定している）
 * - `deny`: 実行そのものを止める（確認に上げない）。人間が「この形は確認すら要らず止めたい」と
 *   決めたときの設定で、既定ではない
 * - `off`: 待つ形の門を掛けない。判定器も呼ばない。**本番デプロイ（release-prod）の起動だけは、`off` でも
 *   確認に残す**（`bash-release-prod-guard.ts`。取り返しがつきにくい操作を黙って通す設定にしない）
 *
 * **これは能力の制限ではなく実行環境の設定である**（north_star 禁止2「方針は設定で開けられなければならない」）。
 * 綴りの扱いは `ALTEROID_MEMORY_GUARD`（`tools.ts` の `resolveMemoryGuard`）と同じ——空・空白は未設定として
 * 既定へ、綴り違いは黙って既定へ倒さず落とす（持ち主が気づけないままにならないため）。
 */
export const BASH_GUARD_ENV = 'ALTEROID_BASH_GUARD';

/** 環境変数が受け付ける値。 */
export const BASH_GUARD_VALUES = ['ask', 'deny', 'off'] as const;
export type BashGuardMode = (typeof BASH_GUARD_VALUES)[number];

/** 既定値。確認に上げる（止めっぱなしにも、黙って通すことにもしない）。 */
export const DEFAULT_BASH_GUARD: BashGuardMode = 'ask';

export function resolveBashGuardMode(env: NodeJS.ProcessEnv = process.env): BashGuardMode {
  const given = env[BASH_GUARD_ENV]?.trim();
  if (given === undefined || given.length === 0) return DEFAULT_BASH_GUARD;
  if ((BASH_GUARD_VALUES as readonly string[]).includes(given)) return given as BashGuardMode;
  throw new Error(
    `${BASH_GUARD_ENV} の値が不正: ${given}（使えるのは ${BASH_GUARD_VALUES.join(' / ')}。既定は ${DEFAULT_BASH_GUARD}）`,
  );
}
