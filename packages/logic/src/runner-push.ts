/**
 * runner への反映（`PUT /credentials` / `PUT|DELETE /profile/:name` / 旧 `PUT /profile` /
 * `PUT /mcp-servers`）の成否から、「成功の見出しを出してよいか」を言う純関数（#3157）。
 *
 * ## 何を「一部失敗」と数えるか（応答の形を読んだ判定）
 *
 * 3つの応答は同じ形の `runners: { runnerId, ok, ... }[]` を持つ。デーモンはこれを
 * `RunnerRegistry#list()` の runner 1台ずつへ push した結果から作る
 * （`packages/core/src/credential-service.ts` の `pushAll` ほか）。
 *
 * - **`ok === false` が1つでも在る** → 一部失敗。警告にする。
 *   MCP の `unsupported: true`（受け取る口の無い古い runner）も `ok: false` なので同じ。
 * - **`runners` が空**（runner が1台も繋がっていない・配る先が無い）→ 失敗ではない。
 *   配る相手がそもそも居ないのであって、反映が壊れたのではない。繋がった runner へは
 *   次の名乗り（`hello`）で降ろし直す。見出しは成功のまま、「配っていない」を従来どおり言う。
 * - **未接続の runner** は `runners` に載らない（`list()` は繋がっている相手だけを返す）ので、
 *   やはり失敗に数えない。
 * - **反映が要らない**ケース（既に同じ指紋など）は、runner は `ok: true` で返るので失敗ではない。
 * - **`runners` 欄が無い**（古いデーモンの応答）→ 失敗とは言えないので警告にしない。
 *
 * 書き込み自体（正本への保存）は、`runners` に失敗が在っても成功している（200）。
 * だから警告にするのは「反映できていない runner がある」であって、「保存に失敗した」ではない。
 */
export interface RunnerPushOutcomeLike {
  ok: boolean;
}

export interface RunnerPushesLike<T extends RunnerPushOutcomeLike = RunnerPushOutcomeLike> {
  runners?: readonly T[];
}

/** 反映に失敗した runner（`ok: false`）だけを、応答の順のまま返す。 */
export function failedRunnerPushes<T extends RunnerPushOutcomeLike>(
  update: RunnerPushesLike<T>,
): T[] {
  return (update.runners ?? []).filter((runner) => !runner.ok);
}

/** 1台でも反映に失敗していれば true。runner が0台・欄が無いときは false。 */
export function hasRunnerPushFailure(update: RunnerPushesLike): boolean {
  return failedRunnerPushes(update).length > 0;
}

/**
 * `PUT /mcp-servers` だけの追加の判定。**`ok: true` でも、runner が返した指紋が保存した指紋と
 * 違えば、その runner は違う版を持っている**（`mcpServersUpdateResponseSchema` の doc:
 * 突き合わせて「同じ版が届いたか」を言う唯一の手がかり）。成功の見出しの下に赤い行だけが
 * 並ぶのは、`ok: false` が埋もれるのと同じ形なので、これも反映できていない側に数える。
 */
export function hasMcpFingerprintMismatch(update: {
  sha256?: string;
  runners?: readonly { ok: boolean; mcpServers?: { sha256: string } }[];
}): boolean {
  if (update.sha256 === undefined) return false;
  return (update.runners ?? []).some(
    (runner) =>
      runner.ok && runner.mcpServers !== undefined && runner.mcpServers.sha256 !== update.sha256,
  );
}

/** MCP 登録の反映が一部でも届いていない（失敗・または指紋の不一致）。 */
export function hasMcpPushProblem(
  update: Parameters<typeof hasMcpFingerprintMismatch>[0],
): boolean {
  return hasRunnerPushFailure(update) || hasMcpFingerprintMismatch(update);
}
