import type { AgentPermissionDecision } from './agent-session.js';
import type { PeerApprovalSource } from './peer-broker.js';
import type { RecentMap } from './recent.js';
import { decideAnswer } from './runner-decide-answer.js';
import type { RunnerEvent } from './runner-protocol.js';
import type { RunnerSdkSession } from './runner-sdk-session.js';

export interface PendingRequest {
  id: string;
  kind: 'question' | 'permission';
  summary: string;
  // 取り直さない: 引き取りのたびに取り直すと、待っている時間の長さが消えるため
  askedAt: string;
  // `message` の文言を嗅がない（`withdrawn` / `aborted` で判定する）: AGENTS.md「文字列で本文を嗅がない」
  // `aborted` を `settled` イベントに載せない: 中断は `withdrawn` が言う「CLI へ届いていない」とは別の事実のため
  settle: (answer: {
    message: string;
    decision?: 'allow' | 'deny';
    withdrawn?: true;
    aborted?: true;
  }) => void;
  result: Promise<AgentPermissionDecision>;
}

/**
 * `RunnerSession` が口として渡すもの。6 本。
 * 値で渡すのは作った後に変わらない欄（`managerId`。`RunnerSession` では `readonly`）だけ。
 * `sdkSession`・`pending`・`resolved` は参照のまま渡す（写すと、`RunnerSession` の他の経路〔`answer`・`#settleAll`・再送の判定・状態の読み出し〕が
 * 変えた状態をここが見られず、ここが `push`・`splice`・`setStatus`・`set` した状態を他の経路が見られなくなる）。
 * 関数の口は async の皮で包まずに渡す（すべて同期で、`await` を足すと `ask` と `settled` が出る周回と、`result` が解ける周回が動くため）。
 * `decideAnswer`（`Session#answer()` と共有する唯一の実装）は口で受けず、`runner-decide-answer.ts` から直に import する: 純関数だけのファイルなので循環しない（`runner.ts` はそれを再 export しているだけ）。
 */
interface RunnerRequestQueuePorts {
  /** `RunnerSession#sdkSession`（使うのは `status`・`setStatus` だけ）。参照。 */
  sdkSession: Pick<RunnerSdkSession, 'status' | 'setStatus'>;
  /** `RunnerSession#pending`（確認待ちの要求。積むのも外すのもここ。中身だけが変わる参照で、差し替わらない）。参照。 */
  pending: PendingRequest[];
  /** `RunnerSession#resolved`（解けた確認の記憶。ここが `set` する）。参照。 */
  resolved: Pick<RecentMap<AgentPermissionDecision>, 'set'>;
  /** `RunnerSession#emit`（`ask`・`settled` を降ろす）。同期。 */
  emit: (event: RunnerEvent) => void;
  /** `RunnerSession#id`（作った後に変わらない）。 */
  managerId: string;
  /** `RunnerSession#deliverPeerNotices`（確認待ちの間に溜めた peer の知らせを届ける）。同期。 */
  deliverPeerNotices: () => void;
}

/**
 * `RunnerSession#queueRequest`（確認を積み、`ask` を出し、決着を待つ形。`#onPermission` と `#onPermissionDenied` が共有する）を受け持つ側。
 * 切り出し前の `RunnerSession` から切り出した。振る舞いは変えていない。自前の欄は無い。
 * `queueRequest` は同期（`async` にしない）。呼び元の `await` の数と周回数を動かさないため。
 */
export class RunnerRequestQueue {
  readonly #sdkSession: RunnerRequestQueuePorts['sdkSession'];
  readonly #pending: RunnerRequestQueuePorts['pending'];
  readonly #resolved: RunnerRequestQueuePorts['resolved'];
  readonly #emit: RunnerRequestQueuePorts['emit'];
  readonly #id: RunnerRequestQueuePorts['managerId'];
  readonly #deliverPeerNotices: RunnerRequestQueuePorts['deliverPeerNotices'];

  constructor(ports: RunnerRequestQueuePorts) {
    this.#sdkSession = ports.sdkSession;
    this.#pending = ports.pending;
    this.#resolved = ports.resolved;
    this.#emit = ports.emit;
    this.#id = ports.managerId;
    this.#deliverPeerNotices = ports.deliverPeerNotices;
  }

  // `#onPermission` と `#onPermissionDenied` が共有する「確認を積み、`ask` を出し、決着を待つ」形。2箇所に書くと `settle` の後始末や解けた印が黙ってずれるため
  // `ask` を中断の確かめより先に出す（#4772）: 受けた時点で中断済みだと `settled` が先に出て、デーモンが後から届いた `ask` を答えようの無い確認として積むため
  // `withdrawn` を型から落とさない: 落とすと畳みで解けた確認が取り下げとして日誌に残らず、`#onPermissionDenied` の deny の note がクローンの判断として書かれるため
  queueRequest(spec: {
    id: string;
    kind: PendingRequest['kind'];
    summary: string;
    askedAt: string;
    input: Record<string, unknown>;
    source: PeerApprovalSource | undefined;
    signal: AbortSignal | undefined;
    abortAnswer: Parameters<PendingRequest['settle']>[0];
    onAbort?: () => void;
  }): {
    result: Promise<AgentPermissionDecision>;
    answered: Promise<Parameters<PendingRequest['settle']>[0]>;
  } {
    const { id, kind, summary, askedAt, input, source, signal, abortAnswer, onAbort } = spec;
    let settle!: PendingRequest['settle'];
    const answered = new Promise<Parameters<PendingRequest['settle']>[0]>((resolve) => {
      settle = resolve;
    });

    const result = answered.then((answer) => {
      // `decideAnswer` の呼び出しを変えない: `Session#answer()` が同じ関数を呼んでおり、クローンへ返す値と SDK へ返る `behavior` の一致が壊れるため
      const { decision, unreadable } = decideAnswer(kind, answer.decision, answer.message);
      // 畳む・中断の経路では `question` も deny で返す: `decideAnswer` は `question` なら常に allow を返すので、`decision` だけで判定すると人間が答えていない問いに畳む・中断の理由の文言が「答え」として乗るため（`message` の文字列は嗅がない）
      const teardown = answer.withdrawn === true || answer.aborted === true;
      // teardown 側を `unreadable` の対象外にする: クローンの回答そのものではないため
      const denyMessage =
        !teardown && unreadable ? unreadableDenyMessage(answer.message) : answer.message;
      const outcome: AgentPermissionDecision =
        teardown || decision === 'deny'
          ? { behavior: 'deny', message: denyMessage }
          : kind === 'question'
            ? { behavior: 'allow', updatedInput: withAnswers(input, answer.message) }
            : { behavior: 'allow' };
      // 解けたことを覚えるのはここ1箇所: 経路ごとに覚え忘れる隙を作らないため
      this.#resolved.set(id, outcome);
      return outcome;
    });

    let done = false;
    let unlisten = () => undefined as void;

    const request: PendingRequest = {
      id,
      kind,
      summary,
      askedAt,
      result,
      // 待ち行列から自分を外すのは settle の責任: 呼び出し側任せにすると中断で解けた1件が行列に残り、次に届いた言葉を食い潰すため
      settle: (value) => {
        if (done) return;
        done = true;
        unlisten();
        const at = this.#pending.indexOf(request);
        if (at !== -1) this.#pending.splice(at, 1);
        if (this.#sdkSession.status === 'waiting_human' && this.#pending.length === 0) {
          this.#sdkSession.setStatus('running');
        }
        this.#emit({
          type: 'settled',
          managerId: this.#id,
          requestId: id,
          ...(value.withdrawn === true ? { withdrawn: { reason: value.message } } : {}),
        });
        settle(value);
        // 確認待ちの間に溜めた peer の知らせを届ける: 手すきのマネージャーへ背景の peer が上げた確認だと、
        // この後に報告の区切りが来ず、溜めたまま残るため
        this.#deliverPeerNotices();
      },
    };

    this.#pending.push(request);
    this.#sdkSession.setStatus('waiting_human');

    this.#emit({
      type: 'ask',
      managerId: this.#id,
      requestId: id,
      kind,
      summary,
      askedAt,
      ...(source === undefined ? {} : { source: { type: 'peer', provider: source.provider } }),
    });

    if (signal !== undefined) {
      const abort = () => {
        onAbort?.();
        request.settle(abortAnswer);
      };
      if (signal.aborted) {
        abort();
      } else {
        signal.addEventListener('abort', abort, { once: true });
        unlisten = () => signal.removeEventListener('abort', abort);
      }
    }

    return { result, answered };
  }
}

function withAnswers(input: Record<string, unknown>, message: string): Record<string, unknown> {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const text = (question as { question?: unknown }).question;
    if (typeof text === 'string') answers[text] = message;
  }
  return { ...input, answers };
}

// 元の文言を1文字も消さない: 安全側で拒否したことと答え直し方を前置きとして足すだけ
function unreadableDenyMessage(original: string): string {
  return (
    '[decision が無く、承認とも拒否とも読み取れなかったので安全側で拒否した] ' +
    `${original}\n\n許可するときは decision: 'allow' を明示して答え直すこと。`
  );
}
