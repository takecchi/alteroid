import { SettingsTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { settingsDocumentTitle } from '~/lib/nav';
import {
  describeUnmeteredUsage,
  describeUnreadableUsage,
  describeUnreadableUsageRows,
  describeUsageDateOrder,
  describeWebSearchRequests,
  formatUsd,
  isDelegationActorId,
  isRealUsageDate,
  summarizeUsage,
  USAGE_DATE_PATTERN,
  USAGE_LAYERS,
  USAGE_SITES,
  CLONE_ACTOR_ID,
  type UnreadableUsageRow,
} from '@alteroid/core/usage';
import { useId, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';

import {
  Page,
  Badge,
  BarList,
  Button,
  Card,
  CardHeader,
  cn,
  Empty,
  Input,
  Select,
  Spinner,
  WarnNote,
} from '@alteroid/ui';
import { useManagers, useTokens, useUsage, type UsageQuery } from '@alteroid/swr';
import {
  describeAccountUsageView,
  formatDateTime,
  tokensHref,
  usageLayerLabel,
  usageSiteLabel,
  USAGE_LAYER_LABELS,
  USAGE_SITE_LABELS,
  USAGE_FROM_PARAM,
  USAGE_MANAGER_ID_PARAM,
  USAGE_TO_PARAM,
} from '@alteroid/logic';
import type {
  AccountUsageState,
  UnrecordedManager,
  UsageLayer,
  UsageRow,
  UsageSite,
  UsageTurnRow,
  UsageUnmeteredRow,
} from '@alteroid/logic';

// 算術は core に任せる。ここで足し直す・丸め直すと、口ごとに数字が食い違う。

const AXIS_LIMIT = 20;

/** 0件・欄なし（古いデーモン）なら描かない。文言は core が出した行をそのまま並べる。 */
export function UnreadableUsageRowsNote({
  rows,
  className,
}: {
  rows: readonly UnreadableUsageRow[] | undefined;
  className?: string;
}) {
  const lines = describeUnreadableUsageRows(rows);
  if (lines.length === 0) return null;
  return <WarnNote className={className}>{lines.join(' ')}</WarnNote>;
}

/** 0 ではなく「取れなかった」と言う。0件・欄なしなら描かない。文言は core をそのまま並べる。 */
export function UnmeteredUsageNote({
  rows,
  className,
}: {
  rows: readonly UsageUnmeteredRow[] | undefined;
  className?: string;
}) {
  const lines = describeUnmeteredUsage(rows);
  if (lines.length === 0) return null;
  return <WarnNote className={className}>{lines.join(' ')}</WarnNote>;
}

// `from` / `to` / `managerId` は logic の正本を使う。他画面のリンク組み立てと欄名を書き写すと、片方だけ変わる経路が生まれる。
const FROM_PARAM = USAGE_FROM_PARAM;
const TO_PARAM = USAGE_TO_PARAM;
const MANAGER_ID_PARAM = USAGE_MANAGER_ID_PARAM;
const LAYER_PARAM = 'layer';
const SITE_PARAM = 'site';
const TOKEN_ID_PARAM = 'tokenId';

/** `searchParams.get` は先頭の値しか返さない。重複を黙って採ると、人が書いた2つ目の指定が無視されたことに気付けない。 */
function duplicateParamNotices(searchParams: URLSearchParams): string[] {
  const labels: Array<[string, string]> = [
    [FROM_PARAM, '開始日'],
    [TO_PARAM, '終了日'],
    [MANAGER_ID_PARAM, 'マネージャー'],
    [LAYER_PARAM, '「誰が」'],
    [SITE_PARAM, '「どこで」'],
    [TOKEN_ID_PARAM, '認証トークン'],
  ];
  return labels
    .filter(([param]) => searchParams.getAll(param).length > 1)
    .map(([, label]) => `${label}の指定が複数あるので、先頭の値を使っています`);
}

// 知らない値は API へ渡さず絞り込み無しにするが、黙って読み替えない（「すべて」の数字が指定した絞り込みの数字に見えるため）。捨てたことは呼び出し側が raw と戻り値を突き合わせて注記で言う。
function parseUsageLayer(raw: string | null): UsageLayer | '' {
  if (raw === null) return '';
  return (USAGE_LAYERS as readonly string[]).includes(raw) ? (raw as UsageLayer) : '';
}

function parseUsageSite(raw: string | null): UsageSite | '' {
  if (raw === null) return '';
  return (USAGE_SITES as readonly string[]).includes(raw) ? (raw as UsageSite) : '';
}

const RAW_VALUE_MAX = 40;
function clipRawValue(raw: string): string {
  const chars = Array.from(raw);
  return chars.length > RAW_VALUE_MAX ? `${chars.slice(0, RAW_VALUE_MAX).join('')}…` : raw;
}

/**
 * 読めない値は捨てて「絞り込み無し」にする。空文字は「読めない」とは扱わない（絞り込み無しと等価）。
 * 形と実在の判定は core のものを使い、私家版の判定へ戻さない（デーモンの 400 とずれるため）。
 * export はテストのため。
 */
export function parseUsageDate(raw: string | null): string {
  if (raw === null || raw === '') return '';
  if (!USAGE_DATE_PATTERN.test(raw)) return '';
  return isRealUsageDate(raw) ? raw : '';
}

const UNKNOWN_MANAGER = '（一覧に無い委譲）';
const UNKNOWN_TOKEN = '（一覧に無い認証トークン）';

const UNREADABLE_MANAGER_NAMES =
  '委譲の一覧を読めていないので、名前を出せない。委譲は id の先頭8文字で示している。';
const UNREADABLE_TOKEN_NAMES =
  '認証トークンの一覧を読めていないので、名前を出せない。認証トークンは id の先頭8文字で示している。';

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function UnreadableNamesNote({ lines }: { lines: readonly string[] }) {
  if (lines.length === 0) return null;
  return <WarnNote>{lines.join(' ')}</WarnNote>;
}

interface IdLabels {
  manager: (id: string) => string;
  token: (id: string) => string;
}

function shortenRequest(request: string): string {
  const flat = request.replace(/\s+/g, ' ').trim();
  if (flat === '') return '（依頼文なし）';
  return flat.length > 28 ? `${flat.slice(0, 28)}…` : flat;
}

function FilterField({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * 現在の値が候補に無くても消さない（消すと、絞り込みが効いているのに欄は「すべて」に見える）。
 * 「一覧に無い」と言えるのは一覧を読めたとき（`listLoaded`）だけ。
 */
function CandidateSelect({
  id,
  value,
  options,
  listLoaded,
  unknownLabel,
  onChange,
}: {
  id: string;
  value: string;
  options: readonly { value: string; label: string }[];
  listLoaded: boolean;
  unknownLabel: string;
  onChange: (value: string) => void;
}) {
  const known = value === '' || options.some((option) => option.value === value);
  return (
    <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">すべて</option>
      {!known && <option value={value}>{listLoaded ? unknownLabel : shortId(value)}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}

export default function Usage() {
  // 絞り込みの正本は URL。state に閉じ込めると、開き直すと消える・共有できない。
  const [searchParams, setSearchParams] = useSearchParams();
  const rawFrom = searchParams.get(FROM_PARAM);
  const rawTo = searchParams.get(TO_PARAM);
  const from = parseUsageDate(rawFrom);
  const to = parseUsageDate(rawTo);
  const invalidFrom = rawFrom !== null && rawFrom !== '' && from === '' ? rawFrom : null;
  const invalidTo = rawTo !== null && rawTo !== '' && to === '' ? rawTo : null;
  const managerId = searchParams.get(MANAGER_ID_PARAM) ?? '';
  const rawLayer = searchParams.get(LAYER_PARAM);
  const rawSite = searchParams.get(SITE_PARAM);
  const layer = parseUsageLayer(rawLayer);
  const site = parseUsageSite(rawSite);
  const invalidLayer = rawLayer !== null && rawLayer !== '' && layer === '' ? rawLayer : null;
  const invalidSite = rawSite !== null && rawSite !== '' && site === '' ? rawSite : null;
  const tokenId = searchParams.get(TOKEN_ID_PARAM) ?? '';
  const idPrefix = useId();
  // 一覧が取れなくても URL の値で絞り込めるので、一覧の失敗は画面のエラーにしない。
  const { data: managersData, error: managersError } = useManagers();
  const { data: tokensData, error: tokensError } = useTokens();
  const managerOptions = (managersData?.managers ?? []).map((manager) => ({
    value: manager.managerId,
    label: `${shortenRequest(manager.request)}（${formatDateTime(manager.startedAt)}）`,
  }));
  const tokenOptions = (tokensData?.tokens ?? []).map((token) => ({
    value: token.id,
    label: token.label,
  }));
  // 一覧が取れていないとき（読み込み中・失敗）は「一覧に無い」と言えないので、id の先頭だけで区別する。
  // id は秘密ではない（秘密は認証トークンの `value` で、API は id しか出さない）。名前の方が読みやすいので名前を優先しているだけで、id を隠す意図ではない。
  const labels: IdLabels = {
    manager: (id) =>
      managersData === undefined
        ? shortId(id)
        : (managerOptions.find((option) => option.value === id)?.label ?? UNKNOWN_MANAGER),
    token: (id) =>
      tokensData === undefined
        ? shortId(id)
        : (tokenOptions.find((option) => option.value === id)?.label ?? UNKNOWN_TOKEN),
  };
  const unreadableNames = [
    ...(managersError !== undefined && managersData === undefined
      ? [UNREADABLE_MANAGER_NAMES]
      : []),
    ...(tokensError !== undefined && tokensData === undefined ? [UNREADABLE_TOKEN_NAMES] : []),
  ];

  function setFilter(param: string, value: string) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value === '') next.delete(param);
        else next.set(param, value);
        return next;
      },
      { replace: true },
    );
  }

  const query: UsageQuery = {
    ...(from === '' ? {} : { from }),
    ...(to === '' ? {} : { to }),
    ...(managerId === '' ? {} : { managerId }),
    ...(layer === '' ? {} : { layer }),
    ...(site === '' ? {} : { site }),
    ...(tokenId === '' ? {} : { tokenId }),
  };
  const { data, error, isLoading, isValidating, mutate } = useUsage(query);
  const queryKey = JSON.stringify(query);
  const [okQueryKey, setOkQueryKey] = useState<string>();
  if (data !== undefined && error === undefined && !isLoading && okQueryKey !== queryKey) {
    setOkQueryKey(queryKey);
  }
  const showsOtherQuery = error !== undefined && data !== undefined && okQueryKey !== queryKey;

  // 黙って捨てない: 読めなかった生の値をそのまま画面に出す（人間が書いた URL の値であって秘密ではない）。
  const filterNotices: string[] = duplicateParamNotices(searchParams);
  if (invalidFrom !== null) {
    filterNotices.push(
      `開始日に指定された値（${invalidFrom}）は日付として読めないので、絞り込みに使っていません`,
    );
  }
  if (invalidTo !== null) {
    filterNotices.push(
      `終了日に指定された値（${invalidTo}）は日付として読めないので、絞り込みに使っていません`,
    );
  }
  if (invalidLayer !== null) {
    filterNotices.push(
      `「誰が」に指定された値（${clipRawValue(invalidLayer)}）は選べないので、絞り込みに使っていません`,
    );
  }
  if (invalidSite !== null) {
    filterNotices.push(
      `「どこで」に指定された値（${clipRawValue(invalidSite)}）は選べないので、絞り込みに使っていません`,
    );
  }
  // `to < from` はデーモンが検査せず0件になり、「本当に記録が無い」と区別が付かないので、隣に理由を足す。
  const dateOrderNotice = describeUsageDateOrder(
    from === '' ? undefined : from,
    to === '' ? undefined : to,
  );
  if (dateOrderNotice !== null) {
    filterNotices.push(dateOrderNotice);
  }

  return (
    <Page
      tabs={<SettingsTabs />}
      documentTitle={settingsDocumentTitle('/usage')}
      title="利用状況"
      description="alteroid が使った分（トークンと費用）。推定値であり、Anthropic の請求明細ではありません"
    >
      <Card className="mb-4 p-4">
        {/*
          `grid-cols-1` を外さない: 基底が無いと暗黙トラックが auto（max-content）になり、中身の幅で `Card` の枠を超える。
          `type="date"` の `Input` の `min-w-0` も外さない: 内在幅が大きく（特に iOS Safari）、実機で確かめられないので二重に押さえてある。
        */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FilterField id={`${idPrefix}-from`} label="開始日">
            <Input
              id={`${idPrefix}-from`}
              type="date"
              className="min-w-0"
              value={from}
              onChange={(event) => setFilter(FROM_PARAM, event.target.value)}
            />
          </FilterField>
          <FilterField id={`${idPrefix}-to`} label="終了日">
            <Input
              id={`${idPrefix}-to`}
              type="date"
              className="min-w-0"
              value={to}
              onChange={(event) => setFilter(TO_PARAM, event.target.value)}
            />
          </FilterField>
          <FilterField id={`${idPrefix}-manager`} label="マネージャー">
            <CandidateSelect
              id={`${idPrefix}-manager`}
              value={managerId}
              options={managerOptions}
              listLoaded={managersData !== undefined}
              unknownLabel={UNKNOWN_MANAGER}
              onChange={(value) => setFilter(MANAGER_ID_PARAM, value)}
            />
          </FilterField>
          <FilterField id={`${idPrefix}-layer`} label="誰が">
            <Select
              id={`${idPrefix}-layer`}
              value={layer}
              onChange={(event) => setFilter(LAYER_PARAM, event.target.value)}
            >
              <option value="">すべて</option>
              {USAGE_LAYERS.map((value) => (
                <option key={value} value={value}>
                  {USAGE_LAYER_LABELS[value]}
                </option>
              ))}
            </Select>
          </FilterField>
          <FilterField id={`${idPrefix}-site`} label="どこで">
            <Select
              id={`${idPrefix}-site`}
              value={site}
              onChange={(event) => setFilter(SITE_PARAM, event.target.value)}
            >
              <option value="">すべて</option>
              {USAGE_SITES.map((value) => (
                <option key={value} value={value}>
                  {USAGE_SITE_LABELS[value]}
                </option>
              ))}
            </Select>
          </FilterField>
          <FilterField id={`${idPrefix}-token`} label="認証トークン">
            <CandidateSelect
              id={`${idPrefix}-token`}
              value={tokenId}
              options={tokenOptions}
              listLoaded={tokensData !== undefined}
              unknownLabel={UNKNOWN_TOKEN}
              onChange={(value) => setFilter(TOKEN_ID_PARAM, value)}
            />
          </FilterField>
        </div>
      </Card>

      {filterNotices.map((line) => (
        <p key={line} className="mb-4 text-xs text-warn">
          {line}
        </p>
      ))}

      <LoadError
        what="使用量"
        error={error}
        onRetry={() => mutate()}
        retrying={isValidating}
        className="mb-4"
      />

      {showsOtherQuery && (
        <p className="mb-4 text-xs text-warn">
          新しい条件では読み込めなかった。下は前の条件の数字。
        </p>
      )}

      {/* `keepPreviousData` のとき `isLoading` は別の条件の初回読み込みでも真になる。スピナーにしてよいのは出せるデータが無いときだけ。 */}
      {isLoading && data === undefined ? (
        <Spinner />
      ) : data === undefined ? null : (
        <div className="flex flex-col gap-4" aria-busy={isLoading}>
          {isLoading && (
            <p role="status" className="text-xs text-muted-foreground">
              前の条件の数字を表示しています。新しい条件で読み込み中です。
            </p>
          )}
          {/* 台帳が空でも出す。片方を理由にもう片方を隠すと、枠の状態が画面から消える。 */}
          <AccountCard account={data.account} />
          <UnreadableNamesNote lines={unreadableNames} />
          {data.since === null ? (
            <>
              {/* `$0.00` と出さない。まだ1件も無いのを「使っていない」に見せない。 */}
              <Card>
                <Empty inset="card">
                  {describeUnreadableUsageRows(data.unreadableRows).length > 0
                    ? '読めた使用量の記録はありません。読めずに外した行があります（下の注記）。'
                    : 'まだ使用量の記録がありません。会話を始めると、ここに出ます。'}
                </Empty>
                <ReadingGuide>
                  <li>
                    使用量の記録は、この機能を入れた時点から始まります。それより前の分は残っていません。
                  </li>
                </ReadingGuide>
              </Card>
              <UnreadableUsageRowsNote rows={data.unreadableRows} />
              <UnmeteredUsageNote rows={data.unmeteredRows} />
              <UnrecordedManagersCard
                unrecordedManagers={data.unrecordedManagers}
                labels={labels}
              />
            </>
          ) : (
            <UsageBody
              rows={data.rows}
              turnRows={data.turnRows}
              since={data.since}
              layersSince={data.layersSince}
              tokensSince={data.tokensSince}
              beforeLedger={data.beforeLedger}
              beforeLayers={data.beforeLayers}
              beforeTokens={data.beforeTokens}
              notice={data.notice}
              unrecordedManagers={data.unrecordedManagers}
              labels={labels}
              unreadableRows={data.unreadableRows}
              unmeteredRows={data.unmeteredRows}
            />
          )}
        </div>
      )}
    </Page>
  );
}

/**
 * 文言を画面で書き直さない（面ごとに「取れなかった」の言い方が分かれ、片方だけが 0 と描く）。
 * 台帳のカードと同じ見た目に混ぜない（自分で数えた推定値と向こうの値は一致する保証がない）。
 */
function AccountCard({ account }: { account: AccountUsageState | undefined }) {
  const view = describeAccountUsageView(account);
  return (
    <Card>
      <CardHeader
        title="アカウント全体の残り（Claude 側の値）"
        subtitle="下の記録（alteroid が使った分）とは別物です。足さないでください"
      />
      <div className="flex flex-col gap-2 px-4 py-3">
        {view.headline !== undefined && (
          <p className={cn('text-sm', view.tone === 'warn' ? 'text-warn' : 'text-foreground')}>
            {view.headline}
          </p>
        )}
        {view.action !== undefined && (
          <p className="text-sm text-muted-foreground">{view.action}</p>
        )}
        {view.lines.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {view.lines.map((line, index) => (
              <li
                key={`${index}-${line}`}
                className="text-sm break-words whitespace-pre-wrap text-muted-foreground"
              >
                {line}
              </li>
            ))}
          </ul>
        )}
        {view.details.length > 0 && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">詳しい情報（開発者向け）</summary>
            <ul className="mt-2 flex flex-col gap-0.5">
              {view.details.map((line, index) => (
                <li
                  key={`${index}-${line}`}
                  className="font-mono text-[11px] break-words whitespace-pre-wrap"
                >
                  {line}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Card>
  );
}

function ReadingGuide({ children }: { children: ReactNode }) {
  return (
    <details className="border-t px-4 py-3 text-xs text-muted-foreground">
      <summary className="cursor-pointer">記録の読み方</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5">{children}</ul>
    </details>
  );
}

/** 0件でも必ず出す。空配列は「調べていない」ではなく「取りこぼしが無い」。 */
function UnrecordedManagersCard({
  unrecordedManagers,
  labels,
}: {
  unrecordedManagers: readonly UnrecordedManager[];
  labels: IdLabels;
}) {
  if (unrecordedManagers.length === 0) {
    return (
      <Card>
        <CardHeader title="記録の無い委譲" action={<Badge>0</Badge>} />
        <p className="px-4 py-3 text-sm text-muted-foreground">
          使用量の記録が1件も無い委譲は、ありません。
        </p>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader
        title="記録の無い委譲"
        subtitle="全期間で判定します。開始日・終了日の絞り込みには影響されません"
        action={<Badge>{unrecordedManagers.length}</Badge>}
      />
      <p className="px-4 pt-3 text-sm text-warn">
        使用量の記録がまだ1件も無い委譲が {unrecordedManagers.length}{' '}
        件あります。上の合計には入っていません。
      </p>
      <ul className="flex flex-col gap-0.5 px-4 py-3">
        {unrecordedManagers.map((manager) => (
          <li key={manager.managerId} className="text-sm break-words text-muted-foreground">
            <Link to={`/managers/${manager.managerId}`} className="hover:underline">
              {labels.manager(manager.managerId)}
            </Link>
            （起こした時刻: {formatDateTime(manager.startedAt)}）
          </li>
        ))}
      </ul>
    </Card>
  );
}

function UsageBody({
  rows,
  turnRows,
  since,
  layersSince,
  tokensSince,
  beforeLedger,
  beforeLayers,
  beforeTokens,
  notice,
  unrecordedManagers,
  labels,
  unreadableRows,
  unmeteredRows,
}: {
  labels: IdLabels;
  unreadableRows: readonly UnreadableUsageRow[] | undefined;
  unmeteredRows: readonly UsageUnmeteredRow[] | undefined;
  rows: readonly UsageRow[];
  turnRows: readonly UsageTurnRow[];
  since: string;
  layersSince: string | null;
  tokensSince: string | null;
  beforeLedger: boolean;
  beforeLayers: boolean;
  beforeTokens: boolean;
  notice: string;
  unrecordedManagers: readonly UnrecordedManager[];
}) {
  const summary = summarizeUsage(rows, turnRows);

  return (
    <div className="flex flex-col gap-4">
      <UnreadableUsageRowsNote rows={unreadableRows} />
      <UnmeteredUsageNote rows={unmeteredRows} />
      <Card>
        <CardHeader title="合計" subtitle={`記録の始まり: ${formatDateTime(since)}`} />
        <div className="px-4 py-3">
          {rows.length === 0 ? (
            <Empty inset="none">
              {describeUnreadableUsageRows(unreadableRows).length > 0
                ? 'この期間に読めた使用量の記録はありません。読めずに外した行があります（上の注記）。'
                : 'この期間の使用量の記録はありません。'}
            </Empty>
          ) : (
            <>
              <p className="text-2xl font-semibold">{formatUsd(summary.total.costUsd)}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                入力 {summary.total.inputTokens.toLocaleString('en-US')} / 出力{' '}
                {summary.total.outputTokens.toLocaleString('en-US')} / キャッシュ読み{' '}
                {summary.total.cacheReadInputTokens.toLocaleString('en-US')} / キャッシュ書き{' '}
                {summary.total.cacheCreationInputTokens.toLocaleString('en-US')}
                {describeWebSearchRequests(summary.total)}
              </p>
            </>
          )}
          {/* 0 と言わない。記録が始まる前の期間を「使っていない期間」と読ませない。 */}
          {beforeLedger && rows.length > 0 && (
            <p className="mt-3 text-xs text-warn">
              指定した範囲の一部は、記録が始まる前の期間です。その分は 0 ではなく「記録なし」です。
            </p>
          )}
          {describeUnreadableUsage(summary.total).map((line) => (
            <p key={line} className="mt-3 text-xs text-warn">
              {line}
            </p>
          ))}
        </div>
        {(beforeLedger && rows.length === 0) || beforeLayers || beforeTokens ? (
          <ReadingGuide>
            {beforeLedger && rows.length === 0 && (
              <li>
                指定した範囲は、記録が始まる前の期間にかかっています。その分は 0
                ではなく「記録なし」です。
              </li>
            )}
            {beforeLayers && (
              // 層の始点を記録の始点と混ぜない。それより前の層と場所は初期値であって観測ではない。
              <li>
                指定した範囲は、「誰が・どこで」を記録し始める前（
                {layersSince === null ? 'まだ記録なし' : formatDateTime(layersSince)}
                ）にかかっています。その分の「誰が・どこで」は、実際に観測した値ではありません。
              </li>
            )}
            {beforeTokens && (
              // null はプールを使っていない構成でも最後まで null。それが正常でありうると書く。
              <li>
                指定した範囲は、認証トークンを記録し始める前（
                {tokensSince === null ? 'まだ記録なし' : formatDateTime(tokensSince)}
                ）にかかっています。
                {tokensSince === null && '認証トークンを使い分けていない場合は、これが正常です。'}
                その分は、どの認証トークンかが分かりません（0 ではありません）。
              </li>
            )}
          </ReadingGuide>
        ) : null}
      </Card>

      <UnrecordedManagersCard unrecordedManagers={unrecordedManagers} labels={labels} />

      {rows.length > 0 && (
        // 子の幅の膨らみを止めているのは `BarList` の行名の `min-w-0 truncate`。
        // `grid-cols-1` を外すと暗黙トラックが auto になり、モバイルで枠を超える。
        // jsdom はレイアウトを持たないので、効いているかは試験では確かめられない。
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <AxisCard
            title="日別"
            order="recent"
            entries={[...summary.byDate]
              .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
              .map((entry) => ({ label: entry.date, costUsd: entry.totals.costUsd }))}
          />
          {/* 委譲かどうかは `isDelegationActorId` で見分ける。`mgr-` の接頭辞では見分けない。 */}
          <AxisCard
            title="マネージャー別"
            entries={summary.byManager.map((entry) => ({
              id: entry.managerId,
              label:
                entry.managerId === CLONE_ACTOR_ID ? 'クローン' : labels.manager(entry.managerId),
              costUsd: entry.totals.costUsd,
              ...(isDelegationActorId(entry.managerId)
                ? { href: `/managers/${entry.managerId}` }
                : {}),
            }))}
          />
          <AxisCard
            title="モデル別"
            entries={summary.byModel.map((entry) => ({
              label: entry.model,
              costUsd: entry.totals.costUsd,
            }))}
          />
          {/* モデル別と層別を1つにしない。クローンとマネージャーは既定で同じモデルなので、モデル名では「誰が使ったか」に答えられない。 */}
          <AxisCard
            title="誰が使ったか"
            entries={summary.byLayer.map((entry) => ({
              label: usageLayerLabel(entry.layer),
              costUsd: entry.totals.costUsd,
            }))}
          />
          <AxisCard
            title="どこで使ったか"
            entries={summary.bySite.map((entry) => ({
              label: usageSiteLabel(entry.site),
              costUsd: entry.totals.costUsd,
            }))}
          />
          {/* `tokenId` が null の要素を落とさない。落とすとこの軸だけ合計に足し合わなくなり、気づく手がかりが無い。 */}
          <AxisCard
            title="認証トークン別"
            entries={summary.byToken.map((entry) => ({
              id: entry.tokenId,
              label:
                entry.tokenId === null
                  ? '（認証トークンの分からない分）'
                  : labels.token(entry.tokenId),
              costUsd: entry.totals.costUsd,
              ...(entry.tokenId !== null ? { href: tokensHref({ tokenId: entry.tokenId }) } : {}),
            }))}
          />
        </div>
      )}

      <p className="text-xs text-muted-foreground">{notice}</p>
    </div>
  );
}

function AxisCard({
  title,
  entries,
  order = 'cost',
}: {
  title: string;
  entries: { id?: string | null; label: string; costUsd: number; href?: string }[];
  /** 日別を金額で並べ直すと、切り詰めが「最近の 20 日」ではなく「金額の上位 20 日」になるので、`recent` は渡された並びのまま使う。 */
  order?: 'cost' | 'recent';
}) {
  if (order === 'cost') entries = [...entries].sort((a, b) => b.costUsd - a.costUsd);
  const labelCounts = new Map<string, number>();
  for (const entry of entries)
    labelCounts.set(entry.label, (labelCounts.get(entry.label) ?? 0) + 1);
  const [showAll, setShowAll] = useState(false);
  const overflowing = entries.length > AXIS_LIMIT;
  return (
    <Card>
      <CardHeader title={title} action={<Badge>{entries.length}</Badge>} />
      {/* 打ち切ったら必ずそう書く: 黙って切り捨てると「全部でこれだけ」と読める出力が嘘になる。切り詰めと注記は `BarList` が持つ（面ごとに書き分けると、片方だけ直したときに片方だけ黙る）。 */}
      <BarList
        {...(showAll ? {} : { limit: AXIS_LIMIT })}
        formatValue={formatUsd}
        items={entries.map((entry) => {
          const { href } = entry;
          return {
            id: entry.id ?? undefined,
            label:
              entry.id && (labelCounts.get(entry.label) ?? 0) > 1
                ? `${entry.label}（${shortId(entry.id)}）`
                : entry.label,
            value: entry.costUsd,
            ...(href === undefined
              ? {}
              : {
                  renderLabel: (label: ReactNode) => (
                    <Link to={href} className="hover:underline">
                      {label}
                    </Link>
                  ),
                }),
          };
        })}
      />
      {overflowing && (
        <div className="border-t border-border px-4 py-2">
          <Button variant="ghost" size="sm" onClick={() => setShowAll((value) => !value)}>
            {showAll
              ? order === 'recent'
                ? `最近の ${AXIS_LIMIT} 日に戻す`
                : `上位 ${AXIS_LIMIT} 件に戻す`
              : 'すべて表示する'}
          </Button>
        </div>
      )}
    </Card>
  );
}
