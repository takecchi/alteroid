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
import { foldUsageSnapshot, hasAnyUsage, type UsageBaseline, type UsageTotals } from './usage.js';

/**
 * マネージャー層の MCP `peer`（`peer_run` / `peer_reply`）の中身（Issue #486 S7）。
 *
 * マネージャーが、もう一方の provider のエージェントを「相談相手」として1本立て、
 * 話しかける。**呼ぶかどうかはマネージャー自身の判断**で、枠やコストを理由に alteroid が
 * 寄せることはない。見える provider は人間が `ALTEROID_MANAGER_PEERS` で開けたものだけである
 * （空なら、この道具ごと出さない）。
 *
 * ## 承認は、呼び出し元のマネージャーの承認として既存の経路でクローンへ上げる
 *
 * peer のセッションで許可確認が出たら、`askApproval`（runner の既存の承認の経路。`ask` イベント）へ
 * 上げる。**出所の印（`【peer: <provider>】`。要約の先頭と `ask.source`）を必ず付ける。**
 * 新しい権限は増やさない（クローンが答える既存の経路に乗るだけ）。答えが出るまで `peer_run` /
 * `peer_reply` の応答は保留される。**閉じる側に倒す**: `askApproval` が無い・投げた・質問（`AskUserQuestion`）
 * のときは拒否する。peer のセッションは「確認なしで勝手に動かない」構えで起こす
 * （`strictApprovals`: Claude は `default` モード、Codex は `untrusted`）ので、信頼済みの読み取り以外は
 * 必ず確認に上がる。許可・拒否の件数は結果と日誌の note に出る。
 *
 * ## 台帳
 *
 * 1ターンごとに、peer セッションの累積を peer セッション自身の基準で増分にして
 * {@link PeerUsageReport} として降ろす（デーモンが `site: 'peer'`・層 `manager` で積む）。
 * 消費を報告しない provider は 0 を積まず「取れなかった」として数える。
 */

/** `peer_run` / `peer_reply` の道具名（MCP サーバ名 {@link PEER_MCP_SERVER_NAME} の下）。 */
export const PEER_TOOL_NAMES = ['peer_run', 'peer_reply'] as const;

/** MCP サーバ名。道具の名前は `mcp__alteroid-peer__peer_run` になる。 */
export const PEER_MCP_SERVER_NAME = 'alteroid-peer';

/** peer のセッションへ足すシステムプロンプト（承認が上がらないことを本人へ伝える）。 */
export const PEER_SYSTEM_PROMPT_APPEND =
  'あなたは alteroid のマネージャーから相談相手として呼ばれた、別の provider のエージェントである。' +
  '依頼してきたのはマネージャーであり、人間ではない。' +
  'このセッションの許可確認は、呼び出し元のマネージャーを通じてクローンへ上がる。確認が要る操作（書き込み・外部への通信など）は、クローンが許可するまで待たされ、拒否されることもある。' +
  '調査・読み取り・レビュー・方針の相談に徹し、結論と根拠を簡潔に返すこと。';

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
  readonly driverOf: (provider: AgentProviderId) => AgentManagerDriver;
  /**
   * peer セッション1本の材料。`input` と `onPermission` / `onNote` だけを渡す。残り（cwd・env・
   * 子プロセスの起こし方・モデル・フック）は呼び出し側（runner）が持つ。
   * `strictApprovals: true` を必ず載せること。
   */
  readonly makeSpec: (
    provider: AgentProviderId,
    parts: {
      input: AsyncIterable<AgentUserInput>;
      onPermission: AgentPermissionHandler;
      onNote: (text: string) => void;
    },
  ) => AgentManagerSessionSpec;
  /** provider が消費を報告するか（`capabilities.usage`）。 */
  readonly reportsUsage: (provider: AgentProviderId) => boolean;
  readonly onNote: (text: string) => void;
  readonly onUsage: (report: PeerUsageReport) => void;
  readonly now?: () => Date;
  /**
   * peer のセッションの承認を、呼び出し元のマネージャーの承認として既存の経路でクローンへ上げる口
   * （出所の印つき。`peerApprovalMark`）。**省略（または投げた）ときは全部拒否する**（閉じる側）。
   * 待つあいだ `peer_run` / `peer_reply` の応答は保留される。
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

/** 1回の `peer_run` / `peer_reply` の結果。 */
export interface PeerTurnResult {
  readonly sessionId: string;
  readonly provider: AgentProviderId;
  readonly ok: boolean;
  /** 応答の本文（失敗なら失敗の説明）。 */
  readonly text: string;
  /** 承認が要るとして拒否した操作の道具名（重複あり・到着順）。 */
  readonly denied: readonly string[];
  /** クローンが許可した操作の道具名。 */
  readonly approved: readonly string[];
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

interface TurnWaiter {
  resolve(result: { ok: boolean; text: string }): void;
  text: string[];
}

class PeerSession {
  readonly id: string;
  readonly provider: AgentProviderId;
  readonly #input = new InputQueue();
  readonly #session: AgentManagerSession;
  readonly #deps: PeerBrokerDeps;
  #waiter: TurnWaiter | undefined;
  #denied: string[] = [];
  #approved: string[] = [];
  #baseline: UsageBaseline | null = null;
  #providerSessionId: string | undefined;
  #ended: string | undefined;

  constructor(id: string, provider: AgentProviderId, deps: PeerBrokerDeps) {
    this.id = id;
    this.provider = provider;
    this.#deps = deps;
    const deny = (message: string): AgentPermissionDecision => ({ behavior: 'deny', message });
    const onPermission: AgentPermissionHandler = async (request) => {
      const ask = deps.askApproval;
      // 質問（AskUserQuestion）は上げない。続きは peer_reply で話す。
      if (ask === undefined || request.kind === 'question') {
        this.#denied.push(request.toolName);
        deps.onNote(
          `peer（${provider}）[${id}] のセッションで承認が要る操作を拒否した: ${request.toolName}` +
            (request.kind === 'question' ? '（質問は上げない）' : '（承認の口が無い）'),
        );
        return deny(
          'このセッションでは確認が上に届かないため、承認が要る操作・質問は拒否される。' +
            '読み取りだけで答えられる形に切り替えるか、できないと伝えること。',
        );
      }
      let decision: AgentPermissionDecision;
      try {
        decision = await ask({ provider, sessionId: id }, request);
      } catch (error) {
        decision = deny(
          `承認を上げられなかったので拒否した: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (decision.behavior === 'allow') {
        this.#approved.push(request.toolName);
        deps.onNote(`peer（${provider}）[${id}] の ${request.toolName} をクローンが許可した`);
      } else {
        this.#denied.push(request.toolName);
        deps.onNote(`peer（${provider}）[${id}] の ${request.toolName} をクローンが拒否した`);
      }
      return decision;
    };
    this.#session = deps.driverOf(provider).open(
      deps.makeSpec(provider, {
        input: this.#input,
        onPermission,
        onNote: (text) => deps.onNote(`peer（${provider}）[${id}] ${text}`),
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

  /** 1ターン流して、終わりを待つ。同時に2ターンは流さない（呼び出し側が `busy` を見る）。 */
  get busy(): boolean {
    return this.#waiter !== undefined;
  }

  turn(text: string, signal: AbortSignal | undefined): Promise<PeerTurnResult> {
    if (this.#ended !== undefined) {
      return Promise.resolve(
        this.#result(false, `peer のセッションは終わっている（${this.#ended}）`),
      );
    }
    this.#denied = [];
    this.#approved = [];
    const waiter: TurnWaiter = { text: [], resolve: () => undefined };
    const done = new Promise<{ ok: boolean; text: string }>((resolve) => {
      waiter.resolve = resolve;
    });
    this.#waiter = waiter;
    const onAbort = (): void => {
      this.close();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    this.#input.push(text);
    return done.then(
      (outcome) => {
        signal?.removeEventListener('abort', onAbort);
        return this.#result(outcome.ok, outcome.text);
      },
      (error: unknown) => {
        signal?.removeEventListener('abort', onAbort);
        throw error;
      },
    );
  }

  close(): void {
    this.#input.close();
    try {
      this.#session.close();
    } catch {
      // 既に閉じている
    }
  }

  #result(ok: boolean, text: string): PeerTurnResult {
    return {
      sessionId: this.id,
      provider: this.provider,
      ok,
      text,
      denied: [...this.#denied],
      approved: [...this.#approved],
    };
  }

  #end(reason: string): void {
    this.#ended ??= reason;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.resolve({ ok: false, text: `peer のセッションが途中で終わった（${reason}）` });
  }

  async #onEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'session_started':
        this.#providerSessionId = event.sessionId;
        return;
      case 'assistant_message': {
        if (event.parentToolUseId !== null) return;
        for (const block of event.blocks) {
          if (block.type === 'text') this.#waiter?.text.push(block.text);
        }
        return;
      }
      case 'turn_ended': {
        await this.#reportUsage(event);
        const waiter = this.#waiter;
        this.#waiter = undefined;
        if (waiter === undefined) return;
        if (event.failure !== undefined || !event.succeeded) {
          const lines = event.errorLines.length > 0 ? `: ${event.errorLines.join(' / ')}` : '';
          waiter.resolve({
            ok: false,
            text: `peer のターンが失敗した（${event.outcome ?? '失敗'}）${lines}`,
          });
          return;
        }
        const body = event.body.length > 0 ? event.body : waiter.text.join('\n');
        waiter.resolve({ ok: true, text: body });
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

export interface PeerBroker {
  run(provider: string, prompt: string, signal?: AbortSignal): Promise<PeerTurnResult | string>;
  reply(sessionId: string, message: string, signal?: AbortSignal): Promise<PeerTurnResult | string>;
  closeAll(): void;
  /** 道具を載せた MCP サーバ（`createSdkMcpServer` の戻り値）。 */
  mcpServer(): ReturnType<typeof createSdkMcpServer>;
}

export function createPeerBroker(deps: PeerBrokerDeps): PeerBroker {
  const sessions = new Map<string, PeerSession>();
  const allowed = new Set<string>(deps.allowed);

  const run: PeerBroker['run'] = async (provider, prompt, signal) => {
    if (!allowed.has(provider)) {
      return `provider「${provider}」は呼べない（呼べるのは ${[...allowed].join(' / ')}）`;
    }
    const id = `peer-${randomBytes(6).toString('hex')}`;
    let session: PeerSession;
    try {
      session = new PeerSession(id, provider as AgentProviderId, deps);
    } catch (error) {
      return `peer のセッションを開けなかった: ${error instanceof Error ? error.message : String(error)}`;
    }
    sessions.set(id, session);
    deps.onNote(`peer（${provider}）[${id}] を起こした`);
    return session.turn(prompt, signal);
  };

  const reply: PeerBroker['reply'] = async (sessionId, message, signal) => {
    const session = sessions.get(sessionId);
    if (session === undefined)
      return `session_id「${sessionId}」の peer セッションは無い（peer_run で起こすこと）`;
    if (session.busy) return `peer のセッション ${sessionId} は前のターンの応答を待っている`;
    return session.turn(message, signal);
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
    if (result.denied.length > 0) {
      lines.push(
        `承認が要る操作を ${result.denied.length} 件拒否した（${[...new Set(result.denied)].join(', ')}）。` +
          '（クローンが拒否した、または上げられなかった）',
      );
    }
    if (result.approved.length > 0) {
      lines.push(
        `クローンが承認した操作が ${result.approved.length} 件あった（${[...new Set(result.approved)].join(', ')}）`,
      );
    }
    lines.push('', result.text);
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      ...(result.ok ? {} : { isError: true }),
    };
  };

  const providerList = deps.allowed.join(' / ');
  return {
    run,
    reply,
    closeAll() {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    },
    mcpServer() {
      return createSdkMcpServer({
        name: PEER_MCP_SERVER_NAME,
        version: '0.1.0',
        instructions:
          `もう一方の provider（${providerList}）のエージェントを、相談相手として呼ぶ道具。` +
          '呼ぶかどうかは自分で判断すること（枠やコストを理由に自動で寄せる仕組みは無い）。',
        tools: [
          tool(
            'peer_run',
            `もう一方の provider（${providerList}）のエージェントを新しく1本立て、prompt を渡して最初の応答を受け取る。` +
              '相手は別の担い手で、あなたの文脈を持たない——必要な前提は prompt に書くこと。' +
              '相手のセッションで承認が要る操作（書き込みなど）が出ると、あなたの承認としてクローンへ上がり' +
              '（出所は peer と印が付く）、答えが出るまでこの呼び出しは返らない。拒否されることもある' +
              '（件数は結果に出る）。読み取り・調査・レビュー・方針の相談に向く。' +
              '続きは返ってきた session_id を peer_reply へ渡す。',
            {
              provider: z
                .enum(deps.allowed as [AgentProviderId, ...AgentProviderId[]])
                .describe('呼ぶ provider'),
              prompt: z.string().min(1).describe('相手への依頼（前提を含めて自己完結に書く）'),
            },
            async (args, extra) => render(await run(args.provider, args.prompt, signalOf(extra))),
          ),
          tool(
            'peer_reply',
            'peer_run で立てた相手のセッションへ、続きの言葉を送って応答を受け取る。',
            {
              session_id: z.string().min(1).describe('peer_run が返した session_id'),
              message: z.string().min(1).describe('相手への続きの言葉'),
            },
            async (args, extra) =>
              render(await reply(args.session_id, args.message, signalOf(extra))),
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
