import type { ManagerActivityKind } from './manager-activity.js';
import type { JobStatus } from './schema.js';

/**
 * Issue #1394 段⑤ — 「手が空いた委譲を自動で畳んで pids を解放する機構が無い」の
 * 最小の形。**この段では畳む操作そのものは作っていない**（人間側の判断を
 * 待った）。ここは元々 `manager_list` の各行に「畳む候補」であることを ⚠ で
 * **表示するだけ**の純関数を置く場所として作った——`manager_stop` は
 * このファイルからは一切呼ばない・呼ばせない（それはいまも変わっていない）。
 *
 * **⚠️ ただし段④⑥⑦（同 Issue、`manager.ts` の
 * `#autoFoldIdleOnRunnerIfUnderPressure` / `#autoFoldOne`）が、この判定関数
 * （{@link isManagerFoldCandidate}）を呼び出し元として使い、実際に
 * `ManagerPool.abort()` を呼ぶようになった。** 畳む・呼ぶのはあちら側で、
 * この関数自体は今日も判定しかしない——「この関数が畳む」わけではないが、
 * 「この関数の結果を使ってどこかが畳むことはある」に変わっている。契機は
 * `ManagerPool#runners()` が `resources: true` で pids を受け取った時点
 * （新しい周期処理は足していない）。読み手が「表示だけの機能」と早合点
 * しないよう、ここに一言残す。
 *
 * ## 候補の条件（すべて AND）
 *
 * 1. `status` が `done` である
 * 2. 背景処理待ちの印（`ManagerSummary.awaitingBackground`）が立っていない
 * 3. **かつ、その器がその印（2）を送る版であると確かめられる**
 * 4. {@link ManagerActivityKind}（`classifyManagerActivity` の結果）が `'active'`
 * 5. 最後のターン終了から {@link MANAGER_FOLD_CANDIDATE_IDLE_THRESHOLD_MS} 以上
 *    経っている
 * 6. 未配達の `manager_send` など、その委譲への届いていない入力が無い
 *
 * **どれか1つでも判定に要る値が取れなければ、候補にしない。** 「取れない」を
 * 「空いた」へ倒さない（AGENTS.md「取れない軸に0の行を作る」と同じ理由）。
 *
 * ## 条件3 — 材料が無いので常に偽として実装した
 *
 * `tools.ts` の `manager_list` の説明文は逐語で「**この印は器が名乗った分にだけ
 * 立つ** — この欄を送らない古い器では、背景処理を待っていても立たない」と
 * 言っている（`awaitingBackground` の doc・`ManagerAwaitingBackground` の doc
 * も同じ「`undefined` ＝『そう名乗られていない』」という約束）。**では、
 * どの器がその印を送る版なのかを確かめる材料は無いか**——`runner-protocol.ts`
 * の `hello` イベント（`{ type: 'hello', runnerId }`）・`report` イベント・
 * `ManagerSummary` のどこにも、runner/manager 側のプロトコル版・機能申告
 * （`protocolVersion` / `capabilities` のようなもの）は無い（調査時点
 * 2026-09-24、`grep -rn 'protocolVersion\|capabilities' packages/core/src`
 * で確認——`ManagerSummary` にはこの種の欄が1つも無い）。
 *
 * **⟹ 「送っているはず」と仮定しない。** 材料が無いので、この条件は常に偽
 * ——{@link ManagerFoldCandidateInput.awaitingBackgroundSignalVersionConfirmed}
 * を **必須の（optional ではない）** boolean フィールドとしてこの純関数には
 * 持たせるが、**実際の呼び出し元（`tools.ts` の `manager_list`）は、いまは
 * 常に `false` を渡す**（呼び出し側のコメントに同じ理由を書く）。この関数
 * 自身を「常に false を返す」形にはしていない——理由は2つ:
 *
 * - この関数を「入力に関わらず常に false」にすると、条件1・2・4・5・6の
 *   単体テストが書けなくなる（どんな入力を与えても false にしかならず、
 *   変異試験で「条件2を外したら背景処理待ちの委譲まで候補に出る」ことを
 *   赤く示せない——テストの構造そのものが観測不能になる、変異試験の
 *   生存の4分類3と同じ形）
 * - 将来、器がプロトコル版・機能申告を送るようになったとき、この関数を
 *   直さなくても呼び出し元が正しい値を渡すだけで機能する（純関数自体は
 *   条件3の判定材料が「今は取れない」ことにしか依存していない）
 *
 * **だから「常に偽」は、この純関数の中にではなく、呼び出し元の配線
 * （`tools.ts`）に置く。** 呼び出し元がいま `false` を固定で渡している
 * ことは、呼び出し元のコメントと、統合の歯（`tools.test.ts` 側。⚠ の行が
 * 一度も出ないことを確かめる）で担保する。
 *
 * ## 条件6 — 材料が無いので判定に使わない
 *
 * `manager_send` は同期的に結果（`outcome: 'delivered' | 'session_missing' |
 * 'unknown' | 'answered'`）を返す口であって、「まだ配達されていない入力」を
 * 後で配達するための非同期のキューは、`ManagerSummary` にも `Job`
 * （`schema.ts` の `jobSchema`）にもフィールドが無い（調査時点 2026-09-24。
 * `waiting`（`RunnerWaiting[]`）はクローン**からの**確認待ちであって、
 * クローン**への**未配達の送信を表す欄ではない——意味が逆である）。
 *
 * **⟹ この条件は判定に使わない。** 材料が見つからないことと、材料が無い
 * ことを確かめずに「無いから候補にしてよい」と決め打つことは別なので、
 * この条件は AND から外し、いまは6条件のうち5条件（1・2・3・4・5）だけで
 * 判定する——6条件目が要求されたが判定できないことを、ここに明記する。
 */
export interface ManagerFoldCandidateInput {
  /** 条件1の材料。`done` 以外は候補にしない。 */
  readonly status: JobStatus;
  /**
   * 条件2の材料。`ManagerSummary.awaitingBackground` が立っている
   * （`undefined` ではない）かどうか。**立っていれば無条件で候補にしない**
   * ——「やりすぎた変異」はここを外すこと（背景処理待ちの委譲まで候補に出る）。
   */
  readonly hasAwaitingBackgroundSignal: boolean;
  /**
   * 条件3の材料。**この委譲の器が、条件2の印（`awaitingBackground`）を送る版
   * であると確かめられたか。** このファイル冒頭の doc のとおり、確かめる
   * 材料はいま存在しない——呼び出し元（`tools.ts`）はいまは常に `false` を
   * 渡す。`true` を渡せる経路ができるまで、この条件は事実上つねに偽になる。
   */
  readonly awaitingBackgroundSignalVersionConfirmed: boolean;
  /**
   * 条件4の材料。`classifyManagerActivity`（`manager-activity.ts`）の結果。
   * `'active'` 以外（`'unknown'` ・ `'stalled-turn-end'` ・
   * `'stalled-tool-use'`）は候補にしない——`'unknown'`（判定できない）を
   * 「手が空いている」へ倒さない。
   */
  readonly activityKind: ManagerActivityKind;
  /**
   * 条件5の材料。「最後のターン終了」とみなす時刻（ISO 8601）。
   *
   * **`ManagerSummary.turnEndedAt` ではなく `ManagerSummary.updatedAt` を
   * 渡すこと。** `turnEndedAt` は `ManagerPool#probeTurnEnds()`
   * （`manager.ts`）が `record.job.status === 'running'` の委譲だけを対象に
   * 計算する（`if (record.job.status !== 'running') continue;`）——`status`
   * が `done` になった委譲では新しく計算されず、`done` になる前の古い値の
   * まま残るか、一度も立たずに `undefined` のままである。条件1が `done` を
   * 要求するこの判定にとって、`turnEndedAt` は構造的にほぼ存在しないか
   * 陳腐化した値になる。
   *
   * 一方 `updatedAt`（`Job.updatedAt`）は `#persist()` が委譲に何か起きる
   * たび（`case 'report'` を含む）に必ず「いま」へ更新する——`done` へ
   * 遷移した瞬間の時刻を確実に持つ。**⚠ ただし `manager_appraise` は
   * `#persist()` を経由せず `job.updatedAt` を直接いまの時刻へ進める**
   * （`manager.ts` の `appraise()`）——評定を付け直しただけの委譲は、この
   * 欄だけを見ると「最近まで動いていた」ように見える。これは経過時間の
   * 起点が「最後にこの委譲へ何らかの書き込みがあった時刻」であることの
   * 帰結であり、この純関数の外側（`tools.ts` の呼び出し元・将来の読み手）
   * が知っておくべき前提として、ここに書いておく。
   */
  readonly lastTurnEndedAt?: string;
}

/**
 * 「手が空いた」と判定するまでの、最後のターン終了からの経過時間の下限
 * （条件5）。6時間。
 */
export const MANAGER_FOLD_CANDIDATE_IDLE_THRESHOLD_MS = 6 * 60 * 60_000;

/**
 * 条件をすべて評価し、候補なら経過ミリ秒を、候補でなければ `null` を返す。
 * {@link isManagerFoldCandidate} と {@link describeManagerFoldCandidate} の
 * 唯一の判定点——判定のコピーを2つ作らない（`manager-activity.ts` と同じ
 * 作法）。
 */
function evaluateFoldCandidate(
  input: ManagerFoldCandidateInput,
  now: Date,
): { readonly elapsedMs: number } | null {
  // 条件1
  if (input.status !== 'done') return null;
  // 条件2
  if (input.hasAwaitingBackgroundSignal) return null;
  // 条件3（いまは常に false を渡される——このファイル冒頭の doc）
  if (!input.awaitingBackgroundSignalVersionConfirmed) return null;
  // 条件4
  if (input.activityKind !== 'active') return null;
  // 条件5
  if (input.lastTurnEndedAt === undefined) return null;
  const lastTurnEndedAtMs = Date.parse(input.lastTurnEndedAt);
  if (Number.isNaN(lastTurnEndedAtMs)) return null;
  const elapsedMs = now.getTime() - lastTurnEndedAtMs;
  if (elapsedMs < MANAGER_FOLD_CANDIDATE_IDLE_THRESHOLD_MS) return null;
  return { elapsedMs };
}

/**
 * この委譲が「畳む候補」かどうかだけを返す純関数の単体の歯向け。
 * 表示文言が要るなら {@link describeManagerFoldCandidate} を使うこと
 * （判定は共有している——2つに割れない）。
 */
export function isManagerFoldCandidate(input: ManagerFoldCandidateInput, now: Date): boolean {
  return evaluateFoldCandidate(input, now) !== null;
}

/**
 * `manager_list` の1行へ添える ⚠ の文言。候補でなければ `null`
 * （健全な委譲では1文字も増えない——`describeTurnEnd` 等と同じ約束）。
 *
 * **候補であって畳んだのではないことを、文言そのものに書く。** 「いまは
 * 表示だけで、畳む操作はしない」を毎回添えるのは、読み手が「⚠ が出た
 * ＝もう畳まれた」と誤読しないため（この Issue で今回作らないと決めたのは
 * 畳む操作そのものであって、候補の表示ではない）。
 */
export function describeManagerFoldCandidate(
  input: ManagerFoldCandidateInput,
  now: Date,
): string | null {
  const result = evaluateFoldCandidate(input, now);
  if (result === null) return null;
  const elapsedHours = Math.floor(result.elapsedMs / 3_600_000);
  return (
    `  ⚠ 畳む候補（手が空いてから${elapsedHours}時間。背景処理待ちの印なし・` +
    '状態の判定 active）。いまは表示だけで、畳む操作はしない。'
  );
}
