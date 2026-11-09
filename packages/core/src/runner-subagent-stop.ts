import type { AgentContextOutcome, AgentSubagentStopRecord } from './agent-hooks.js';
import { reasonOf } from './dropped-record.js';
import {
  classifyBackgroundTaskStatus,
  isOwnerRecordableTaskType,
  taskRow,
  truncateWithNote,
} from './runner-background-task-rows.js';
import type { RunnerBackgroundWaiters } from './runner-background-waiters.js';
import type { CutOffBackgroundTaskSummary, RunnerCutOffWorkers } from './runner-cut-off-workers.js';
import type { RunnerEvent } from './runner-protocol.js';
import {
  BACKGROUND_TASK_OWNER_LIMIT,
  SUBAGENT_BACKGROUND_WAIT_MS,
  type RunnerSubagentStopState,
} from './runner-subagent-stop-state.js';
import type { WorkerToolWatch } from './runner-worker-tool-watch.js';

// 超えた分を黙って落とさない: 切ったこと自体を末尾に書く（AGENTS.md「静かに失敗する道具」）
const SUBAGENT_STOP_NOTE_TEXT_LIMIT = 1_500;

/**
 * `RunnerSession` が口として渡すもの。9 本。
 * `workerTools`・`stopState`・`sdkSession`・`cutOffWorkers` は参照のまま渡し、使うメンバーだけの型（`Pick`／同じ形の interface）で受ける（`RunnerSession` の他の経路と同じ器を共有するため。
 * 値に写すと、`sdkSession.stopped`・`generation`・`liveBackgroundTasks`（getter）が呼ぶたびの値でなくなり、通算・診断済みの旗・所有者の表が二重になる）。
 * `backgroundWaiters` は `sdkSession` の getter 越しに引く（`wait`・`isFinished`・`outputFileOf` だけを使う）。
 * 関数の口（`note`・`emit`・`tryObservation`・`resumeGuidance`）は async の皮で包まずに渡す（`observe` の握りは、同期で投げた口を `catch` で受ける前提のため。
 * 包むと `await` を足したのと同じに周回が動く）。
 */
interface RunnerSubagentStopObserverPorts {
  /** `RunnerSession#workerTools`（作業者の道具の見張り）。`settleAgent` だけ。参照。 */
  workerTools: Pick<WorkerToolWatch, 'settleAgent'>;
  /** `RunnerSession#tryObservation`（観測の失敗を握る）。同期。 */
  tryObservation: (label: string, fn: () => void) => void;
  /** `RunnerSession#stopState`（所有者の表・診断済みの旗・通算・間引き）。参照。 */
  stopState: Pick<
    RunnerSubagentStopState,
    | 'backgroundTaskOwner'
    | 'backgroundTaskCommand'
    | 'hasBackgroundTaskOwner'
    | 'ownerLookupFailureNoted'
    | 'markOwnerLookupFailureNoted'
    | 'settledOnlyNoted'
    | 'markSettledOnlyNoted'
    | 'recordSubagentWakeup'
    | 'subagentWakeupTotal'
    | 'recordSubagentLimitReachedNote'
  >;
  /** `RunnerSession#sdkSession`（畳み・世代・載っている背景処理・完了の待ち）。参照。getter は呼ぶたびに読む。 */
  sdkSession: {
    readonly stopped: boolean;
    readonly generation: number;
    readonly liveBackgroundTasks: readonly { id: string; taskType: string }[];
    readonly backgroundWaiters: Pick<
      RunnerBackgroundWaiters,
      'wait' | 'isFinished' | 'outputFileOf'
    >;
  };
  /** `RunnerSession#cutOffWorkers`（打ち切った作業者の控え）。`recordCutOff` だけ。参照。 */
  cutOffWorkers: Pick<RunnerCutOffWorkers, 'recordCutOff'>;
  /** `RunnerSession#note`（担当の note を出す）。同期。 */
  note: (text: string) => void;
  /** `RunnerSession#emit`（`stall` 付きの note を降ろす）。同期。 */
  emit: (event: RunnerEvent) => void;
  /** `RunnerSession#id`（作った後に変わらない）。 */
  managerId: string;
  /** `RunnerSession#resumeGuidance`（再開の案内の文面。他の場所とも共有するので `RunnerSession` に残す）。同期。 */
  resumeGuidance: (agentId: string) => string;
}

/**
 * `RunnerSession#onSubagentStop`（作業者が畳むときの背景処理の完了待ちと起こし直し／打ち切り）を受け持つ側。切り出し前の `RunnerSession` から切り出した。振る舞いは変えていない。
 * 自前の欄は無い（通算・旗・所有者の表は `RunnerSession` が持つ `RunnerSubagentStopState` を参照で受ける）。
 * `observe` は `async` のまま・`await` 1 か所（`#waitForBackgroundTasks` の待ち）のまま保つ（フックの戻りまでの周回数を動かさないため）。
 */
export class RunnerSubagentStopObserver {
  readonly #workerTools: RunnerSubagentStopObserverPorts['workerTools'];
  readonly #tryObservation: RunnerSubagentStopObserverPorts['tryObservation'];
  readonly #stopState: RunnerSubagentStopObserverPorts['stopState'];
  readonly #sdkSession: RunnerSubagentStopObserverPorts['sdkSession'];
  readonly #cutOffWorkers: RunnerSubagentStopObserverPorts['cutOffWorkers'];
  readonly #note: RunnerSubagentStopObserverPorts['note'];
  readonly #emit: RunnerSubagentStopObserverPorts['emit'];
  readonly #id: RunnerSubagentStopObserverPorts['managerId'];
  readonly #resumeGuidance: RunnerSubagentStopObserverPorts['resumeGuidance'];

  constructor(ports: RunnerSubagentStopObserverPorts) {
    this.#workerTools = ports.workerTools;
    this.#tryObservation = ports.tryObservation;
    this.#stopState = ports.stopState;
    this.#sdkSession = ports.sdkSession;
    this.#cutOffWorkers = ports.cutOffWorkers;
    this.#note = ports.note;
    this.#emit = ports.emit;
    this.#id = ports.managerId;
    this.#resumeGuidance = ports.resumeGuidance;
  }

  /**
   * [sdk-verbatim SubagentStopHookSpecificOutput]
   * > Hook-specific output for the SubagentStop event. additionalContext is non-error feedback delivered to the subagent; the subagent continues so it can act on it.
   */
  // `decision: 'block'` を使わず `additionalContext` だけを返す: `block` は止める側の口で、地雷「ターン数上限・実行回数上限で暴走を止める」（能力の削除）に当たるため
  // `runner-protocol.ts` の欄を増やさず `note` に乗せる: runner が新しく名乗る値を足すと古い runner が居る窓が開くため
  // `background_tasks` が非空であることを空転の署名にしない: 畳もうとしている当人と兄弟の作業者も配列に入り、件数では「この作業者が待っている」が言えないため（所有者で絞る）
  // `mine` を「まだ走っているもの」と見ない（`status` で言い分ける）: 畳み終えた背景処理の完了を待たせる形で作業者を起こし直し、進まないまま上限に達して委譲が止まるため
  // 回数の上限で暴走を止めない: 回数で止める形は地雷に当たり、各回は背景処理が終わった後の1ターンで空転ではなく仕事のため（終わらない背景処理は30分で切れる）
  // 待ちの途中で畳まれたら起こし直さず返す: 畳まれつつある世代で作業者にモデルを1ターン回させても結果は誰にも届かない。打ち切りではないので `recordCutOff` は通さない
  // この `note` が出ないことを「空転が無かった」と読ませない: フックの発火は親のターンが開いていたかで割れ、拾えるのは一部のため
  // 例外が出ても起こし直さず `{ continue: true }` へ倒す。`#markProgressed()` を呼ばない: 挙動を変えるのは継続の合図だけのため
  async observe(record: AgentSubagentStopRecord): Promise<AgentContextOutcome> {
    if (typeof record.agentId === 'string') {
      const agentId = record.agentId;
      this.#tryObservation('作業者の道具の見張りの片付け', () => {
        this.#workerTools.settleAgent(agentId);
      });
    }
    try {
      if (record.readError !== undefined) throw record.readError;
      const tasks = record.backgroundTasks ?? [];
      const crons = record.sessionCrons ?? [];
      const agentId = record.agentId;
      const stopHookActive = record.stopHookActive;

      const mine = tasks.filter((task) => {
        const { id } = taskRow(task);
        if (id === undefined || agentId === undefined) return false;
        return this.#stopState.backgroundTaskOwner(id) === agentId;
      });

      if (mine.length === 0) {
        this.#noteOwnerLookupFailure(tasks);
        return { kind: 'continue' };
      }
      if (agentId === undefined) return { kind: 'continue' };

      // `'unknown'` は「走っている」側へ倒す: 倒す先を間違えると起こし直しが黙って効かなくなるため（分からなかったことは下の `note` に書く）
      const remaining: unknown[] = [];
      const settled: unknown[] = [];
      let unknownStatusCount = 0;
      for (const task of mine) {
        const kind = classifyBackgroundTaskStatus(taskRow(task).status);
        if (kind === 'settled') {
          settled.push(task);
          continue;
        }
        remaining.push(task);
        if (kind === 'unknown') unknownStatusCount += 1;
      }

      // 当人のものが全部終わっていたら起こし直さないが、黙らない: 1セッションに1回だけ日誌へ出す（`#noteSettledOnly`）
      if (remaining.length === 0) {
        this.#noteSettledOnly(settled);
        return { kind: 'continue' };
      }

      const stopHookActiveText =
        stopHookActive === undefined ? '' : ` stop_hook_active=${String(stopHookActive)}。`;
      const disclaimer =
        '⚠️ この行が出ないことは「空転が無かった」を意味しない — ' +
        'このフックは、作業者が畳んだ瞬間に親のターンが開いていたときにしか発火しない（#570）。';

      // 数に入れなかったものを黙って落とさない: 「残っている」の件数だけを出すと `status` で言い分けたこと自体が消えるため（AGENTS.md「静かに失敗する道具」）
      const settledText =
        settled.length === 0
          ? ''
          : `（当人が起こしたもののうち ${settled.length}件 は status が「終わった」側だったので数に入れていない）`;
      const unknownText =
        unknownStatusCount === 0
          ? ''
          : `⚠️ 上のうち ${unknownStatusCount}件 は status が既知の語彙のどちらでもない —— ` +
            '「走っている」へ倒して数えた（分からないものを「終わった」へ倒さない）。' +
            'この行が出たら計器のほうを疑う — SDK が status の語彙を変えた見込みが高い。';
      // `id` を防御的にもう一度 `typeof` で絞る: 前提が崩れても例外で落ちない側へ倒すため
      const remainingIds = remaining
        .map((task) => taskRow(task).id)
        .filter((id): id is string => id !== undefined);
      const waitOutcome = await this.#waitForBackgroundTasks(remainingIds);

      // 待ちの途中で畳まれたら起こし直さず返す: 結果が誰にも届かず、`recordCutOff` を通すと新しい世代で「打ち切った作業者」の注記を誤って出すため
      if (waitOutcome === 'released') {
        this.#note(
          truncateWithNote(
            `SubagentStop（作業者: ${record.agentType ?? '(不明)'} / agent_id=${agentId}）: ` +
              `**この作業者が自分で起こした背景処理が ${remaining.length}件 残ったまま畳もうとした** ` +
              '— 完了を待っている途中でセッションが畳まれた（stop / 畳み直し / 世代交代）ので、' +
              `起こし直さずに返した。${stopHookActiveText}`,
            SUBAGENT_STOP_NOTE_TEXT_LIMIT,
          ),
        );
        return { kind: 'continue' };
      }

      if (waitOutcome === 'settled') {
        const newTotal = this.#stopState.recordSubagentWakeup(agentId);
        const taskLines = this.#renderSubagentStopTaskLines(remaining);

        const noteLines = [
          `SubagentStop（作業者: ${record.agentType ?? '(不明)'} / agent_id=${agentId}）: ` +
            `**この作業者が自分で起こした背景処理が ${remaining.length}件 残ったまま畳もうとした**` +
            settledText +
            `（この瞬間のセッション全体の在庫=${tasks.length}件、session_crons=${crons.length}件）。` +
            `**完了を待ってから起こし直した**（この作業者の通算 ${newTotal}回目）。${stopHookActiveText}`,
          ...taskLines,
          ...(unknownText === '' ? [] : [unknownText]),
          disclaimer,
        ];
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text: truncateWithNote(noteLines.join('\n'), SUBAGENT_STOP_NOTE_TEXT_LIMIT),
          stall: {
            agentId,
            ...(record.agentType === undefined ? {} : { agentType: record.agentType }),
            ownedTaskCount: remaining.length,
            sessionTaskCount: tasks.length,
            wakeupCount: newTotal,
            outcome: 'woken',
          },
        });

        // 出力の置き場所が取れなければ「取れなかった」と書く: 作り物のパスを主張しないため
        const snapshotCommands = new Map<string, string>();
        for (const task of remaining) {
          const { id, command } = taskRow(task);
          if (id !== undefined && command !== undefined) snapshotCommands.set(id, command);
        }
        const finishedLines = remainingIds.map((id) => {
          const command = snapshotCommands.get(id) ?? this.#stopState.backgroundTaskCommand(id);
          const outputFile = this.#sdkSession.backgroundWaiters.outputFileOf(id);
          return (
            `- id=${id}${command === undefined ? '' : ` command=${command}`} ` +
            `出力: ${outputFile === null ? '取れなかった（完了通知の output_file が無い）' : outputFile}`
          );
        });
        const contextLines = [
          `あなたが自分で起こした背景処理が ${remaining.length}件、残ったまま畳もうとしたので、` +
            '**終わるまで待ってから**起こし直した。**背景処理は終わった。**' +
            settledText +
            `（この瞬間のセッション全体の在庫=${tasks.length}件、session_crons=${crons.length}件）。`,
          ...finishedLines,
          ...(unknownText === '' ? [] : [unknownText]),
          '**結果（出力）を読んでから畳むこと。** 出力の置き場所は上の行のとおり。' +
            'まだ続きの背景処理を起こすなら、畳む前にまた最大 ' +
            `${String(SUBAGENT_BACKGROUND_WAIT_MS / 60_000)} 分は完了を待つ（それを超えると打ち切られる）。`,
          `これはこの作業者の通算 ${newTotal}回目の起こし直し。`,
        ];
        return {
          kind: 'addContext',
          text: truncateWithNote(contextLines.join('\n'), SUBAGENT_STOP_NOTE_TEXT_LIMIT),
        };
      }

      // `escalate` を毎回立てない: 同じ agentId が `SubagentStop` を送るたびに同じ report がクローンの受信箱へ積まれ続けるため（間引くのは知らせであって実行の制限ではない）
      const total = this.#stopState.subagentWakeupTotal(agentId);
      const { count: limitNoteCount, shouldEscalate: shouldEscalateLimitNote } =
        this.#stopState.recordSubagentLimitReachedNote(agentId);

      const taskLines = this.#renderSubagentStopTaskLines(remaining);
      const limitReasonText =
        `**背景処理の完了を ${String(SUBAGENT_BACKGROUND_WAIT_MS / 60_000)} 分（待ちの上限）まで待ったが、` +
        `終わらなかったため、起こし直さずに打ち切った**（この作業者の通算 ${total}回 起こし直し済み）。`;
      const limitNoteCountText =
        `打ち切ってから ${limitNoteCount}回目（1・3・9…回目だけクローンへ上げる）。` +
        (shouldEscalateLimitNote ? '' : ' この回はクローンの受信箱へは上げない — 日誌には残る。');
      const noteLines = [
        `SubagentStop（作業者: ${record.agentType ?? '(不明)'} / agent_id=${agentId}）: ` +
          `**この作業者が自分で起こした背景処理が ${remaining.length}件 残ったまま畳もうとした**` +
          settledText +
          `（この瞬間のセッション全体の在庫=${tasks.length}件、session_crons=${crons.length}件）。` +
          limitReasonText +
          stopHookActiveText,
        limitNoteCountText,
        ...taskLines,
        ...(unknownText === '' ? [] : [unknownText]),
        disclaimer,
        // `taskLines` より後ろに置く: `truncateWithNote` は末尾から切るので、読み手がいちばん要る id / command を残すため
        '出力の置き場所は、処理が終わったら知らせる（#1554）。',
        this.#resumeGuidance(agentId),
      ];
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text: truncateWithNote(noteLines.join('\n'), SUBAGENT_STOP_NOTE_TEXT_LIMIT),
        ...(shouldEscalateLimitNote ? { escalate: true } : {}),
        stall: {
          agentId,
          ...(record.agentType === undefined ? {} : { agentType: record.agentType }),
          ownedTaskCount: remaining.length,
          sessionTaskCount: tasks.length,
          // 間引きの回数 `limitNoteCount` を運ばない: スキーマの doc の意味を変えないため
          wakeupCount: total,
          outcome: 'limit_reached',
        },
      });
      const cutOffTasks: CutOffBackgroundTaskSummary[] = remaining.flatMap((task) => {
        const { id, command } = taskRow(task);
        if (id === undefined) return [];
        return [{ id, ...(command === undefined ? {} : { command }) }];
      });
      this.#cutOffWorkers.recordCutOff(agentId, cutOffTasks);

      return { kind: 'continue' };
    } catch (error: unknown) {
      // フックが例外でセッションを止めない: 起こし直しよりも必ず `continue: true` を返すことを優先する
      try {
        this.#note(`SubagentStop の観測に失敗した: ${reasonOf(error)}`);
      } catch {
        // ここまで失敗したら、もう上げる手段が無い。黙って諦める
        // （挙動は変えない＝必ず continue: true を返すことのほうを優先する）。
      }
      return { kind: 'continue' };
    }
  }

  // 載ったことの無い id を「載っていない」だけで終わりとしない: id 空間が違えば常に真になり、待たずに毎回起こし直して空転が無限になるため
  // `stopped` / 世代を待つ前にも待った後にも見る: 解きより後に始まった待ちは誰も解かず、待った後に世代が替わっていれば古い世代の作業者を起こさないため
  async #waitForBackgroundTasks(
    ids: readonly string[],
  ): Promise<'settled' | 'timeout' | 'released'> {
    if (this.#sdkSession.stopped) return 'released';
    const generation = this.#sdkSession.generation;
    const waiters = this.#sdkSession.backgroundWaiters;
    const seenLive = new Set<string>();
    const outcome = await waiters.wait(() => {
      const live = new Set(this.#sdkSession.liveBackgroundTasks.map((task) => task.id));
      return ids.every((id) => {
        if (waiters.isFinished(id)) return true;
        if (live.has(id)) {
          seenLive.add(id);
          return false;
        }
        return seenLive.has(id);
      });
    }, SUBAGENT_BACKGROUND_WAIT_MS);
    if (
      outcome === 'settled' &&
      (this.#sdkSession.stopped || generation !== this.#sdkSession.generation)
    ) {
      return 'released';
    }
    return outcome;
  }

  #renderSubagentStopTaskLines(tasks: readonly unknown[]): string[] {
    return tasks.map((task) => {
      const t = taskRow(task);
      const id = t.id ?? '(不明)';
      const type = t.type ?? '(不明)';
      const status = t.status ?? '(不明)';
      const description = t.description ?? '(不明)';
      const command = t.command === undefined ? '' : ` command=${t.command}`;
      // `id` と `command` を `description` より前に置く: `truncateWithNote` は末尾から切るので、`description` が先に切られる側にするため
      return `- id=${id}${command} type=${type} status=${status} description=${description}`;
    });
  }

  /**
   * [sdk-verbatim SubagentStopHookInput.background_tasks]
   * > In-flight background work (running/pending + backgrounded) registered in this session. Lets hooks distinguish "session is done" from "session is paused waiting for background work to wake it". Empty array when nothing is in flight.
   */
  // 起こし直さない側でも黙らない: 黙ると「作業者はきれいに畳んだ」と日誌の上で同じ顔になるため
  // `stall` を載せない: `note.stall.outcome` の2語のどちらでもなく、欄を増やすとデプロイの窓で古い側が黙って落とすため
  #noteSettledOnly(settled: readonly unknown[]): void {
    if (this.#stopState.settledOnlyNoted) return;
    this.#stopState.markSettledOnlyNoted();

    const listed = settled
      .map((task) => {
        const { type = '(不明)', status = '(不明)' } = taskRow(task);
        return `type=${type} status=${status}`;
      })
      .join(' / ');

    this.#note(
      truncateWithNote(
        `SubagentStop: 当人が起こした背景処理が ${settled.length}件 配列に載っていたが、` +
          `**status は全部「終わった」側だった**（${listed}）。起こし直していない。` +
          'SDK は `background_tasks` を「in-flight」と名乗っているので、この行が出たら' +
          '計器のほうを疑う — 畳み終えた分が配列に残っているか、status の語彙が変わった' +
          'かである。⟹ この Issue（#570）へ、この行と SDK の版を添えて報告してほしい。' +
          '（雑音にしないため、この診断はセッションに1回だけ出す。）',
        SUBAGENT_STOP_NOTE_TEXT_LIMIT,
      ),
    );
  }

  // 壊れても無音にしない: 表が引けなくなった状態と「作業者はきれいに畳んだ」が日誌の上で同じ顔になるため
  // `type !== 'subagent'` にしない: Monitor / Workflow / 遠隔の Task も表に載らず、設計どおりでも診断が出るため
  #noteOwnerLookupFailure(tasks: readonly unknown[]): void {
    if (this.#stopState.ownerLookupFailureNoted) return;

    const orphans = tasks.filter((task) => {
      const { id, type } = taskRow(task);
      if (!isOwnerRecordableTaskType(type)) return false;
      return id === undefined || !this.#stopState.hasBackgroundTaskOwner(id);
    });
    if (orphans.length === 0) return;

    this.#stopState.markOwnerLookupFailureNoted();
    const listed = orphans
      .map((task) => {
        const { id = '(不明)', type = '(不明)' } = taskRow(task);
        return `id=${id} type=${type}`;
      })
      .join(' / ');

    this.#note(
      `SubagentStop: 背景処理の**所有者を引けなかった**（${orphans.length}件。${listed}）。` +
        'この行が出たら計器のほうを疑う — ' +
        '`PostToolUse` の `tool_response.backgroundTaskId` が改名・消滅したか、' +
        `表が上限（${BACKGROUND_TASK_OWNER_LIMIT}件）で古い側を捨てたかである。` +
        '⟹ この Issue（#570）へ、この行と SDK の版を添えて報告してほしい。' +
        'そのあいだ「自分の背景処理を残して畳んだ作業者」の記録は出なくなる（無音になる）。' +
        '（雑音にしないため、この診断はセッションに1回だけ出す。）',
    );
  }
}
