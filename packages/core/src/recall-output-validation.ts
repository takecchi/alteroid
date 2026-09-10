import type { z } from "zod";
import { RecallResultSchema } from "./recall.js";
import type { RecallOutputValidation, RecallOutputValidationIssue } from "./recall.js";

/**
 * `recall()` の戻り値を検証するときの倒れ方（Issue #131、ADR 0098）。
 *
 * - `"off"` — 検証しない。`RecallResult.outputValidation` は無い（`undefined`）。
 * - `"report"` — 検証し、結果を `RecallResult.outputValidation` に載せて返す。
 *   **例外は投げない**——落ちても `recall()` は resolve する。
 * - `"throw"` — 検証し、落ちていたら {@link RecallOutputValidationError} を投げる
 *   （resolve しない）。
 *
 * **既定は `"report"`である**（{@link DEFAULT_RECALL_OUTPUT_VALIDATION}）。`recall()` は
 * 使う側の主経路であり、既定を `"throw"` にすると「いままで（誤った値のまま）動いていた
 * 呼び出しが例外になる」という公開 API の破壊的変更になる——`docs/autonomy.md` §3 は
 * 破壊的変更をオーナーの判断としている（ADR 0098 参照）。
 */
export type RecallOutputValidationMode = "off" | "report" | "throw";

/** {@link RecallOutputValidationMode} の既定値。ADR 0098 の芯——既定では投げない。 */
export const DEFAULT_RECALL_OUTPUT_VALIDATION: RecallOutputValidationMode = "report";

/**
 * `validateRecallOutput` が `mode: "throw"` で検証に落ちたときに投げる例外（Issue #131、ADR 0098）。
 *
 * `recallId` を持つ理由: 検証は段6（`MemoryStore.createRecall`）が既に書き込まれた**後**に
 * 走る。⟹ `"throw"` モードでは「`recalls` の行は書かれたのに、呼び出し側は例外を受け取る」
 * という状態になる——この不一致を呼び出し側が調べられるように、`recallId` を例外へ載せて
 * 相関を取れるようにしてある（ADR 0098「引き受けた負債」）。
 */
export class RecallOutputValidationError extends Error {
  readonly issues: readonly RecallOutputValidationIssue[];
  readonly recallId: string;

  constructor(issues: readonly RecallOutputValidationIssue[], recallId: string) {
    super(
      `recall: output failed validation (recallId: ${recallId}): ` +
        issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
    );
    this.name = "RecallOutputValidationError";
    this.issues = issues;
    this.recallId = recallId;
  }
}

/** zod の `safeParse` が返す `error.issues` を {@link RecallOutputValidationIssue} へ写す。 */
function toValidationIssues(error: z.ZodError): RecallOutputValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join("."),
    code: issue.code,
    message: issue.message,
  }));
}

/**
 * `recall()` の戻り値（`outputValidation` を載せる前の draft）を検証する純関数
 * （Issue #131、ADR 0098）。**歯を直接当てる口。**
 *
 * `draft` は `RecallResultSchema` が要求する形（`outputValidation` を除く）を満たしている
 * べき値だが、**検証の対象そのものはここでは信用しない**——`unknown` として受け取り、
 * `RecallResultSchema.safeParse` に通す。
 *
 * **`draft` の値は一切書き換えない。** 検証は読むだけで、`usage.share` のような
 * 「契約上は妥当だが以前の型では弾かれていた」値（ADR 0097）を丸めたり捨てたりしない
 * ——壊れていることを見えなくするのが最悪の結末である（依頼文参照）。
 *
 * @returns `mode: "off"` のときだけ `undefined`。それ以外は検証結果
 *   （`mode: "throw"` かつ検証に落ちた場合は {@link RecallOutputValidationError} を投げる）。
 */
export function validateRecallOutput(
  draft: unknown,
  mode: RecallOutputValidationMode,
  recallId: string,
): RecallOutputValidation | undefined {
  if (mode === "off") {
    return undefined;
  }

  const result = RecallResultSchema.safeParse(draft);
  if (result.success) {
    return { ok: true, issues: [] };
  }

  const issues = toValidationIssues(result.error);
  if (mode === "throw") {
    throw new RecallOutputValidationError(issues, recallId);
  }
  return { ok: false, issues };
}
