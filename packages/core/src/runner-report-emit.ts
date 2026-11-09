import type { AgentTurnEnded } from './agent-events.js';
import { resultTextOf } from './runner-failure-classify.js';
import type { RunnerEvent, RunnerOutboxFile, RunnerOutboxRejectedFile } from './runner-protocol.js';
import type { RunnerSdkSession } from './runner-sdk-session.js';
import { FAILED_REPORT_PARTIAL_MARKER, type SdkFailure } from './sdk-failure.js';

/**
 * **鍵の器（`CredentialStore`）が無い器で、マネージャーが `Not logged in` で落ちたときの案内。**
 * 器が無いのは、デーモンの同一プロセスの runner（`createLocalRunner` に `credentials` を渡さない構成）。
 * そこではトークンプールの鍵を降ろす先が無く（`setCredentials` が断る）、マネージャーの子には器の鍵が届かない。
 * 別プロセスの runner（`apps/runner`）は必ず器を作るので、この案内は出ない（本番の runner の挙動は変えない）。
 */
const NO_CREDENTIAL_DIR_HINT =
  '鍵の置き場（ALTEROID_CREDENTIAL_DIR）が無いと、ローカル runner のマネージャーへ鍵が届かない。' +
  'この runner には鍵の置き場が無い（同一プロセスの runner は置き場を持たない）。' +
  '`ALTEROID_CREDENTIAL_DIR` 付きの runner（apps/runner）を別に起こし、デーモンの `ALTEROID_RUNNER_URL` で繋ぐこと。';

/**
 * `RunnerSession` が口として渡すもの。10 本。
 * 値で渡すのは作った後に変わらない欄（`managerId`。`RunnerSession` では `readonly`）だけ。
 * `sdkSession`・`pending`・`outwardActions` は参照のまま渡す（写すと、`RunnerSession` の他の経路が変えた状態をここが見られず、
 * ここが `splice(0)` した配列や `setStatus` した状態を他の経路が見られなくなる。`sdkSession` は getter を持つので、値へ写さない）。
 * 関数の口は async の皮で包まずに渡す（`#collectOutbox` は元から `Promise` を返すのでそのまま渡す。
 * 他は同期で、`await` を足すと `report` が見える周回数と、`report` を出した後に呼ぶ 2 つの順序が動くため）。
 */
interface RunnerReportEmitterPorts {
  /** `RunnerSession#liveBackgroundTasks`（SDK の背景処理と背景の peer を合わせた一覧）。同期。 */
  liveBackgroundTasks: () => readonly { id: string; taskType: string }[];
  /** `RunnerSession#outboxHasEntries`（出し箱が空でないか）。同期。 */
  outboxHasEntries: () => boolean;
  /** `RunnerSession#collectOutbox`（出し箱の取り込み）。`Promise` をそのまま返す。 */
  collectOutbox: () => Promise<{
    files?: RunnerOutboxFile[];
    rejectedFiles?: RunnerOutboxRejectedFile[];
  }>;
  /** `RunnerSession#sdkSession`（使うのは `setStatus`・`status`・`wantsTokenRecycle`・`wakeInput` だけ）。参照。 */
  sdkSession: Pick<RunnerSdkSession, 'setStatus' | 'status' | 'wantsTokenRecycle' | 'wakeInput'>;
  /** `RunnerSession#pending`（確認待ちの要求。中身だけが変わる参照で、差し替わらない。ここは読むだけ）。参照。 */
  pending: readonly unknown[];
  /** `RunnerSession#outwardActions`（外へ出した行いの控え。ここが `splice(0)` で空へ戻す）。参照。 */
  outwardActions: string[];
  /** `RunnerSession#emit`（`report` を降ろす）。同期。 */
  emit: (event: RunnerEvent) => void;
  /** `RunnerSession#id`（作った後に変わらない）。 */
  managerId: string;
  /** `RunnerSession#wakeForFinishedBackgroundTaskOutputs`（溜まった完了を起こす）。同期。 */
  wakeForFinishedBackgroundTaskOutputs: () => void;
  /** `RunnerSession#deliverPeerNotices`（確認待ちの間に溜めた peer の知らせを届ける）。同期。 */
  deliverPeerNotices: () => void;
}

/** `RunnerSession#applyTurnEnded` の前半が算出した、報告の組み立てに要る値。評価順は前半の側で決まっており、ここでは並べ替えない。 */
interface RunnerReportEmitArgs {
  said: readonly string[];
  failure: SdkFailure | undefined;
  noCredentialDirHint: boolean;
  openedWorkersThisTurn: number;
  workerRejectionsThisTurn: readonly string[];
  failedWorkerNotificationsThisTurn: number;
  failedWorkerNotificationsNamingLimitThisTurn: number;
}

/**
 * `RunnerSession#applyTurnEnded` の「後半」（報告の本文の組み立て・出し箱の取り込み・`setStatus`・`report` の送出・後始末の呼び出し）を受け持つ側。
 * 切り出し前の `RunnerSession` から切り出した。振る舞いは変えていない。自前の欄は無い。
 * `emit` は `async` のまま保つ。`await` は出し箱が空でないときの `#collectOutbox` の 1 か所だけ（空なら `await` を挟まず、最後まで同期で走る）。
 */
export class RunnerReportEmitter {
  readonly #liveBackgroundTasks: RunnerReportEmitterPorts['liveBackgroundTasks'];
  readonly #outboxHasEntries: RunnerReportEmitterPorts['outboxHasEntries'];
  readonly #collectOutbox: RunnerReportEmitterPorts['collectOutbox'];
  readonly #sdkSession: RunnerReportEmitterPorts['sdkSession'];
  readonly #pending: RunnerReportEmitterPorts['pending'];
  readonly #outwardActions: RunnerReportEmitterPorts['outwardActions'];
  readonly #emit: RunnerReportEmitterPorts['emit'];
  readonly #id: RunnerReportEmitterPorts['managerId'];
  readonly #wakeForFinishedBackgroundTaskOutputs: RunnerReportEmitterPorts['wakeForFinishedBackgroundTaskOutputs'];
  readonly #deliverPeerNotices: RunnerReportEmitterPorts['deliverPeerNotices'];

  constructor(ports: RunnerReportEmitterPorts) {
    this.#liveBackgroundTasks = ports.liveBackgroundTasks;
    this.#outboxHasEntries = ports.outboxHasEntries;
    this.#collectOutbox = ports.collectOutbox;
    this.#sdkSession = ports.sdkSession;
    this.#pending = ports.pending;
    this.#outwardActions = ports.outwardActions;
    this.#emit = ports.emit;
    this.#id = ports.managerId;
    this.#wakeForFinishedBackgroundTaskOutputs = ports.wakeForFinishedBackgroundTaskOutputs;
    this.#deliverPeerNotices = ports.deliverPeerNotices;
  }

  async emit(
    event: AgentTurnEnded,
    {
      said,
      failure,
      noCredentialDirHint,
      openedWorkersThisTurn,
      workerRejectionsThisTurn,
      failedWorkerNotificationsThisTurn,
      failedWorkerNotificationsNamingLimitThisTurn,
    }: RunnerReportEmitArgs,
  ): Promise<void> {
    // 失敗した回の報告に失敗であることを載せる: 上限の英語文言が「マネージャーの報告」として流れ、「報告が来た」と「エラーで死んだ」が区別できなくなるため
    // 本文（`text`）の側でも包む: 構造化した `failure` を見ていない読み手にはエラー文が報告として見えるため
    // 失敗で終わった回は `contentless` に含めない: 上限に当たった事実をクローンが知る必要があるため
    const outcome =
      failure === undefined
        ? reportText(said, resultTextOf(event))
        : {
            text:
              failedReportText(
                said,
                failure,
                resultTextOf(event).text,
                openedWorkersThisTurn,
                workerRejectionsThisTurn,
                failedWorkerNotificationsThisTurn,
                failedWorkerNotificationsNamingLimitThisTurn,
              ) + (noCredentialDirHint ? `\n\n${NO_CREDENTIAL_DIR_HINT}` : ''),
            contentless: false,
          };
    // 取り込みは `setStatus` より前に済ませる: 後ろへ置くと `await` が `report.status` / `awaitingBackground` の算出との間に挟まり、その間に変わった状態で嘘の報告になる
    // 背景処理の完了待ちで畳む報告でも取り込む: デーモンはファイルの付いた報告を背景待ちでも畳まずに配る。残すと、背景処理が絶えない担当では成果物が出し箱に置き去りになる
    // 取り込みの `await` より前に1回だけ読む: 背景の peer はこの間にも止まりうるので、取り込みの前後で別の一覧を見ないため
    const liveBackground = this.#liveBackgroundTasks();
    // 出し箱が空なら `await` を挟まない: 余計な yield が報告の出る順序（と、それを前提にした観測）を変えるため
    const outbox = this.#outboxHasEntries() ? await this.#collectOutbox() : {};
    this.#sdkSession.setStatus(this.#pending.length > 0 ? 'waiting_human' : 'done');
    if (this.#sdkSession.wantsTokenRecycle) this.#sdkSession.wakeInput();
    // 3条件（失敗でない・`done`・背景処理が在る）が揃うときだけ載せる、欠けたら配る側へ倒す: 上限・拒否や確認待ちを黙って畳むと人間の判断が止まるため
    const awaitingBackground =
      failure === undefined && this.#sdkSession.status === 'done' && liveBackground.length > 0
        ? {
            count: liveBackground.length,
            breakdown: summarizeBackgroundTasks(liveBackground),
          }
        : undefined;
    const outwardActions = this.#outwardActions.splice(0);
    this.#emit({
      type: 'report',
      managerId: this.#id,
      reportId: event.id,
      text: outcome.text,
      ...('fullText' in outcome && outcome.fullText !== undefined
        ? { fullText: outcome.fullText }
        : {}),
      status: this.#sdkSession.status,
      ...(failure === undefined
        ? {}
        : {
            failure: {
              code: failure.code,
              via: failure.via,
              ...(failure.status === undefined ? {} : { status: failure.status }),
            },
          }),
      ...(outcome.contentless ? { contentless: true } : {}),
      ...(awaitingBackground === undefined ? {} : { awaitingBackground }),
      ...(outwardActions.length === 0 ? {} : { outwardActions }),
      ...(failure === undefined ? {} : { synthesized: 'turn_failed' }),
      ...outbox,
    });
    // `report` を出した後に呼ぶ: `push()` が状態を `running` へ戻すので、先に呼ぶと `report.status` / `awaitingBackground` が嘘になるため
    this.#wakeForFinishedBackgroundTaskOutputs();
    // 確認待ちの間に溜めた peer の知らせも、同じ理由でここで届ける
    this.#deliverPeerNotices();
    return;
  }
}

function summarizeBackgroundTasks(tasks: readonly { id: string; taskType: string }[]): string {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    counts.set(task.taskType, (counts.get(task.taskType) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([taskType, count]) => `${taskType}×${String(count)}`)
    .join(', ');
}

// `result` が含まれていなくても落とさずに足す: 本文には出ないまま結果だけが来ることがあり、黙って捨てると終わり方が分からなくなるため
// `（報告なし）` という文字列に一致させない: `contentless` は構造化された印で、文言の判定ではないため
// 結論は「最後の発言」で切る: SDK の `result` は最後の assistant の本文で、Codex の `turn_ended.body` も最後の agentMessage なので、両 provider で同じ線になるため
// 全文（`fullText`）は捨てずに運ぶ: 途中の発言を見たいときに `manager_report` と画面から引けることがオーナーの条件のため
export function reportText(
  said: readonly string[],
  result: { text: string; empty: boolean },
): { text: string; fullText?: string; contentless: boolean } {
  const body = said.join('\n\n').trim();
  if (body.length === 0) return { text: result.text, contentless: result.empty };
  const full = body.includes(result.text.trim()) ? body : `${body}\n\n${result.text}`;
  const last = (said.at(-1) ?? '').trim();
  const conclusion = last.includes(result.text.trim()) ? last : `${last}\n\n${result.text}`.trim();
  if (conclusion === full) return { text: full, contentless: false };
  return { text: conclusion, fullText: full, contentless: false };
}

// 先頭で「応答ではない」と言い切る: 支出上限の英語文言が「マネージャーの報告」として台帳・日誌・受信箱へ入るため
// SDK の文言を言い換えない（人間が検索できる形で残す）。途中まで出ていた本文も捨てない: 次に何を頼み直すかの材料のため
// `openedWorkers` が0のときは1文字も足さない: 委譲と無関係な失敗まで作業者絡みに見えるため（AGENTS.md「取れない軸に0の行を作らない」）
// 3つの証拠を足し合わせて全部載せない: 本文が太るだけでいちばん確かな証拠が埋もれるため（`workerRejections` → `failedWorkerNotifications` → `openedWorkers` の順に差し替える）
// 「本体は当たっていない」とは言わない: 作業者自身の発言に拒否の印が付いていても、本体の状態は分からないため
function failedReportText(
  said: readonly string[],
  failure: SdkFailure,
  result: string,
  openedWorkers: number,
  workerRejections: readonly string[] = [],
  failedWorkerNotifications = 0,
  failedWorkerNotificationsNamingLimit = 0,
): string {
  const body = failure.text.length > 0 ? failure.text : result;
  // `via === 'assistant_error'` のときだけ「本体も当たっている」と言い切る: この via は本体自身の assistant メッセージに拒否の印が付いた回にしか立たないため
  const bodyHit = failure.via === 'assistant_error';
  const workerNote =
    workerRejections.length > 0
      ? bodyHit
        ? `\n（このターンでは作業者の発言に SDK の拒否の印が付いていた: ${describeRejectionCodes(workerRejections)}。作業者が当たったことは確かで、本体の発言にも拒否の印が付いていたので、本体も当たっている）`
        : `\n（このターンでは作業者の発言に SDK の拒否の印が付いていた: ${describeRejectionCodes(workerRejections)}。作業者が当たったことは確かだが、本体も当たったかは SDK からは分からない）`
      : failedWorkerNotifications > 0
        ? `\n（このターンでは作業者 ${String(failedWorkerNotifications)} 体が失敗で終わった${
            failedWorkerNotificationsNamingLimit > 0
              ? `（うち ${String(failedWorkerNotificationsNamingLimit)} 体は枠(429)を名乗った）`
              : ''
          }。${
            bodyHit
              ? '本体の発言にも拒否の印が付いていたので、本体も当たっている'
              : '本体も当たったかは SDK からは分からない'
          }）`
        : openedWorkers > 0
          ? `\n（このターンでは作業者が ${String(openedWorkers)} 体開いていた。${
              bodyHit
                ? '作業者が当たったかは SDK からは分からないが、本体の発言には拒否の印が付いていたので、本体は当たっている'
                : 'どちらが当たったかは SDK からは分からない'
            }）`
          : '';
  const head = `（このターンは応答を返さずに終わった: ${failure.code} / ${failure.via}）\n${body}${workerNote}`;
  const partial = said.join('\n\n').trim();
  return partial.length === 0 ? head : `${head}\n\n${FAILED_REPORT_PARTIAL_MARKER}\n${partial}`;
}

function describeRejectionCodes(codes: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  return [...counts].map(([code, n]) => `${code} ×${String(n)}`).join(' / ');
}
