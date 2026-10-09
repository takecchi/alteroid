import { randomBytes } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';

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
import type { AgentToolAuditRecord } from './agent-hooks.js';
import { excerptLine } from './excerpt.js';
import type { PeerWorkdirScanner } from './peer-workdir-scan.js';
import { foldUsageSnapshot, hasAnyUsage, type UsageBaseline, type UsageTotals } from './usage.js';

// 承認は保留したまま待たず、確認の中身と `approval_id` を添えてマネージャーへ返す（`peer_approve` で答える）。
// 閉じる側に倒す: 質問（`AskUserQuestion` 相当）は上げずに拒否する。escalate で `askApproval` が無い・投げた、
// 知らない `approval_id`、セッションが閉じた・ターンが終わった・マネージャーが止まった、はどれも拒否として閉じる。
// ほかの peer セッションを起こしても閉じない: 並べて頼むと無関係な確認まで拒否される。期限は付けない。
// 消費を報告しない provider は 0 を積まず「取れなかった」として数える。
export const PEER_TOOL_NAMES = ['peer_run', 'peer_reply', 'peer_approve'] as const;

/** 道具の名前は `mcp__alteroid-peer__peer_run` になる。 */
export const PEER_MCP_SERVER_NAME = 'alteroid-peer';

export const PEER_SYSTEM_PROMPT_APPEND =
  'あなたは alteroid のマネージャーから、作業を任された別の provider のエージェントである。' +
  '依頼してきたのはマネージャーであり、人間ではない。' +
  '依頼された作業は、調査や助言で止めずに実際に行うこと（ファイルの作成・編集、コマンドの実行を含む）。' +
  'このセッションの許可確認は、まず呼び出し元のマネージャーへ届き、マネージャーが判断できないときはクローンへ上がる。' +
  '確認が要る操作は、答えが出るまで待たされ、拒否されることもある。拒否されたら別の方法を探すか、できなかったことを伝えること。' +
  '終わったら、何をしたか（変えたファイル・実行したコマンド）と、残っていることを簡潔に返すこと。';

// peer の cwd はマネージャーの作業場に揃える: 共有の場所に作られると他の担当の作業ツリーに混ざり、作ったものも見つけにくい。
export function peerSystemPromptAppend(workdir: string): string {
  return (
    PEER_SYSTEM_PROMPT_APPEND +
    `作業場は ${workdir} である（このセッションの作業ディレクトリ）。` +
    '依頼文に場所の指定があれば、それに従うこと。共有の場所にファイルを作らないこと。'
  );
}

export const PEER_APPROVAL_DECISIONS = ['allow', 'deny', 'escalate'] as const;
export type PeerApprovalDecision = (typeof PEER_APPROVAL_DECISIONS)[number];

/** `auto` は閉じる側に倒した拒否。 */
export type PeerApprovalAnswerer = 'manager' | 'clone' | 'auto';

export interface PeerApprovalRecord {
  readonly toolName: string;
  readonly by: PeerApprovalAnswerer;
}

export interface PeerPendingApproval {
  readonly approvalId: string;
  readonly toolName: string;
  readonly summary: string;
}

export const PEER_APPROVAL_SUMMARY_LIMIT = 1200;

export interface PeerUsageReport {
  readonly provider: AgentProviderId;
  readonly sessionId?: string;
  readonly models: Record<string, UsageTotals>;
  readonly unmetered: boolean;
}

export interface PeerBrokerDeps {
  readonly allowed: readonly AgentProviderId[];
  /** 一覧に無い値は断る（既定へ倒さない）。空（または省略）なら `peer_run` に `model` 引数を出さない。 */
  readonly models?: Partial<Record<AgentProviderId, readonly string[]>>;
  readonly closedReason?: (provider: AgentProviderId) => string | undefined;
  readonly driverOf: (provider: AgentProviderId) => AgentManagerDriver;
  readonly makeSpec: (
    provider: AgentProviderId,
    parts: {
      input: AsyncIterable<AgentUserInput>;
      onPermission: AgentPermissionHandler;
      onNote: (text: string) => void;
      model?: string;
    },
  ) => AgentManagerSessionSpec;
  readonly reportsUsage: (provider: AgentProviderId) => boolean;
  readonly onNote: (text: string) => void;
  readonly onUsage: (report: PeerUsageReport) => void;
  readonly now?: () => Date;
  /** 省略（または投げた）ときは拒否する（閉じる側）。 */
  readonly askApproval?: (
    source: PeerApprovalSource,
    request: AgentPermissionRequest,
  ) => Promise<AgentPermissionDecision>;
  /** `started` は同じ `turnId` で2度来ることがある（モデルが後から分かったとき）。 */
  readonly onTurn?: (event: PeerTurnEvent) => void;
  /** 省略すると背景実行は断る（知らせる先が無いまま流すと、結果がどこにも届かない）。 */
  readonly onBackgroundStop?: (result: PeerTurnResult) => void;
  readonly scanWorkdir?: PeerWorkdirScanner;
}

export type PeerTurnEvent =
  | {
      readonly kind: 'started';
      readonly provider: AgentProviderId;
      readonly turnId: string;
      readonly tool: 'peer_run' | 'peer_reply';
      readonly startedAt: string;
      readonly model?: string;
    }
  | { readonly kind: 'ended'; readonly provider: AgentProviderId; readonly turnId: string };

export interface PeerApprovalSource {
  readonly provider: AgentProviderId;
  readonly sessionId: string;
}

export function peerActorOf(managerId: string, provider: string): string {
  return `peer:${managerId}:${provider}`;
}

export function parsePeerActor(actor: string): { managerId: string; provider: string } | undefined {
  if (!actor.startsWith('peer:')) return undefined;
  const rest = actor.slice('peer:'.length);
  const sep = rest.lastIndexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return undefined;
  return { managerId: rest.slice(0, sep), provider: rest.slice(sep + 1) };
}

export function peerApprovalMark(provider: string): string {
  return `【peer: ${provider}】`;
}

export interface PeerTurnResult {
  readonly sessionId: string;
  readonly provider: AgentProviderId;
  readonly model?: string;
  readonly ok: boolean;
  readonly text: string;
  /** 在れば、ターンはこの確認の答えを待って止まっている。 */
  readonly pendingApproval?: PeerPendingApproval;
  readonly denied: readonly PeerApprovalRecord[];
  readonly approved: readonly PeerApprovalRecord[];
  readonly generatedFiles?: readonly string[];
  /** `generatedFiles` に載ったものは除く。相手以外の変更も混ざりうる。 */
  readonly workdirChanges?: PeerWorkdirChanges;
}

export interface PeerWorkdirChanges {
  readonly dir: string;
  readonly paths: readonly string[];
  readonly truncated?: string;
  readonly unreadable?: number;
}

export const PEER_FILES_LISTED_MAX = 50;

/** `{ type: 'add' }` の形と、文字列の形のどちらも読む。 */
function changeKindOf(kind: unknown): string | undefined {
  if (typeof kind === 'string') return kind;
  if (typeof kind === 'object' && kind !== null) {
    const type = (kind as { type?: unknown }).type;
    return typeof type === 'string' ? type : undefined;
  }
  return undefined;
}

function generatedFilesOf(record: AgentToolAuditRecord, cwd: string | undefined): string[] {
  const input = record.toolInput;
  if (typeof input !== 'object' || input === null) return [];
  if (record.toolName === 'imageGeneration') {
    const path = (input as { savedPath?: unknown }).savedPath;
    return typeof path === 'string' && path.length > 0 ? [path] : [];
  }
  if (record.toolName === 'fileChange') {
    const changes = (input as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) return [];
    const paths: string[] = [];
    for (const change of changes as { path?: unknown; kind?: unknown }[]) {
      const path = change.path;
      if (typeof path !== 'string' || path.length === 0) continue;
      if (changeKindOf(change.kind) === 'delete') continue;
      paths.push(cwd === undefined ? path : resolvePath(cwd, path));
    }
    return paths;
  }
  return [];
}

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
  inBackground = false;
  readonly #input = new InputQueue();
  readonly #session: AgentManagerSession;
  readonly #deps: PeerBrokerDeps;
  #turnActive = false;
  #turnText: string[] = [];
  #finished: { ok: boolean; text: string } | undefined;
  readonly #pending: PendingEntry[] = [];
  readonly #stopWaiters = new Set<() => void>();
  #denied: PeerApprovalRecord[] = [];
  #approved: PeerApprovalRecord[] = [];
  #generated: string[] = [];
  #workdirChanges: PeerWorkdirChanges | undefined;
  #turnStartedMs = 0;
  readonly #cwd: string | undefined;
  #baseline: UsageBaseline | null = null;
  #providerSessionId: string | undefined;
  #model: string | undefined;
  #ended: string | undefined;
  readonly #requestedModel: string | undefined;
  #turnSeq = 0;
  #running: { turnId: string; tool: 'peer_run' | 'peer_reply'; startedAt: string } | undefined;

  constructor(
    id: string,
    provider: AgentProviderId,
    deps: PeerBrokerDeps,
    model: string | undefined,
  ) {
    this.id = id;
    this.provider = provider;
    this.#deps = deps;
    this.#requestedModel = model;
    const onPermission: AgentPermissionHandler = (request) => this.#onPermission(request);
    const spec = deps.makeSpec(provider, {
      input: this.#input,
      onPermission,
      onNote: (text) => deps.onNote(`peer（${provider}）[${id}] ${text}`),
      ...(model === undefined ? {} : { model }),
    });
    this.#cwd = spec.cwd;
    this.#session = deps.driverOf(provider).open({
      ...spec,
      onPostToolUse: (record) => {
        for (const file of generatedFilesOf(record, this.#cwd)) {
          if (!this.#generated.includes(file)) this.#generated.push(file);
        }
        return spec.onPostToolUse(record);
      },
    });
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

  get busy(): boolean {
    return this.#turnActive;
  }

  get pendingIds(): readonly string[] {
    return this.#pending.map((entry) => entry.approvalId);
  }

  hasPending(approvalId: string): boolean {
    return this.#pending.some((entry) => entry.approvalId === approvalId);
  }

  turn(
    text: string,
    signal: AbortSignal | undefined,
    tool: 'peer_run' | 'peer_reply' = 'peer_reply',
  ): Promise<PeerTurnResult> {
    if (this.#ended !== undefined) {
      return Promise.resolve(
        this.#result(false, `peer のセッションは終わっている（${this.#ended}）`),
      );
    }
    this.#denied = [];
    this.#approved = [];
    this.#generated = [];
    this.#workdirChanges = undefined;
    this.#turnText = [];
    this.#finished = undefined;
    this.#turnActive = true;
    this.#turnSeq += 1;
    const startedAt = this.#deps.now?.() ?? new Date();
    this.#turnStartedMs = startedAt.getTime();
    this.#running = {
      turnId: `${this.id}:${String(this.#turnSeq)}`,
      tool,
      startedAt: startedAt.toISOString(),
    };
    this.#announceRunning();
    this.#input.push(text);
    return this.#nextStop(signal);
  }

  #announceRunning(): void {
    const running = this.#running;
    if (running === undefined) return;
    const model = this.#requestedModel ?? this.#model;
    this.#notifyTurn({
      kind: 'started',
      provider: this.provider,
      ...running,
      ...(model === undefined ? {} : { model }),
    });
  }

  #notifyTurn(event: PeerTurnEvent): void {
    try {
      this.#deps.onTurn?.(event);
    } catch {
      // 握りつぶす
    }
  }

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
      ...(this.#generated.length === 0 ? {} : { generatedFiles: [...this.#generated] }),
      ...(this.#workdirChanges === undefined ? {} : { workdirChanges: this.#workdirChanges }),
    };
  }

  async #scanWorkdir(): Promise<void> {
    const scan = this.#deps.scanWorkdir;
    const dir = this.#cwd;
    if (scan === undefined || dir === undefined) return;
    // 秒単位でしか更新時刻を持たないファイルシステムでも、開始と同じ秒に書かれたものを落とさない
    const since = Math.floor(this.#turnStartedMs / 1000) * 1000;
    try {
      const found = await scan(dir, since);
      const known = new Set(this.#generated);
      this.#workdirChanges = {
        dir,
        paths: found.paths.filter((path) => !known.has(path)),
        ...(found.truncated === undefined ? {} : { truncated: found.truncated }),
        ...(found.unreadable === undefined ? {} : { unreadable: found.unreadable }),
      };
    } catch (error) {
      this.#workdirChanges = {
        dir,
        paths: [],
        truncated: `作業場を探せなかった: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  #finishTurn(outcome: { ok: boolean; text: string }): void {
    if (!this.#turnActive) return;
    this.#turnActive = false;
    const running = this.#running;
    this.#running = undefined;
    if (running !== undefined) {
      this.#notifyTurn({ kind: 'ended', provider: this.provider, turnId: running.turnId });
    }
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
          const known = this.#model;
          this.#model = event.runtime.model;
          if (this.#requestedModel === undefined && known !== this.#model) this.#announceRunning();
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
        // 失敗したターンでも、途中で作ったファイルは残っているので探す
        await this.#scanWorkdir();
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
  readonly model?: string;
  readonly signal?: AbortSignal;
  readonly background?: boolean;
}

export interface PeerBackgroundStarted {
  readonly background: true;
  readonly sessionId: string;
  readonly provider: AgentProviderId;
}

/** 文字列は道具のエラー（相手を起こしていない）。 */
export type PeerCallResult = PeerTurnResult | PeerBackgroundStarted | string;

export interface PeerBroker {
  run(provider: string, prompt: string, options?: PeerRunOptions): Promise<PeerCallResult>;
  reply(
    sessionId: string,
    message: string,
    options?: { signal?: AbortSignal; background?: boolean },
  ): Promise<PeerCallResult>;
  approve(
    approvalId: string,
    decision: PeerApprovalDecision,
    options?: { message?: string; signal?: AbortSignal; background?: boolean },
  ): Promise<PeerCallResult>;
  /** 確認待ちで止まったものは入らない（止まりどころとしてマネージャーへ知らせ済みで、答えを待っているのは相手のほう）。 */
  backgroundTasks(): { id: string; taskType: string }[];
  closeAll(): void;
  mcpServer(): ReturnType<typeof createSdkMcpServer>;
}

function uniqueList(by: readonly PeerApprovalRecord[]): string {
  return [...new Set(by.map((record) => `${record.toolName}(${record.by})`))].join(', ');
}

export function describePeerTurnResult(result: PeerTurnResult): string {
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
        '答えるまで相手のターンは止まっている（ほかの peer セッションを起こしても、この確認は閉じない。' +
        'セッションが終わる・あなたが止まると拒否として閉じる）。',
    );
    return lines.join('\n');
  }
  lines.push(...describePeerFiles(result));
  lines.push('', result.text);
  return lines.join('\n');
}

// 作業場の探索を打ち切った・探せなかったときは、ファイルが無くても黙らずに書く。
function describePeerFiles(result: PeerTurnResult): string[] {
  const generated = result.generatedFiles ?? [];
  const changes = result.workdirChanges;
  const changed = changes?.paths ?? [];
  const notes = [
    ...(changes?.truncated === undefined
      ? []
      : [`作業場の探索は途中までしか見ていない（${changes.truncated}）。`]),
    ...(changes?.unreadable === undefined
      ? []
      : [`作業場の中で読めなかったディレクトリが ${changes.unreadable} 個あった。`]),
  ];
  if (generated.length === 0 && changed.length === 0 && notes.length === 0) return [];
  const lines: string[] = [];
  let room = PEER_FILES_LISTED_MAX;
  const shownGenerated = generated.slice(0, room);
  room -= shownGenerated.length;
  const shownChanged = changed.slice(0, room);
  if (shownGenerated.length > 0) {
    lines.push(
      '',
      '相手が生成したファイル（相手の器の中のパス）:',
      ...shownGenerated.map((path) => `- ${path}`),
    );
  }
  if (shownChanged.length > 0 && changes !== undefined) {
    lines.push(
      '',
      `ターンの間に作業場（${changes.dir}）で変わったもの（相手以外の変更も混ざりうる）:`,
      ...shownChanged.map((path) => `- ${path}`),
    );
  }
  const rest = generated.length + changed.length - shownGenerated.length - shownChanged.length;
  if (rest > 0) lines.push(`- 他 ${rest} 件`);
  if (notes.length > 0) lines.push('', ...notes);
  if (generated.length > 0 || changed.length > 0) {
    lines.push(
      '報告に添えて人間へ届けるなら、$ALTEROID_OUTBOX（設定されていれば）の直下へ写すこと（cp など）。',
    );
  }
  return lines;
}

function renderPeerCall(result: PeerCallResult): {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
} {
  if (typeof result === 'string')
    return { content: [{ type: 'text', text: result }], isError: true };
  if ('background' in result) {
    return {
      content: [
        {
          type: 'text',
          text:
            `session_id: ${result.sessionId}（背景で流し始めた。provider: ${result.provider}）\n` +
            '止まりどころ（ターンの終わり・確認待ち）に来たら、alteroid が知らせを送ってあなたを起こす。' +
            'それまで別の仕事を進めてよい。このセッションへの peer_reply は、知らせが来るまで断られる。',
        },
      ],
    };
  }
  return {
    content: [{ type: 'text', text: describePeerTurnResult(result) }],
    ...(result.ok || result.pendingApproval !== undefined ? {} : { isError: true }),
  };
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
    // ほかのセッションの答えていない確認には触らない: 並べて頼むと無関係なセッションの確認まで拒否される。
    if (options.background === true && deps.onBackgroundStop === undefined) {
      return '背景へ回す口が無い（run_in_background を外して呼ぶこと）';
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
    return follow(
      session,
      options.background === true,
      (signal) => session.turn(prompt, signal, 'peer_run'),
      options.signal,
    );
  };

  // 背景の待ちには呼び出しの中断の合図を渡さない: 道具の呼び出しはもう返っているので、その合図で相手を畳まない。
  const follow = (
    session: PeerSession,
    background: boolean,
    start: (signal: AbortSignal | undefined) => Promise<PeerTurnResult>,
    signal: AbortSignal | undefined,
  ): Promise<PeerCallResult> => {
    if (!background) return start(signal);
    const onStop = deps.onBackgroundStop;
    if (onStop === undefined) {
      return Promise.resolve('背景へ回す口が無い（run_in_background を外して呼ぶこと）');
    }
    session.inBackground = true;
    void start(undefined).then((result) => {
      // 知らせる前に下ろす: 知らせで起きたマネージャーの報告が、終わった peer を背景待ちに数えないため
      session.inBackground = false;
      try {
        onStop(result);
      } catch (error) {
        deps.onNote(
          `peer（${session.provider}）[${session.id}] の止まりどころを知らせられなかった: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    return Promise.resolve({ background: true, sessionId: session.id, provider: session.provider });
  };

  const reply: PeerBroker['reply'] = async (sessionId, message, options = {}) => {
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
    return follow(
      session,
      options.background === true,
      (signal) => session.turn(message, signal, 'peer_reply'),
      options.signal,
    );
  };

  const approve: PeerBroker['approve'] = async (approvalId, decision, options = {}) => {
    for (const session of sessions.values()) {
      if (session.hasPending(approvalId)) {
        return follow(
          session,
          options.background === true,
          (signal) => session.answer(approvalId, decision, options.message, signal),
          options.signal,
        );
      }
    }
    return (
      `approval_id「${approvalId}」の確認は無い（もう答えた・拒否として閉じた・知らない id）。` +
      '答えの無い確認は拒否として扱われている'
    );
  };

  const render = renderPeerCall;

  const providerList = deps.allowed.join(' / ');
  const approvalNote =
    '相手のセッションで確認が要る操作（書き込み・コマンドの実行など）が出ると、呼び出しは確認の中身と approval_id を' +
    '添えて返る（確認待ち）。peer_approve で答えると続きが返る。' +
    'run_in_background を true にすると、相手を流し始めた時点で返り、止まりどころ（ターンの終わり・確認待ち）に来たら' +
    ' alteroid が知らせを送ってあなたを起こす（作業者の背景実行と同じ。待つ間のあなたの報告は背景待ちとして畳まれる）。';
  const backgroundShape = {
    run_in_background: z
      .boolean()
      .optional()
      .describe(
        'true なら相手を流し始めた時点で返り、止まりどころで alteroid が知らせる（作業者の run_in_background と同じ）。省略は false（止まりどころまで待つ）',
      ),
  };
  return {
    run,
    reply,
    approve,
    backgroundTasks() {
      return [...sessions.values()]
        .filter((session) => session.inBackground)
        .map((session) => ({ id: `peer:${session.id}`, taskType: `peer:${session.provider}` }));
    },
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
        ...backgroundShape,
      };
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
            { ...runShape, ...modelShape } as typeof runShape,
            async (args, extra) => {
              const model = (args as { model?: string }).model;
              const signal = signalOf(extra);
              return render(
                await run(args.provider, args.prompt, {
                  ...(model === undefined ? {} : { model }),
                  ...(signal === undefined ? {} : { signal }),
                  ...(args.run_in_background === true ? { background: true } : {}),
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
              ...backgroundShape,
            },
            async (args, extra) => {
              const signal = signalOf(extra);
              return render(
                await reply(args.session_id, args.message, {
                  ...(signal === undefined ? {} : { signal }),
                  ...(args.run_in_background === true ? { background: true } : {}),
                }),
              );
            },
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
              ...backgroundShape,
            },
            async (args, extra) => {
              const signal = signalOf(extra);
              return render(
                await approve(args.approval_id, args.decision, {
                  ...(args.message === undefined ? {} : { message: args.message }),
                  ...(signal === undefined ? {} : { signal }),
                  ...(args.run_in_background === true ? { background: true } : {}),
                }),
              );
            },
          ),
        ],
      });
    },
  };
}

function signalOf(extra: unknown): AbortSignal | undefined {
  const signal = (extra as { signal?: unknown } | undefined)?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}
