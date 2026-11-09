import type { AgentTurnEnded } from './agent-events.js';
import type { CredentialStore } from './credentials.js';
import { noteUnclassifiedFailure } from './dropped-record.js';
import type { RunnerEvent } from './runner-protocol.js';
import type { SdkFailure } from './sdk-failure.js';
import { classifyFailedTurnUsageNotice } from './usage-limits.js';

// 鍵の器が無い器で `Not logged in` が来たときの案内（`runner.ts` の `NO_CREDENTIAL_DIR_HINT`）を足すかの判定に使う
const NOT_LOGGED_IN_PATTERN = /not logged in/i;

// `empty` は構造的な事実で、返す文字列（`（報告なし）` 等）そのものではない: 文字列を変えずに構造だけを添える
export function resultTextOf(event: AgentTurnEnded): { text: string; empty: boolean } {
  if (event.body.length > 0) return { text: event.body, empty: false };
  if (event.outcome !== undefined)
    return { text: `（結果なしで終了: ${event.outcome}）`, empty: false };
  return { text: '（報告なし）', empty: true };
}

/**
 * `RunnerSession` が口として渡すもの。4 本。
 * 値で渡すのは作った後に変わらない欄（`credentials` と `managerId`。`RunnerSession` では `readonly`）だけで、`unclassifiedFailures` は参照のまま渡す
 * （写すと、`RunnerSession` が `stop()` / `finish()` の合計の行（`noteUnclassifiedFailuresSummary`）で読む件数に、ここが数えた分が載らない）。
 * 関数の口（`emit`）は async の皮で包まずに渡す（`classify` は同期で、`await` を足すと呼び元の `#applyTurnEnded` の
 * `usage_notice` と `report` の出る周回が動くため）。
 */
interface RunnerFailureClassifierPorts {
  /** `RunnerSession#emit`（`usage_notice` を降ろす）。同期。 */
  emit: (event: RunnerEvent) => void;
  /** `RunnerSession#id`（作った後に変わらない）。 */
  managerId: string;
  /** `RunnerSession#credentials`（作った後に変わらない。`undefined` は鍵の器が無い器）。 */
  credentials: CredentialStore | undefined;
  /** `RunnerSession#sdkSession.unclassifiedFailures`（分類できなかった失敗の件数。ここが書く）。参照。 */
  unclassifiedFailures: Map<string, number>;
}

/**
 * `RunnerSession#applyTurnEnded` の「失敗分類の前半」（`usage_notice` の送出と、分類できなかった失敗の跡・資格なし案内の判定）を受け持つ側。
 * 切り出し前の `RunnerSession` から切り出した。振る舞いは変えていない。自前の欄は無い。`classify` は同期・戻り値 `boolean` のまま保つ。
 */
export class RunnerFailureClassifier {
  readonly #emit: RunnerFailureClassifierPorts['emit'];
  readonly #id: RunnerFailureClassifierPorts['managerId'];
  readonly #credentials: RunnerFailureClassifierPorts['credentials'];
  readonly #unclassifiedFailures: RunnerFailureClassifierPorts['unclassifiedFailures'];

  constructor(ports: RunnerFailureClassifierPorts) {
    this.#emit = ports.emit;
    this.#id = ports.managerId;
    this.#credentials = ports.credentials;
    this.#unclassifiedFailures = ports.unclassifiedFailures;
  }

  /** 戻り値は、報告の本文の末尾へ鍵の置き場の案内（`NO_CREDENTIAL_DIR_HINT`）を足すか。 */
  classify(event: AgentTurnEnded, failure: SdkFailure | undefined): boolean {
    // なぜ終わったのかを落とさない: 上限で止まったのか失敗したのかが区別できないと、待つ／人間に頼むと挑み直すで手が正反対になるため
    // 成否の分岐の外に出す: `assistant.error` で止まった回は `result` が成功で返ることがあるため
    // マネージャーの本文 `said` を分類に通さない: `classifyUsageNotice` は部分一致で、報告に「上限に当たった」と書いただけで誤判定するため
    // 鍵の器が無い器で `Not logged in` が来たときの案内。分類できなかった失敗の中でも、原因の見当が付く1つだけに足す
    let noCredentialDirHint = false;
    if (failure !== undefined) {
      // 候補と順序（応答の本文を入れない理由を含む）は `classifyFailedTurnUsageNotice` に1つだけ置く: クローンの層（`clone.ts`）と同じ判定を使うため
      const notice = classifyFailedTurnUsageNotice(failure.text, event.errorLines);
      if (notice !== undefined) {
        this.#emit({ type: 'usage_notice', managerId: this.#id, notice });
      } else {
        // 1件も分類できなかった回に跡を残す: 黙って抜けると、回し手が原理的に聞けない失敗（資格が1つも無い器）が何回起きているかがどこにも残らないため
        noCredentialDirHint =
          this.#credentials === undefined &&
          [failure.text, resultTextOf(event).text, ...event.errorLines].some((text) =>
            NOT_LOGGED_IN_PATTERN.test(text),
          );
        noteUnclassifiedFailure(this.#unclassifiedFailures, this.#id, failure.via, failure.code);
      }
    }
    return noCredentialDirHint;
  }
}
