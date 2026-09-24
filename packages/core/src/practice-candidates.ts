/**
 * 段4: やり方の候補を**材料として**差し出す（#1055）。
 *
 * ## ⛔ これは採否の機構ではない（2026-09-23T00:22Z の設計コメントの決定）
 *
 * 評定が `practice_write` へ機械的に流れると、やり方は「クローンが決めたもの」
 * ではなく「最適化器の出力」になる。**しかもその最適化器の評価関数（信号 (c)
 * ＝クローン自身の評定）は較正されていない。** ⟹ 段4 は段2（`appraisal.ts`）の
 * 相似形として作る —— 段2 が評定の束を蒸留の指示文へ差し込むだけで
 * `memory_update` を自動で呼ばないのと同じく、ここも**候補と証拠を差し込むだけ**
 * で、`practice_write` を呼ぶ経路も、採る／採らないを決める判定も持たない。
 *
 * ⟹ 段4 の受け入れ基準「(c) だけで採否が決まる経路が無い」「採否の判定が評定の
 * 平均だけで行われていない」は、**禁じるチェックを足すことではなく、判定そのもの
 * を作らないこと**で満たしている。**ここに「閾値を超えたら書く」「平均が下がったら
 * 戻す」の類を足さないこと** —— 足した瞬間に上の決定が壊れる。
 *
 * ## 形は `appraisal.ts`（段2）に揃える
 *
 * 1. **純関数** — ストアを叩かない。呼び手（`clone.ts`）が読んだ結果を渡す
 * 2. **返り値は文字列** — 指示文へそのまま焼き込める
 * 3. **空のとき専用の断り書きを返す** — 「やり方を変えなくてよい」と読ませない
 * 4. **予算は `renderListing` に委譲する** — 件数ではなく文字数で締める
 * 5. **台帳と委譲を1つの群に混ぜない** — 同じ種類の名前でも、軸が違えば別の群で
 *    ある（`schema.ts` の `JOB_APPRAISAL_DECISION_PREFIX` の doc が持つ理由）
 * 6. **未評定を `good` にも `bad` にも数えない** — 群には評定済みの行だけが入る
 *
 * ## 何を「候補の的」にするか —— 並べるだけで、順位は判定ではない
 *
 * 群に入れるのは、**種類を述べた評定のうち「うまくいかなかった」か「判定できない」
 * が1件以上ある群**である。**比率の閾値は置かない** —— 閾値を置くと「どの群なら
 * やり方を変えるべきか」を器が決めることになり、上の ⛔ に当たる。並びは
 * 「うまくいかなかった」の件数 → 「判定できない」の件数の多い順で、これは予算を
 * どこから使うかの順であって優先度の判定ではない（出力にもそう書く）。
 *
 * **未分類（種類を述べていない評定）は群にしない。** やり方は種類で引くので、
 * 未分類には突き合わせる相手が無い。ただし件数は必ず出す（消えたことを出力から
 * 消さない。#1308 の「どれかの種類へ寄せない」決定と同じ向き）。
 *
 * ## (b)/(c) の食い違いは軸ごとであって、種類ごとではない
 *
 * `appraisal-stats.ts` の `computeAppraisalReconciliation`（#1310）が数えるのは
 * 軸（台帳／委譲）ごとの対である。**種類ごとには割っていない** —— 対の片方
 * （クローンの評定）ともう片方（人間の付け直し）とで述べた種類が食い違いうる
 * ので、どちらの種類に数えるかは判断であり、ここでは割らなかった。⟹ 出力には
 * 「種類ごとではない」と書く（割っていないことを出力から消さない）。
 */

import { renderReconciliation, type AppraisalReconciliationStats } from './appraisal-stats.js';
import { excerptLine, renderListing } from './excerpt.js';
import { APPRAISAL_LABELS, appraisalSchema, type Job } from './schema.js';
import type { CommitmentList } from './store.js';
import { groupByWorkKind, UNCLASSIFIED_WORK_KIND_LABEL, workKindGroupKey } from './work-kind.js';

/**
 * 1つの軸（台帳／委譲）ぶんの文字数の予算。件数ではない。
 *
 * 軸は2つ在るので全体はこの2倍＋固定の文面（食い違い・材料の注記）になる。
 * 段2 の `APPRAISAL_TARGETS_BUDGET` と値を共有しないのは、片方だけ直したく
 * なったときに一緒に動かないようにするためである（`listing-and-detail` の約束）。
 */
export const PRACTICE_CANDIDATES_BUDGET = 2_500;

/**
 * 1つの群の中で、証拠（うまくいかなかった／判定できない件の抜粋）に使う予算。
 *
 * **群の中にも予算が要る。** 無いと、1つの種類に `bad` が積もった器ではその群の
 * 1ブロックだけで軸の予算を食い潰し、`renderListing` がそのブロックを途中で
 * 切ることになる（他の種類が1つも見えなくなる）。
 */
export const PRACTICE_CANDIDATE_EVIDENCE_BUDGET = 700;

/** 証拠1件の本文（台帳の本文 / 委譲の要旨）を切る長さ。 */
export const PRACTICE_CANDIDATE_LINE_LIMIT = 100;

/** 評定の理由を切る長さ。 */
export const PRACTICE_CANDIDATE_REASON_LIMIT = 100;

/** いまのやり方の本文を切る長さ。**全文は載せない**（`practice_read` で取れる）。 */
export const PRACTICE_CANDIDATE_PRACTICE_EXCERPT_LIMIT = 140;

/**
 * 突き合わせに使う、いまのやり方1件。
 *
 * **呼び手は候補の的になった種類のやり方だけを読んで渡してよい**
 * （{@link practiceCandidateKindKeys}）。渡されたやり方のうち、的の種類に当たらない
 * ものはここでは出さない。
 */
export interface PracticeCandidateMaterial {
  slug: string;
  kind: string;
  title: string;
  updatedAt: string;
  /** 本文。抜粋にしてから載せる。 */
  content: string;
  /**
   * 追記専用の履歴に積まれた版の数（#1309 の `listVersions` の長さ）。
   *
   * **読めなかったら `undefined`**（0 にしない。「版が無い」と「数えられなかった」は
   * 別の状態である）。
   */
  versions?: number;
}

/** 食い違いの数え上げ。測れなかった回を「対が無い」に化けさせないため、2つの形を持つ。 */
export type PracticeCandidateReconciliation =
  { measured: true; stats: AppraisalReconciliationStats } | { measured: false; reason: string };

/** 群を組むのに要る、評定つきレコードの最小限の形。 */
interface CandidateRecord {
  id: string;
  /** 台帳＝`body` / 委譲＝`summary`。 */
  text: string;
  appraisal?: string;
  appraisedAt?: string;
  appraisalReason?: string;
  workKind?: string;
}

interface AppraisedCandidateRecord extends CandidateRecord {
  appraisal: string;
}

type KnownOrOther = 'good' | 'bad' | 'unclear' | 'other';

function classify(value: string): KnownOrOther {
  const known = appraisalSchema.safeParse(value);
  return known.success ? known.data : 'other';
}

function labelOf(value: string): string {
  const known = appraisalSchema.safeParse(value);
  return known.success ? APPRAISAL_LABELS[known.data] : value;
}

function countOf(records: readonly AppraisedCandidateRecord[]): Record<KnownOrOther, number> {
  const counts = { good: 0, bad: 0, unclear: 0, other: 0 };
  for (const record of records) counts[classify(record.appraisal)] += 1;
  return counts;
}

/** `appraisedAt` の新しい順（`undefined` は最後）。 */
function compareAppraisedAtDesc(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

/** 評定済みだけを残す。**未評定はここで群から外れる**（どの値にも数えない）。 */
function appraisedOnly(records: readonly CandidateRecord[]): AppraisedCandidateRecord[] {
  return records.filter(
    (record): record is AppraisedCandidateRecord => record.appraisal !== undefined,
  );
}

/** 「うまくいかなかった」か「判定できない」が1件以上ある群か。 */
function isCandidateGroup(records: readonly AppraisedCandidateRecord[]): boolean {
  const counts = countOf(records);
  return counts.bad + counts.unclear > 0;
}

/**
 * 候補の的になる種類の鍵（`workKindGroupKey` で寄せた後の値）を返す（純関数）。
 *
 * **呼び手（`clone.ts`）が、読む必要のあるやり方だけを読むために使う。** 全部の
 * やり方の本文と版を毎回読まないための口であって、ここで選んだ種類以外のやり方が
 * 「要らない」という判断ではない。台帳・委譲のどちらかで的になれば入る。
 */
export function practiceCandidateKindKeys(input: {
  commitments: CommitmentList;
  jobs: readonly Job[];
}): Set<string> {
  const keys = new Set<string>();
  for (const records of [commitmentRecords(input.commitments), jobRecords(input.jobs)]) {
    for (const group of groupByWorkKind(appraisedOnly(records), (r) => r.workKind)) {
      if (group.key !== null && isCandidateGroup(group.items)) keys.add(group.key);
    }
  }
  return keys;
}

function commitmentRecords(list: CommitmentList): CandidateRecord[] {
  return list.entries.map((entry) => ({
    id: entry.id,
    text: entry.body,
    appraisal: entry.appraisal,
    appraisedAt: entry.appraisedAt,
    appraisalReason: entry.appraisalReason,
    workKind: entry.workKind,
  }));
}

function jobRecords(jobs: readonly Job[]): CandidateRecord[] {
  return jobs.map((job) => ({
    id: job.id,
    text: job.summary,
    appraisal: job.appraisal,
    appraisedAt: job.appraisedAt,
    appraisalReason: job.appraisalReason,
    workKind: job.workKind,
  }));
}

function renderEvidenceLine(record: AppraisedCandidateRecord): string {
  const reason =
    record.appraisalReason === undefined
      ? '（理由: 無し）'
      : `（理由: ${excerptLine(record.appraisalReason, PRACTICE_CANDIDATE_REASON_LIMIT)}）`;
  return (
    `  - [${labelOf(record.appraisal)}] ${record.id}: ` +
    `${excerptLine(record.text, PRACTICE_CANDIDATE_LINE_LIMIT)}${reason}`
  );
}

function renderPracticeLine(practice: PracticeCandidateMaterial): string {
  const versions =
    practice.versions === undefined ? '版の数は読めなかった' : `版 ${practice.versions} 件`;
  return (
    `  - やり方 ${practice.slug}「${excerptLine(practice.title, 60)}」` +
    `（${versions}・更新 ${practice.updatedAt}）: ` +
    excerptLine(practice.content, PRACTICE_CANDIDATE_PRACTICE_EXCERPT_LIMIT)
  );
}

/** 1つの種類の群を1ブロックに組む（見出し・内訳・いまのやり方・証拠）。 */
function renderGroupBlock(params: {
  label: string;
  key: string;
  items: readonly AppraisedCandidateRecord[];
  practices: readonly PracticeCandidateMaterial[];
  continuationTool: string;
}): string {
  const { label, key, items, practices, continuationTool } = params;
  const counts = countOf(items);
  const head =
    `### 種類「${excerptLine(label, 40)}」 評定済み ${items.length} 件` +
    `（うまくいかなかった ${counts.bad} / 判定できない ${counts.unclear} / ` +
    `うまくいった ${counts.good} / 上の3値以外 ${counts.other}）`;

  const matched = practices.filter((practice) => workKindGroupKey(practice.kind) === key);
  const practiceLines =
    matched.length === 0
      ? ['  - この種類のやり方は器に無い（やり方が無いことは正常な状態である）。']
      : matched.map(renderPracticeLine);

  // **証拠に出すのは「うまくいかなかった」→「判定できない」の順。`good` は数だけ。**
  // 学びが残っているのはうまくいかなかった側だからである（段2 と同じ向き）。
  const evidence = items
    .filter((record) => {
      const value = classify(record.appraisal);
      return value === 'bad' || value === 'unclear';
    })
    .sort(
      (a, b) =>
        (classify(a.appraisal) === 'bad' ? 0 : 1) - (classify(b.appraisal) === 'bad' ? 0 : 1) ||
        compareAppraisedAtDesc(a.appraisedAt, b.appraisedAt),
    )
    .map(renderEvidenceLine);
  const evidenceListing = renderListing(evidence, {
    budget: PRACTICE_CANDIDATE_EVIDENCE_BUDGET,
    omitted: ({ rest, shown, total }) =>
      `  …ほか ${rest} 件は省略（全 ${total} 件のうち ${shown} 件だけ出した。` +
      `続きは ${continuationTool} で確認できる）。`,
  });

  return [head, '  いまのやり方:', ...practiceLines, '  証拠:', evidenceListing].join('\n');
}

function describeAxis(params: {
  heading: string;
  records: readonly CandidateRecord[];
  practices: readonly PracticeCandidateMaterial[];
  continuationTool: string;
  notices: readonly string[];
}): { text: string; groups: number } {
  const { heading, records, practices, continuationTool, notices } = params;
  const appraised = appraisedOnly(records);
  const unappraised = records.length - appraised.length;
  const groups = groupByWorkKind(appraised, (record) => record.workKind);
  const unclassified = countOf(groups.find((group) => group.key === null)?.items ?? []);

  // **並びは予算をどこから使うかの順であって、優先度の判定ではない**（冒頭の doc）。
  const candidates = groups
    .filter(
      (group): group is typeof group & { key: string } =>
        group.key !== null && isCandidateGroup(group.items),
    )
    .map((group) => ({ group, counts: countOf(group.items) }))
    .sort(
      (a, b) =>
        b.counts.bad - a.counts.bad ||
        b.counts.unclear - a.counts.unclear ||
        (a.group.key < b.group.key ? -1 : a.group.key > b.group.key ? 1 : 0),
    );

  const blocks = candidates.map(({ group }) =>
    renderGroupBlock({
      label: group.label,
      key: group.key,
      items: group.items,
      practices,
      continuationTool,
    }),
  );

  const listing =
    blocks.length === 0
      ? '（この軸には、うまくいかなかった／判定できないが付いた種類の群が無い）'
      : renderListing(blocks, {
          budget: PRACTICE_CANDIDATES_BUDGET,
          omitted: ({ rest, shown, total }) =>
            `…ほか ${rest} 種類は省略（全 ${total} 種類のうち ${shown} 種類だけ出した。` +
            `続きは ${continuationTool} と practice_list で確認できる）。`,
        });

  const lines = [
    heading,
    `評定済み ${appraised.length} 件・未評定 ${unappraised} 件（未評定はどの群にも数えていない）。` +
      `${UNCLASSIFIED_WORK_KIND_LABEL}（種類を述べていない評定）は ${unclassified.good + unclassified.bad + unclassified.unclear + unclassified.other} 件` +
      `（うまくいかなかった ${unclassified.bad} / 判定できない ${unclassified.unclear}）——` +
      'やり方は種類で引くので、群にはしていない。',
    ...notices,
    listing,
  ];
  return { text: lines.join('\n'), groups: blocks.length };
}

function describeReconciliation(reconciliation: PracticeCandidateReconciliation): string {
  const heading =
    '## 評定する側の較正の材料 —— (b) 人間の付け直し と (c) クローンの評定の食い違い' +
    '（#1310。軸ごとの全期間の数で、種類ごとには割っていない）';
  if (!reconciliation.measured) {
    return (
      `${heading}\n` +
      `測れなかった（理由: ${reconciliation.reason}）。**「食い違いが無い」とは読まないこと。** ` +
      'appraisal_stats で引き直せる。'
    );
  }
  return [
    heading,
    '### 引き受けた仕事（台帳）',
    ...renderReconciliation(reconciliation.stats.commitments),
    '### 委譲',
    ...renderReconciliation(reconciliation.stats.jobs),
    '上の群の件数はクローン自身の評定 (c) を多く含む。同じモデルが書いて同じモデルが評価した数である。',
  ].join('\n');
}

/**
 * 仕事の種類ごとに、評定が「うまくいかなかった／判定できない」へ傾いている群を、
 * 証拠・いまのやり方・較正の材料と一緒に並べる（#1055 段4）。
 *
 * **材料を並べるだけで、何も決めない。** 「このやり方を書き換えよ」「`bad` を
 * 付けるべき」とは書かない —— 基準の在り処は記憶であってプロンプトではなく、
 * 採るかどうかはクローンが決める（冒頭の ⛔）。
 *
 * `input.commitments` は `CommitmentList.list({ includeClosed: true })` の戻り値、
 * `input.jobs` は `JobStore.listJobs()` の戻り値をそのまま渡すこと（段2 と同じ）。
 */
export function describePracticeCandidates(input: {
  commitments: CommitmentList;
  jobs: readonly Job[];
  practices: readonly PracticeCandidateMaterial[];
  reconciliation: PracticeCandidateReconciliation;
}): string {
  const commitmentNotices: string[] = [];
  if (input.commitments.trimmedClosed > 0) {
    commitmentNotices.push(
      `⚠️ 古い片付き行が ${input.commitments.trimmedClosed} 件消えている（この器は保持上限を持つ）` +
        'ので、この軸の件数は全期間の実数ではない。',
    );
  }
  if (input.commitments.unreadable.length > 0) {
    commitmentNotices.push(
      `⚠️ 読めなかった行が ${input.commitments.unreadable.length} 件在るので、そのぶんはどの数にも入っていない。`,
    );
  }

  const commitmentAxis = describeAxis({
    heading: '## 引き受けた仕事（台帳）',
    records: commitmentRecords(input.commitments),
    practices: input.practices,
    continuationTool: 'commitment_list',
    notices: commitmentNotices,
  });
  const jobAxis = describeAxis({
    heading: '## 委譲（マネージャーへ出した仕事）',
    records: jobRecords(input.jobs),
    practices: input.practices,
    continuationTool: 'manager_list',
    notices: [
      '⚠️ 見ているのは台帳（JobStore）に降りた評定だけである。走行中の委譲の評定は、' +
        'その委譲が終端するまでここに現れないことがある（`ManagerPool.appraise` の doc）。',
    ],
  });

  const reconciliation = describeReconciliation(input.reconciliation);

  // **空の枝でも較正の材料と軸ごとの件数は出す。** 群が無いことの理由（評定が
  // 無い／種類を述べていない／うまくいった側だけ）は軸の1行目が数で持っている
  // ので、ここで原因を断言しない。
  if (commitmentAxis.groups === 0 && jobAxis.groups === 0) {
    return [
      '候補の的: うまくいかなかった／判定できないが付いた「種類を述べた評定」の群が、' +
        '台帳・委譲のどちらにも無い。**これは「やり方を変えなくてよい」ではない** —— ' +
        '評定は付けたときにしか残らず、種類は評定のときに述べたときにしか残らない。',
      '',
      commitmentAxis.text,
      '',
      jobAxis.text,
      '',
      reconciliation,
    ].join('\n');
  }

  return [
    '以下は、種類ごとに「うまくいかなかった／判定できない」が付いた群と、その種類のいまの' +
      'やり方を並べた**材料**である。群の並びは件数の順で、優先度の判定ではない。',
    '',
    commitmentAxis.text,
    '',
    jobAxis.text,
    '',
    reconciliation,
  ].join('\n');
}
