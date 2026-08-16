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
import {
  inboxEventShape,
  journalEntryShape,
  noteDroppedInboxEvent,
  noteDroppedRecord,
} from './dropped-record.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { Inbox } from './inbox.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import type { ProfileApplier } from './profile.js';
import type { ProfileService } from './profile-service.js';
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
import type { SelfFacts } from './self.js';
import type { PendingInboxEvent, Stores } from './store.js';
import { CLONE_ALLOWED_TOOLS, MCP_SERVER_NAME, createCloneMcpServer } from './tools.js';
import type { AccountUsageState } from './usage-snapshot.js';

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
  /**
   * 実行環境プロファイルを置いて配る1本道（`profile_read` / `profile_write` と
   * 再接続時の降ろし直しが通る）。
   *
   * **デーモンが作った同じインスタンスを渡すこと。** 人間の口とクローンの道具が
   * 別のインスタンスを持つと直列化の意味が消える（層ごとに違う本文が残る）。
   */
  profileService?: ProfileService;
  /**
   * アカウント全体の利用状況（claude.ai 側の値）を読む口。
   *
   * **人間が `claude.ai/settings/usage` で見られるものを、クローンにも渡す。**
   * 見られないのは能力の削除（north_star 禁止1）であり、しかもこれは飾りではなく
   * 判断の材料である（重い委譲を続けてよいかは、残りを見ずには決められない）。
   */
  accountUsage?: () => AccountUsageState;
  /**
   * いま自分がどう走っているかの事実（記憶の器・作業ディレクトリ・委譲先・
   * 入口・モデル帯）。システムプロンプトの自己認識の節に載る。
   *
   * **省略できるのはテストのためだけである。** 本番の配線で落とすと、
   * クローンは自分がどこで走っているかを知らないまま判断することになる。
   * 組み立てるのはデーモン側 — 事実を知っているのはあちらだからで、
   * ここで環境変数を読み直すと出所が2つになる。
   */
  self?: SelfFacts;
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
  /** 自己認識の材料。デーモンが組み立てて渡す（テストでは省略される）。 */
  readonly #self: SelfFacts | undefined;

  readonly #inbox = new Inbox();
  readonly #listeners = new Map<string, Set<Listener>>();
  /** 受信箱に積んだイベントの処理完了を待つための約束。 */
  readonly #completions = new Map<string, () => void>();

  /**
   * 未読として器に置いた合図。id → その書き込みの約束。
   *
   * **消し込みがこの書き込みを追い越さないために持つ。** `post` は同期なので
   * 書き込みは非同期になり、短いターンなら「処理を終えた」が「書けた」より先に
   * 来る。順序を見ないと、消したはずの合図が後から書かれて永久に配り直される。
   *
   * ここに居ないものは器に置いていない合図である（`#postAndWait` の蒸留）。
   */
  readonly #unread = new Map<string, Promise<void>>();
  /** 起動時に拾い直した合図。id → 何度目の配達か。 */
  readonly #redelivered = new Map<string, PendingInboxEvent>();
  /**
   * いま処理している合図が配り直しなら、その断り書き。ターンの本文の先頭に載る。
   *
   * **断り書きを起点ごとに配らない。** プロンプトの組み立ては起点の数だけ
   * （7か所）散っていて、そのうち1か所へ入れ忘れると「二度目だと分からない
   * 配達」がその起点にだけ生まれる。ターンの入口（`#runTurn`）は1か所しかない
   * ので、そこに置けば起点を問わず必ず載る。
   */
  #redeliveryNotice = '';

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
  readonly #profileService: ProfileService | undefined;
  readonly #accountUsage: (() => AccountUsageState) | undefined;

  constructor(options: CloneOptions) {
    const {
      stores,
      queryFn,
      cwd,
      runners,
      sessionStore,
      managers,
      env,
      profile,
      profileService,
      accountUsage,
      self,
    } = options;
    this.#stores = stores;
    this.#queryFn = queryFn ?? query;
    this.#cwd = cwd;
    this.#sessionStore = sessionStore;
    this.#model = resolveCloneModel(env ?? process.env);
    this.#env = env ?? process.env;
    this.#profile = profile;
    this.#profileService = profileService;
    this.#accountUsage = accountUsage;
    this.#self = self;
    this.#managers =
      managers ??
      createManagerPool({
        stores,
        ...(profileService === undefined ? {} : { profile: profileService }),
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
    // 片付け中に届いたものは処理できない（`stop()` の直後に `storage.close()` →
    // `process.exit(0)` が来る）。**だが黙って消さない** — ここは7種類の起点
    // すべてが通る1本道で、人間の発言もマネージャーの完了報告もここで消える。
    // 跡が無いと「受信箱に積まれたまま死んだ」「閉じた後に届いた」「ターンが
    // 間に合わなかった」が日誌の上で同じ形になり、切り分けられない。
    // stderr へ同期で書く理由は `noteDroppedInboxEvent`。
    if (this.#stopped) {
      noteDroppedInboxEvent(event);
      return;
    }

    // 同じ合図がまだ読まれないまま積み重なっても、読んだときに見る材料は同じなので
    // 畳む。**これは実行回数の制限ではない**（AGENTS.md 地雷2）— 発火を減らすのでも
    // 遅らせるのでもなく、「まだ読んでいない同じ合図」を二度読まないだけである。
    // 人間の発言・マネージャーからの一件・外部イベントは中身が違うので絶対に畳まない。
    if (isTick(event) && this.#inbox.hasPending((queued) => isSameTick(queued, event))) return;

    // **受理した時点で未読として書き出す。** 境界を「queue に入った時点」に置いては
    // いけない — クローンが暇なときに届いた合図は `Inbox#push` の waiter 経路を
    // 通って queue を素通りするので、queue を吐き出す形の永続化はその経路を1件も
    // 救わない。ここに置けば、どちらの経路でも必ず1度は通る。
    this.#remember(event);
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
    // 前の器が終えられなかったものを戻す。**始めるだけで、待たない。**
    //
    // 待つと2つ壊れる。1つは可用性で、器（PostgreSQL）が詰まっているときに
    // `claimPending` が返らないと、**受信箱のループそのものが始まらない** —
    // 人間の発言すら処理できないクローンになる。未読を拾い直せないことと、
    // 何も受け取れないことは釣り合わない。もう1つは取り出しの間合いで、ここで
    // 待つと `for await` の最初の `next()`（＝待ち受けの登録）が1周遅れ、起動
    // 直後に積まれた合図の畳み込み方が変わる（`isTick` の畳み込みは「処理中の
    // 1件＋待ち行列の1件」を残す形で効いている）。
    //
    // 拾い直したものは、戻り次第この同じループへ入る。**待たない以上、失敗は
    // 自分で受けること** — ここで漏らすと unhandled rejection になり、未読を
    // 拾い直せなかっただけでデーモンごと落ちる（走行中のマネージャーも巻き添え）。
    void this.#restoreUnread().catch((error: unknown) => {
      noteDroppedRecord('未読の読み直し', '', error);
    });

    for await (const event of this.#inbox) {
      this.#redeliveryNotice = this.#redeliveryNoticeFor(event);
      try {
        await this.#handle(event);
      } catch (error) {
        await this.#reportFailure(this.#conversationOf(event), String(error));
        this.#finishTurn();
      } finally {
        this.#redeliveryNotice = '';
        // **終えた時点で消す。取り出した時点ではない。** 取り出した時点で消すと、
        // 処理の途中でプロセスが死んだものが失われる＝いま塞いでいる穴がそのまま残る。
        //
        // **例外で終わったものも消す。** ここへ来ているということは失敗が
        // `#reportFailure`（＝人間へ流すか日誌へ落とす）に記録されたということで、
        // 消えたわけではない。残す側を選ぶと、決定的に失敗する合図（形が不正・
        // 参照先が消えている）が起動のたびに配り直され、そのたびに同じ失敗を
        // 繰り返してクローンのターンを1本ずつ焼く。**残るのはプロセスが死んだ
        // ときだけ**、が守るべき唯一の線である。
        await this.#forget(event);
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

  // -------------------------------------------------------------------------
  // 未読の永続化（プロセスが死んでも判断の材料を失わない）
  // -------------------------------------------------------------------------

  /**
   * 受け取った合図を未読として器に置く。
   *
   * **`post` は同期で返り値を持たない**（7種類の起点すべてがそう呼ぶ）ので、書き
   * 込みは待てない。したがって「受理した」と「書けた」の間には窓が残る。**そこは
   * 塞げないが、塞げるのは残り全部である** — この直しの前は「受理してから処理を
   * 終えるまで」丸ごとが失われる窓で、そこにはターン1本ぶん（マネージャーの委譲を
   * 含めば数分から数十分）が入っていた。
   *
   * **失敗しても post を落とさない。** 未読を書けないことでその合図の処理まで
   * 止めたら、いま直そうとしているものより広い穴になる。跡は stderr へ1行だけ残す
   * （本文を出さない理由は `dropped-record.ts`。ここへ来る合図には人間の発言・
   * webhook の本文・マネージャーの報告が入り、報告本文に `GH_TOKEN` が全文で出た
   * 前例がある）。
   */
  #remember(event: InboxEvent): void {
    this.#unread.set(
      event.id,
      this.#stores.inbox.put(event, event.at).catch((error: unknown) => {
        noteDroppedRecord('未読の合図', inboxEventShape(event), error);
      }),
    );
  }

  /**
   * 処理を終えた合図を器から消す。
   *
   * **書き込みの完了を待ってから消す。** 待たないと、短いターンでは消し込みが
   * 書き込みを追い越し、消したはずの合図が後から書かれて**起動のたびに永久に
   * 配り直される**（この直しが一番作りやすい壊れ方である）。
   */
  async #forget(event: InboxEvent): Promise<void> {
    const written = this.#unread.get(event.id);
    // 器に置いていない合図（`#postAndWait` の蒸留）は消すものが無い。
    if (written === undefined) return;
    this.#unread.delete(event.id);
    this.#redelivered.delete(event.id);

    await written;
    try {
      await this.#stores.inbox.remove(event.id);
    } catch (error) {
      // 消せなかったものは次の起動で配り直される。**それは設計どおりの側の失敗**
      // （消えるより配り直す）なので、跡だけ残して進む。
      noteDroppedRecord('未読の消し込み', inboxEventShape(event), error);
    }
  }

  /**
   * 前の器が終えられなかった合図を受信箱へ戻す。
   *
   * **永続化と拾い直しは1つの直しの前半と後半である。** 永続化しても拾い直さな
   * ければ器の中で腐るだけだし、拾い直しには永続化が要る。片方だけ入れないこと。
   *
   * **digest（`digest.ts`）は変えない。** あちらも `done` のマネージャーを拾うが、
   * 見せるのは 200 字の抜粋・最大15件・24時間の窓であり、**未読かどうかは区別
   * しない**。ここで戻すのは全文が1ターンとして届く経路なので、両者は競合しない
   * （digest に載るのは「この期間に何があったか」で、この直しの前から報告の抜粋は
   * そこに出ていた＝重複が増えるわけではない）。むしろ**「消えたと思ったものが、
   * 実は 200 字の抜粋として通り過ぎていた」を解くのがこちら側である** — 未読は
   * 抜粋ではなく全文で、断り書き付きで届く。
   */
  async #restoreUnread(): Promise<void> {
    let pending: PendingInboxEvent[];
    try {
      pending = await this.#stores.inbox.claimPending();
    } catch (error) {
      // 読めなければ配り直せないが、消してもいないので次の起動で拾い直せる。
      noteDroppedRecord('未読の読み直し', '', error);
      return;
    }

    for (const record of pending) {
      if (this.#stopped || this.#inbox.closed) return;

      // 人間が後から「なぜ二度来たのか」を追えるようにする。**積む前に書く** —
      // 後だと、配り直した合図の処理（`#handle` が起点ごとの型で残す本文）より
      // 後ろに回りうる。**本文は載せない**（同じ本文を二重に持たない）。
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text:
          `未読のまま残っていた合図を配り直した（${record.deliveries}回目の配達、` +
          `${record.at} に受け取ったもの）: ${inboxEventShape(record.event)}`,
      });

      // 日誌を書いているあいだに片付けが始まっていることがある。**積む直前に
      // もう一度見ること**（`Inbox#push` は閉じた後だと投げる）。消してはいない
      // ので、積めなかったものは次の起動で拾い直せる。
      if (this.#stopped || this.#inbox.closed) return;

      this.#redelivered.set(record.event.id, record);
      // 既に器に在るので書き直さない。**ただし消し込みの対象には入れる**
      // （入れ忘れると、拾い直したものが処理後も残って毎回配られる）。
      this.#unread.set(record.event.id, Promise.resolve());
      // `post` を通さないのは、tick の畳み込みで落ちた行が器に残り続けるからである
      // （落とした側は誰も消さないので、起動のたびに配られて回数だけが増える）。
      this.#inbox.push(record.event);
    }
  }

  /**
   * 配り直しの断り書き。初めての配達なら空文字。
   *
   * **「二度届く」ことは受け入れるが、「二度目だと分からない」ことは受け入れない。**
   * 分からなければクローンは同じ報告に二度応答し、そのターンが丸ごと無駄になる
   * （消費にも直結する）。ここが、消し込みを「終えた時点」に置いた取引の対価である。
   */
  #redeliveryNoticeFor(event: InboxEvent): string {
    const record = this.#redelivered.get(event.id);
    if (record === undefined) return '';

    return [
      `[system] **これは配り直しである（${record.deliveries} 回目の配達）。**` +
        `${record.at} に受け取ったまま、処理を終える前にデーモンが落ちた合図を、起動時に拾い直した。`,
      '同じ内容に既に応答しているかもしれない。日誌（`journal_read`）と `manager_list` を見て、' +
        '同じ仕事を二度起こさないこと。',
      ...(record.deliveries >= 2
        ? [
            '**2 回以上配り直している。** この合図を処理するたびに器が落ちている可能性がある。' +
              '同じやり方をもう一度なぞる前に、なぜ落ちたかを先に見ること。',
          ]
        : []),
      '',
      '---',
      '',
    ].join('\n');
  }

  /**
   * ターンの失敗を必ずどこかに残す。
   *
   * 人間が繋がっていれば chat へも流れるが、**流せたことを記録の代わりにしない。**
   * `#emit` はその会話の購読者が居なければ何もしないので、chat へ流すだけで
   * 済ませると「人間が発言 → chat を閉じる／切断 → そのターンが例外で失敗」が
   * どこにも残らない。内部ターン（マネージャーからの確認・蒸留・自律）には
   * そもそも聞き手が居ないので、握り潰せば「クローンが黙り、マネージャーが
   * 永久に返事を待つ」が無記録で起きる。**どちらの向きも日誌で受ける。**
   *
   * これは消し込みの前提でもある。受信箱のループは例外で終わった合図も
   * `#forget` するが（`#pump` の `finally`）、その根拠は「失敗が記録されて
   * いる」ことである。人間の発言だけがその根拠を欠いていた。
   *
   * **なぜ日誌か（`Clone#post` の #57 とは選択が違う）。** あちらは同期で
   * 返り値を持たず、日誌へ書けば fire-and-forget ＝跡が残る前にプロセスが
   * 消える窓そのものへ賭けることになるので stderr にした。ここは `async` で、
   * **呼び出し側が全経路で `await` している**（`#pump` の catch / `#runTurn` /
   * 読み取りループの finally）。しかも `#forget` はこの `await` が返った後の
   * `finally` で走るので、書き終える前に落ちれば合図は未読のまま残って配り
   * 直される。跡を残す窓と競合しない以上、stderr へ落とす理由が無い。
   *
   * **本文（`message`）を stderr へは出さない。** ここに入るのは呼び出し側3か所
   * すべてで `String(error)` である。**いま辿れる範囲に、人間の発言そのものを
   * 載せて戻ってくる経路は無い**（発言を束縛して書くのは `#handle` の
   * `#journal` だが、あれは自分で握って `noteDroppedRecord` へ落とすので
   * ここまで投げてこない）。だが `message` は SDK・API・ストアのドライバが
   * 決める文字列であって**こちらが値を決めていない** — `journalEntryShape` の
   * 判定基準（「自由文かどうか」ではなく「値を誰が決めるか」）では出せない側で
   * ある。日誌は持ち主しか読まないが stderr は器の外へ出ていく
   * （`noteDroppedRecord` の doc）。書けなかったときの跡は `#journal` が
   * `journalEntryShape` ＝長さだけに畳んで `noteDroppedRecord` へ落とす。
   * **ここに素の `String(error)` を1行も足さないこと。**
   */
  async #reportFailure(conversationId: string | null, message: string): Promise<void> {
    // 繋がっている人間には即座に見せる。日誌より先なのは、書き込みを待たせて
    // 「反応が無い」時間を伸ばさないため。届かなくても下の記録が残る。
    this.#emit(conversationId, { type: 'error', message });

    // `conversationId` は呼び出し側が構造化フィールドとして持っている値なので
    // 載せる（#56 の線）。落とすと、失敗がどの会話のものだったかを時刻でしか
    // 突き合わせられなくなる — 日誌には列があるのに。
    await this.#journal(
      conversationId === null
        ? {
            type: 'exchange',
            with: 'self',
            role: 'outbound',
            text: `内部ターンが失敗した: ${message}`,
          }
        : {
            type: 'exchange',
            with: 'human',
            role: 'outbound',
            text: `人間との対話ターンが失敗した: ${message}`,
            conversationId,
          },
    );
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
      // 配り直しの断り書きは**ここでだけ**載せる（`#redeliveryNotice` の理由）。
      this.#pushInput(await this.#withFreshMemory(this.#redeliveryNotice + text));
      // 入力がモデルへ渡った瞬間から最初の出力までは「考えている」。
      // **`#ensureQuery` より後で送る** — セッションの起動そのものはまだ考え
      // 始めていないので、そこで送ると手が動いていないのに考えていると
      // 言うことになる。`#pushInput` は同期なので、この emit は続く `text`
      // より必ず先に届く。
      this.#emit(conversationId, { type: 'thinking' });
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
          ...(this.#profileService === undefined ? {} : { profile: this.#profileService }),
          ...(this.#accountUsage === undefined ? {} : { accountUsage: this.#accountUsage }),
        }),
      },
      systemPrompt: buildCloneSystemPrompt({
        memory,
        ...(this.#self === undefined ? {} : { self: this.#self }),
      }),
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
            // **蒸留のターンでも同じ道具を渡す。** ここだけ欠けていると、
            // 会話の最後に「鍵を実行環境へ移す」をやろうとして失敗する。
            ...(this.#profileService === undefined ? {} : { profile: this.#profileService }),
            ...(this.#accountUsage === undefined ? {} : { accountUsage: this.#accountUsage }),
          }),
        },
        systemPrompt: buildCloneSystemPrompt({
          memory,
          ...(this.#self === undefined ? {} : { self: this.#self }),
        }),
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

      // 道具の結果が返った＝実行は終わり、モデルが次を考え始めた。ここで
      // 送り直さないと画面は `tool` の合図（「…を実行中…」）のまま止まり、
      // もう終わっている実行をまだ続いているように見せてしまう。
      // `tool_result` を含むときだけにしているのは、人間の発言のエコーや
      // replay（`SDKUserMessageReplay`）を「考え始めた」と読み違えないため。
      case 'user': {
        if (!contentBlocks(message.message).some((block) => block.type === 'tool_result')) return;
        this.#emit(this.#turn?.conversationId ?? null, { type: 'thinking' });
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
    } catch (error) {
      // 記録できないこと自体は致命ではない。文脈を失う方が高くつく。
      // **ただし黙って消さない。** 跡がどこにも無いと「日誌に無い」が
      // 「起きなかった」と読めてしまい、日誌を判別器に使った切り分けが
      // 静かに嘘をつく（本文を出さない理由は `noteDroppedRecord`）。
      noteDroppedRecord('日誌', journalEntryShape(entry), error);
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
