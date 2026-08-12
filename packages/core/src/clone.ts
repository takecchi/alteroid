import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { CloneHost } from './host.js';
import { Inbox } from './inbox.js';
import { buildCloneSystemPrompt, buildDistillPrompt } from './prompt.js';
import type { ChatStreamEvent, InboxEvent, JournalEntryInput } from './schema.js';
import type { Stores } from './store.js';
import { CLONE_ALLOWED_TOOLS, MCP_SERVER_NAME, createCloneMcpServer } from './tools.js';

/**
 * クローン = デーモン内の長寿命 SDK セッション1本（docs/architecture.md）。
 *
 * - model は `fable` 固定。役割とモデル帯の対応は設計判断であり、変更には
 *   人間の承認が要る（AGENTS.md 地雷5）。
 * - `tools: []` で組み込みツールを持たせない。これは人間の写像としての配置で
 *   あってデグレードではない。マネージャー以下へこの理由を流用しないこと。
 * - **ターンの起動口は受信箱ただ1つ。** 人間の発言もタイマーも蒸留も、必ず
 *   受信箱を通って直列に処理される。ここを迂回して直接ターンを起こすと、
 *   走行中のターンを踏み潰してループごと止まる。
 */

/** クローンのモデル帯。変更には人間の承認が要る。 */
export const CLONE_MODEL = 'fable';

/** PreCompact で退避したトランスクリプトのうち、蒸留に渡す末尾のサイズ。 */
const DISTILL_TRANSCRIPT_TAIL_BYTES = 60_000;

/** PreCompact フック内の蒸留に許す時間（秒）。超えたら compaction を待たせない。 */
const PRE_COMPACT_HOOK_TIMEOUT_SECONDS = 120;

export interface CloneOptions {
  stores: Stores;
  /** 主にテスト用。既定は SDK の `query`。 */
  queryFn?: typeof query;
  /**
   * クローンのセッションを置くディレクトリ。SDK はここを基準に
   * トランスクリプトを保存するので、**呼び出し元のカレントディレクトリに
   * 依存させてはいけない**（依存させると別の場所から起動した途端に resume が
   * 迷子になる）。デーモンは `~/.alteroid` を渡す。
   */
  cwd?: string;
}

type Listener = (event: ChatStreamEvent) => void;

interface Turn {
  /** 出力を届ける会話。null なら人間に見せない内部ターン（蒸留など）。 */
  conversationId: string | null;
  text: string;
  /** 逐次配信（stream_event）で本文を流したか。流していなければ完成品を流す。 */
  streamed: boolean;
  resolve: () => void;
}

export function createClone(options: CloneOptions): CloneHost {
  return new Clone(options);
}

class Clone implements CloneHost {
  readonly #stores: Stores;
  readonly #queryFn: typeof query;
  readonly #cwd: string | undefined;

  readonly #inbox = new Inbox();
  readonly #listeners = new Map<string, Set<Listener>>();
  /** 受信箱に積んだイベントの処理完了を待つための約束。 */
  readonly #completions = new Map<string, () => void>();

  /** SDK へ流す入力の待ち行列。 */
  readonly #input: SDKUserMessage[] = [];
  #inputWaiter: (() => void) | null = null;

  #query: Query | null = null;
  #reader: Promise<void> | null = null;
  #turn: Turn | null = null;
  #stopped = false;
  /** いまの SDK セッションに載せた記憶。人間の手編集を拾い直すために持つ。 */
  #injectedMemory = '';
  /** resume を試みた session id。init が来る前に落ちたら捨てる。 */
  #resumedFrom: string | null = null;
  #sawInit = false;

  constructor({ stores, queryFn, cwd }: CloneOptions) {
    this.#stores = stores;
    this.#queryFn = queryFn ?? query;
    this.#cwd = cwd;
    void this.#pump();
  }

  // -------------------------------------------------------------------------
  // CloneHost
  // -------------------------------------------------------------------------

  post(event: InboxEvent): void {
    if (this.#stopped) return;
    this.#inbox.push(event);
  }

  subscribe(conversationId: string, listener: Listener): () => void {
    const set = this.#listeners.get(conversationId) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(conversationId, set);
    return () => {
      set.delete(listener);
      if (this.#listeners.get(conversationId) === set && set.size === 0) {
        this.#listeners.delete(conversationId);
      }
    };
  }

  async endConversation(conversationId: string): Promise<void> {
    // 会話終了は蒸留の契機。受信箱を通すので、走行中のターンを踏み潰さない。
    await this.#postAndWait({
      type: 'distill',
      id: randomUUID(),
      at: new Date().toISOString(),
      reason: 'conversation_end',
    });
    const set = this.#listeners.get(conversationId);
    if (set && set.size === 0) this.#listeners.delete(conversationId);
  }

  async answerApproval(approvalId: string, answer: string): Promise<void> {
    const approval = await this.#stores.jobs.getApproval(approvalId);
    if (!approval) throw new Error(`承認待ち ${approvalId} は存在しない`);

    const answeredAt = new Date().toISOString();
    await this.#stores.jobs.putApproval({ ...approval, answeredAt, answer });

    // 日誌だけを追っても回答済みだと分かるようにする（追記専用なので新しい行）
    await this.#journal({
      type: 'escalation',
      question: approval.question,
      approvalId,
      answeredAt,
      answer,
    });

    // 回答は受信箱へ。止まっていたその仕事だけが再開する。
    this.post({
      type: 'human_answer',
      id: randomUUID(),
      at: answeredAt,
      approvalId,
      answer,
    });
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;

    // 落ちる前にもう一度だけ記憶へ移す機会を作る（蒸留は生存条件）。
    // 既にセッションが無いなら何も起きない。
    if (this.#query) {
      await this.#postAndWait({
        type: 'distill',
        id: randomUUID(),
        at: new Date().toISOString(),
        reason: 'shutdown',
      }).catch(() => undefined);
    }

    this.#stopped = true;
    this.#inbox.close();
    this.#wakeInput();
    try {
      this.#query?.close();
    } catch {
      // 既に閉じている
    }
    await this.#reader?.catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // 受信箱のループ（ターンの起動口はここだけ）
  // -------------------------------------------------------------------------

  #postAndWait(event: InboxEvent): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#completions.set(event.id, resolve);
      this.#inbox.push(event);
    });
  }

  async #pump(): Promise<void> {
    for await (const event of this.#inbox) {
      try {
        await this.#handle(event);
      } catch (error) {
        this.#emit(this.#conversationOf(event), { type: 'error', message: String(error) });
        this.#finishTurn();
      } finally {
        const done = this.#completions.get(event.id);
        this.#completions.delete(event.id);
        done?.();
      }
    }
    // 閉じた後に待っている人を取り残さない
    for (const done of this.#completions.values()) done();
    this.#completions.clear();
  }

  #conversationOf(event: InboxEvent): string | null {
    return event.type === 'human_message' ? event.conversationId : null;
  }

  async #handle(event: InboxEvent): Promise<void> {
    switch (event.type) {
      case 'human_message': {
        await this.#journal({
          type: 'exchange',
          with: 'human',
          role: 'inbound',
          text: event.text,
          conversationId: event.conversationId,
        });
        await this.#runTurn(event.conversationId, event.text);
        return;
      }

      case 'distill': {
        // セッションがまだ無いなら蒸留するものも無い
        if (!this.#query) return;
        await this.#runInternal(
          buildDistillPrompt(event.reason === 'shutdown' ? 'conversation_end' : event.reason),
        );
        return;
      }

      case 'human_answer': {
        const approval = await this.#stores.jobs.getApproval(event.approvalId);
        const question = approval?.question ?? '(不明な質問)';
        await this.#runInternal(
          `[system] 承認待ちにしていた質問に人間が答えた。\n\n質問: ${question}\n回答: ${event.answer}\n\n` +
            'この回答に沿って続きを進めよ。今後同じ判断を自分でできるよう、必要なら記憶へ残すこと。',
        );
        return;
      }

      // M3 で起点が増える。受信箱の構造は既にそれを受けられる。
      case 'timer':
      case 'external':
      case 'self_initiative':
      case 'manager_message':
        await this.#runInternal(
          `[system] 未対応の起点 (${event.type}) を受け取った。M3 以降で実装される。`,
        );
        return;

      default: {
        const exhaustive: never = event;
        throw new Error(`未知の受信箱イベント: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // ターンの実行
  // -------------------------------------------------------------------------

  async #runTurn(conversationId: string | null, text: string): Promise<void> {
    // ターンは **セッションを起こす前に** 登録する。セッションの生成が失敗したり
    // 読み取りが即死したりしても、待っているターンを必ず誰かが解放できるように。
    const done = new Promise<void>((resolve) => {
      this.#turn = { conversationId, text: '', streamed: false, resolve };
    });

    try {
      await this.#ensureQuery();
      this.#pushInput(await this.#withFreshMemory(text));
    } catch (error) {
      this.#emit(conversationId, { type: 'error', message: String(error) });
      this.#finishTurn();
    }

    await done;
  }

  /** 人間に見せない内部ターン（蒸留・承認回答の反映）。 */
  async #runInternal(text: string): Promise<void> {
    await this.#runTurn(null, text);
  }

  /**
   * システムプロンプトはセッション開始時に固定されるので、走行中に人間が記憶を
   * 書き換えても届かない。ターンごとに差分を見て、変わっていたら本文の前に
   * 現在の記憶を載せ直す（受け入れ基準3: 手編集が次の会話に反映されること）。
   */
  async #withFreshMemory(text: string): Promise<string> {
    let memory: string;
    try {
      memory = await this.#stores.persona.concat();
    } catch {
      return text;
    }
    if (memory === this.#injectedMemory) return text;
    this.#injectedMemory = memory;

    return [
      '[system] 記憶が更新された（人間が直接書き換えたか、あなた自身が更新した）。以降はこちらが現在の記憶である。',
      '',
      memory.trim().length > 0 ? memory : '（記憶は空）',
      '',
      '---',
      '',
      text,
    ].join('\n');
  }

  #pushInput(text: string): void {
    this.#input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    this.#wakeInput();
  }

  #wakeInput(): void {
    const waiter = this.#inputWaiter;
    this.#inputWaiter = null;
    waiter?.();
  }

  async *#inputStream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.#input.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#stopped) return;
      await new Promise<void>((resolve) => {
        this.#inputWaiter = resolve;
      });
    }
  }

  // -------------------------------------------------------------------------
  // SDK セッション
  // -------------------------------------------------------------------------

  async #ensureQuery(): Promise<void> {
    if (this.#query) return;

    const resume = await this.#stores.sessions.getCloneSessionId();
    this.#resumedFrom = resume;
    this.#sawInit = false;

    const q = this.#queryFn({
      prompt: this.#inputStream(),
      options: await this.#buildOptions(resume),
    });
    this.#query = q;
    this.#reader = this.#read(q);
  }

  async #buildOptions(resume: string | null): Promise<Options> {
    const memory = await this.#stores.persona.concat();
    this.#injectedMemory = memory;

    return {
      model: CLONE_MODEL,
      // 組み込みツールは持たせない（人間の写像としての配置）
      tools: [],
      allowedTools: CLONE_ALLOWED_TOOLS,
      mcpServers: {
        [MCP_SERVER_NAME]: createCloneMcpServer({
          stores: this.#stores,
          emit: (event) => this.#emit(this.#turn?.conversationId ?? null, event),
        }),
      },
      systemPrompt: buildCloneSystemPrompt({ memory }),
      // 人間のプロジェクト設定を持ち込まない。クローンは実プロジェクトの
      // 作業者ではなく、判断する側である（設定の共有は M2 のマネージャー側）。
      settingSources: [],
      includePartialMessages: true,
      ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
      ...(resume === null ? {} : { resume }),
      hooks: {
        PreCompact: [
          {
            timeout: PRE_COMPACT_HOOK_TIMEOUT_SECONDS,
            hooks: [(input, _toolUseId, extra) => this.#onPreCompact(input, extra?.signal)],
          },
        ],
      },
    };
  }

  /**
   * 要約に潰される直前に、全文をアーカイブへ落とし、そこから蒸留する。
   *
   * 蒸留は生存条件であり、後回しにしてよい機能ではない。ここで記憶へ移し損ねた
   * ものは、compaction のたびに人格の一部として失われる。
   */
  async #onPreCompact(input: unknown, signal?: AbortSignal): Promise<{ continue: true }> {
    const { session_id: sessionId, transcript_path: transcriptPath } = input as {
      session_id?: string;
      transcript_path?: string;
    };

    if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
      return { continue: true };
    }

    try {
      // 退避するのは全文（ロードマップの要件）。蒸留に渡すのは末尾だけにする。
      const transcript = await readFile(transcriptPath, 'utf8');
      await this.#stores.archive.archive(sessionId ?? 'clone', transcript);
      if (signal?.aborted !== true) await this.#distillFromTranscript(tailOf(transcript));
    } catch (error) {
      // これはクローンの判断ではなくシステムの失敗なので、判断として記録しない
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: `PreCompact の退避・蒸留に失敗した: ${String(error)}`,
      });
    }

    return { continue: true };
  }

  /**
   * 走行中のセッションは compaction 中なので、蒸留は別の短命セッションで行う。
   * 道具（記憶・日誌）は同じインプロセス MCP を渡すので、書き込み先は同じ。
   */
  async #distillFromTranscript(transcriptTail: string): Promise<void> {
    const memory = await this.#stores.persona.concat();

    const prompt = [
      buildDistillPrompt('pre_compact'),
      '',
      '以下は、要約に潰される直前の会話の生ログ（末尾）である。',
      '',
      transcriptTail,
    ].join('\n');

    const side = this.#queryFn({
      prompt,
      options: {
        model: CLONE_MODEL,
        tools: [],
        allowedTools: CLONE_ALLOWED_TOOLS,
        mcpServers: {
          [MCP_SERVER_NAME]: createCloneMcpServer({
            stores: this.#stores,
            emit: () => undefined,
          }),
        },
        systemPrompt: buildCloneSystemPrompt({ memory }),
        settingSources: [],
        persistSession: false,
        ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
      },
    });

    for await (const message of side) {
      if (message.type === 'result') break;
    }
  }

  async #read(q: Query): Promise<void> {
    let failure: string | null = null;

    try {
      for await (const message of q) {
        await this.#dispatch(message);
      }
    } catch (error) {
      failure = String(error);

      // init すら来ずに落ちたなら resume 素材が腐っている。捨てて作り直す。
      // 同一性はセッションではなく記憶に宿るので、捨てて困るものは無い。
      if (!this.#stopped && !this.#sawInit && this.#resumedFrom !== null) {
        await this.#stores.sessions.setCloneSessionId(null).catch(() => undefined);
      }
    } finally {
      if (!this.#stopped) {
        // result を伴わずに終わってもターンを取り残さない（取り残すと受信箱ごと止まる）
        const turn = this.#turn;
        if (turn) {
          this.#emit(turn.conversationId, {
            type: 'error',
            message: failure ?? 'クローンのセッションが終了した',
          });
        }
        this.#finishTurn();
        this.#query = null;
        this.#injectedMemory = '';
      }
    }
  }

  async #dispatch(message: SDKMessage): Promise<void> {
    switch (message.type) {
      case 'system': {
        if (message.subtype === 'init') {
          this.#sawInit = true;
          await this.#stores.sessions.setCloneSessionId(message.session_id).catch(() => undefined);
        }
        return;
      }

      case 'stream_event': {
        const delta = textDelta(message.event);
        if (delta === null) return;
        const turn = this.#turn;
        if (turn) turn.streamed = true;
        this.#emit(turn?.conversationId ?? null, { type: 'text', text: delta });
        return;
      }

      case 'assistant': {
        const turn = this.#turn;
        for (const block of contentBlocks(message.message)) {
          if (block.type === 'text' && typeof block.text === 'string') {
            if (turn) turn.text += block.text;
            // 逐次配信が来ていない環境でも、人間に本文が届かないことは無いようにする
            if (!turn?.streamed) {
              this.#emit(turn?.conversationId ?? null, { type: 'text', text: block.text });
            }
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            this.#emit(turn?.conversationId ?? null, { type: 'tool', tool: block.name });
          }
        }
        return;
      }

      case 'result': {
        const turn = this.#turn;
        if (turn && turn.text.trim().length > 0) {
          // 内部ターン（蒸留・自律）も必ず残す。見えない層を作らない。
          await this.#journal({
            type: 'exchange',
            with: turn.conversationId === null ? 'self' : 'human',
            role: 'outbound',
            text: turn.text,
            ...(turn.conversationId === null ? {} : { conversationId: turn.conversationId }),
          });
        }
        this.#emit(turn?.conversationId ?? null, { type: 'done' });
        this.#finishTurn();
        return;
      }

      default:
        return;
    }
  }

  /** 日誌の書き込み失敗でクローンのセッションを殺さない。 */
  async #journal(entry: JournalEntryInput): Promise<void> {
    try {
      await this.#stores.journal.append(entry);
    } catch {
      // 記録できないこと自体は致命ではない。文脈を失う方が高くつく。
    }
  }

  #finishTurn(): void {
    const turn = this.#turn;
    this.#turn = null;
    turn?.resolve();
  }

  #emit(conversationId: string | null, event: ChatStreamEvent): void {
    if (conversationId === null) return;
    for (const listener of this.#listeners.get(conversationId) ?? []) {
      try {
        listener(event);
      } catch {
        // 購読側の失敗でクローンを止めない
      }
    }
  }
}

interface Block {
  type?: string;
  text?: unknown;
  name?: unknown;
}

function contentBlocks(message: unknown): Block[] {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

function textDelta(event: unknown): string | null {
  const candidate = event as {
    type?: string;
    delta?: { type?: string; text?: unknown };
  };
  if (candidate.type !== 'content_block_delta') return null;
  if (candidate.delta?.type !== 'text_delta') return null;
  return typeof candidate.delta.text === 'string' ? candidate.delta.text : null;
}

/**
 * 蒸留に渡す末尾。全文はアーカイブに残っているので、ここでは直近だけでよい。
 * 行の途中と壊れた文字で始めないように整える。
 */
function tailOf(transcript: string): string {
  if (transcript.length <= DISTILL_TRANSCRIPT_TAIL_BYTES) return transcript;
  const cut = transcript.slice(-DISTILL_TRANSCRIPT_TAIL_BYTES);
  const newline = cut.indexOf('\n');
  return newline === -1 ? cut : cut.slice(newline + 1);
}
