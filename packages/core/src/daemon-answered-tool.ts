/**
 * 「その道具の応答を待っているのはデーモン（＝クローン）自身のはずか」を
 * 道具名だけで判定する述語（Issue #2173）。
 *
 * **出所は `runner.ts` の `#onPermission` である。** あそこは SDK の
 * `canUseTool` へ渡す確認を「質問（`kind: 'question'`）」と「許可
 * （`kind: 'permission'`）」の2種類に分けており、分け方は逐語で
 * ```
 * const kind = toolName === 'AskUserQuestion' ? 'question' : 'permission';
 * ```
 * ——道具名が `'AskUserQuestion'` かどうかだけである。**この述語はその
 * 分け方をそのまま切り出したもの**で、`runner.ts` 側は挙動を1バイトも
 * 変えずにこの述語を呼ぶだけへ寄せてある。
 *
 * **なぜ「質問／許可」ではなく「デーモンが答える道具か」という名前にしたか。**
 * `manager-activity.ts`（`classifyManagerActivity`、Issue #572/#2173）が
 * 同じ分け方を別の目的で要る——`toolUseStallPending`（SDK が応答を待って
 * いるらしい `tool_use`）に載った道具の名前が **この述語を満たすときだけ**、
 * 「デーモンの `waiting` が空なのに SDK は応答を待っている」ことが矛盾になる。
 * 満たさない（＝`Bash` 等の**ふつうの道具**）ときは、既定の
 * `permissionMode: 'auto'` ではその道具は `canUseTool` を一度も通らない
 * ので、応答を待っているのは SDK 自身であり、デーモンの `waiting` が空
 * なのは矛盾ではなく**ただ実行中なだけ**である。同じ真偽値を「runner が
 * 確認をどちらの形で出すか」にも「manager-activity が矛盾と読むか」にも
 * 使うので、`runner.ts` の語彙（`question`/`permission`）ではなく、両方の
 * 呼び出し元に共通する意味（「デーモンだけが応答を返せる道具か」）で名付けた。
 *
 * **循環 import を避けるためだけにここへ切り出した。** `manager-activity.ts`
 * は `apps/web`（ブラウザ）からも `@alteroid/core/manager-activity`
 * （実行時の依存を持たない軽い口。`tsup.config.ts` の doc）として import
 * される——`runner.ts`（Node 専用の組み込みと `@anthropic-ai/claude-agent-sdk`
 * に依存する）を巻き込むとブラウザのバンドルが壊れる（`tsup.config.ts` の
 * `journal-search.ts` の doc と同じ理由の族）。このファイルは他の何も
 * import しない、依存の無い葉（leaf）である——`runner.ts`・
 * `manager-activity.ts` のどちらからも安全に import できる。
 *
 * **将来 `AskUserQuestion` 以外の道具がデーモンの確認を経由するようになって
 * も、直す場所はここ1箇所である。** `runner.ts` の `#onPermission` も
 * `manager-activity.ts` の `classifyManagerActivity` も、この関数の結果だけを
 * 見る——文字列比較を2箇所に複製しない。
 */
export function isDaemonAnsweredTool(name: string): boolean {
  return name === 'AskUserQuestion';
}
