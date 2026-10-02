/**
 * alteroid の許可の判断を、Codex app-server の承認 request への答えへ写す純粋関数
 * （#486 M7 段 S6 の前提部品。**どこからも呼ばない**。承認の往復の配線は S6 PR-B）。
 *
 * 使うのは `codex-*.ts` だけである（番人は `codex-protocol.test.ts`）。
 *
 * ## 判断の語彙
 *
 * 新しい語彙は作らない。許可確認の判断は中立の {@link AgentPermissionDecision}
 * （`agent-session.ts`。Claude 側は `claude-manager-driver.ts` の
 * `toClaudePermissionResult` が `canUseTool` の `PermissionResult` へ写す）で、
 * `allow` と `deny` の2つしか無い。**中断に当たるものは既存の型に無い**
 * （`interrupt` の欄は `AgentPermissionDecision` にも `toClaudePermissionResult` にも無く、
 * 中断は `AgentPermissionRequest.signal` の abort＝provider 側の取り下げで表している）。
 * Codex の `cancel`（承認の拒否に加えてターンを即座に中断する）を表すには `allow` / `deny`
 * では足りないので、**この層の中だけの**入力として {@link CodexApprovalInterrupt} を足した。
 * 中立の型には足していない（足すかどうかは呼び出し側＝S6 PR-B と、その上の判断）。
 *
 * ## 写しの表（approvalPolicy は on-request）
 *
 * | request                              | allow            | deny                 | interrupt            |
 * | ------------------------------------ | ---------------- | -------------------- | -------------------- |
 * | item/commandExecution/requestApproval | decision accept  | decision decline     | decision cancel      |
 * | item/fileChange/requestApproval       | decision accept  | decision decline     | decision cancel      |
 * | mcpServer/elicitation/request         | **写せない**     | action decline       | action cancel        |
 * | item/permissions/requestApproval      | **写せない**     | permissions {}       | permissions {}       |
 * | item/tool/requestUserInput            | **写せない**     | **写せない**         | **写せない**         |
 * | 知らない method                       | **写せない**     | **写せない**         | **写せない**         |
 *
 * ## 表せない request の扱い（推測で値を作らない）
 *
 * - **`acceptForSession` と、セッション単位・恒久的な許可（`scope: 'session'`、
 *   execpolicy / network policy の amendment）は、どの入力からも出さない。**
 *   alteroid の「許可」は今回の1件だけの許可である。
 * - `item/permissions/requestApproval`: 答えは「どの権限を付与するか」の欄（生成スキーマの
 *   `GrantedPermissionProfile`）で、accept / decline / cancel の列挙は無い。alteroid の
 *   `allow` は「何を付与するか」を持たないので、要求された権限を丸ごと写して付与するのは
 *   許可の水増しになる。よって `allow` は写せない。拒否は「何も付与しない」＝空の `permissions`
 *   （スキーマ上実在する値）。`cancel` に当たる値は無いので、`interrupt` も同じ空の付与に
 *   倒す——**ターンは中断されない**（中断したいなら呼び出し側が `turn/interrupt` を送る）。
 *   `scope` は付けない（既定は `turn`）。
 * - `item/tool/requestUserInput`: 答えは質問 id → 回答で、許可・拒否・中断の値が無い。
 *   空の `answers` を拒否として作るのは、スキーマに無い意味を与えることになる。全判断で
 *   写せない。呼び出し側（クローンへ上げる側）が決める。
 * - `mcpServer/elicitation/request`: `decline` / `cancel` は実在する。`accept` も実在するが、
 *   elicitation は「承認」ではなく MCP サーバーが人間へ入力（form）や URL の訪問を求める
 *   ものなので、`content` を持たない alteroid の `allow` を `accept` に写すと、内容の無い
 *   入力を承諾したことになる。許可に寄せないため `allow` は写せない。
 * - 知らない method、知らない判断（型の外から来た値）も写せない。許可にはしない。
 */

import type { AgentPermissionDecision } from './agent-session.js';
import type {
  CodexCommandApprovalDecision,
  CodexFileChangeApprovalDecision,
  CodexServerRequestMap,
  CodexServerRequestMethod,
} from './codex-protocol.js';
import { isCodexServerRequestMethod } from './codex-protocol.js';

/** 「許可」ではなく「中断」（承認を断り、ターンも止める）。この層の中だけの入力。 */
export interface CodexApprovalInterrupt {
  readonly behavior: 'interrupt';
}

/** 写しの入力。`allow` / `deny` は中立の {@link AgentPermissionDecision} そのもの。 */
export type CodexApprovalJudgement = AgentPermissionDecision | CodexApprovalInterrupt;

/** この写しが返しうる decision。`acceptForSession` は型の上でも除く。 */
export type CodexMappedApprovalDecision = Exclude<
  CodexCommandApprovalDecision & CodexFileChangeApprovalDecision,
  'acceptForSession'
>;

export type CodexApprovalUnmappableReason =
  | 'unknown-request' // 知らない method
  | 'unknown-judgement' // 知らない判断
  | 'allow-not-expressible' // この request では「許可」を表す値が無い（許可に寄せない）
  | 'no-decline-value'; // 許可・拒否・中断のどれの値も無い

export type CodexApprovalMapping<M extends CodexServerRequestMethod = CodexServerRequestMethod> =
  | { readonly ok: true; readonly response: CodexServerRequestMap[M]['result'] }
  | { readonly ok: false; readonly reason: CodexApprovalUnmappableReason };

const DECISION_BY_BEHAVIOR = {
  allow: 'accept',
  deny: 'decline',
  interrupt: 'cancel',
} as const satisfies Record<CodexApprovalJudgement['behavior'], CodexMappedApprovalDecision>;

const ELICITATION_ACTION_BY_BEHAVIOR = {
  deny: 'decline',
  interrupt: 'cancel',
} as const;

function unmappable(reason: CodexApprovalUnmappableReason): {
  readonly ok: false;
  readonly reason: CodexApprovalUnmappableReason;
} {
  return { ok: false, reason };
}

/**
 * 判断を、request の種別ごとの答えへ写す。写せなければ `ok: false`（呼び出し側が決める）。
 * `method` は文字列で受ける（受信した JSON-RPC の method をそのまま渡せる）。
 */
export function mapCodexApproval(
  method: string,
  judgement: CodexApprovalJudgement,
): CodexApprovalMapping {
  if (!isCodexServerRequestMethod(method)) return unmappable('unknown-request');
  const behavior: unknown = (judgement as { behavior?: unknown } | null)?.behavior;
  if (behavior !== 'allow' && behavior !== 'deny' && behavior !== 'interrupt') {
    return unmappable('unknown-judgement');
  }
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { ok: true, response: { decision: DECISION_BY_BEHAVIOR[behavior] } };
    case 'mcpServer/elicitation/request':
      if (behavior === 'allow') return unmappable('allow-not-expressible');
      return { ok: true, response: { action: ELICITATION_ACTION_BY_BEHAVIOR[behavior] } };
    case 'item/permissions/requestApproval':
      if (behavior === 'allow') return unmappable('allow-not-expressible');
      return { ok: true, response: { permissions: {} } };
    case 'item/tool/requestUserInput':
      return unmappable('no-decline-value');
    default: {
      const unreachable: never = method;
      return unreachable;
    }
  }
}
