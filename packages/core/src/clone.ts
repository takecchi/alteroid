import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  SessionStore,
} from '@anthropic-ai/claude-agent-sdk';

import { buildActivityDigest } from './digest.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { Inbox } from './inbox.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import type { ProfileApplier } from './profile.js';
import type { RunnerRegistry } from './runner-protocol.js';
import {
  buildCloneSystemPrompt,
  buildDailyReportPrompt,
  buildDistillPrompt,
  buildExternalEventPrompt,
  buildSelfInitiativePrompt,
  buildTimerPrompt,
} from './prompt.js';
import { DAILY_REPORT_KIND, localDate, localDayRange } from './schedule.js';
import type { ChatStreamEvent, InboxEvent, JournalEntryInput, ScheduledRequest } from './schema.js';
import type { Stores } from './store.js';
import { CLONE_ALLOWED_TOOLS, MCP_SERVER_NAME, createCloneMcpServer } from './tools.js';

/**
 * クローン = デーモン内の長寿命 SDK セッション1本（docs/architecture.md）。
 *
 * - model の既定は `fable`。役割とモデル帯の対応は設計判断であり、変更には
 *   人間の承認が要る（AGENTS.md 地雷5）。`ALTEROID_CLONE_MODEL` はその
 *   **承認そのもの**であって、AI や実装の都合で動かしてよい旋盤ではない。
 * - `tools: []` で組み込みツールを持たせない。これは人間の写像としての配置で
 *   あってデグレードではない。マネージャー以下へこの理由を流用しないこと。
 * - **ターンの起動口は受信箱ただ1つ。** 人間の発言もタイマーも蒸留も、必ず
 *   受信箱を通って直列に処理される。ここを迂回して直接ターンを起こすと、
 *   走行中のターンを踏み潰してループごと止まる。
 */

/** クローンのモデル帯の既定。変更には人間の承認が要る。 */
export const CLONE_MODEL = 'fable';

/**
 * クローンのモデル帯を人間が差し替えるための環境変数。
 *
 * **これは設定ではなく、人間の承認の置き場である。** 層とモデル帯の対応は
 * 設計判断であり（AGENTS.md 地雷5）、既定は `fable` のまま動かさない。ここに
 * 値を置けるのは人間だけで、置いた事実はデーモンの起動時に必ず表へ出す
 * （黙って上位帯から降りることを許さない）。
 *
 * 読むのはクローンを組み立てる一度きり。走行中の SDK セッションのモデルは
 * どのみち差し替えられないので、途中で読み直すと本セッションと蒸留の
 * サイドクエリだけがずれる。効かせたければ器を作り直すこと。
 */
export const CLONE_MODEL_ENV_KEY = 'ALTEROID_CLONE_MODEL';

/**
 * 環境変数を見てクローンのモデル帯を決める。空・空白なら既定（`fable`）。
 *
 * 値は検証しない。既知の別名だけを通す関門を置くと、SDK が新しいモデルを
 * 増やすたびにこちらが追いつくまで人間が選べなくなる＝能力の削除になる
 * （north_star 禁止1）。読めない値は SDK が起動時に弾く。
 */
export function resolveCloneModel(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[CLONE_MODEL_ENV_KEY];
  const trimmed = raw === undefined ? '' : raw.trim();
  return trimmed.length > 0 ? trimmed : CLONE_MODEL;
}

/** PreCompact で退避したトランスクリプトのうち、蒸留に渡す末尾のサイズ。 */
const DISTILL_TRANSCRIPT_TAIL_BYTES = 60_000;

/** PreCompact フック内の蒸留に許す時間（秒）。超えたら compaction を待たせない。 */
const PRE_COMPACT_HOOK_TIMEOUT_SECONDS = 120;

/** 発意 tick と定期ジョブに渡す「直近」の幅。 */
const RECENT_DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 日報が既に書かれたかを確かめるときに遡る件数。 */
const DAILY_REPORT_LOOKUP = 30;

/** 外部イベントの中身をクローンに見せる上限。全文が要るなら送り元で切ること。 */
const EXTERNAL_PAYLOAD_LIMIT = 8_000;

/**
 * 継続中の依頼の器に触るときの試行回数と間隔（読み取りと発火の記録の両方）。
 *
 * **これは回数制限ではない**（AGENTS.md 地雷2）。器が一瞬揺れただけで1周期ぶんの
 * 仕事を落とさないための拾い直しであって、仕事の量を絞るものではない。
 */
const SCHEDULE_STORE_ATTEMPTS = 3;
const SCHEDULE_STORE_RETRY_MS = 200;

/**
 * 版が入れ替わっていたときに読み直す回数。
 *
 * 人間が依頼を直した瞬間に発火が重なると1回ずれる。**古い本文で走らないことが最優先**
 * なので、合わなければ諦めて次の発火に譲る（依頼は消えないし `lastRunAt` も進まない）。
 */
const SCHEDULE_CLAIM_ROUNDS = 3;

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
  /**
   * 委譲先（manager-runner）の名簿。
   *
   * **クローンは SDK を直接起こさない。** マネージャーは別プロセス（既定では
   * 別コンテナ）の runner で走り、ここはその宛先を決める間接層だけを見る
   * （docs/architecture.md「プロセス境界」）。
   */
  runners?: RunnerRegistry;
  /**
   * SDK のセッション永続化先（M4）。クローンとマネージャーの生ログを同じ
   * PostgreSQL へ載せる。渡さなければローカルディスクのまま（M1〜M3 と同じ）。
   */
  sessionStore?: SessionStore;
  /** 主にテスト用。差し替えると委譲先ごと入れ替えられる。 */
  managers?: ManagerPool;
  /**
   * モデル帯の差し替え（`ALTEROID_CLONE_MODEL`）を読む先。主にテスト用で、
   * 既定は `process.env`。
   */
  env?: NodeJS.ProcessEnv;
  /**
   * 実行環境プロファイル（`.zprofile` 相当）。
   *
   * **クローンにも効かせる。** 人間の `.zshenv` は、その人が Claude Code に頼む
   * ときにも、自分で端末を叩くときにも同じように効く。クローンは人間の写像で
   * あって「道具を持たない存在」ではない（north_star「適用範囲」）ので、
   * 「マネージャーには効くがクローンには効かない」を作らない。
   */
  profile?: ProfileApplier;
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
  readonly #sessionStore: SessionStore | undefined;
  readonly #managers: ManagerPool;
  /**
   * このクローンのモデル帯。本セッションと蒸留のサイドクエリで必ず同じものを
   * 使う（片方だけ帯が違うと、蒸留＝人格の書き手だけが別の頭になる）。
   */
  readonly #model: string;

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
  readonly #env: NodeJS.ProcessEnv;
  readonly #profile: ProfileApplier | undefined;

  constructor(options: CloneOptions) {
    const { stores, queryFn, cwd, runners, sessionStore, managers, env, profile } = options;
    this.#stores = stores;
    this.#queryFn = queryFn ?? query;
    this.#cwd = cwd;
    this.#sessionStore = sessionStore;
    this.#model = resolveCloneModel(env ?? process.env);
    this.#env = env ?? process.env;
    this.#profile = profile;
    this.#managers =
      managers ??
      createManagerPool({
        stores,
        // マネージャーからの報告・質問も、人間の発言と同じ受信箱を通る。
        post: (event) => this.post(event),
        runners: runners ?? createRunnerRegistry([]),
      });
    void this.#pump();
  }

  /** デーモンの HTTP 層から一覧・生ログへ降りるための口。 */
  get managers(): ManagerPool {
    return this.#managers;
  }

  // -------------------------------------------------------------------------
  // CloneHost
  // -------------------------------------------------------------------------

  post(event: InboxEvent): void {
    if (this.#stopped) return;

    // 同じ合図がまだ読まれないまま積み重なっても、読んだときに見る材料は同じなので
    // 畳む。**これは実行回数の制限ではない**（AGENTS.md 地雷2）— 発火を減らすのでも
    // 遅らせるのでもなく、「まだ読んでいない同じ合図」を二度読まないだけである。
    // 人間の発言・マネージャーからの一件・外部イベントは中身が違うので絶対に畳まない。
    if (isTick(event) && this.#inbox.hasPending((queued) => isSameTick(queued, event))) return;

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
    // 走行中のマネージャーも畳む。返事待ちで宙吊りのまま消えない。
    await this.#managers.stop().catch(() => undefined);
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
        await this.#reportFailure(this.#conversationOf(event), String(error));
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

  /**
   * ターンの失敗を必ずどこかに残す。
   *
   * 人間が繋がっていれば chat へ流れるが、**内部ターンには聞き手が居ない**。
   * マネージャーからの確認も蒸留も内部ターンなので、そこで握り潰すと、
   * 「クローンが黙り、マネージャーが永久に返事を待つ」が無記録で起きる。
   */
  async #reportFailure(conversationId: string | null, message: string): Promise<void> {
    if (conversationId !== null) {
      this.#emit(conversationId, { type: 'error', message });
      return;
    }
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: `内部ターンが失敗した: ${message}`,
    });
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
        // 宛先は managerId と requestId の対で戻す。requestId を落とすと、
        // そのマネージャーが複数を待っているとき宛先が決まらず、人間が答えたのに
        // 仕事が再開しない（人間へ回る経路の端から端まで id を運ぶこと）。
        const waiting =
          approval?.jobId === undefined
            ? ''
            : `\n\nこの確認はマネージャー ${approval.jobId} のものである。` +
              `回答を \`manager_send\`（許可確認なら decision 付き）で返すと、止まっていたその仕事が再開する。` +
              `\n宛先: managerId: "${approval.jobId}"` +
              (approval.requestId === undefined ? '' : `, requestId: "${approval.requestId}"`);
        await this.#runInternal(
          `[system] 承認待ちにしていた質問に人間が答えた。\n\n質問: ${question}\n回答: ${event.answer}` +
            `${waiting}\n\n` +
            'この回答に沿って続きを進めよ。今後同じ判断を自分でできるよう、必要なら記憶へ残すこと。',
        );
        return;
      }

      case 'manager_message': {
        await this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text: `[${event.managerId}/${event.kind}] ${event.text}`,
        });
        await this.#runInternal(managerPrompt(event));
        return;
      }

      // --- 人間以外の起点（PRD「自律」の②③④） -------------------------------
      // どれも人間が見ていない時間に来る。だから応答の宛先は無く（内部ターン）、
      // 何をするかの判断はプロンプトではなくクローンに残す。

      case 'timer': {
        if (event.kind === DAILY_REPORT_KIND) {
          await this.#dailyReport(event.target ?? localDate(new Date(event.at)));
          return;
        }
        // 依頼の本文は**いま**読み、読んだその版で発火を確定させる。イベントに
        // 載せて運ぶと、人間が依頼を書き換えても発火時点の写しで走る（真実はストア側）。
        const claimed = await this.#claimScheduledRun(
          event.kind,
          event.at,
          // 省略時は定期の予定（`schema.ts` の `timer` の既定）
          event.cause === 'manual' ? 'manual' : 'schedule',
        );

        // **動かさない方を選ぶ場面が3つある。** どれも「時刻が来れば必ず届く」の側を
        // 1周期遅らせるだけで済むが、走らせてしまうと取り返せない。
        if (claimed.status !== 'ok' && claimed.status !== 'missing') {
          await this.#journal({
            type: 'exchange',
            with: 'self',
            role: 'outbound',
            text: `定期の依頼 ${event.kind} は、この発火では動かない: ${claimed.reason}`,
          });
          return;
        }

        const cause = event.cause === 'manual' ? 'manual' : 'schedule';
        const plan = claimed.status === 'ok' ? claimed.plan : null;
        await this.#runInternal(
          buildTimerPrompt({
            kind: event.kind,
            ...(event.target === undefined ? {} : { target: event.target }),
            ...(plan === null ? {} : { request: plan.request }),
            ...(plan?.lastRunAt === undefined ? {} : { lastRunAt: plan.lastRunAt }),
            // 前の発火が終わっていなかったなら、それは器が落ちた跡である。
            // 走りかけていた可能性があることを隠さない（二重に手を出さないため）。
            ...(plan?.pendingRun === undefined ? {} : { unfinishedAt: plan.pendingRun.at }),
            digest: await this.#recentDigest(),
          }),
        );

        // **終わったことを記録するのはここ。** claim（引き受けた印）とは別に置く。
        // ここまで来ないうちに器が落ちたら、印が残っているので配り直される
        // （日次なら翌日・週次なら翌週まで消える、を作らない）。
        if (plan !== null) await this.#completeScheduledRun(event.kind, event.at, cause);
        return;
      }

      case 'external': {
        const body = renderPayload(event.payload);
        await this.#journal({
          type: 'external_event',
          source: event.source,
          summary: body,
        });
        await this.#runInternal(buildExternalEventPrompt({ source: event.source, body }));
        return;
      }

      case 'self_initiative': {
        await this.#runInternal(
          buildSelfInitiativePrompt({ reason: event.reason, digest: await this.#recentDigest() }),
        );
        return;
      }

      default: {
        const exhaustive: never = event;
        throw new Error(`未知の受信箱イベント: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // ターンの実行
  // -------------------------------------------------------------------------

  /** 応答の本文を返す（内部ターンの結果を取りこぼさないため）。 */
  async #runTurn(conversationId: string | null, text: string): Promise<string> {
    // ターンは **セッションを起こす前に** 登録する。セッションの生成が失敗したり
    // 読み取りが即死したりしても、待っているターンを必ず誰かが解放できるように。
    let turn!: Turn;
    const done = new Promise<void>((resolve) => {
      turn = { conversationId, text: '', streamed: false, resolve };
      this.#turn = turn;
    });

    try {
      await this.#ensureQuery();
      this.#pushInput(await this.#withFreshMemory(text));
    } catch (error) {
      await this.#reportFailure(conversationId, String(error));
      this.#finishTurn();
    }

    await done;
    return turn.text;
  }

  /** 人間に見せない内部ターン（蒸留・承認回答の反映・人間以外の起点）。 */
  async #runInternal(text: string): Promise<string> {
    return this.#runTurn(null, text);
  }

  // -------------------------------------------------------------------------
  // 自律（人間以外の起点の中身）
  // -------------------------------------------------------------------------

  /**
   * 発火した kind の依頼を読む。
   *
   * **「消された」と「読めなかった」を区別する。** 前者は人間が手で仕込んだ kind を
   * 起こした場合も含むので、本文なしのターン（記憶に照らして判断する）が正しい。
   * 後者は器の瞬断であって、本文なしで動かす理由にはならない。
   *
   * 一瞬の揺れで1周期ぶんの仕事を落とさないよう、この発火の中で読み直す。**回数を
   * 絞るためではなく取りこぼしを拾うため**であり、諦めた場合も `lastRunAt` を
   * 進めないので、次の発火で同じ依頼がそのまま来る。
   */
  async #scheduledRequestFor(
    kind: string,
  ): Promise<
    { status: 'ok'; plan: ScheduledRequest | null } | { status: 'unreadable'; error: string }
  > {
    let last = '';
    for (let attempt = 0; attempt < SCHEDULE_STORE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, SCHEDULE_STORE_RETRY_MS * attempt));
      }
      try {
        return { status: 'ok', plan: await this.#stores.schedules.get(kind) };
      } catch (error) {
        last = String(error);
      }
    }
    return { status: 'unreadable', error: last };
  }

  /**
   * 「この発火で起きた」をストア側で確定させる。書けたら確定した依頼、書けなければ
   * 理由を返す（`null` は「同じ版がもう無い」＝消された・書き換わった）。
   *
   * 読み取りと同じ理由で、この発火の中で書き直す（器の一瞬の揺れで1周期ぶんの仕事を
   * 落とさない）。**それでも書けなければ動かない** — 動いた事実が外の世界にだけ残り、
   * `lastRunAt` が古いままだと、次の起動で「落ちている間に過ぎた予定」として同じ仕事を
   * もう一度起こす（取り消せない操作の二重実行は、1周期遅れるよりずっと高い）。
   */
  async #claimRun(
    kind: string,
    expectedUpdatedAt: string,
    at: string,
    cause: 'schedule' | 'manual',
  ): Promise<
    { status: 'ok'; plan: ScheduledRequest | null } | { status: 'failed'; error: string }
  > {
    let last = '';
    for (let attempt = 0; attempt < SCHEDULE_STORE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, SCHEDULE_STORE_RETRY_MS * attempt));
      }
      try {
        return {
          status: 'ok',
          plan: await this.#stores.schedules.claimRun(kind, expectedUpdatedAt, at, cause),
        };
      } catch (error) {
        last = String(error);
      }
    }
    return { status: 'failed', error: last };
  }

  /**
   * 引き受けた発火が終わったことを記録する。
   *
   * 書けなくても**ターンはもう走っている**ので、ここで止めるものは無い。印が残るぶん
   * 次の起動で配り直されるが、それは「消えるより配り直す」を選んだ結果である
   * （プロンプトには前の発火が終わっていないことを添えるので、二重に手を出す前に
   * クローンが `manager_list` と日誌を見られる）。
   */
  async #completeScheduledRun(
    kind: string,
    at: string,
    cause: 'schedule' | 'manual',
  ): Promise<void> {
    let last = '';
    for (let attempt = 0; attempt < SCHEDULE_STORE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, SCHEDULE_STORE_RETRY_MS * attempt));
      }
      try {
        await this.#stores.schedules.completeRun(kind, at, cause);
        return;
      } catch (error) {
        last = String(error);
      }
    }
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text:
        `定期の依頼 ${kind} の「終わった」を記録できなかった` +
        `（引き受けた印が残るので、次の起動で配り直される）: ${last}`,
    });
  }

  /**
   * 発火した kind を「読んで、その版で確定させる」まで通す。
   *
   * **読んだ本文で走るなら、走ると決めた時点でその版が生きていることを確かめる。**
   * 読みと記録が別操作だと、その隙間に人間が消した・直した依頼が古い本文で走る
   * （消した依頼が外の世界へ手を出したら取り返せない）。確定はストア側の1操作
   * （`claimRun`）に閉じてあり、ここはその周りの再試行と、版が入れ替わっていたときの
   * 読み直しだけを持つ。
   *
   * 版が入れ替わっていたら**新しい版を読み直して**そちらで確定させる。人間が直した
   * 直後なら、その新しい依頼で動くのが正しい（古い方で走らないことが最優先）。
   */
  async #claimScheduledRun(
    kind: string,
    at: string,
    cause: 'schedule' | 'manual',
  ): Promise<
    | { status: 'ok'; plan: ScheduledRequest }
    /**
     * そもそも仕込みが無い kind だった（人間が手で `POST /schedule/:kind/run` を
     * 叩いた等）。本文が無いのは正常なので、記憶に照らして判断させる。
     */
    | { status: 'missing' }
    | { status: 'unreadable' | 'unrecordable' | 'withdrawn' | 'churning'; reason: string }
  > {
    // 一度でも依頼を読めていたなら、後から消えたのは「人間が消した」である。
    // 最初から無いのとは意味が違うので分ける（片方は動かさない、片方は判断させる）。
    let sawPlan = false;

    for (let round = 0; round < SCHEDULE_CLAIM_ROUNDS; round += 1) {
      const found = await this.#scheduledRequestFor(kind);
      if (found.status === 'unreadable') {
        return {
          status: 'unreadable',
          reason:
            `依頼を読めなかった（本文なしで曖昧に動かすより、次の発火で読み直す）: ` + found.error,
        };
      }
      if (found.plan === null) {
        return sawPlan
          ? {
              status: 'withdrawn',
              reason: '確定する前に人間がこの依頼を消した（取り消された仕事は動かさない）',
            }
          : { status: 'missing' };
      }
      sawPlan = true;

      const claimed = await this.#claimRun(kind, found.plan.updatedAt, at, cause);
      if (claimed.status === 'failed') {
        return {
          status: 'unrecordable',
          reason:
            `「起きた」を記録できなかった（動いてから記録できないと、次の起動で同じ仕事を` +
            `もう一度起こす）: ${claimed.error}`,
        };
      }
      // 確定できた。返るのは更新前の姿なので「前回いつ動いたか」も分かる
      if (claimed.plan !== null) return { status: 'ok', plan: claimed.plan };
      // 読んでから確定するまでに人間が消した・直した。新しい版で読み直す
    }
    return {
      status: 'churning',
      reason: '読むたびに依頼が書き換わっている（人間が直している最中なので次の発火に譲る）',
    };
  }

  /** 発意・定期ジョブに渡す直近の状況。 */
  async #recentDigest(): Promise<string> {
    try {
      return await buildActivityDigest(this.#stores, {
        since: new Date(Date.now() - RECENT_DIGEST_WINDOW_MS),
      });
    } catch (error) {
      return `（直近の状況をまとめられなかった: ${String(error)}）`;
    }
  }

  /**
   * 日報 — 人間が普段読む唯一の層（PRD「可観測性」）。
   *
   * クローンに `daily_report_write` で書かせるが、**書かれなかった日を作らない**。
   * 道具を呼び忘れたらその応答をそのまま日報にする。ここで穴が開くと、人間が
   * 見ようとしたときに見えないという、要件上バグとして扱う状態になる。
   */
  async #dailyReport(date: string): Promise<void> {
    const range = localDayRange(date);
    const digest =
      range === null
        ? await this.#recentDigest()
        : await buildActivityDigest(this.#stores, range).catch(
            (error: unknown) => `（この日の記録をまとめられなかった: ${String(error)}）`,
          );

    const answer = await this.#runInternal(buildDailyReportPrompt({ date, digest }));

    const written = await this.#stores.journal
      .list({ types: ['daily_report'], limit: DAILY_REPORT_LOOKUP })
      .catch(() => []);
    if (written.some((entry) => entry.type === 'daily_report' && entry.date === date)) return;

    await this.#journal({
      type: 'daily_report',
      date,
      body:
        answer.trim().length > 0
          ? answer
          : '（クローンがこの日の日報を残さなかった。日誌から直接辿ること。）',
    });
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
      model: this.#model,
      // 組み込みツールは持たせない（人間の写像としての配置）
      tools: [],
      allowedTools: CLONE_ALLOWED_TOOLS,
      mcpServers: {
        [MCP_SERVER_NAME]: createCloneMcpServer({
          stores: this.#stores,
          emit: (event) => this.#emit(this.#turn?.conversationId ?? null, event),
          managers: this.#managers,
        }),
      },
      systemPrompt: buildCloneSystemPrompt({ memory }),
      // 人間のプロジェクト設定を持ち込まない。クローンは実プロジェクトの
      // 作業者ではなく、判断する側である（設定の共有は M2 のマネージャー側）。
      settingSources: [],
      // 人間が置いた実行環境プロファイルを、クローンの手にも効かせる。
      env: this.#childEnv(),
      includePartialMessages: true,
      ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
      ...(resume === null ? {} : { resume }),
      // セッションの生ログも記憶ストアと同じ PostgreSQL へ（M4）。器を作り直しても
      // resume の素材が残る。**同一性はそれでも記憶に宿る** — ここが空でも、
      // 記憶と日誌が同じならクローンは同じクローンである。
      ...(this.#sessionStore === undefined ? {} : { sessionStore: this.#sessionStore }),
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
   * クローンの SDK 子プロセスへ渡す env。
   *
   * **記憶ストアの鍵は落とさない。** ここはマネージャー（`runner.ts` の
   * `#childEnv`）と扱いが逆である — 伏せるのは「上（記憶）へ到達する鍵を
   * *下の層* へ配らない」ためであって、記憶の持ち主であるクローン自身から
   * 取り上げるためではない。取り上げれば、それはただのデグレードになる。
   */
  #childEnv(): NodeJS.ProcessEnv {
    return { ...this.#env, ...(this.#profile?.env() ?? {}) };
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
        model: this.#model,
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
        env: this.#childEnv(),
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
          await this.#reportFailure(
            turn.conversationId,
            failure ?? 'クローンのセッションが終了した',
          );
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

/**
 * マネージャーからの一件をクローンの言葉に直す。
 *
 * ここに「何なら答えてよいか」の一覧を書かないこと。答えるか人間に回すかの線引きは
 * クローンが記憶として持っているものであり、書いた瞬間に人による違いが潰れる
 * （PRD「権限境界」/ AGENTS.md 地雷3）。
 */
function managerPrompt(event: Extract<InboxEvent, { type: 'manager_message' }>): string {
  const head = `[system] マネージャー ${event.managerId} から届いた。`;

  if (event.kind === 'report') {
    return [
      `${head}（報告）`,
      '',
      event.text,
      '',
      '続きが要るなら `manager_send` で指示を出し、要らないなら何もしなくてよい。',
      '学びや判断の基準になったことがあれば記憶へ移すこと。',
    ].join('\n');
  }

  const label = event.kind === 'question' ? '質問' : '実行の許可確認';
  // 宛先には requestId まで書く。同じマネージャーが同時に複数を待つことがあり
  // （1応答で並列に呼ばれた道具）、宛先を欠いた回答は宛先を推測できない。
  const to =
    event.requestId === undefined
      ? `managerId: "${event.managerId}"`
      : `managerId: "${event.managerId}", requestId: "${event.requestId}"`;

  return [
    `${head}（${label}）`,
    '',
    event.text,
    '',
    `返事をするまで ${event.managerId} のこの1件だけが止まっている（他のマネージャーも、同じマネージャーの別の確認も、それぞれ独立に待っている）。`,
    `記憶に根拠があるなら自分で決めて \`manager_send\`（${to}）で返し、その判断を \`journal_write\` に残せ。`,
    event.kind === 'permission' ? '許可確認なので `decision` に allow / deny を明示すること。' : '',
    `根拠が無いなら \`ask_human\` に ${to} を添えて積み、人間の回答が届いてから同じ宛先へ \`manager_send\` で返せ。` +
      '（宛先を添えないと、人間が答えてもこの仕事を再開できない）',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * 中身を持たない「見に行け」の合図か。
 *
 * 時間起点の発火と発意 tick だけがこれに当たる。どちらも materialize されるのは
 * 処理の瞬間（そこで最新の状況をまとめ直す）なので、読まれる前の重複には情報が無い。
 */
function isTick(event: InboxEvent): boolean {
  return event.type === 'self_initiative' || event.type === 'timer';
}

function isSameTick(a: InboxEvent, b: InboxEvent): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'self_initiative') return true;
  if (a.type === 'timer' && b.type === 'timer') {
    // 対象日が違えば別の仕事（別の日の日報は畳めない）。手で起こした分と定期の
    // 発火も別物である（前者は予定をずらさない＝記録先が違う）ので畳まない。
    return a.kind === b.kind && a.target === b.target && a.cause === b.cause;
  }
  return false;
}

/** 外部から届いた中身を、そのままクローンに読ませられる形にする。 */
function renderPayload(payload: unknown): string {
  // 中身なしの通知（source だけ）もある。`undefined` という文字列を読ませない。
  if (payload === undefined || payload === null || payload === '') {
    return '（中身のない通知。source だけが届いた。）';
  }
  const body = typeof payload === 'string' ? payload : safeJson(payload);
  return body.length > EXTERNAL_PAYLOAD_LIMIT
    ? `${body.slice(0, EXTERNAL_PAYLOAD_LIMIT)}\n…（以下省略）`
    : body;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
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
