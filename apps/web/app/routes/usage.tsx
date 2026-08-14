import { formatUsd, summarizeUsage } from '@alteroid/core/usage';
import { useState } from 'react';

import { Page } from '~/components/page';
import { Badge, Card, CardHeader, Empty, ErrorNote, Input, Spinner } from '~/components/ui';
import { useUsage, type UsageQuery } from '~/hooks/queries';
import type { UsageRow } from '~/lib/types';

/**
 * `/usage` — alteroid が使った分（トークンと費用）。
 *
 * 経路は `GET /usage` の1本だけ（`apps/daemon/src/app.ts`「経路は1本だけにする」）。
 * CLI（`alteroid usage` / chat の `/usage`）・クローンの道具（`usage_read`）と
 * 同じものを見る。
 *
 * **算術は core（`summarizeUsage` / `formatUsd`）に任せる。** ここで足し直したり
 * 丸め直したりしない — 口ごとに数字が食い違うと、この画面自体が信用を失う。
 */

/** 軸ごとの表示上限。**打ち切ったら必ずそう書く**（黙って切り捨てない）。 */
const AXIS_LIMIT = 20;

export default function Usage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [managerId, setManagerId] = useState('');

  const query: UsageQuery = {
    ...(from === '' ? {} : { from }),
    ...(to === '' ? {} : { to }),
    ...(managerId === '' ? {} : { managerId }),
  };
  const { data, error, isLoading } = useUsage(query);

  return (
    <Page
      title="利用状況"
      description="alteroid が使った分（トークンと費用）。SDK の推定値であり、Anthropic の請求明細ではない"
    >
      <Card className="mb-4 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            from
            <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            to
            <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            manager
            <Input
              placeholder="manager id"
              value={managerId}
              onChange={(event) => setManagerId(event.target.value)}
            />
          </label>
        </div>
      </Card>

      <ErrorNote error={error} className="mb-4" />

      {isLoading ? (
        <Spinner />
      ) : data === undefined ? null : data.since === null ? (
        // **`$0.00` と出さない。** まだ台帳に1件も無いのを「使っていない」に見せない。
        <Card>
          <Empty>
            台帳にはまだ1件も記録が無い。（消費の記録はこの機能を入れた時点から始まる。それより前の分は残っていない）
          </Empty>
        </Card>
      ) : (
        <UsageBody
          rows={data.rows}
          since={data.since}
          beforeLedger={data.beforeLedger}
          notice={data.notice}
        />
      )}
    </Page>
  );
}

function UsageBody({
  rows,
  since,
  beforeLedger,
  notice,
}: {
  rows: readonly UsageRow[];
  since: string;
  beforeLedger: boolean;
  notice: string;
}) {
  const summary = summarizeUsage(rows);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="合計" subtitle={`台帳の始点: ${since}`} />
        <div className="px-4 py-3">
          {rows.length === 0 ? (
            <Empty>その範囲には記録が無い。</Empty>
          ) : (
            <>
              <p className="text-2xl font-semibold">{formatUsd(summary.total.costUsd)}</p>
              <p className="mt-1 text-xs text-muted">
                入力 {summary.total.inputTokens.toLocaleString('en-US')} / 出力{' '}
                {summary.total.outputTokens.toLocaleString('en-US')} / キャッシュ読み{' '}
                {summary.total.cacheReadInputTokens.toLocaleString('en-US')} / キャッシュ書き{' '}
                {summary.total.cacheCreationInputTokens.toLocaleString('en-US')}
              </p>
            </>
          )}
          {beforeLedger && (
            // **0 と言わない。** 台帳が無かった期間を「使っていない期間」と読ませない。
            <p className="mt-3 text-xs text-warn">
              照会した範囲は台帳の始点より前にかかっている。その分は 0 ではなく「記録が無い」。
            </p>
          )}
        </div>
      </Card>

      {rows.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-3">
          <AxisCard
            title="日別"
            entries={[...summary.byDate]
              .reverse()
              .map((entry) => ({ label: entry.date, costUsd: entry.totals.costUsd }))}
          />
          <AxisCard
            title="マネージャー別"
            entries={[...summary.byManager]
              .sort((a, b) => b.totals.costUsd - a.totals.costUsd)
              .map((entry) => ({ label: entry.managerId, costUsd: entry.totals.costUsd }))}
          />
          <AxisCard
            title="モデル別"
            entries={[...summary.byModel]
              .sort((a, b) => b.totals.costUsd - a.totals.costUsd)
              .map((entry) => ({ label: entry.model, costUsd: entry.totals.costUsd }))}
          />
        </div>
      )}

      {/* **省略・要約しない。数字を出すところには必ず添える。** */}
      <p className="text-xs text-muted">{notice}</p>
    </div>
  );
}

function AxisCard({
  title,
  entries,
}: {
  title: string;
  entries: { label: string; costUsd: number }[];
}) {
  const shown = entries.slice(0, AXIS_LIMIT);

  return (
    <Card>
      <CardHeader title={title} action={<Badge>{entries.length}</Badge>} />
      {shown.length === 0 ? (
        <Empty>無し。</Empty>
      ) : (
        <ul>
          {shown.map((entry) => (
            <li
              key={entry.label}
              className="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-sm last:border-b-0"
            >
              <span className="min-w-0 truncate font-mono text-[11px] text-muted">
                {entry.label}
              </span>
              <span className="shrink-0">{formatUsd(entry.costUsd)}</span>
            </li>
          ))}
        </ul>
      )}
      {entries.length > AXIS_LIMIT && (
        // **打ち切ったら必ずそう書く。** 黙って切り捨てると「全部でこれだけ」と読める出力が嘘になる。
        <p className="border-t border-border px-4 py-2 text-[11px] text-muted">
          …残り {entries.length - AXIS_LIMIT} 件は出していない
        </p>
      )}
    </Card>
  );
}
