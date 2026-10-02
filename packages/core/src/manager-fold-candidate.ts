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
 * 2つある——どちらも「デーモンが既に払った往復」の結果を拾うだけで、
 * この判定のために新しい周期処理・新しい往復は足していない:
 *
 * 1. `ManagerPool#runners()` が `resources: true` で pids を受け取った時点
 *    （`runner_list resources:true`）
 * 2. `manager_start` の自動配置（`RunnerRegistry#place`）が全台の resources
 *    を聞いた時点（`ManagerPool#autoFoldOnPlacementPressure`。同 Issue の
 *    「残り」——契機が (1) だけだったところに足した）
 *
 * 読み手が「表示だけの機能」と早合点しないよう、ここに一言残す。
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
 * ## 条件3 — 器の機能申告で確かめる
 *
 * `tools.ts` の `manager_list` の説明文は逐語で「**この印は器が名乗った分にだけ
 * 立つ** — この欄を送らない古い器では、背景処理を待っていても立たない」と
 * 言っている（`awaitingBackground` の doc・`ManagerAwaitingBackground` の doc
 * も同じ「`undefined` ＝『そう名乗られていない』」という約束）。だから印が
 * 無いことを「背景処理を待っていない」と読めるのは、その器が印を送る版だと
 * 確かめられたときに限る。
 *
 * **確かめる材料は、器の `hello` の機能申告である**（#1394 段(C) / PR #1461。
 * `runner-protocol.ts` の `RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL`）。
 * 書き始めた時点（2026-09-24）にはこの材料が無く、呼び出し元は常に `false`
 * を渡していたが、いまは `ManagerRegistry.runnerHasCapability` の結果を渡す。
 * 名乗らない器（旧い runner）・名乗りをまだ受けていない器・runnerId が無い
 * 委譲は `false`——**「送っているはず」と仮定しない。**
 *
 * この関数は条件3を {@link ManagerFoldCandidateInput.awaitingBackgroundSignalVersionConfirmed}
 * という **必須の（optional ではない）** boolean として受け取るだけで、判定の
 * 材料を自分では取りに行かない。呼び出し元は2つある:
 *
 * - `tools.ts` の `manager_list`（表示だけ。段⑤）
 * - `manager.ts` の `#autoFoldIdleOnRunnerIfUnderPressure`（自動で畳む。段④⑥⑦）
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
   * であると確かめられたか。** 呼び出し元が器の機能申告
   * （`RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL`、#1394 段(C)）を読んで渡す。
   * 名乗りが無ければ `false`（このファイル冒頭の doc）。
   */
  readonly awaitingBackgroundSignalVersionConfirmed: boolean;
  /**
   * 条件4の材料。`classifyManagerActivity`（`manager-activity.ts`）の結果。
   * `'active'` 以外（`'unknown'` ・ `'stalled-turn-end'` ・
   * `'stalled-tool-use'` ・ `'tool-running'`（Issue #2173 で追加））は候補に
   * しない——`'unknown'`（判定できない）を「手が空いている」へ倒さない。
   * **`'tool-running'` も同じ側**——条件1（`status === 'done'`）と両立する
   * ことは構造的に無い（`toolUseStallPending` を書く `probeTurnEnds` は
   * `status === 'running'` のときしか動かない）ので実害は無いが、`!==
   * 'active'` という判定式は5値のどれであっても正しく弾く。
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
  // 条件3（器の機能申告。名乗りが無ければ false——このファイル冒頭の doc）
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
