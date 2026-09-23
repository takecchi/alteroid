/**
 * 評定（`good` / `bad` / `unclear` / 未評定）の内訳を、要るときに数える口（#1278）。
 *
 * ## なぜこれが要るか
 *
 * `appraisal.ts`（#1055 段2）は定期の棚卸しの蒸留に相乗りする形で、**いま台帳・
 * 委譲に載っている行に限って**内訳を名乗る。それは次の2点で「要るときに数える口」
 * の代わりにならない（#1278 本文の実測）:
 *
 * 1. `storage-fs` は保持上限を超えた古い片付き行を物理削除するので
 *    （`store.ts` の `CommitmentList.trimmedClosed` の doc）、台帳側の分母が
 *    全期間の実数とは限らない。
 * 2. 定期の棚卸しの中でしか出ず、要求したときに引ける口ではない。
 *
 * 一方、**日誌（`JournalStore`）は追記専用で、通常運用で行を削除する経路が無い**
 * （`ワークスペースのリセット専用`の `clear()` を除く）。日誈に残る評定の
 * `decision` 行を先頭一致で数えれば、`storage-fs` の保持上限を経由しない
 * 全期間の実数が取れる。
 *
 * ## 2つの印を混ぜない（#1278 の必須条件）
 *
 * `COMMITMENT_APPRAISAL_DECISION_PREFIX`（引き受けた仕事）と
 * `JOB_APPRAISAL_DECISION_PREFIX`（委譲）は別の軸である。混ぜると分母が
 * 別物になる（`schema.ts` の `JOB_APPRAISAL_DECISION_PREFIX` の doc）。
 * この理由で {@link tallyAppraisalDecisions} は呼び出しごとに `prefix` を
 * 1つだけ受け、呼び手（下の {@link computeAppraisalJournalStats}）が
 * 2回呼んで2つの束を別々に返す——1回の呼びで両方を混ぜて返す形にしない。
 *
 * ## これは「総数」であって「下限」ではない
 *
 * **`journal_read`（MCP の道具）が持つ `limit` の上限（200）は道具の zod
 * スキーマ側の制約であって、ストアの契約には無い。** この関数はストアを直接
 * 呼ぶので、`journal_read` を通したときのように 200 件で静かに下限へ化けること
 * は無い。
 *
 * ⚠️ **「総数」を支えているのは「`limit` を渡さないこと」ではない**（#1342 で
 * 直した。以前ここにはそう書いてあった）。いまは
 * {@link computeAppraisalJournalStats} が `scanJournalPages` でページ単位に
 * 読み継ぎ、**1ページごとの `journal.list()` には必ず有限の `limit` が渡る**
 * ——それでも総数であるのは、**最後のページまで読み切り、件数をカウンタで
 * 足し込んでいるから**である。⟹ `limit` の有無と、総数か下限かは、別の軸である。
 *
 * このことは `appraisal-stats.test.ts` に2本の歯として残してある——
 * 「200 件を超える decision 行でも全件数える」（1ページに収まる側）と
 * 「1ページを超える母集団でも全件数え、ストアへは毎回 有限の limit が渡る」
 * （ページ送りが実際に回る側）。**後者は、ページ送りを外して無制限へ戻しても、
 * ページ送りを途中で打ち切っても、どちらでも赤くなる。**
 *
 * ⚠️ **ただし2つの前提の上に立っている——両方とも「無い」ことを確かめた
 * わけではなく、既存のコードを読んで確認した設計上の前提である:**
 *
 * 1. fs / pg の `list()` は、スキーマに合わない行を「跡は残すが結果には
 *    含めない」形で静かに落とす（`dropped-record.ts` の
 *    `noteDroppedJournalRow`。issue #224）。この欠落は stderr へのログでしか
 *    残らず、`list()` の戻り値には現れない——**理論上はこの経路でも総数が
 *    下限に化ける。** これは #1278 が作った穴ではなく、`JournalStore.list()`
 *    を呼ぶ全ての既存コード（`digest.ts` 等）が共有している既存の性質であり、
 *    ここで新しく作ったものではない（#1278 の範囲外——直すなら別 issue）。
 * 2. 日誌に保持上限や削除の運用が将来足された場合、この doc は追随しない
 *    （腐る）。追随させるかどうかは、足す側の責任である。
 */

import { scanJournalPages } from './journal-scan.js';
import {
  appraisalSchema,
  inferAppraisedByFromGrounds,
  jobStatusSchema,
  parseAppraisalDecisionId,
  parseAppraisalDecisionValue,
  type AppraisalValue,
  type AppraisedBy,
  type Job,
  type JobStatus,
  type JournalEntry,
} from './schema.js';
import type { JournalStore } from './store.js';

/** 先頭一致で拾った評定の内訳。件数は「その prefix で始まる decision 行の総数」。 */
export interface AppraisalDecisionTally {
  good: number;
  bad: number;
  unclear: number;
  /** 3値（`good`/`bad`/`unclear`）のどれでもない値。0 は「無かった」であって「測っていない」ではない。 */
  other: number;
  /** good + bad + unclear + other。 */
  total: number;
}

function emptyTally(): AppraisalDecisionTally {
  return { good: 0, bad: 0, unclear: 0, other: 0, total: 0 };
}

/**
 * `into` に `part` を足し込む（破壊的。ページ送りの途中経過を1つに畳むため）。
 *
 * **全ての欄を明示して足す**——`Object.keys` を回す形にすると、
 * {@link AppraisalDecisionTally} に欄が増えたとき**黙って0のまま**になる。
 * ここを手で並べてあれば、欄が増えたときに `tsc` が足りない欄を指す
 * （`AGENTS.md`「型で塞いだ分岐にも、実行時の倒れ先の歯を足す」と同じ向きの
 * 判断で、ここは型のほうで塞いでいる）。
 */
function addTally(into: AppraisalDecisionTally, part: AppraisalDecisionTally): void {
  into.good += part.good;
  into.bad += part.bad;
  into.unclear += part.unclear;
  into.other += part.other;
  into.total += part.total;
}

/**
 * 日誌のエントリ群から、`prefix` で始まる `decision` 行だけを数える（純関数）。
 *
 * **2つの印を1回の呼びに混ぜないこと。** 呼び手は
 * `COMMITMENT_APPRAISAL_DECISION_PREFIX` と `JOB_APPRAISAL_DECISION_PREFIX`
 * それぞれについて、別々にこの関数を呼ぶこと。
 *
 * `entries` は `type !== 'decision'` の行を含んでいてよい（この関数が無視する）
 * ——呼び手が `types: ['decision']` で先に絞っておく必要は無いが、絞っておいた
 * ほうがストアから読む量は減る（{@link computeAppraisalJournalStats} はそう
 * している）。
 *
 * **呼び手は「全件の配列」を渡すとは限らない。** #1342 以降、
 * {@link computeAppraisalJournalStats} はページ1枚ぶんずつここへ渡して結果を
 * 足し込む——**この関数自身は渡された配列より広い母集団を知らない**ので、
 * ここが返す `total` を「全期間の総数」と読まないこと（総数にするのは、
 * 最後のページまで足し込む呼び手の側の仕事である）。
 */
export function tallyAppraisalDecisions(
  entries: readonly JournalEntry[],
  prefix: string,
): AppraisalDecisionTally {
  const tally = emptyTally();
  for (const entry of entries) {
    if (entry.type !== 'decision') continue;
    const value = parseAppraisalDecisionValue(entry.decision, prefix);
    if (value === undefined) continue; // この行はこの印の評定行ではない
    tally.total += 1;
    if (value === 'other') tally.other += 1;
    else tally[value] += 1;
  }
  return tally;
}

/** {@link computeAppraisalJournalStats} の戻り値。 */
export interface AppraisalJournalStats {
  /** `COMMITMENT_APPRAISAL_DECISION_PREFIX`（引き受けた仕事）の内訳。 */
  commitments: AppraisalDecisionTally;
  /** `JOB_APPRAISAL_DECISION_PREFIX`（委譲）の内訳。 */
  jobs: AppraisalDecisionTally;
}

/**
 * 日誌ストアから、2つの印それぞれの評定の内訳を数える（I/O あり）。
 *
 * **`scanJournalPages` でページ単位に読み継ぎ、1ページごとに両方の prefix を
 * 数えて件数だけを足し込む。** 2回叩かないのは、`decision` 型の行という1つの
 * 母集団から2つの別の束を作っているだけで、母集団の走査自体は1回で足りるから
 * である。
 *
 * ## なぜページ送りなのか（#1342）
 *
 * ここは以前 `journal.list({ types: ['decision'] })` を **`limit` 無指定**で
 * 呼んでいた。pg 実装は `limit` 省略時に `Number.MAX_SAFE_INTEGER` を渡す
 * （`grep -Fn -- 'query.limit ?? Number.MAX_SAFE_INTEGER' packages/storage-pg/src/journal.ts`）
 * ので、**該当行の全文が1クエリで JS のヒープへ載る**——#1283 の OOM の形その
 * ものである。`journal-scan.ts` がその穴を塞ぐ足場として既に在ったが、この口は
 * それより前に出た PR（#1321）で足されたため、規律が届いていなかった。
 *
 * **保つのは「全期間の総数」のほうである。** 件数はカウンタで足し込み、行の
 * 配列は1ページぶんより長く持たない——`onPage` が受け取ったページを外へ貯め
 * ないので、`journal-scan.ts` 冒頭の doc が言う約束を呼び出し側でも破っていない。
 *
 * ⚠️ **`maxScanned` を渡していない。意図である。** `journal-scan.ts` の
 * `JournalScanOptions.maxScanned` の doc は「走査が別の理由で早めに終わる見込みが
 * 強い場合以外は必ず上限を渡せ」と言っており、ここはその条件を満たさない
 * （最後の1行まで数え切るのが仕事なので、早期終了しない）。**それでも渡さないのは、
 * 上限を渡した瞬間に出力が「総数」から「下限」へ化けるからである**——#1278 が
 * 求めたのは全期間の総数そのもので、黙って切れた下限を総数と名乗るのは、直そうと
 * している退行（`journal_read` の limit=200）と同じ形になる。**あの doc が守って
 * いるのはヒープではなく往復（クエリ）の回数**で、ヒープのほうはページの大きさが
 * 守る。往復は `decision` 行 6,855 件（2026-09-23 の実測、#1342 本文）で
 * `ceil(6855/500)` ＝ **14 回**——およそ 600 行/日 の伸びで、1日あたり +1 回強。
 * **ここが重くなったと分かったら、上限を足すのではなく、集計を走査の外（ストア側の
 * `COUNT`）へ出すこと**——上限を足す道は、出力の意味を変えずには通れない。
 */
export async function computeAppraisalJournalStats(
  journal: Pick<JournalStore, 'list'>,
  prefixes: { commitmentPrefix: string; jobPrefix: string },
): Promise<AppraisalJournalStats> {
  const commitments = emptyTally();
  const jobs = emptyTally();
  await scanJournalPages(journal, { types: ['decision'] }, (page) => {
    addTally(commitments, tallyAppraisalDecisions(page, prefixes.commitmentPrefix));
    addTally(jobs, tallyAppraisalDecisions(page, prefixes.jobPrefix));
  });
  return { commitments, jobs };
}

/**
 * (b) 人間 と (c) クローンの食い違いの数え上げ（#1310。#1055 段4の受け入れ
 * 基準「(b) と (c) の食い違いが数え上げられる」の実体）。
 *
 * 「クローンが評定を付け（(c)）、後から人間がその評定を覆した（(b)）」対を
 * 1つの `id` の時系列に沿って数える。**クローン→人間の遷移だけを数える**
 * ——人間→人間・クローン→クローンの付け直しは較正の材料にならない
 * （#1055 段4 が言う「(b) が届いたときに、その件について (c) が何と
 * 言っていたかを突き合わせる」に当たらない）。
 */
export interface AppraisalReconciliationTransition {
  /** クローンが付けていた値（3値のどれでもなければ `'other'`）。 */
  cloneValue: AppraisalValue | 'other';
  /** 人間が付け直した値。 */
  humanValue: AppraisalValue | 'other';
  count: number;
}

/** {@link computeAppraisalReconciliation} の、1つの軸（台帳 or 委譲）ぶんの結果。 */
export interface AppraisalReconciliation {
  /** (クローンの値 → 人間の値) の組ごとの件数。件数の多い順。 */
  transitions: readonly AppraisalReconciliationTransition[];
  /** `transitions` の `count` の総和。 */
  totalPairs: number;
  /** 一致（人間が同じ値で付け直した）件数。 */
  matched: number;
  /** 食い違い件数。 */
  mismatched: number;
  /**
   * この軸の評定行のうち、`id` または「誰が付けたか」が復元できず、対の
   * 判定に使えなかった件数。
   *
   * **0 に数えないこと。** 復元できないことと、対が無いことは別の状態
   * である（AGENTS.md「取れない軸に 0 の行を作る」「判定できないという
   * 3つ目の状態を持つ」）。
   */
  undetermined: number;
}

interface ReconciliationAccumulator {
  transitions: Map<string, AppraisalReconciliationTransition>;
  totalPairs: number;
  matched: number;
  mismatched: number;
  undetermined: number;
  /** `id` ごとの「直近に見た（値・誰が付けたか）」。時系列（昇順）走査の途中経過。 */
  last: Map<string, { value: AppraisalValue | 'other'; by: AppraisedBy }>;
}

function emptyReconciliationAccumulator(): ReconciliationAccumulator {
  return {
    transitions: new Map(),
    totalPairs: 0,
    matched: 0,
    mismatched: 0,
    undetermined: 0,
    last: new Map(),
  };
}

/**
 * 1件の日誌行を、`kind` の軸の積み上げへ足し込む（破壊的）。
 *
 * **新しい行（構造欄あり）と過去の行（無し）を同じ経路で扱う。** 構造欄が
 * 在れば直接読み、無ければ `parseAppraisalDecisionId` /
 * `parseAppraisalDecisionValue` / `inferAppraisedByFromGrounds` で
 * 復元する——どちらの経路でも `id` / `value` / `by` の3つが埋まって初めて
 * `last` を更新し、クローン→人間の遷移を判定できる。**3つのどれか1つでも
 * 欠ければ `undetermined` へ計上し、`last` は更新しない**（不確かな値で
 * 以降の対の判定を汚さないため）。
 */
function recordAppraisalDecision(
  acc: ReconciliationAccumulator,
  entry: JournalEntry,
  prefix: string,
  kind: 'commitment' | 'job',
): void {
  if (entry.type !== 'decision') return;
  if (!entry.decision.startsWith(prefix)) return; // この軸の評定行ではない

  const structured =
    entry.appraisal !== undefined && entry.appraisal.target === kind ? entry.appraisal : undefined;
  const id = structured?.id ?? parseAppraisalDecisionId(entry.decision, prefix);
  const value: AppraisalValue | 'other' | undefined =
    structured?.value ?? parseAppraisalDecisionValue(entry.decision, prefix);
  const by = structured?.by ?? inferAppraisedByFromGrounds(entry.grounds, kind);

  if (id === undefined || value === undefined || by === undefined) {
    acc.undetermined += 1;
    return;
  }

  const prior = acc.last.get(id);
  if (prior !== undefined && prior.by === 'clone' && by === 'human') {
    const key = `${prior.value}->${value}`;
    const existing = acc.transitions.get(key);
    if (existing === undefined) {
      acc.transitions.set(key, { cloneValue: prior.value, humanValue: value, count: 1 });
    } else {
      existing.count += 1;
    }
    acc.totalPairs += 1;
    if (prior.value === value) acc.matched += 1;
    else acc.mismatched += 1;
  }

  acc.last.set(id, { value, by });
}

function finalizeReconciliation(acc: ReconciliationAccumulator): AppraisalReconciliation {
  return {
    transitions: [...acc.transitions.values()].sort((a, b) => b.count - a.count),
    totalPairs: acc.totalPairs,
    matched: acc.matched,
    mismatched: acc.mismatched,
    undetermined: acc.undetermined,
  };
}

/** {@link computeAppraisalReconciliation} の戻り値。 */
export interface AppraisalReconciliationStats {
  /** `COMMITMENT_APPRAISAL_DECISION_PREFIX`（引き受けた仕事）の軸。 */
  commitments: AppraisalReconciliation;
  /** `JOB_APPRAISAL_DECISION_PREFIX`（委譲）の軸。 */
  jobs: AppraisalReconciliation;
}

/**
 * 日誌ストアから、2つの軸それぞれで (b)/(c) の食い違いを数える（I/O あり）。
 *
 * **時系列に沿って読む必要があるので `order: 'asc'` で走査する**——
 * {@link computeAppraisalJournalStats} の単純な合計と違い、ここは「直前に
 * 誰が何を付けていたか」を1つの `id` ごとに追う必要がある（降順で読むと
 * 「直前」が逆向きになる）。
 *
 * **走査は {@link computeAppraisalJournalStats} とは別の1回**（`asc` /
 * `desc` を1回の走査で両立できないため）。往復（クエリ）の回数は
 * 実質2倍になる——`appraisal-stats.ts` 冒頭の doc が言う「重くなったら
 * ストア側の集計へ出す」判断は、この関数にも同様に当てはまる。
 */
export async function computeAppraisalReconciliation(
  journal: Pick<JournalStore, 'list'>,
  prefixes: { commitmentPrefix: string; jobPrefix: string },
): Promise<AppraisalReconciliationStats> {
  const commitments = emptyReconciliationAccumulator();
  const jobs = emptyReconciliationAccumulator();
  await scanJournalPages(journal, { types: ['decision'], order: 'asc' }, (page) => {
    for (const entry of page) {
      recordAppraisalDecision(commitments, entry, prefixes.commitmentPrefix, 'commitment');
      recordAppraisalDecision(jobs, entry, prefixes.jobPrefix, 'job');
    }
  });
  return { commitments: finalizeReconciliation(commitments), jobs: finalizeReconciliation(jobs) };
}

/**
 * 委譲（`Job`）のうち、いま「手が離れている」状態を「終端」と呼ぶ。
 *
 * **`running` / `waiting_human` は含めない**——どちらもまだ続く可能性がある
 * 状態で（`jobStatusSchema` の doc）、「評定が付いていない」を問う対象では
 * ない（続いている最中に評定が無いのは当然であり、欠落ではない）。
 *
 * **`switch` を通して網羅性を型で強制する。** `jobStatusSchema` に値が増えた
 * とき、ここを直し忘れると `tsc` が落ちる——黙って「非終端」側へ落ちて
 * 数え上げから消える形を避ける（`AGENTS.md`「型で塞いだ分岐にも、実行時の
 * 倒れ先の歯を足す」と同じ理由。ここは型のほうで塞いでいる）。
 */
export function isTerminalJobStatus(status: JobStatus): boolean {
  switch (status) {
    case 'running':
    case 'waiting_human':
      return false;
    case 'done':
    case 'failed':
    case 'lost':
    case 'stopped':
      return true;
  }
}

/** 1つの `JobStatus` について、終端した委譲の評定の有無を数えた行。 */
export interface JobAppraisalCoverageRow {
  status: JobStatus;
  /** この状態で終端した委譲の総数。 */
  total: number;
  /** そのうち `appraisal` 欄を持つもの。 */
  appraised: number;
  /** そのうち `appraisal` 欄を持たないもの（＝評定が1度も付いていない）。 */
  unappraised: number;
}

/** {@link computeJobAppraisalCoverage} の戻り値。 */
export interface JobAppraisalCoverage {
  /** `jobStatusSchema.options` の順で並ぶ、終端した状態だけの内訳。 */
  byStatus: readonly JobAppraisalCoverageRow[];
  /** 終端した委譲の合計（`byStatus` の `total` の総和）。 */
  terminalTotal: number;
  terminalAppraised: number;
  terminalUnappraised: number;
  /**
   * まだ終端していない委譲の件数（`running` + `waiting_human`）。
   *
   * **この Issue の測定対象ではない**（続いている最中の評定の有無を問うのは
   * 意味が無い）が、「終端した委譲」の分母が全体の何割かを読み手が自分で
   * 判断できるように、取れない扱いにせず件数だけ添える（0 でも「無い」でも
   * ない実測値）。
   */
  nonTerminalTotal: number;
}

/**
 * `JobStore.listJobs()` の戻りから、終端の仕方ごとに評定の有無を数える
 * （純関数。#1278 の実測コメントが求めた「評定が1度も付いていない委譲の
 * 本数」と「終端の仕方ごとの内訳」）。
 *
 * **走行中の委譲の評定は `JobStore` にまだ降りていないことがある**
 * （`manager.ts` の `ManagerPool.appraise` の doc）。ただし `running` /
 * `waiting_human` はそもそもこの集計の対象外なので、この欠落はここには
 * 効かない——`done`/`failed`/`lost`/`stopped` になった時点で
 * `ManagerPool.appraise` は常に `putJob` で台帳へ書く（呼ばれていれば）ので、
 * 終端後の `appraisal` 欄の有無は `JobStore` を信頼できる。
 */
export function computeJobAppraisalCoverage(jobs: readonly Job[]): JobAppraisalCoverage {
  const rows = new Map<JobStatus, { total: number; appraised: number }>();
  for (const status of jobStatusSchema.options) {
    if (isTerminalJobStatus(status)) rows.set(status, { total: 0, appraised: 0 });
  }

  let nonTerminalTotal = 0;
  for (const job of jobs) {
    if (!isTerminalJobStatus(job.status)) {
      nonTerminalTotal += 1;
      continue;
    }
    // `rows` は上のループで全ての終端状態を先に埋めてあるので必ず在る。
    const row = rows.get(job.status);
    if (row === undefined) continue; // 到達しない（型で網羅済み）。安全側。
    row.total += 1;
    if (job.appraisal !== undefined) row.appraised += 1;
  }

  const byStatus: JobAppraisalCoverageRow[] = [...rows.entries()].map(([status, counts]) => ({
    status,
    total: counts.total,
    appraised: counts.appraised,
    unappraised: counts.total - counts.appraised,
  }));

  const terminalTotal = byStatus.reduce((sum, row) => sum + row.total, 0);
  const terminalAppraised = byStatus.reduce((sum, row) => sum + row.appraised, 0);

  return {
    byStatus,
    terminalTotal,
    terminalAppraised,
    terminalUnappraised: terminalTotal - terminalAppraised,
    nonTerminalTotal,
  };
}

/** 評定の3値の日本語ラベル（未知の値はそのまま返す）。`describeAppraisal` と同じ流儀。 */
function appraisalTallyLabel(value: AppraisalValue): string {
  return { good: 'うまくいった', bad: 'うまくいかなかった', unclear: '判定できない' }[value];
}

function renderTally(tally: AppraisalDecisionTally): string {
  const parts = appraisalSchema.options
    .map((value) => `${appraisalTallyLabel(value)} ${tally[value]}`)
    .join(' / ');
  return `評定行 ${tally.total} 件（${parts} / 上の3値以外 ${tally.other}）`;
}

/** `AppraisalValue | 'other'` を日本語のラベルへ（3値以外はそのまま返す）。 */
function renderReconciliationValue(value: AppraisalValue | 'other'): string {
  const known = appraisalSchema.safeParse(value);
  return known.success ? appraisalTallyLabel(known.data) : value;
}

function renderReconciliation(rec: AppraisalReconciliation): string[] {
  const lines: string[] = [];
  if (rec.totalPairs === 0) {
    lines.push('（クローンが付けた評定を人間が付け直した対は無い）');
  } else {
    for (const t of rec.transitions) {
      const mark = t.cloneValue === t.humanValue ? '一致' : '食い違い';
      lines.push(
        `- クローン「${renderReconciliationValue(t.cloneValue)}」→人間「${renderReconciliationValue(t.humanValue)}」: ${t.count} 件（${mark}）`,
      );
    }
    lines.push(`合計: ${rec.totalPairs} 対（一致 ${rec.matched} / 食い違い ${rec.mismatched}）。`);
  }
  lines.push(
    `⚠️ 判定できない（id または「誰が付けたか」が復元できなかった）評定行: ${rec.undetermined} 件` +
      '（0件は「無かった」であって「測っていない」ではない）。',
  );
  return lines;
}

/**
 * `appraisal_stats` 道具（MCP）が返す文面を組む。
 *
 * **予算（`excerpt.ts` の `renderListing`）は使っていない。** この出力は
 * 母集団の件数（decision 行の総数・委譲の総数）に応じて行数が増える一覧では
 * なく、固定個数の集計値（内訳3〜4個 × 数軸）だけなので、件数がどれだけ
 * 増えても出力の行数は変わらない——`.claude/skills/listing-and-detail/SKILL.md`
 * が対象にしている「件数に比例して伸びる一覧」の形に当たらない、という
 * 判断で外してある。
 */
export function describeAppraisalStats(input: {
  journal: AppraisalJournalStats;
  jobCoverage: JobAppraisalCoverage;
  reconciliation: AppraisalReconciliationStats;
}): string {
  const { journal, jobCoverage, reconciliation } = input;

  const lines: string[] = [];
  lines.push(
    '## 評定の内訳（日誌の decision 行を先頭一致で数えた全期間の総数。ページ送りで最後まで数えている）',
  );
  lines.push('');
  lines.push(`### 引き受けた仕事（COMMITMENT_APPRAISAL_DECISION_PREFIX）`);
  lines.push(renderTally(journal.commitments));
  lines.push('');
  lines.push(`### 委譲（JOB_APPRAISAL_DECISION_PREFIX）`);
  lines.push(renderTally(journal.jobs));
  lines.push('');
  lines.push(
    '⚠️ 上の2つは別の印である。混ぜて比べないこと（分母が別物——台帳の行の始末と、' +
      'マネージャーに出した仕事の出来は違う軸）。',
  );
  lines.push('');
  lines.push('## 委譲の評定の有無（JobStore を終端の仕方ごとに割った内訳）');
  lines.push('');
  for (const row of jobCoverage.byStatus) {
    lines.push(
      `- ${row.status}: 終端 ${row.total} 件（評定あり ${row.appraised} / 評定なし ${row.unappraised}）`,
    );
  }
  lines.push(
    `合計: 終端した委譲 ${jobCoverage.terminalTotal} 件中、評定なしが ${jobCoverage.terminalUnappraised} 件` +
      `（評定あり ${jobCoverage.terminalAppraised} 件）。`,
  );
  lines.push(
    `（参考・この集計の対象外: running/waiting_human で終端していない委譲が ${jobCoverage.nonTerminalTotal} 件。` +
      'まだ続きうるので「評定が無い」を欠落として数えていない）',
  );
  lines.push('');
  lines.push(
    '## (b) 人間 と (c) クローンの食い違い（#1055 段4。クローンが付けた評定を人間が後から付け直した対）',
  );
  lines.push('');
  lines.push('### 引き受けた仕事（COMMITMENT_APPRAISAL_DECISION_PREFIX）');
  lines.push(...renderReconciliation(reconciliation.commitments));
  lines.push('');
  lines.push('### 委譲（JOB_APPRAISAL_DECISION_PREFIX）');
  lines.push(...renderReconciliation(reconciliation.jobs));
  lines.push('');
  lines.push('⚠️ 上の2つもここまでの節と同じく別の軸である。混ぜて比べないこと。');
  return lines.join('\n');
}
