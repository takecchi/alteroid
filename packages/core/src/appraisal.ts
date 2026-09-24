/**
 * 段2: 横断の蒸留 — 個別の評定を束ねて名指しする（#1055）。
 *
 * `describeMemoryTidyTargets`（`memory.ts`）と同じ形を踏襲する:
 *
 * 1. **純関数** — ストアを直接叩かない。呼び手（`clone.ts`）が読んだ結果を渡す
 * 2. **返り値は文字列** — 指示文へそのまま焼き込める形にする
 * 3. **空のとき専用の断り書きを返す** — 「良い仕事が無い」と読ませない
 * 4. **予算は `excerpt.ts` の `renderListing` に委譲する** — 件数ではなく文字数で締める
 *
 * ## ⭐ なぜ節を2つに分けるか
 *
 * `schema.ts` の `JOB_APPRAISAL_DECISION_PREFIX` の doc が既に理由を持っている
 * （逐語）:
 *
 * > 同じ印にすると、段2（同じ種類の仕事の直近 N 件を束ねる）で「台帳の行の評定」と
 * > 「委譲の評定」が同じ束に混ざる —— 片方は人間との約束の始末で、もう片方は
 * > マネージャーに出した仕事の出来なので、数え上げの分母が別物になる。
 *
 * ⟹ 台帳（`Commitment.appraisal`）と委譲（`Job.appraisal`）は必ず別の節へ出す。
 * 1つの束に混ぜない。
 *
 * ## ⚠️ この束が見ているのは台帳に降りたぶんだけである
 *
 * 走行中の委譲の評定は `JobStore` にまだ降りていないことがある
 * （`manager.ts` の `ManagerPool.appraise` の doc —— 走行中は `ManagerPool` が
 * プロセス内の像へ評定を書き、`#persist` が終端後に台帳へ降ろす）。**この関数は
 * `input.jobs`（＝ `JobStore.listJobs()` の戻り）しか見ないので、走行中の委譲に
 * 付いた評定はここには現れないことがある。** この欠落を「委譲の節」の出力から
 * 消さないこと ——下の委譲節は毎回この注記を1行持つ。
 */

import { excerptLine, renderListing } from './excerpt.js';
import { APPRAISAL_LABELS, appraisalSchema, type Job } from './schema.js';
import { groupByWorkKind, UNCLASSIFIED_WORK_KIND_LABEL, workKindGroupKey } from './work-kind.js';
import type { CommitmentList } from './store.js';

/**
 * 束1つぶんの文字数の予算。件数ではない。節は2つ在るので全体はこの2倍＋見出しになる。
 */
export const APPRAISAL_TARGETS_BUDGET = 2_000;

/** 1件の素（台帳の本文 / 委譲の要旨）を切る長さ。本文の全文は載せない。 */
export const APPRAISAL_TARGETS_LINE_LIMIT = 160;

/** 評定の理由を切る長さ。 */
export const APPRAISAL_TARGETS_REASON_LIMIT = 160;

/** 節の1行を組むのに要る、評定つきレコードの最小限の形。 */
interface AppraisalTargetRecord {
  id: string;
  /** 台帳＝`body` / 委譲＝`summary`。抜粋にしてから載せる（全文は載せない）。 */
  text: string;
  appraisal?: string;
  appraisedAt?: string;
  appraisalReason?: string;
  /** 評定が述べた仕事の種類（#1308）。無ければ未分類。 */
  workKind?: string;
}

/**
 * 節の頭に出す「種類ごとの内訳」で名前を出す群の上限（#1308 段B）。
 *
 * **種類は自由文なので群の数に上限が無い。** 1行に全部並べると、表記ゆれが
 * 積もった器で予算（{@link APPRAISAL_TARGETS_BUDGET}）をこの1行が食い潰す。
 * 件数の多い群から出し、残りは「ほか N 種類」と数だけ出す（消えたことを出力から
 * 消さない）。
 */
export const APPRAISAL_WORK_KIND_GROUPS_SHOWN = 8;

/** 未知の値はラベルが無いので、生の文字列をそのまま返す（落とさない）。 */
function appraisalLabel(value: string): string {
  const known = appraisalSchema.safeParse(value);
  return known.success ? APPRAISAL_LABELS[known.data] : value;
}

/**
 * 並び順のための群: `bad` → `unclear` → 3値以外 → `good`。
 *
 * **Issue が名指ししたのは「評定が割れている／悪い評定が続いている件の束」
 * なので、学びの残っている側（うまくいかなかった・判定できない）から予算を使う。**
 */
function appraisalGroupRank(value: string): number {
  const known = appraisalSchema.safeParse(value);
  if (!known.success) return 2;
  switch (known.data) {
    case 'bad':
      return 0;
    case 'unclear':
      return 1;
    case 'good':
      return 3;
  }
}

/** `appraisedAt` の新しい順（`undefined` は最後）。 */
function compareAppraisedAtDesc(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

function renderAppraisalLine(record: AppraisalTargetRecord & { appraisal: string }): string {
  const label = appraisalLabel(record.appraisal);
  const body = excerptLine(record.text, APPRAISAL_TARGETS_LINE_LIMIT);
  const reason =
    record.appraisalReason === undefined
      ? '（理由: 無し）'
      : `（理由: ${excerptLine(record.appraisalReason, APPRAISAL_TARGETS_REASON_LIMIT)}）`;
  const kind =
    workKindGroupKey(record.workKind) === null
      ? `［${UNCLASSIFIED_WORK_KIND_LABEL}］`
      : `［${excerptLine(record.workKind ?? '', 40)}］`;
  return `- [${label}]${kind} ${record.id}: ${body}${reason}`;
}

/** 評定済みの3値 + 3値以外の内訳。 */
function countAppraisals(records: readonly AppraisalTargetRecord[]): {
  good: number;
  bad: number;
  unclear: number;
  other: number;
} {
  const counts = { good: 0, bad: 0, unclear: 0, other: 0 };
  for (const record of records) {
    if (record.appraisal === undefined) continue;
    const known = appraisalSchema.safeParse(record.appraisal);
    if (known.success) counts[known.data] += 1;
    else counts.other += 1;
  }
  return counts;
}

/**
 * 評定済みの行を仕事の種類ごとに束ねた1行（#1308 段B）。評定済みが0件なら空文字。
 *
 * **群ごとに「うまくいかなかった／判定できない」の件数を添える** —— #1055 段2 が
 * 見たいのは「同じ種類の仕事で悪い評定が続いているか」であって、群の大きさでは
 * ない。**未分類は種類の1つとして並べず、最後に件数だけ出す**（#1308 の決定:
 * どれかの種類に寄せない）。
 */
function describeWorkKindBreakdown(appraised: readonly AppraisalTargetRecord[]): string {
  if (appraised.length === 0) return '';
  const groups = groupByWorkKind(appraised, (record) => record.workKind);
  const named = groups.filter((group) => group.key !== null);
  const unclassified = groups.find((group) => group.key === null)?.items.length ?? 0;
  const shown = named.slice(0, APPRAISAL_WORK_KIND_GROUPS_SHOWN).map((group) => {
    const counts = countAppraisals(group.items);
    return (
      `${excerptLine(group.label, 40)} ${group.items.length} 件` +
      `（うまくいかなかった ${counts.bad} / 判定できない ${counts.unclear}）`
    );
  });
  const hidden = named.length - shown.length;
  const parts = [
    ...shown,
    ...(hidden > 0 ? [`ほか ${hidden} 種類`] : []),
    `${UNCLASSIFIED_WORK_KIND_LABEL} ${unclassified} 件`,
  ];
  return `\n種類ごと（評定が述べた仕事の種類。#1308）: ${parts.join('・')}`;
}

function describeAppraisalSection(params: {
  heading: string;
  records: readonly AppraisalTargetRecord[];
  continuationTool: string;
  /** 節の頭に必ず出す注記（走行中の委譲の欠落など。測った値ではないので常に出す）。 */
  fixedNotices?: readonly string[];
  /** 測った値が非ゼロのときだけ出す注記（`trimmedClosed` / `unreadable` 等）。 */
  measuredNotices?: readonly string[];
}): string {
  const { heading, records, continuationTool, fixedNotices = [], measuredNotices = [] } = params;

  const appraised = records.filter(
    (record): record is AppraisalTargetRecord & { appraisal: string } =>
      record.appraisal !== undefined,
  );
  const unappraisedCount = records.length - appraised.length;
  const counts = countAppraisals(records);

  const sorted = [...appraised].sort(
    (a, b) =>
      appraisalGroupRank(a.appraisal) - appraisalGroupRank(b.appraisal) ||
      compareAppraisedAtDesc(a.appraisedAt, b.appraisedAt),
  );
  const lines = sorted.map(renderAppraisalLine);

  const listing =
    lines.length === 0
      ? '（評定済みの行は無い）'
      : renderListing(lines, {
          budget: APPRAISAL_TARGETS_BUDGET,
          omitted: ({ rest, shown, total }) =>
            `…ほか ${rest} 件は省略（学びが残っている側——うまくいかなかった／判定できない側——から ` +
            `${shown} 件だけ出した。全 ${total} 件。続きは ${continuationTool} で確認できる）。`,
        });

  // **`bad` が0件であることは「測った値」であって「良し悪しの基準」ではない。**
  // 評定済みが0件の節では出さない（「測っていない」と「測って0だった」は別である）。
  const badWarning =
    appraised.length > 0 && counts.bad === 0
      ? '\n⚠️ 「うまくいかなかった」が0件である（評定済み ' +
        `${appraised.length} 件中）。評定する側が \`good\` へ寄っている可能性がある——` +
        '**これは測った値であって、良し悪しの基準ではない。**'
      : '';

  const kindLine = describeWorkKindBreakdown(appraised);

  const notices = [...fixedNotices, ...measuredNotices];
  const noticeLines = notices.length > 0 ? `\n${notices.join('\n')}` : '';

  return (
    `${heading}\n` +
    `評定済み ${appraised.length} 件（うまくいった ${counts.good} / うまくいかなかった ${counts.bad} / ` +
    `判定できない ${counts.unclear} / 上の3値以外 ${counts.other} 件）・未評定 ${unappraisedCount} 件` +
    `${kindLine}${noticeLines}\n${listing}${badWarning}`
  );
}

/**
 * いま評定が付いている件を、台帳（`Commitment`）と委譲（`Job`）の2節に分けて名指しする。
 *
 * **未評定（`appraisal` 欄が無い）を `good` にも `bad` にも寄せない。** 一覧には
 * 1件も出さず、件数だけを別の数として出す —— 未評定は「測っていない」であって
 * 「0」でも「良い」でもない（AGENTS.md「取れない軸に 0 の行を作る」の向き）。
 *
 * `input.commitments` は `CommitmentStore.list({ includeClosed: true })` の
 * 戻り値をそのまま渡すこと。**台帳の分母は全期間の実数とは限らない** ——
 * `storage-fs` は保持上限を超えた古い片付き行を物理削除し、その累計を
 * `trimmedClosed` に持つ（`store.ts` の `CommitmentList.trimmedClosed` の doc）。
 * `trimmedClosed` / `unreadable` が非ゼロのときは、その旨を台帳の節へ1行足す
 * （取れていないことを出力から消さない）。
 */
export function describeAppraisalTargets(input: {
  commitments: CommitmentList;
  jobs: readonly Job[];
}): string {
  const commitmentRecords: AppraisalTargetRecord[] = input.commitments.entries.map((entry) => ({
    id: entry.id,
    text: entry.body,
    appraisal: entry.appraisal,
    appraisedAt: entry.appraisedAt,
    appraisalReason: entry.appraisalReason,
    workKind: entry.workKind,
  }));
  const jobRecords: AppraisalTargetRecord[] = input.jobs.map((job) => ({
    id: job.id,
    text: job.summary,
    appraisal: job.appraisal,
    appraisedAt: job.appraisedAt,
    appraisalReason: job.appraisalReason,
    workKind: job.workKind,
  }));

  const totalAppraised =
    commitmentRecords.filter((record) => record.appraisal !== undefined).length +
    jobRecords.filter((record) => record.appraisal !== undefined).length;

  // **消えた分母の申告は、0件の枝より前で組み立てる。** 後ろで組むと、
  // 「評定が1件も無い」で早期に返る枝からこの申告が丸ごと落ちる（下の枝の doc）。
  const measuredNotices: string[] = [];
  if (input.commitments.trimmedClosed > 0) {
    measuredNotices.push(
      `⚠️ 古い片付き行が ${input.commitments.trimmedClosed} 件消えている（この器は保持上限を持つ）` +
        'ので、上の件数は全期間の実数ではない。',
    );
  }
  if (input.commitments.unreadable.length > 0) {
    measuredNotices.push(
      `⚠️ 読めなかった行が ${input.commitments.unreadable.length} 件在るので、そのぶんは上の` +
        'どの数にも入っていない。',
    );
  }

  // **⛔ この枝は Issue #1055 の冒頭の門がそのまま読む値である**（「0件なら段2 の
  // 入力は永久に空なので段2 を書くな」と分岐する）。⟹ **0 の原因をここで断言して
  // 外すと、この Issue でいちばん高くつく誤読になる。**
  //
  // `trimmedClosed` / `unreadable` が在るときは「付けていないから空」とは限らない
  // ——付けた評定が古い片付き行ごと消えている経路が `storage-fs` に実在する。
  // だから申告が在るときだけ断言を弱める（無いときの文面は1文字も変えない）。
  if (totalAppraised === 0) {
    const doubt =
      measuredNotices.length === 0
        ? ''
        : `\n${measuredNotices.join('\n')}\n` +
          '**⟹ この0を「まだ付けていない」と読まないこと。** 付けた評定が上の欠落に' +
          '巻き込まれて消えている可能性がある。';
    return (
      '評定の的: 評定が付いた件が台帳・委譲のどちらにも1件も無い。' +
      '**これは「良い仕事が無い」ではない** —— 評定は付けたときにしか残らないので、' +
      '付けていなければここは常に空になる（`commitment_appraise` / `manager_appraise` で付ける）。' +
      doubt
    );
  }

  const commitmentSection = describeAppraisalSection({
    heading: '## 引き受けた仕事（台帳）',
    records: commitmentRecords,
    continuationTool: 'commitment_list',
    measuredNotices,
  });

  const jobSection = describeAppraisalSection({
    heading: '## 委譲（マネージャーへ出した仕事）',
    records: jobRecords,
    continuationTool: 'manager_list',
    fixedNotices: [
      '⚠️ この一覧が見ているのは台帳（JobStore）に降りた評定だけである。走行中の委譲の評定は、' +
        'その委譲が終端するまでここに現れないことがある（`ManagerPool.appraise` の doc）。',
    ],
  });

  return `${commitmentSection}\n\n${jobSection}`;
}
