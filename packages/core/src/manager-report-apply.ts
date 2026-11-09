import type { ManagerRecord } from './manager.js';
import { reportFullTextOf } from './manager-notices.js';
import type { RunnerEvent } from './runner-protocol.js';
import { isQuotaFailure } from './sdk-failure.js';
import type { NoticeResetMatch } from './token-reset-match.js';

/**
 * `Pool` が口として渡すもの。
 * `usageStopped`・`resetTimeSkewMatches` は `Pool` が持つ Set／Map の参照そのもの（`UsageWake`・`UsageReceiver` と共有する。コピーしない）。
 * 時計は呼ぶたびに `Pool` の側で引く（器の時計を直に読まない）。いずれも async の皮で包まずに渡す（同期のまま保つため）。
 */
interface ManagerReportApplyPorts {
  /** `Pool#nowIso` を束ねたもの。 */
  nowIso: () => string;
  /** 枠で止まった担当の印（`Pool#usageStopped`）の参照。 */
  usageStopped: Set<string>;
  /** 429 の文言の resets 時刻の突き合わせの結果（`Pool#resetTimeSkewMatches`）の参照。 */
  resetTimeSkewMatches: Map<string, NoticeResetMatch>;
}

/**
 * `report` の段 2（報告の中身を台帳 `record.job` へ写す）を受け持つ側（`Pool#handleReport` が `await this.#persist(record)` の手前で呼ぶ。
 * `Pool` の `#applyReportToJob` から切り出した。振る舞いは変えていない）。
 * 自前の欄は持たない: 書くのは引数の `record.job` と、口で受けた枠の印の Set・突き合わせの Map だけ。日誌は書かない。
 * 同期のまま保つ: `await` を挟まず、呼び元も `await` で包まない（並行の出来事に先を越されるため）。
 */
export class ManagerReportApply {
  readonly #nowIso: ManagerReportApplyPorts['nowIso'];
  readonly #usageStopped: ManagerReportApplyPorts['usageStopped'];
  readonly #resetTimeSkewMatches: ManagerReportApplyPorts['resetTimeSkewMatches'];

  constructor(ports: ManagerReportApplyPorts) {
    this.#nowIso = ports.nowIso;
    this.#usageStopped = ports.usageStopped;
    this.#resetTimeSkewMatches = ports.resetTimeSkewMatches;
  }

  // `report` の段2: 報告の中身を台帳（`record.job`）へ写す。同期のまま保つ（`await` を挟むと並行の出来事に先を越される）。枠の印を新しく立てたら `true`。
  applyReportToJob(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'report' }>,
  ): boolean {
    // 台帳と日誌には全文を残す: `manager_report` と画面の「最後の報告」は `lastReport` を読むので、途中の発言を見たいときはそこから引ける
    record.job.lastReport = reportFullTextOf(event);
    // `#noteRunnerSessionSince` と同じ時計（`this.#now()`）で書く: `reportSeenInSession` が前後を比べるので、別の時計だと注入した時計の試験で崩れる。
    record.job.lastReportAt = this.#nowIso();
    // 並行処理の間に `closed(failed / lost)` が書いた終端を `event.status` で書き戻さない: 台帳は非終端のままクローンに `closed_failed` が出る／`lost` の引き取りの契機が消える。
    // `isTerminalJobStatus` は使わない: `done` を含むが、`done` は idle を兼ね再び走り出せる。managerId ごとの直列化は配達順に効くので採らない。
    const settledByClosed = record.job.status === 'failed' || record.job.status === 'lost';
    // 畳む直前の書き出し（`unreported`）は、台帳を `failed` / `lost` にしない（#4963）: 状態は直後に必ず届く `closed` が決める。
    // ここで終端にすると、続く `closed(failed)` が「確定済みへの重複」として捨てられ、`closed` にしか無い処理（失敗の行と cgroup の注記・`lastSystemError` / `lastCgroupEvents`・器の失敗の計上・pids の飽和の印・`closed_failed` の知らせ）が全部飛ぶ。
    const deferTerminalToClosed =
      event.unreported !== undefined && (event.status === 'failed' || event.status === 'lost');
    if (!settledByClosed && !deferTerminalToClosed) record.job.status = event.status;
    // 背景処理の完了待ちで閉じた `done` は、台帳の `status` では idle と見分けられないので、印を別の欄に立てる（`ManagerTaskLink#sync` が task を倒さない根拠）。
    // 背景待ちでない報告では下ろす。`done` 以外の状態へ動く書き込みは `#persist` が下ろす。
    if (event.awaitingBackground !== undefined && record.job.status === 'done') {
      record.job.awaitingBackgroundSince = this.#nowIso();
    } else {
      delete record.job.awaitingBackgroundSince;
    }
    // `waiting` が空なら `waiting_human` を名乗らせない: `stop()` は `#settleAll` の前に控えた状態で報告を畳むので「解かれる前」の値が届き、器の入れ替え（`abort()` の上書きが無い経路）では食い違いが台帳に残る。
    // `event.status` そのものは書き換えない: 報告が名乗った値は `lastReportStatus` に残し、「何を名乗ったか」と「いまの状態をどう数えるか」を1つに畳まない。
    if (!settledByClosed && event.status === 'waiting_human' && record.waiting.length === 0) {
      record.job.status = 'running';
    }
    // `record.job.status` とは意図して別の値になりうる（上の補正）: `lastReportStatus` は「報告が何を名乗ったか」を残す欄で、既定値は作らない。
    record.job.lastReportStatus = event.status;
    // 応答として終わった回では畳んだ本文を消す: 残すと次に `manager_report` を読む側が「畳まれた途中経過」と誤読する。
    delete record.job.lastFoldedTurn;
    // `event.failure` の有無で条件を付けない: `report` が届いたこと自体が「セッションは生きて出力している」を確定させ、`lastSystemError` / `lastCgroupEvents` は過去になる。
    delete record.job.lastSystemError;
    delete record.job.lastCgroupEvents;
    // この報告で枠の印を新しく立てたか（下の失敗の枝）。立てた回だけ、使える鍵が在れば今すぐ回すよう回し手へ頼む。
    let markedByFailure = false;
    // 失敗として終わった回は台帳にもそう残す: 包んだ文字列だけに頼ると、一覧を出す側は「報告が来た」と「エラーで死んだ」を本文の先頭を読んで判定することになる（＝ 表示のたびに文言の判定が要る）。
    // 応答として終わった回では消す: 過去の失敗が生きているマネージャーに貼り付く。`delete` なのは `exactOptionalPropertyTypes` のため。
    if (event.failure === undefined) {
      delete record.job.lastFailure;
      // 枠で止まった印は成功した回で下ろす（失敗の回では下ろさない: そこが起こし直したい相手）。印は `reached` の通知でターンの途中にも立つので、残すと通り切ったマネージャーが「枠で止まっている」ことになり、鍵が回るたびに1ターン焼く。
      this.#usageStopped.delete(event.managerId);
      this.#resetTimeSkewMatches.delete(event.managerId);
      // `UsageWake#clearUsageStoppedMark` を呼ばず直接 `delete`: すぐ下の `#persist` に乗せるので、呼ぶと二重に書き込む。
      delete record.job.usageStoppedAt;
    } else {
      // `status` は台帳へ写さない: 枠の束の判定にだけ使う値で、`lastFailure` の欄（code / via）を増やさない。
      record.job.lastFailure = {
        code: event.failure.code,
        via: event.failure.via,
        at: this.#nowIso(),
      };
      // 429・枠の失敗は、枠の通知（`usage_notice`）が先に届かなくても印を立てる（#4850）: 通知は本文の文言でしか出ないので、構造化された失敗（`status=429` など）だけで落ちたターンは印が無く、鍵が回っても起こし直しの対象に入らなかった。クラッシュなど枠と無関係な失敗は `isQuotaFailure` が偽なので立てない。
      // 同期の位置で立てる（`usage_notice` と同じ理由）: 間に `await` を挟むと並行の出来事に先を越される。永続化は下の `#persist` に乗せる。
      if (isQuotaFailure(event.failure) && !this.#usageStopped.has(event.managerId)) {
        this.#usageStopped.add(event.managerId);
        record.job.usageStoppedAt ??= this.#nowIso();
        markedByFailure = true;
      }
    }
    // `event.failure` の有無とは独立に判定する: 両方無いことも片方だけ在ることもある。
    if (event.unreported === undefined) {
      delete record.job.lastUnreported;
    } else {
      record.job.lastUnreported = {
        ...event.unreported,
        at: this.#nowIso(),
      };
    }
    return markedByFailure;
  }
}
