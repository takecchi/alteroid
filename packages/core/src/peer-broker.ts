import { randomBytes } from 'node:crypto';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { AgentEvent } from './agent-events.js';
import type {
  AgentManagerDriver,
  AgentManagerSession,
  AgentManagerSessionSpec,
  AgentPermissionDecision,
  AgentPermissionHandler,
  AgentPermissionRequest,
  AgentUserInput,
} from './agent-session.js';
import type { AgentProviderId } from './agent-ports.js';
import { excerptLine } from './excerpt.js';
import { foldUsageSnapshot, hasAnyUsage, type UsageBaseline, type UsageTotals } from './usage.js';

/**
 * マネージャー層の MCP `peer`（`peer_run` / `peer_reply` / `peer_approve`）の中身（Issue #486 S7・#3940）。
 *
 * マネージャーが、もう一方の provider のエージェントを1本立てて**作業を頼む**（相談だけでなく、
 * ファイルの作成・編集・コマンドの実行を含む）。**呼ぶかどうかはマネージャー自身の判断**で、枠やコストを
 * 理由に alteroid が寄せることはない。見える provider は人間が `ALTEROID_MANAGER_PEERS` で開けたものだけ
 * である（空なら、この道具ごと出さない）。
 *
 * ## 承認は、まずマネージャーへ返す。判断できないときだけクローンへ上げる（2026-10-07 のオーナー決定）
 *
 * peer のセッションの構えは呼び出し元のマネージャーと同じ（runner の `makeSpec`）。それでも確認が出たら、
 * `peer_run` / `peer_reply` は**保留したまま待たずに**、確認の中身と一意な id（`approval_id`）を添えて
 * マネージャーへ返す。マネージャーは `peer_approve` で `allow` / `deny`（その場で答える）か
 * `escalate`（既存の経路 `askApproval` でクローンの受信箱へ上げ、答えを待つ）を選ぶ。どの判断のあとも、
 * 相手の続き（次の確認待ち、またはターンの結果）を返す。
 *
 * **出所の印（`【peer: <provider>】`。要約の先頭と `ask.source`）は escalate の経路で必ず付く。**
 * 誰が答えたか（`manager` / `clone`）は結果と日誌の note に出る。
 *
 * **閉じる側に倒す**: 質問（`AskUserQuestion` 相当）は上げずに拒否する。escalate で `askApproval` が
 * 無い・投げた、知らない `approval_id`、答えないまま次の `peer_run` が呼ばれた、セッションが閉じた・
 * ターンが終わった——どれも拒否として閉じる（確認を宙に浮かせたまま相手を止め続けない）。
 *
 * ## 台帳
 *
 * 1ターンごとに、peer セッションの累積を peer セッション自身の基準で増分にして
 * {@link PeerUsageReport} として降ろす（デーモンが `site: 'peer'`・層 `manager` で積む）。
 * 消費を報告しない provider は 0 を積まず「取れなかった」として数える。
 */

/** `peer_run` / `peer_reply` / `peer_approve` の道具名（MCP サーバ名 {@link PEER_MCP_SERVER_NAME} の下）。 */
export const PEER_TOOL_NAMES = ['peer_run', 'peer_reply', 'peer_approve'] as const;

/** MCP サーバ名。道具の名前は `mcp__alteroid-peer__peer_run` になる。 */
export const PEER_MCP_SERVER_NAME = 'alteroid-peer';

/** peer のセッションへ足すシステムプロンプト（誰に呼ばれたか・確認の行き先を本人へ伝える）。 */
export const PEER_SYSTEM_PROMPT_APPEND =
  'あなたは alteroid のマネージャーから、作業を任された別の provider のエージェントである。' +
  '依頼してきたのはマネージャーであり、人間ではない。' +
  '依頼された作業は、調査や助言で止めずに実際に行うこと（ファイルの作成・編集、コマンドの実行を含む）。' +
  'このセッションの許可確認は、まず呼び出し元のマネージャーへ届き、マネージャーが判断できないときはクローンへ上がる。' +
  '確認が要る操作は、答えが出るまで待たされ、拒否されることもある。拒否されたら別の方法を探すか、できなかったことを伝えること。' +
  '終わったら、何をしたか（変えたファイル・実行したコマンド）と、残っていることを簡潔に返すこと。';

/** peer の確認に対するマネージャーの判断。 */
export const PEER_APPROVAL_DECISIONS = ['allow', 'deny', 'escalate'] as const;
export type PeerApprovalDecision = (typeof PEER_APPROVAL_DECISIONS)[number];

/** 誰が答えたか。`auto` は閉じる側に倒した拒否（質問・口が無い・放置・セッション終了）。 */
export type PeerApprovalAnswerer = 'manager' | 'clone' | 'auto';

/** 確認1件の記録（結果に出す）。 */
export interface PeerApprovalRecord {
  readonly toolName: string;
  readonly by: PeerApprovalAnswerer;
}

/** マネージャーへ返す、答えを待っている確認。 */
export interface PeerPendingApproval {
  readonly approvalId: string;
  readonly toolName: string;
  /** 何をしようとしているか（抜粋）。 */
  readonly summary: string;
}

/** 確認の中身の抜粋の上限（1件の確認であって一覧ではないが、出す側で締める）。 */
export const PEER_APPROVAL_SUMMARY_LIMIT = 1200;

export interface PeerUsageReport {
  readonly provider: AgentProviderId;
  readonly sessionId?: string;
  /** このターンの増分（空なら積めるものが無かった）。 */
  readonly models: Record<string, UsageTotals>;
  /** 消費を報告しない provider のターン。 */
  readonly unmetered: boolean;
}

export interface PeerBrokerDeps {
  /** 呼んでよい provider（呼び出し側が自分の層の provider を除いた集合）。 */
  readonly allowed: readonly AgentProviderId[];
  /**
   * provider ごとに、人間が開けたモデル名の一覧（`ALTEROID_MANAGER_PEER_CODEX_MODELS` 等）。
   * **空（または省略）なら `peer_run` に `model` 引数を出さない。** 一覧に無い値は断る（既定へ倒さない）。
   */
  readonly models?: Partial<Record<AgentProviderId, readonly string[]>>;
  /**
   * いま閉じている provider の理由（#4118）。道具を出した後に資格が外れた（ログアウト・鍵の削除）とき、
   * `peer_run` は相手を起こさずにこの理由で断る。省略・`undefined` は開いている。
   */
  readonly closedReason?: (provider: AgentProviderId) => string | undefined;
  readonly driverOf: (provider: AgentProviderId) => AgentManagerDriver;
  /**
   * peer セッション1本の材料。`input` と `onPermission` / `onNote`（と名指しされたモデル）だけを渡す。
   * 残り（cwd・env・子プロセスの起こし方・権限の構え・フック）は呼び出し側（runner）が持つ。
   * `model` が在れば、それを provider へ渡すこと（無ければ provider の既定）。
   */
  readonly makeSpec: (
    provider: AgentProviderId,
    parts: {
      input: AsyncIterable<AgentUserInput>;
      onPermission: AgentPermissionHandler;
      onNote: (text: string) => void;
      model?: string;
    },
  ) => AgentManagerSessionSpec;
  /** provider が消費を報告するか（`capabilities.usage`）。 */
  readonly reportsUsage: (provider: AgentProviderId) => boolean;
  readonly onNote: (text: string) => void;
  readonly onUsage: (report: PeerUsageReport) => void;
  readonly now?: () => Date;
  /**
   * `escalate` の行き先: peer のセッションの承認を、呼び出し元のマネージャーの承認として既存の経路で
   * クローンへ上げる口（出所の印つき。`peerApprovalMark`）。**省略（または投げた）ときは拒否する**（閉じる側）。
   */
  readonly askApproval?: (
    source: PeerApprovalSource,
    request: AgentPermissionRequest,
  ) => Promise<AgentPermissionDecision>;
}

/** 承認の出所（peer のセッション）。 */
export interface PeerApprovalSource {
  readonly provider: AgentProviderId;
  readonly sessionId: string;
}

/** 要約の先頭に必ず付ける出所の印。 */
export function peerApprovalMark(provider: string): string {
  return `【peer: ${provider}】`;
}

/** 1回の `peer_run` / `peer_reply` / `peer_approve` の結果。 */
export interface PeerTurnResult {
  readonly sessionId: string;
  readonly provider: AgentProviderId;
  /** provider が名乗った実際のモデル名（名乗らなければ無い）。 */
  readonly model?: string;
  readonly ok: boolean;
  /** 応答の本文（失敗なら失敗の説明。確認待ちなら空）。 */
  readonly text: string;
  /** **在れば、ターンはこの確認の答えを待って止まっている**（`peer_approve` で答える）。 */
  readonly pendingApproval?: PeerPendingApproval;
  /** このターンで拒否した操作（到着順）。 */
  readonly denied: readonly PeerApprovalRecord[];
  /** このターンで許可した操作（到着順）。 */
  readonly approved: readonly PeerApprovalRecord[];
}

/** 入力を1通ずつ流し込める AsyncIterable（閉じると終わる）。 */
class InputQueue implements AsyncIterable<AgentUserInput> {
  readonly #items: AgentUserInput[] = [];
  #waiter: (() => void) | undefined;
  #closed = false;

  push(text: string): void {
    this.#items.push({ text });
    this.#wake();
  }

  close(): void {
    this.#closed = true;
    this.#wake();
  }

  #wake(): void {
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AgentUserInput> {
    for (;;) {
      const next = this.#items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#waiter = resolve;
      });
    }
  }
}

interface PendingEntry {
  readonly approvalId: string;
  readonly request: AgentPermissionRequest;
  readonly summary: string;
  readonly settle: (decision: AgentPermissionDecision, by: PeerApprovalAnswerer) => void;
}

function describeRequest(request: AgentPermissionRequest): string {
  const input = JSON.stringify(request.input) ?? '';
  const reason = request.reason === undefined ? '' : ` 理由: ${request.reason}`;
  return excerptLine(`${request.toolName}: ${input}${reason}`, PEER_APPROVAL_SUMMARY_LIMIT);
}

const ANSWERER_LABEL: Record<PeerApprovalAnswerer, string> = {
  manager: 'マネージャー',
  clone: 'クローン',
  auto: 'alteroid（閉じる側）',
};

class PeerSession {
  readonly id: string;
  readonly provider: AgentProviderId;
  readonly #input = new InputQueue();
  readonly #session: AgentManagerSession;
  readonly #deps: PeerBrokerDeps;
  /** 流しているターン（`turn_ended` まで）。 */
  #turnActive = false;
  #turnText: string[] = [];
  /** 終わったが、まだ誰にも返していないターンの結果。 */
  #finished: { ok: boolean; text: string } | undefined;
  readonly #pending: PendingEntry[] = [];
  readonly #stopWaiters = new Set<() => void>();
  #denied: PeerApprovalRecord[] = [];
  #approved: PeerApprovalRecord[] = [];
  #baseline: UsageBaseline | null = null;
  #providerSessionId: string | undefined;
  #model: string | undefined;
  #ended: string | undefined;

  constructor(
    id: string,
    provider: AgentProviderId,
    deps: PeerBrokerDeps,
    model: string | undefined,
  ) {
    this.id = id;
    this.provider = provider;
    this.#deps = deps;
    const onPermission: AgentPermissionHandler = (request) => this.#onPermission(request);
    this.#session = deps.driverOf(provider).open(
      deps.makeSpec(provider, {
        input: this.#input,
        onPermission,
        onNote: (text) => deps.onNote(`peer（${provider}）[${id}] ${text}`),
        ...(model === undefined ? {} : { model }),
      }),
    );
    void this.#session
      .readEvents((event) => this.#onEvent(event))
      .then(
        () => this.#end('セッションが閉じた'),
        (error: unknown) =>
          this.#end(
            `セッションが落ちた: ${error instanceof Error ? error.message : String(error)}`,
          ),
      );
  }

  get ended(): string | undefined {
    return this.#ended;
  }

  /** ターンを流している最中か（確認待ちを含む）。同時に2ターンは流さない。 */
  get busy(): boolean {
    return this.#turnActive;
  }

  /** 答えを待っている確認の id（到着順）。 */
  get pendingIds(): readonly string[] {
    return this.#pending.map((entry) => entry.approvalId);
  }

  hasPending(approvalId: string): boolean {
    return this.#pending.some((entry) => entry.approvalId === approvalId);
  }

  turn(text: string, signal: AbortSignal | undefined): Promise<PeerTurnResult> {
    if (this.#ended !== undefined) {
      return Promise.resolve(
        this.#result(false, `peer のセッションは終わっている（${this.#ended}）`),
      );
    }
    this.#denied = [];
    this.#approved = [];
    this.#turnText = [];
    this.#finished = undefined;
    this.#turnActive = true;
    this.#input.push(text);
    return this.#nextStop(signal);
  }

  /**
   * 確認1件に答え、相手の続き（次の確認待ち、またはターンの結果）を返す。
   * `escalate` はクローンの答えが出るまで返らない。
   */
  async answer(
    approvalId: string,
    decision: PeerApprovalDecision,
    message: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<PeerTurnResult> {
    const index = this.#pending.findIndex((entry) => entry.approvalId === approvalId);
    const entry = index === -1 ? undefined : this.#pending.splice(index, 1)[0];
    if (entry !== undefined) {
      if (decision === 'allow') {
        entry.settle({ behavior: 'allow' }, 'manager');
      } else if (decision === 'deny') {
        entry.settle(
          { behavior: 'deny', message: message ?? '呼び出し元のマネージャーが拒否した。' },
          'manager',
        );
      } else {
        await this.#escalate(entry);
      }
    }
    return this.#nextStop(signal);
  }

  /** 答えを待っている確認を全部拒否として閉じる（放置・セッション終了など）。 */
  denyPending(reason: string): void {
    for (const entry of this.#pending.splice(0)) {
      this.#deps.onNote(
        `peer（${this.provider}）[${this.id}] の確認 ${entry.approvalId}（${entry.request.toolName}）を拒否として閉じた: ${reason}`,
      );
      entry.settle(
        { behavior: 'deny', message: `確認に答えが出なかったので拒否した（${reason}）。` },
        'auto',
      );
    }
  }

  close(): void {
    this.denyPending('セッションを閉じた');
    this.#input.close();
    try {
      this.#session.close();
    } catch {
      // 既に閉じている
    }
  }

  async #escalate(entry: PendingEntry): Promise<void> {
    const ask = this.#deps.askApproval;
    if (ask === undefined) {
      entry.settle(
        {
          behavior: 'deny',
          message: 'クローンへ確認を上げる口が無いため拒否した。',
        },
        'auto',
      );
      this.#deps.onNote(
        `peer（${this.provider}）[${this.id}] の ${entry.request.toolName} はクローンへ上げられないので拒否した（承認の口が無い）`,
      );
      return;
    }
    let decision: AgentPermissionDecision;
    try {
      decision = await ask({ provider: this.provider, sessionId: this.id }, entry.request);
    } catch (error) {
      entry.settle(
        {
          behavior: 'deny',
          message: `承認を上げられなかったので拒否した: ${error instanceof Error ? error.message : String(error)}`,
        },
        'auto',
      );
      return;
    }
    entry.settle(decision, 'clone');
  }

  #onPermission(request: AgentPermissionRequest): Promise<AgentPermissionDecision> {
    // 質問（AskUserQuestion 相当）は返さない。続きは peer_reply で話す。
    if (request.kind === 'question') {
      this.#denied.push({ toolName: request.toolName, by: 'auto' });
      this.#deps.onNote(
        `peer（${this.provider}）[${this.id}] のセッションで質問を拒否した: ${request.toolName}（質問は上げない）`,
      );
      return Promise.resolve({
        behavior: 'deny',
        message: 'このセッションでは質問は上に届かない。分からない点は最後の応答に書くこと。',
      });
    }
    if (this.#ended !== undefined) {
      return Promise.resolve({ behavior: 'deny', message: 'セッションは終わっている。' });
    }
    return new Promise<AgentPermissionDecision>((resolve) => {
      let settled = false;
      const approvalId = `appr-${randomBytes(6).toString('hex')}`;
      const onAbort = (): void => {
        const index = this.#pending.findIndex((entry) => entry.approvalId === approvalId);
        if (index !== -1) this.#pending.splice(index, 1);
        settle({ behavior: 'deny', message: '確認は相手の側で取り下げられた。' }, 'auto');
      };
      const settle = (decision: AgentPermissionDecision, by: PeerApprovalAnswerer): void => {
        if (settled) return;
        settled = true;
        request.signal.removeEventListener('abort', onAbort);
        const record = { toolName: request.toolName, by };
        if (decision.behavior === 'allow') {
          this.#approved.push(record);
          this.#deps.onNote(
            `peer（${this.provider}）[${this.id}] の ${request.toolName} を${ANSWERER_LABEL[by]}が許可した（answeredBy=${by}）`,
          );
        } else {
          this.#denied.push(record);
          this.#deps.onNote(
            `peer（${this.provider}）[${this.id}] の ${request.toolName} を${ANSWERER_LABEL[by]}が拒否した（answeredBy=${by}）`,
          );
        }
        resolve(decision);
      };
      if (request.signal.aborted) {
        onAbort();
        return;
      }
      request.signal.addEventListener('abort', onAbort, { once: true });
      this.#pending.push({ approvalId, request, summary: describeRequest(request), settle });
      this.#deps.onNote(
        `peer（${this.provider}）[${this.id}] の ${request.toolName} の確認 ${approvalId} をマネージャーへ返した`,
      );
      this.#wake();
    });
  }

  #wake(): void {
    const waiters = [...this.#stopWaiters];
    this.#stopWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  /** 次の止まりどころ（確認待ち・ターンの終わり・セッションの終わり）まで待つ。 */
  async #nextStop(signal: AbortSignal | undefined): Promise<PeerTurnResult> {
    const onAbort = (): void => {
      this.close();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        const pending = this.#pending[0];
        if (pending !== undefined) {
          return this.#result(true, '', {
            approvalId: pending.approvalId,
            toolName: pending.request.toolName,
            summary: pending.summary,
          });
        }
        const finished = this.#finished;
        if (finished !== undefined) {
          this.#finished = undefined;
          return this.#result(finished.ok, finished.text);
        }
        if (!this.#turnActive || this.#ended !== undefined) {
          return this.#result(
            false,
            this.#ended === undefined
              ? 'peer のセッションは流しているターンが無い'
              : `peer のセッションは終わっている（${this.#ended}）`,
          );
        }
        await new Promise<void>((resolve) => {
          this.#stopWaiters.add(resolve);
        });
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  #result(ok: boolean, text: string, pendingApproval?: PeerPendingApproval): PeerTurnResult {
    return {
      sessionId: this.id,
      provider: this.provider,
      ...(this.#model === undefined ? {} : { model: this.#model }),
      ok,
      text,
      ...(pendingApproval === undefined ? {} : { pendingApproval }),
      denied: [...this.#denied],
      approved: [...this.#approved],
    };
  }

  #finishTurn(outcome: { ok: boolean; text: string }): void {
    if (!this.#turnActive) return;
    this.#turnActive = false;
    this.#finished = outcome;
    this.denyPending('ターンが終わった');
    this.#wake();
  }

  #end(reason: string): void {
    this.#ended ??= reason;
    this.denyPending('セッションが閉じた');
    this.#finishTurn({ ok: false, text: `peer のセッションが途中で終わった（${reason}）` });
    this.#wake();
  }

  async #onEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'session_started':
        this.#providerSessionId = event.sessionId;
        if (typeof event.runtime?.model === 'string' && event.runtime.model.length > 0) {
          this.#model = event.runtime.model;
        }
        return;
      case 'assistant_message': {
        if (event.parentToolUseId !== null) return;
        for (const block of event.blocks) {
          if (block.type === 'text') this.#turnText.push(block.text);
        }
        return;
      }
      case 'turn_ended': {
        await this.#reportUsage(event);
        if (event.failure !== undefined || !event.succeeded) {
          const lines = event.errorLines.length > 0 ? `: ${event.errorLines.join(' / ')}` : '';
          this.#finishTurn({
            ok: false,
            text: `peer のターンが失敗した（${event.outcome ?? '失敗'}）${lines}`,
          });
          return;
        }
        const body = event.body.length > 0 ? event.body : this.#turnText.join('\n');
        this.#finishTurn({ ok: true, text: body });
        return;
      }
      default:
        return;
    }
  }

  async #reportUsage(event: Extract<AgentEvent, { type: 'turn_ended' }>): Promise<void> {
    try {
      let models = event.usage?.models;
      if (models === undefined && event.succeeded) {
        models = await this.#session.sessionModelUsage().catch(() => undefined);
      }
      if (models === undefined || !hasAnyUsage(models)) {
        // 無報告の provider だけ「取れなかった」と数える（Claude の失敗 result は数えない）。
        if (!this.#deps.reportsUsage(this.provider)) {
          this.#deps.onUsage({
            provider: this.provider,
            ...(this.#providerSessionId === undefined
              ? {}
              : { sessionId: this.#providerSessionId }),
            models: {},
            unmetered: true,
          });
        }
        return;
      }
      const at = (this.#deps.now?.() ?? new Date()).toISOString();
      const fold = foldUsageSnapshot(
        this.#baseline,
        {
          ...(this.#providerSessionId === undefined ? {} : { sessionId: this.#providerSessionId }),
          models,
        },
        at,
      );
      this.#baseline = fold.baseline;
      if (Object.keys(fold.delta).length === 0) return;
      this.#deps.onUsage({
        provider: this.provider,
        ...(this.#providerSessionId === undefined ? {} : { sessionId: this.#providerSessionId }),
        models: fold.delta,
        unmetered: false,
      });
    } catch (error) {
      this.#deps.onNote(
        `peer（${this.provider}）[${this.id}] の消費を読めなかった: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export interface PeerRunOptions {
  /** 人間が開けた一覧（{@link PeerBrokerDeps.models}）の中のモデル名。省略は provider の既定。 */
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export interface PeerBroker {
  run(provider: string, prompt: string, options?: PeerRunOptions): Promise<PeerTurnResult | string>;
  reply(sessionId: string, message: string, signal?: AbortSignal): Promise<PeerTurnResult | string>;
  approve(
    approvalId: string,
    decision: PeerApprovalDecision,
    options?: { message?: string; signal?: AbortSignal },
  ): Promise<PeerTurnResult | string>;
  closeAll(): void;
  /** 道具を載せた MCP サーバ（`createSdkMcpServer` の戻り値）。 */
  mcpServer(): ReturnType<typeof createSdkMcpServer>;
}

function uniqueList(by: readonly PeerApprovalRecord[]): string {
  return [...new Set(by.map((record) => `${record.toolName}(${record.by})`))].join(', ');
}

export function createPeerBroker(deps: PeerBrokerDeps): PeerBroker {
  const sessions = new Map<string, PeerSession>();
  const allowed = new Set<string>(deps.allowed);
  const modelsOf = (provider: AgentProviderId): readonly string[] => deps.models?.[provider] ?? [];
  const allModels = [...new Set(deps.allowed.flatMap((provider) => [...modelsOf(provider)]))];

  const run: PeerBroker['run'] = async (provider, prompt, options = {}) => {
    if (!allowed.has(provider)) {
      return `provider「${provider}」は呼べない（呼べるのは ${[...allowed].join(' / ')}）`;
    }
    const id = provider as AgentProviderId;
    const closed = deps.closedReason?.(id);
    if (closed !== undefined) return closed;
    const { model } = options;
    if (model !== undefined) {
      const open = modelsOf(id);
      if (!open.includes(model)) {
        return open.length === 0
          ? `provider「${provider}」はモデルを名指しできない（人間が開けたモデルが無い）。model を省けば ${provider} の既定で動く`
          : `model「${model}」は選べない（開いているのは ${open.join(' / ')}。省けば ${provider} の既定で動く）`;
      }
    }
    // **答えないまま次の peer_run を呼んだら、古い確認は拒否として閉じる**（相手を止め続けない）。
    for (const session of sessions.values()) {
      session.denyPending('答えないまま次の peer_run が呼ばれた');
    }
    const sessionId = `peer-${randomBytes(6).toString('hex')}`;
    let session: PeerSession;
    try {
      session = new PeerSession(sessionId, id, deps, model);
    } catch (error) {
      return `peer のセッションを開けなかった: ${error instanceof Error ? error.message : String(error)}`;
    }
    sessions.set(sessionId, session);
    deps.onNote(
      `peer（${provider}）[${sessionId}] を起こした${model === undefined ? '' : `（model=${model}）`}`,
    );
    return session.turn(prompt, options.signal);
  };

  const reply: PeerBroker['reply'] = async (sessionId, message, signal) => {
    const session = sessions.get(sessionId);
    if (session === undefined)
      return `session_id「${sessionId}」の peer セッションは無い（peer_run で起こすこと）`;
    if (session.pendingIds.length > 0) {
      return (
        `peer のセッション ${sessionId} は確認の答えを待っている（approval_id=${session.pendingIds.join(', ')}）。` +
        'peer_approve で答えること'
      );
    }
    if (session.busy) return `peer のセッション ${sessionId} は前のターンの応答を待っている`;
    return session.turn(message, signal);
  };

  const approve: PeerBroker['approve'] = async (approvalId, decision, options = {}) => {
    for (const session of sessions.values()) {
      if (session.hasPending(approvalId)) {
        return session.answer(approvalId, decision, options.message, options.signal);
      }
    }
    return (
      `approval_id「${approvalId}」の確認は無い（もう答えた・拒否として閉じた・知らない id）。` +
      '答えの無い確認は拒否として扱われている'
    );
  };

  const render = (
    result: PeerTurnResult | string,
  ): { content: { type: 'text'; text: string }[]; isError?: boolean } => {
    if (typeof result === 'string')
      return { content: [{ type: 'text', text: result }], isError: true };
    const lines = [
      `session_id: ${result.sessionId}（続けるなら peer_reply に渡す）`,
      `provider: ${result.provider}`,
    ];
    if (result.model !== undefined)
      lines.push(`model: ${result.model}（相手が名乗った実際のモデル）`);
    if (result.denied.length > 0) {
      lines.push(
        `承認が要る操作を ${result.denied.length} 件拒否した（${uniqueList(result.denied)}）。` +
          '（括弧内は答えた側: manager / clone / auto=閉じる側に倒した）',
      );
    }
    if (result.approved.length > 0) {
      lines.push(
        `承認した操作が ${result.approved.length} 件あった（${uniqueList(result.approved)}）`,
      );
    }
    const pending = result.pendingApproval;
    if (pending !== undefined) {
      lines.push(
        '',
        `確認待ち: approval_id=${pending.approvalId}`,
        `操作: ${pending.toolName}`,
        `内容: ${pending.summary}`,
        '',
        'peer_approve に approval_id と decision を渡して答えること' +
          '（allow=その場で許可 / deny=拒否 / escalate=判断できないのでクローンへ回す）。' +
          '答えるまで相手のターンは止まっている。答えずに次の peer_run を呼ぶと、この確認は拒否として閉じる。',
      );
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
    lines.push('', result.text);
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      ...(result.ok ? {} : { isError: true }),
    };
  };

  const providerList = deps.allowed.join(' / ');
  const approvalNote =
    '相手のセッションで確認が要る操作（書き込み・コマンドの実行など）が出ると、呼び出しは確認の中身と approval_id を' +
    '添えて返る（確認待ち）。peer_approve で答えると続きが返る。';
  return {
    run,
    reply,
    approve,
    closeAll() {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    },
    mcpServer() {
      const runShape = {
        provider: z
          .enum(deps.allowed as [AgentProviderId, ...AgentProviderId[]])
          .describe('呼ぶ provider'),
        prompt: z.string().min(1).describe('相手への依頼（前提を含めて自己完結に書く）'),
      };
      // 一覧が空なら引数ごと出さない（`model` の欄が在るのに選べる値が無い、という形を作らない）。
      const modelShape: z.ZodRawShape =
        allModels.length === 0
          ? {}
          : {
              model: z
                .enum(allModels as [string, ...string[]])
                .optional()
                .describe(
                  '使うモデル（人間が開けた一覧の中からだけ選べる）。省略は provider の既定',
                ),
            };
      return createSdkMcpServer({
        name: PEER_MCP_SERVER_NAME,
        version: '0.1.0',
        instructions:
          `もう一方の provider（${providerList}）のエージェントに、作業を頼む・相談する道具。` +
          '呼ぶかどうかは自分で判断すること（枠やコストを理由に自動で寄せる仕組みは無い）。',
        tools: [
          tool(
            'peer_run',
            `もう一方の provider（${providerList}）のエージェントを新しく1本立て、prompt を渡して作業を頼む` +
              '（ファイルの作成・編集・コマンドの実行を含む。調査・レビュー・相談にも使える）。' +
              '相手は別の担い手で、あなたの文脈を持たない——必要な前提（作業ディレクトリ・完了の条件）は prompt に書くこと。' +
              approvalNote +
              '続きは返ってきた session_id を peer_reply へ渡す。' +
              (allModels.length === 0
                ? ''
                : `model で開いているモデル（${allModels.join(' / ')}）を名指しできる。`),
            // `model` は在るときだけの欄なので、型は runShape に寄せて、値はハンドラで読む。
            { ...runShape, ...modelShape } as typeof runShape,
            async (args, extra) => {
              const model = (args as { model?: string }).model;
              const signal = signalOf(extra);
              return render(
                await run(args.provider, args.prompt, {
                  ...(model === undefined ? {} : { model }),
                  ...(signal === undefined ? {} : { signal }),
                }),
              );
            },
          ),
          tool(
            'peer_reply',
            'peer_run で立てた相手のセッションへ、続きの指示を送って結果を受け取る。' +
              approvalNote,
            {
              session_id: z.string().min(1).describe('peer_run が返した session_id'),
              message: z.string().min(1).describe('相手への続きの指示'),
            },
            async (args, extra) =>
              render(await reply(args.session_id, args.message, signalOf(extra))),
          ),
          tool(
            'peer_approve',
            '相手のセッションの確認待ち（peer_run / peer_reply / peer_approve が返した approval_id）に答え、続きを受け取る。' +
              'allow / deny はあなたがその場で答える。判断できないときは escalate でクローンへ回す' +
              '（クローンの答えが出るまでこの呼び出しは返らない。出所は peer と印が付く）。',
            {
              approval_id: z.string().min(1).describe('確認待ちの approval_id'),
              decision: z
                .enum(PEER_APPROVAL_DECISIONS)
                .describe('allow=許可 / deny=拒否 / escalate=クローンへ回す'),
              message: z
                .string()
                .min(1)
                .optional()
                .describe('deny のとき相手へ伝える理由（代わりにどうしてほしいか）'),
            },
            async (args, extra) => {
              const signal = signalOf(extra);
              return render(
                await approve(args.approval_id, args.decision, {
                  ...(args.message === undefined ? {} : { message: args.message }),
                  ...(signal === undefined ? {} : { signal }),
                }),
              );
            },
          ),
        ],
      });
    },
  };
}

/** MCP のハンドラの `extra` から、呼び出しの中断の合図を取り出す。 */
function signalOf(extra: unknown): AbortSignal | undefined {
  const signal = (extra as { signal?: unknown } | undefined)?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}
