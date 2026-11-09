import type { AgentStopRecord } from './agent-hooks.js';
import { reasonOf } from './dropped-record.js';
import {
  classifyBackgroundTaskStatus,
  isOwnerRecordableTaskType,
  taskRow,
  truncateWithNote,
} from './runner-background-task-rows.js';
import {
  BACKGROUND_TASK_OWNER_LIMIT,
  type RunnerSubagentStopState,
} from './runner-subagent-stop-state.js';

// `SUBAGENT_STOP_NOTE_TEXT_LIMIT`（`runner.ts`）と共有しない: 片方を動かしたときに黙って一緒に動かないため。超えた分を黙って落とさない
const STOP_NOTE_TEXT_LIMIT = 1_500;

/**
 * `RunnerSession` が口として渡すもの。2 本。
 * `stopState` は参照のまま渡す（`RunnerSession#stopState`。`#onSubagentStop` 側と同じ器を共有し、通算・診断済みの旗・所有者の表を一箇所で持つため。写すと数え直しになる）。
 * `note` は `RunnerSession#note`（担当の note を出す。同期）。async の皮で包まずに渡す（`observe` の握りは、同期で投げた `note` を `catch` で受ける前提のため）。
 */
interface RunnerStopObserverPorts {
  stopState: Pick<
    RunnerSubagentStopState,
    | 'incrementStopFirings'
    | 'backgroundTaskOwner'
    | 'stopFirings'
    | 'stopIdleNoted'
    | 'markStopIdleNoted'
  >;
  note: (text: string) => void;
}

/**
 * `RunnerSession#onStop`（Stop フックの観測）を受け持つ側。切り出し前の `RunnerSession` から切り出した。振る舞いは変えていない。
 * 自前の欄は無い（通算・診断済みの旗・所有者の表は `RunnerSession` が持つ `RunnerSubagentStopState` を参照で受ける）。
 * `observe` は `async` のまま・`await` 0 のまま保つ（フックの戻りまでの周回数を動かさないため）。観測だけで、`{ continue: true }` は呼び元が返す。
 */
export class RunnerStopObserver {
  readonly #stopState: RunnerStopObserverPorts['stopState'];
  readonly #note: RunnerStopObserverPorts['note'];

  constructor(ports: RunnerStopObserverPorts) {
    this.#stopState = ports.stopState;
    this.#note = ports.note;
  }

  /**
   * [sdk-verbatim StopHookInput.background_tasks]
   * > In-flight background work (running/pending + backgrounded) registered in this session. Lets hooks distinguish "session is done" from "session is paused waiting for background work to wake it". Empty array when nothing is in flight.
   */
  // 何も判断せず何も抑制しない（`{ continue: true }` だけを返す）: まず実データを見てから機構を足すかを決めるため
  // 所有者を `owned_by_subagent` に依存して引かない: 0.3.259 以降の型定義に存在しないため（既存の `#backgroundTaskOwners` だけから引く）
  // `background_tasks_changed.tasks[].task_id` の等式に乗らない: 同じ id 空間かを誰もライブで確かめていないため
  // 在り高が非0の回は畳まず毎回出す: 同じ在り高で何度も閉じていること自体が探している署名のため
  // `#markProgressed()` を呼ばない: 既存の挙動を変えないため
  async observe(record: AgentStopRecord): Promise<void> {
    try {
      // 数えるのは何より先: 下のどの枝を通っても（間引かれても）通算が進むため
      const stopFirings = this.#stopState.incrementStopFirings();

      if (record.readError !== undefined) throw record.readError;
      const tasks = record.backgroundTasks ?? [];
      const crons = record.sessionCrons ?? [];
      const stopHookActive = record.stopHookActive;

      if (tasks.length === 0 && crons.length === 0) {
        this.#noteStopIdle();
        return;
      }

      // 0 の行も残す: 数えた結果の 0 で、消すと合計との突き合わせができなくなるため
      const owners = { manager: 0, worker: 0, delegation: 0, unrecordable: 0, unresolved: 0 };
      const statuses = { live: 0, settled: 0, unknown: 0 };
      for (const task of tasks) {
        owners[this.#stopTaskOwnerKind(task)] += 1;
        statuses[classifyBackgroundTaskStatus(taskRow(task).status)] += 1;
      }

      const stopHookActiveText =
        stopHookActive === undefined ? '' : ` stop_hook_active=${String(stopHookActive)}。`;

      const noteLines = [
        `Stop（マネージャーのターンが閉じる瞬間。このセッションで通算 ${stopFirings}回目）: ` +
          `**背景処理 ${tasks.length}件 / session_crons ${crons.length}件 を残したまま閉じようとしている。**` +
          stopHookActiveText,
        `所有者の内訳（表 #backgroundTaskOwners から引いた）: マネージャー自身 ${owners.manager}件 / ` +
          `作業者 ${owners.worker}件 / 委譲そのもの ${owners.delegation}件 / ` +
          `控えられない種類 ${owners.unrecordable}件 / 引けなかった ${owners.unresolved}件。`,
        `status の内訳: 走っている ${statuses.live}件 / 終わった ${statuses.settled}件 / ` +
          `分からない ${statuses.unknown}件。`,
        ...tasks.map((task) => this.#renderStopTaskLine(task)),
        ...(owners.unresolved === 0
          ? []
          : [
              `⚠️ 上のうち ${owners.unresolved}件 は**所有者を引けなかった**（\`type\` が` +
                '**所有者を控えられる種類**なのに、表に無い）。この行が出たら計器の' +
                'ほうを疑う —— `PostToolUse` の `tool_response.backgroundTaskId` が改名・消滅したか、' +
                `表が上限（${BACKGROUND_TASK_OWNER_LIMIT}件）で古い側を捨てたかである。` +
                '（`monitor` / `workflow` / 遠隔の `Task` は元から控えられないので、この数には入らない' +
                '—— それらは「控えられない種類」に数えてある。）',
            ]),
        ...(statuses.unknown === 0
          ? []
          : [
              `⚠️ 上のうち ${statuses.unknown}件 は status が既知の語彙のどちらでもない。` +
                'この行が出たら計器のほうを疑う —— SDK が status の語彙を変えた見込みが高い。',
            ]),
        '⚠️ **これは観測だけである（#861 の段1）。** この行は何も止めておらず、何も起こし直していない。',
        '⚠️ この行が出ないことは「空転が無かった」を意味しない —— `Stop` は**マネージャーが起きて' +
          'いるときにしか来ない**。器が落ちた・入れ替わった・二度と起こされなかった回は、' +
          'この観測にも現れない（#861）。',
      ];

      // `stall` を載せない: `note.stall.outcome` の2語のどちらでもなく、欄を増やすとデプロイの窓で古い側が黙って落とすため
      // `escalate` も立てない: 観測だけなので、クローンの受信箱へ割り込む理由がまだ無いため
      this.#note(truncateWithNote(noteLines.join('\n'), STOP_NOTE_TEXT_LIMIT));
    } catch (error: unknown) {
      try {
        this.#note(`Stop の観測に失敗した: ${reasonOf(error)}`);
      } catch {
        // ここまで失敗したら、もう上げる手段が無い。黙って諦める
        // （挙動は変えない＝必ず continue: true を返すことのほうを優先する）。
      }
    }
  }

  // `unresolved` を他へ混ぜない: 混ぜると経路が壊れて表が空になった状態が「全部が委譲そのものだった」に化けるため
  // `delegation` と `unrecordable` を1つにしない: `subagent` は実測で取れている区別で、名前を1つにして消さないため
  #stopTaskOwnerKind(
    task: unknown,
  ): 'manager' | 'worker' | 'delegation' | 'unrecordable' | 'unresolved' {
    const { id, type } = taskRow(task);
    const owner = id === undefined ? undefined : this.#stopState.backgroundTaskOwner(id);
    if (owner !== undefined) return owner === '' ? 'manager' : 'worker';
    if (type === 'subagent') return 'delegation';
    return isOwnerRecordableTaskType(type) ? 'unresolved' : 'unrecordable';
  }

  // `#renderSubagentStopTaskLines` を使い回さない: 起こし直しの回数を付けると `0回目` が並び、「起こし直しの枠がまだ在る」と読まれるため
  #renderStopTaskLine(task: unknown): string {
    const t = taskRow(task);
    const id = t.id ?? '(不明)';
    const type = t.type ?? '(不明)';
    const status = t.status ?? '(不明)';
    const description = t.description ?? '(不明)';
    const command = t.command === undefined ? '' : ` command=${t.command}`;
    const kind = this.#stopTaskOwnerKind(task);
    const owner =
      kind === 'worker' && t.id !== undefined
        ? `worker:${this.#stopState.backgroundTaskOwner(t.id) ?? ''}`
        : kind;
    return `- id=${id} owner=${owner} type=${type} status=${status} description=${description}${command}`;
  }

  // 毎回出さず1セッションに1回へ間引く: `Stop` はマネージャーのターンが閉じるたびに来るので、毎回出すと日誌がターン数ぶんの同じ行で埋まるため
  // 黙らない: 黙ると「`Stop` が一度も発火しなかった」と「発火したが毎回きれいに閉じた」が日誌の上で同じ顔になるため
  #noteStopIdle(): void {
    if (this.#stopState.stopIdleNoted) return;
    this.#stopState.markStopIdleNoted();

    this.#note(
      truncateWithNote(
        'Stop: マネージャーのターンが閉じたが、**背景処理も session_crons も 0件 だった**' +
          `（このセッションで通算 ${this.#stopState.stopFirings}回目の発火）。` +
          '⟹ SDK の言う「session is done」の側である。' +
          '**この行が出たこと自体が「`Stop` はこの器で発火する」の実測である**（#861 の段1）。' +
          '（雑音にしないため、この「0件で閉じた」診断はセッションに1回だけ出す —— `Stop` は' +
          'ターンが閉じるたびに来るので、毎回出せば日誌がターン数ぶんの同じ行で埋まる。' +
          '⟹ **2回目以降の「0件で閉じた」回は個別には残らない。** 続きは #861。）',
        STOP_NOTE_TEXT_LIMIT,
      ),
    );
  }
}
