import type { AgentPermissionDecision } from './agent-session.js';
import type {
  CodexCommandApprovalDecision,
  CodexFileChangeApprovalDecision,
  CodexServerRequestMap,
  CodexServerRequestMethod,
} from './codex-protocol.js';
import { isCodexServerRequestMethod } from './codex-protocol.js';

// 中立の AgentPermissionDecision に足さない: Codex の cancel（拒否してターンも止める）は allow / deny で表せないため、この層の中だけの入力にする
export interface CodexApprovalInterrupt {
  readonly behavior: 'interrupt';
}

export type CodexApprovalJudgement = AgentPermissionDecision | CodexApprovalInterrupt;

// acceptForSession を返さない: alteroid の許可は今回の1件だけのため
export type CodexMappedApprovalDecision = Exclude<
  CodexCommandApprovalDecision & CodexFileChangeApprovalDecision,
  'acceptForSession'
>;

export type CodexApprovalUnmappableReason =
  'unknown-request' | 'unknown-judgement' | 'allow-not-expressible' | 'no-decline-value';

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
      // allow を accept に写さない: content を持たない allow だと、内容の無い入力を承諾したことになるため
      if (behavior === 'allow') return unmappable('allow-not-expressible');
      return { ok: true, response: { action: ELICITATION_ACTION_BY_BEHAVIOR[behavior] } };
    case 'item/permissions/requestApproval':
      // allow を写さない: 付与する権限を持たない allow で要求を丸ごと付与すると許可の水増しになるため。interrupt も空の付与になり、ターンは中断されない
      if (behavior === 'allow') return unmappable('allow-not-expressible');
      return { ok: true, response: { permissions: {} } };
    case 'item/tool/requestUserInput':
      // 空の answers を拒否にしない: スキーマに無い意味を与えることになるため
      return unmappable('no-decline-value');
    default: {
      const unreachable: never = method;
      return unreachable;
    }
  }
}
