import { Page } from '~/components/page';
import { Card, CardHeader, Empty, ErrorNote, Spinner } from '~/components/ui';
import { useAppraisalStats } from '~/hooks/queries';
import { ApiError } from '~/lib/api';
import type {
  AppraisalDecisionTally,
  AppraisalReconciliation,
  AppraisalReconciliationTransition,
  AppraisalStats,
  AppraisalWorkKindTally,
  JobAppraisalCoverageRow,
} from '~/lib/types';

/**
 * `/appraisal-stats` — 評定（`good`/`bad`/`unclear`/未評定）の内訳を読む
 * （issue #1278「評定の内訳を要るときに数える口が無い」の HTTP 面、
 * issue #1620「入口の等価性——CLI・Web に読む口が無い」の **Web 面**）。
 *
 * **この PR は #1620 の Web 面だけを閉じる。** CLI 側（サブコマンドを1本足す
 * 案）は別の担当・別の PR が持つ——このファイルの doc は Web の話だけをする。
 *
 * 経路は `GET /appraisal-stats` の1本だけで、クローンの MCP 道具
 * `appraisal_stats`（`packages/core/src/appraisal-stats.ts` の
 * `describeAppraisalStats`）と同じ集計（`computeAppraisalJournalStats` /
 * `computeJobAppraisalCoverage` / `computeAppraisalReconciliation`）を見る。
 * **読み取り専用。クエリ引数は無い**（`useAppraisalStats` の doc）。
 *
 * ## なぜ既存の画面に足さず、新しい画面にしたか
 *
 * 評定の入口そのもの（1件ずつ付け直す `AppraisalControl`）は既に2箇所に
 * 在る——`commitments.tsx`（台帳の軸）と `manager-detail.tsx`（委譲の軸）。
 * だがこの内訳は**その2軸を跨いで集計したもの**（`journal.commitments` /
 * `journal.jobs` を並べて出し、混ぜないよう注記する）で、加えて
 * `jobCoverage`（委譲側の終端の仕方ごとの内訳）と `reconciliation`（人間と
 * クローンの食い違い）という、どちらの個票にも属さない軸を持つ。片方の画面に
 * 埋めると、もう片方の軸だけがその画面に無い一覧になり、読む側は「なぜここに
 * この数字が」を個票の文脈で読むことになる。
 *
 * **先例は `dropped.tsx` / `archive.tsx` / `inbox.tsx`。** これらも「個票の
 * 一覧ではなく、集計・跡だけを持つ GET 専用エンドポイント」を1画面1経路の
 * 形で `routes.ts` / `shell.tsx` の可観測性の並びに置いている——この画面も
 * 同じ形に合わせた。
 */
export default function AppraisalStatsPage() {
  const { data, error, isLoading } = useAppraisalStats();

  return (
    <Page
      title="評定の内訳"
      description="良かった／悪かった／判定できない／未評定の内訳。読み取り専用。台帳（未了の仕事）と委譲（マネージャー）を跨いで集計する"
    >
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader
            title="件数（軸ごと）"
            subtitle="alteroid の appraisal_stats / GET /appraisal-stats と同じもの"
          />
          <AppraisalStatsErrorNote error={error} />
          {isLoading && data === undefined ? (
            <div className="px-4 py-3">
              <Spinner />
            </div>
          ) : data === undefined ? null : (
            <TallyCard journal={data.journal} />
          )}
        </Card>

        {data !== undefined && (
          <>
            <WorkKindCard journal={data.journal} />
            <JobCoverageCard jobCoverage={data.jobCoverage} />
            <ReconciliationCard reconciliation={data.reconciliation} />
          </>
        )}
      </div>
    </Page>
  );
}

/**
 * **404 は「この口を持たない古いデーモン」専用の文言にする。** `dropped.tsx`
 * の同名の関数と同じ判断——汎用の `ErrorNote` に投げっぱなしにすると、
 * 「評定行が無い」（0件）と「この版のデーモンにこの口が無い」の違いが読み手に
 * 伝わらない。
 */
function AppraisalStatsErrorNote({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 404) {
    return (
      <div className="px-4 pt-3 text-sm text-danger">
        このデーモンには GET /appraisal-stats が無い（版が古い可能性がある。デーモンを
        更新してください）。評定行が0件だった、という意味ではない。
      </div>
    );
  }
  return <ErrorNote error={error} className="m-4" />;
}

/** 評定の3値 + `other` の日本語ラベル（`good`→`bad`→`unclear`→`other` の順で並べる）。 */
const TALLY_ROWS: readonly { key: 'good' | 'bad' | 'unclear' | 'other'; label: string }[] = [
  { key: 'good', label: '良かった' },
  { key: 'bad', label: '悪かった' },
  { key: 'unclear', label: '判定できない' },
  { key: 'other', label: 'その他（3値以外）' },
];

function renderTallyLine(tally: AppraisalDecisionTally): string {
  const parts = TALLY_ROWS.map((row) => `${row.label} ${tally[row.key]}`).join(' / ');
  return `評定行 ${tally.total} 件（${parts}）`;
}

function TallyCard({ journal }: { journal: AppraisalStats['journal'] }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3 text-sm">
      <div>
        <p className="text-xs text-muted">引き受けた仕事（台帳）</p>
        <p>{renderTallyLine(journal.commitments)}</p>
      </div>
      <div>
        <p className="text-xs text-muted">委譲（マネージャー）</p>
        <p>{renderTallyLine(journal.jobs)}</p>
      </div>
      <p className="text-xs text-warn">
        ⚠️ 上の2つは別の軸である。混ぜて比べないこと（台帳の行の始末と、マネージャーに
        出した仕事の出来は違う軸——`appraisal-stats.ts` の doc）。
      </p>
    </div>
  );
}

/** 種類を述べていない評定の群の名前（Web 版の複製）。 */
const UNCLASSIFIED_WORK_KIND_LABEL_NOTE = '未分類';

/**
 * 仕事の種類ごとの評定行（issue #1308 段B）。
 *
 * **高さに上限を付けて、一覧を下のカードへ押し出さない側にする**（`workKind`
 * は器で列挙にしない自由文なので、`schedule.tsx` の本文プレビューと同じ理由で
 * 件数が運任せに伸びうる）。`GET /appraisal-stats` 自体は上限を持たない
 * （意図——人間はブラウザで扱えるので、ここを締めると人間側の能力が落ちる。
 * `.claude/skills/listing-and-detail/SKILL.md`「HTTP の口は上限を持たない」）
 * ——だから**データそのものは1件も切り捨てず**、`max-h-64` + `overflow-y-auto`
 * でスクロールに逃がす（`schedule.tsx` の `PracticeBody` と同じ形）。
 */
function WorkKindCard({ journal }: { journal: AppraisalStats['journal'] }) {
  return (
    <Card>
      <CardHeader
        title="仕事の種類ごとの評定行（#1308）"
        subtitle="評定行の構造欄が述べた種類。表記ゆれは空白・大小文字・互換文字だけ寄せる"
      />
      <div className="flex flex-col gap-3 px-4 py-3 text-sm">
        <WorkKindList title="引き受けた仕事" tallies={journal.byWorkKind.commitments} />
        <WorkKindList title="委譲" tallies={journal.byWorkKind.jobs} />
        <p className="text-xs text-muted">
          ⚠️ {UNCLASSIFIED_WORK_KIND_LABEL_NOTE}は種類の1つではない（#1308 より前の評定行・
          種類を述べていない評定行）。どれかの種類へ寄せて読まないこと。
        </p>
      </div>
    </Card>
  );
}

function WorkKindList({
  title,
  tallies,
}: {
  title: string;
  tallies: readonly AppraisalWorkKindTally[];
}) {
  return (
    <div>
      <p className="mb-1 text-xs text-muted">{title}</p>
      {tallies.length === 0 ? (
        <Empty>（評定行が無い）</Empty>
      ) : (
        <ul className="max-h-64 overflow-y-auto rounded-md border border-border">
          {tallies.map((tally, index) => (
            <li
              key={`${tally.workKind ?? ''}-${index}`}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-2 py-1.5 text-xs last:border-b-0"
            >
              <span className="font-mono break-all">
                {tally.workKind ?? UNCLASSIFIED_WORK_KIND_LABEL_NOTE}
              </span>
              <span className="shrink-0">{renderTallyLine(tally)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 終端した委譲の状態の日本語ラベル。
 *
 * **`@alteroid/core` から実行時の値を import しない**（`commitments.tsx` の
 * `appraisalLabel` と同じ作法）。**網羅性は `never` で強制する**——デーモンの
 * `jobStatusSchema` に値が増えたのに、ここが追いついていないと `pnpm typecheck`
 * が落ちる。**それでも実行時の倒れ先を残す**——デーモンと Web は別デプロイ
 * なので、版がずれてビルド後に未知の値が届くことがある（`AGENTS.md`「型で
 * 塞いだ分岐にも、実行時の倒れ先の歯を足す」）。倒れ先はその値をそのまま
 * 文字列として出すだけで、画面を落とさない。
 */
function jobStatusLabel(status: JobAppraisalCoverageRow['status']): string {
  switch (status) {
    case 'done':
      return '完了';
    case 'failed':
      return '失敗';
    case 'lost':
      return 'セッションへ戻れず';
    case 'stopped':
      return '停止済み';
    case 'running':
      return '実行中';
    case 'waiting_human':
      return '人間待ち';
    default: {
      const unreachable: never = status;
      void unreachable;
      return String(status);
    }
  }
}

function JobCoverageCard({ jobCoverage }: { jobCoverage: AppraisalStats['jobCoverage'] }) {
  return (
    <Card>
      <CardHeader
        title="委譲の評定の有無（終端の仕方ごと）"
        subtitle="running / waiting_human（まだ終端していない）は対象外"
      />
      <div className="flex flex-col gap-2 px-4 py-3 text-sm">
        <ul className="flex flex-col gap-1">
          {jobCoverage.byStatus.map((row) => (
            <li key={row.status} className="flex flex-wrap items-center justify-between gap-2">
              <span>{jobStatusLabel(row.status)}</span>
              <span className="text-xs text-muted">
                終端 {row.total} 件（評定あり {row.appraised} / 評定なし {row.unappraised}）
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs">
          合計: 終端した委譲 {jobCoverage.terminalTotal} 件中、評定なしが{' '}
          {jobCoverage.terminalUnappraised} 件（評定あり {jobCoverage.terminalAppraised} 件）。
        </p>
        <p className="text-xs text-muted">
          （参考・この集計の対象外: running/waiting_human で終端していない委譲が{' '}
          {jobCoverage.nonTerminalTotal} 件。まだ続きうるので「評定が無い」を欠落として
          数えていない）
        </p>
      </div>
    </Card>
  );
}

/** `AppraisalValue | 'other'` の日本語ラベル（未知の値はそのまま返す）。 */
function reconciliationValueLabel(value: AppraisalReconciliationTransition['cloneValue']): string {
  switch (value) {
    case 'good':
      return '良かった';
    case 'bad':
      return '悪かった';
    case 'unclear':
      return '判定できない';
    case 'other':
      return 'その他（3値以外）';
    default: {
      const unreachable: never = value;
      void unreachable;
      return String(value);
    }
  }
}

function ReconciliationCard({
  reconciliation,
}: {
  reconciliation: AppraisalStats['reconciliation'];
}) {
  return (
    <Card>
      <CardHeader
        title="人間とクローンの食い違い（#1055 段4）"
        subtitle="クローンが付けた評定を人間が後から付け直した対"
      />
      <div className="flex flex-col gap-4 px-4 py-3 text-sm">
        <ReconciliationAxis title="引き受けた仕事" reconciliation={reconciliation.commitments} />
        <ReconciliationAxis title="委譲" reconciliation={reconciliation.jobs} />
        <p className="text-xs text-muted">⚠️ 上の2つも別の軸である。混ぜて比べないこと。</p>
      </div>
    </Card>
  );
}

function ReconciliationAxis({
  title,
  reconciliation,
}: {
  title: string;
  reconciliation: AppraisalReconciliation;
}) {
  return (
    <div>
      <p className="mb-1 text-xs text-muted">{title}</p>
      {reconciliation.totalPairs === 0 ? (
        <Empty>（クローンが付けた評定を人間が付け直した対は無い）</Empty>
      ) : (
        <>
          <ul className="flex flex-col gap-0.5 text-xs">
            {reconciliation.transitions.map((transition, index) => (
              <li key={index}>
                クローン「{reconciliationValueLabel(transition.cloneValue)}」→人間「
                {reconciliationValueLabel(transition.humanValue)}」: {transition.count} 件（
                {transition.cloneValue === transition.humanValue ? '一致' : '食い違い'}）
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs">
            合計: {reconciliation.totalPairs} 対（一致 {reconciliation.matched} / 食い違い{' '}
            {reconciliation.mismatched}）。
          </p>
        </>
      )}
      {/*
        **0件でも常に出す**（`undetermined` は「無かった」であって「測っていない」
        ではない——AGENTS.md「取れない軸に 0 の行を作る」の裏返し。ここは逆に、
        0件という実測値を「測っていない」と読ませないために毎回出す）。
      */}
      <p className="mt-1 text-xs text-muted">
        ⚠️ 判定できない（id または「誰が付けたか」が復元できなかった）評定行:{' '}
        {reconciliation.undetermined} 件（0件は「無かった」であって「測っていない」ではない）。
      </p>
    </div>
  );
}
