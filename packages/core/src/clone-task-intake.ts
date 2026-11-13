import { noteDroppedRecord, inboxEventShape, reasonOf } from './dropped-record.js';
import { EXCHANGE_KIND_FAILURE_PREFIX } from './exchange-kind.js';
import { describeTaskQueuePlacement } from './clone-turn-input-text.js';
import type { HumanMessage } from './clone-batch-prompts.js';
import { DAILY_REPORT_KIND } from './schedule.js';
import type { InboxEvent, JournalEntryInput } from './schema.js';
import { readAtLabel } from './situation.js';
import type { Stores } from './store.js';
import { opensHumanTask, taskFromHumanIntake } from './task-auto-done.js';
import { describeTaskQueueHead, TASK_QUEUE_HEAD_LIMIT } from './task-tools.js';
import { describeWaitingReplyLines, selectWaitingReplyTasks } from './waiting-task-reply-notice.js';

/**
 * `Clone` が協力者へ渡す口。読むものは「呼ばれるまで読まない関数」で渡す（`#stores` は constructor の中で入る）。
 * 口の戻りは Promise を直に返す（`(entry) => this.#journal(entry)`）: 間に `async` の関数を挟むと `await` の段が増え、呼び元の評価の時機が動く。
 */
export interface CloneTaskIntakePorts {
  /** `Clone` の `#stores`（Task の `add`・`list` と、委譲の `listJobs` だけ読む） */
  stores(): {
    readonly tasks: Pick<Stores['tasks'], 'add' | 'list'>;
    readonly jobs: Pick<Stores['jobs'], 'listJobs'>;
  };
  /** `Clone` の `#journal` */
  journal(entry: JournalEntryInput): Promise<void>;
}

/**
 * 人間の依頼を Task として積む取り込みと、その結果を名乗るターンの断り書き（待ち行列の節）。状態は 2 本で、この中だけで書く:
 * 取り込み中の追加（`#taskOpens`。外の 2 箇所 `#closeWithdrawnTasks`・`#autoCloseRepliedTasks` は `pendingOpens()` で同期に読む）と、
 * 積めなかった発言の id（`#humanTaskFailures`。断り書きが 1 回だけ名乗って外す）。
 * 呼び元は `#record`（`openHumanTask`。同期・`void`）と `#prepareTurn`（`await timer.time(...)` の中の `taskQueueNoticeFor`）。
 * メソッドは元と同じ `async`／同期のまま（呼び元の `await` の段を増やさない）。
 * `pendingOpens()` も同期にする: `async` の待ち口にすると、呼び元の `await Promise.all(...)` の前にマイクロタスクが 1 つ挟まる。
 */
export class CloneTaskIntake {
  readonly #ports: CloneTaskIntakePorts;

  // 人間の依頼の Task の追加のうち、まだ終わっていないもの（`openHumanTask`）。返答のターンの終わりが待つ: 届いた直後に返答が終わると、Task がまだ無く閉じ損ねるため
  readonly #taskOpens = new Set<Promise<void>>();
  // Task に積めなかった人間の発言の id。断り書きが1回だけ名乗って外す（`taskQueueNoticeFor`）: 積めなかった事実を、積んだと偽らないため
  readonly #humanTaskFailures = new Set<string>();

  constructor(ports: CloneTaskIntakePorts) {
    this.#ports = ports;
  }

  /**
   * 取り込み中の追加の写し（同期）。`Clone` の `#closeWithdrawnTasks`・`#autoCloseRepliedTasks` が `await Promise.all(this.#tasks.pendingOpens())` と読む。
   * 呼んだ時点の写しを返す（元の `[...this.#taskOpens]` と同じ）: 以後の追加・完了では動かない。
   */
  pendingOpens(): readonly Promise<void>[] {
    return [...this.#taskOpens];
  }

  // 人間の依頼を Task として積む（#5469 P5）。id は受信箱の合図と同じで、`TaskStore.add` の existed が配り直しでの二重を防ぐ。
  // 失敗しても post を落とさない。進行中の追加は `#taskOpens` で控え、返答のターンの終わりが待つ
  // 日誌へは「積んだ」行を書かない: 合図そのものが `#record` で日誌に在り、Task の id がその合図の id と同じなので辿れるため。失敗だけは stderr と日誌に残す
  openHumanTask(event: HumanMessage): void {
    const opening = this.#stores.tasks
      .add(taskFromHumanIntake(event, new Date().toISOString()))
      .then(
        () => undefined,
        (error: unknown) => {
          noteDroppedRecord('Task の自動起票', inboxEventShape(event), error);
          this.#humanTaskFailures.add(event.id);
          return this.#journalSelf(
            'outbound',
            `${EXCHANGE_KIND_FAILURE_PREFIX}人間の依頼を Task として積めなかった（id: ${event.id}）。` +
              `必要なら \`task_add\` で載せ直すこと（理由: ${reasonOf(error)}）。`,
          );
        },
      )
      .finally(() => {
        this.#taskOpens.delete(opening);
      });
    this.#taskOpens.add(opening);
  }

  // 器は起点の中身を読んで順番を付けない: 付けた瞬間に「何を先にやるか」の判断が器へ移るため（人間が待っている合図だけを前へ出す）。一覧そのものは載せない: 件数に比例して伸びるものを毎ターン積むと、溜まっているときほどターンが重くなるため
  // 見出しは「いつ数えた値か」を名乗る: この節は会話履歴へ連結されてターンの数だけ並び、時刻が無いと古い節と新しい節が見分けられないため
  async taskQueueNoticeFor(events: InboxEvent[]): Promise<string> {
    const event = events[0];
    if (event === undefined) return '';

    // 蒸留には載せない: 記憶へ移すためだけの内部ターンで、`stop()` 経由はこの直後にプロセスが消え、未了を渡すと畳んでいる最中に新しい仕事を始めさせるだけのため
    if (event.type === 'distill') return '';

    // Task の追加が済むのを待ってから待ち行列を読む: 待たないと、いま届いた発言の Task がまだ無い件数を名乗るため
    await Promise.all([...this.#taskOpens]);
    const taskEvents = events.filter(opensHumanTask);
    const failedTaskEvents = taskEvents.filter((pending) =>
      this.#humanTaskFailures.delete(pending.id),
    );
    const failedTaskIds = new Set(failedTaskEvents.map((pending) => pending.id));
    const placedTaskEvents = taskEvents.filter((pending) => !failedTaskIds.has(pending.id));
    const taskQueue = await this.#taskQueueNotice(
      event,
      placedTaskEvents,
      failedTaskEvents,
      tickDigestCarriesTaskQueueHead(events),
    );

    // 待ち行列の先頭を要約に任せた回（`head` が空）は、固定の1文も出さない: 1文が指す先頭の行が、この断り書きには無いため。
    // 積んだ・積めなかった行が残る回（tick では出ない）にだけ、全体の区切りを付ける
    if (taskQueue.head.length === 0) {
      const rest = [...taskQueue.placed, ...taskQueue.failed];
      return rest.length === 0 ? '' : [...rest, '', '---', ''].join('\n');
    }

    return [
      ...taskQueue.head,
      ...taskQueue.placed,
      ...taskQueue.failed,
      ...(await this.#waitingReplyLinesFor(taskEvents)),
      '',
      '---',
      '',
    ].join('\n');
  }

  // 人間の発言を含む束だけ、その会話を起点にした返事待ち（waiting）の task を名乗る。該当が無ければ空（1文字も増やさない）。読めなければ名乗らない（断り書き全体を落とさない）
  async #waitingReplyLinesFor(humanEvents: readonly HumanMessage[]): Promise<string[]> {
    if (humanEvents.length === 0) return [];
    try {
      const conversationIds = new Set(humanEvents.map((pending) => pending.conversationId));
      const { entries } = await this.#stores.tasks.list();
      const nowMs = Date.now();
      const candidates = selectWaitingReplyTasks(entries, [], conversationIds, nowMs);
      if (candidates.length === 0) return [];
      const matched = selectWaitingReplyTasks(
        candidates,
        await this.#stores.jobs.listJobs(),
        conversationIds,
        nowMs,
      );
      return describeWaitingReplyLines(
        matched,
        '返事が来たなら `task_set_status` で閉じるか queued に戻すこと（器は状態を変えない）。',
      );
    } catch (error) {
      noteDroppedRecord('返事待ちの task の断り書き', 'waiting-reply', error);
      return [];
    }
  }

  // 断り書きの待ち行列の側（#5469 P6c）。件数と先頭の描き方は digest と同じ `describeTaskQueueHead`（写さない）
  // 待ち行列を読めなかったときは 0 件と書かず、読めなかったと名乗る
  async #taskQueueNotice(
    event: InboxEvent,
    placed: readonly HumanMessage[],
    failed: readonly HumanMessage[],
    // 要約が同じ待ち行列の先頭を載せる回は、読めたときの先頭を出さない（読めなかった断りは要約に無いので残す）
    leaveHeadToDigest: boolean,
  ): Promise<{ head: string[]; placed: string[]; failed: string[] }> {
    const { placed: placedLines, failed: failedLines } = describeTaskQueuePlacement(
      placed.map((pending) => pending.id),
      failed.map((pending) => pending.id),
    );
    let taskList: Awaited<ReturnType<Stores['tasks']['list']>>;
    try {
      taskList = await this.#stores.tasks.list();
    } catch (error) {
      noteDroppedRecord('待ち行列の読み出し', inboxEventShape(event), error);
      return {
        head: [
          `[system] **待ち行列を読めなかった（${readAtLabel(Date.now())} に試みた材料。理由: ${reasonOf(error)}）。** ` +
            '⟹ **開いている仕事が何件あるかは、この回は判定できていない——0 件だったのでも、異常が無かったのでもない。** ' +
            '読み直す手は `task_list` である（同じ理由で失敗するなら、失敗として返る）。',
        ],
        placed: placedLines,
        failed: failedLines,
      };
    }
    if (leaveHeadToDigest) return { head: [], placed: placedLines, failed: failedLines };
    const nowMs = Date.now();
    const rows = describeTaskQueueHead(taskList, { limit: TASK_QUEUE_HEAD_LIMIT, nowMs });
    return {
      head: [`[system] 待ち行列（${readAtLabel(nowMs)} に数えた材料）`, ...rows],
      placed: placedLines,
      failed: failedLines,
    };
  }

  // `Clone` の `#stores` と同じ名前で読む: 本体の式（`this.#stores.tasks…`）を移す前と一字も変えないため。値でなく口越しに読むのは、`Clone` の constructor の中で入る値だから
  get #stores(): ReturnType<CloneTaskIntakePorts['stores']> {
    return this.#ports.stores();
  }

  // `Clone` の `#journalSelf` と同じ形で置く（走査の試験は、この private な helper の呼び出しの字面を数える。口を直に呼ぶ字面だと拾わない）。
  // async にせず口の Promise をそのまま返す: `await` の呼び出し側のタイミングを変えない。
  // 接頭辞（EXCHANGE_KIND_*_PREFIX）は呼び出し箇所の text に字面で置く（exchange-kind-coverage.test.ts が第2引数を走査する）。
  #journalSelf(role: 'inbound' | 'outbound', text: string): Promise<void> {
    return this.#ports.journal({ type: 'exchange', with: 'self', role, text });
  }
}

/**
 * この束の本文が、要約（digest）に「待ち行列の先頭」の節を載せるか。載せる回は断り書きの側で同じ先頭を重ねて出さない。
 * 発意 tick と日報（`buildActivityDigest` の全形）だけが載せる。定期の依頼の tick（timer の日報以外）は件数の形（`shape: 'counts'`）で、
 * 待ち行列の件数の行も先頭の3件も載せないので、断り書きの側に残す。tick は束ねられない（`CloneBatchMerge.mixedSignalBatch` に入らない）ので、束は1件のはず。1件でなければ載せる側に残す。
 */
function tickDigestCarriesTaskQueueHead(events: readonly InboxEvent[]): boolean {
  if (events.length !== 1) return false;
  const [event] = events;
  if (event === undefined) return false;
  if (event.type === 'self_initiative') return true;
  return event.type === 'timer' && event.kind === DAILY_REPORT_KIND;
}
