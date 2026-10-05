import { SettingsTabs } from '~/components/group-tabs';
import { settingsDocumentTitle } from '~/lib/nav';
import { AlertTriangle } from 'lucide-react';
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
import { useId, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';

import {
  Page,
  Badge,
  BarList,
  Card,
  CardHeader,
  cn,
  Empty,
  ErrorNote,
  Input,
  Select,
  Spinner,
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

/**
 * 集計で読めずに外した行が在ることを、合計の上で断る（Issue #2427。ホームの
 * 「今日の利用」カードも使う）。**0件・欄なし（古いデーモン）なら描かない**——
 * 「読めない行は 0 行」を作らない。
 *
 * **文言を画面で書き直さない。** `describeUnreadableUsageRows`（core）が出した行を
 * そのまま並べる（CLI・`usage_read` と同じ言葉になる）。
 */
export function UnreadableUsageRowsNote({
  rows,
  className,
}: {
  rows: readonly UnreadableUsageRow[] | undefined;
  className?: string;
}) {
  const lines = describeUnreadableUsageRows(rows);
  if (lines.length === 0) return null;
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn',
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{lines.join(' ')}</span>
    </div>
  );
}

/**
 * 消費を報告しない provider のターンが在ることを、合計の上で断る（Issue #486 M7）。
 * **0 ではなく取れなかった**と言う。0件・欄なし（Claude だけの器・古いデーモン）なら
 * 描かない。文言は `describeUnmeteredUsage`（core）をそのまま並べる。
 */
export function UnmeteredUsageNote({
  rows,
  className,
}: {
  rows: readonly UsageUnmeteredRow[] | undefined;
  className?: string;
}) {
  const lines = describeUnmeteredUsage(rows);
  if (lines.length === 0) return null;
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn',
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{lines.join(' ')}</span>
    </div>
  );
}

/**
 * 絞り込みを載せる URL のクエリパラメタ名（issue #2050）。
 *
 * **`UsageQuery` の欄名（`from` / `to` / `managerId` / `layer` / `site` /
 * `tokenId`）をそのまま使う。** `journal.tsx` の `types`（#2029）や
 * `managers.tsx` の `status`（#2030）のようにカンマ区切りへまとめる理由が
 * ここには無い——どれも「1つの値」で、複数値を1つのパラメタへ詰める必要が
 * 無いので、API のクエリ名と揃えたほうが読み手には素直である。
 *
 * **`from` / `to` / `managerId` は `packages/logic/src/usage-links.ts` の正本を使う（issue
 * #2077 / #2078）。** 委譲の詳細（`manager-detail.tsx`）とホーム
 * （`dashboard-tiles.tsx`）が `/usage` へのリンクを組み立てるとき、同じ欄名を
 * 書き写さずに済ませるため——書き写すと、片方だけ変わる経路が生まれる。
 * `layer` / `site` / `tokenId` はまだ書き写す先が無いので、ここに残す。
 */
const FROM_PARAM = USAGE_FROM_PARAM;
const TO_PARAM = USAGE_TO_PARAM;
const MANAGER_ID_PARAM = USAGE_MANAGER_ID_PARAM;
const LAYER_PARAM = 'layer';
const SITE_PARAM = 'site';
const TOKEN_ID_PARAM = 'tokenId';

/**
 * `LAYER_PARAM` / `SITE_PARAM` の生の値から、既知のものだけを取り出す。
 *
 * **知らない値は捨てて「すべて」として扱う（#2010 の線。`journal.tsx` の
 * `parseSelectedTypes` / `managers.tsx` の `parseSelectedStatuses` と同じ
 * 判断）。** URL 経由の値は人間が手で書き換えうるので `UsageLayer` /
 * `UsageSite` として型で縛れない。ここで弾いておかないと、不正な値が
 * そのまま `GET /usage` のクエリへ渡ってしまう。
 */
function parseUsageLayer(raw: string | null): UsageLayer | '' {
  if (raw === null) return '';
  return (USAGE_LAYERS as readonly string[]).includes(raw) ? (raw as UsageLayer) : '';
}

function parseUsageSite(raw: string | null): UsageSite | '' {
  if (raw === null) return '';
  return (USAGE_SITES as readonly string[]).includes(raw) ? (raw as UsageSite) : '';
}

/**
 * `FROM_PARAM` / `TO_PARAM` の生の値から、`YYYY-MM-DD` として読める値だけを
 * 取り出す（issue #2133）。**読めない値は捨てて「絞り込み無し」として扱う**
 * （`parseUsageLayer` / `parseUsageSite` と同じ判断——知らない値をそのまま
 * `GET /usage` へ渡さない）。**空文字（`?from=` で明示的に空にした場合）は
 * 「読めない」とは扱わない** ——「絞り込みが無い」と等価であって、人間が
 * 書き損じた値ではない。
 *
 * **形（`USAGE_DATE_PATTERN`）とカレンダー上の実在（`isRealUsageDate`）の
 * 両方を、`@alteroid/core/usage`（ブラウザ向けの軽い口）から読んで見る。**
 *
 * かつては、`usageDateSchema`（`packages/core/src/usage.ts`。サーバ専用の
 * 重い `usage.ts`）がこの2つを持っていなかったため、正規表現と実在検査を
 * ここへ書き写していた（issue #2133）。書き写しの一致は
 * `usage.date-schema-parity.test.ts` が測っていた。実在検査は当時デーモン側に
 * 無かったので、画面だけが `2026-02-30` のような実在しない日を「読めない」側へ
 * 倒しており、**デーモンとは意図的に揃えていなかった**（`type="date"` の
 * `<input>` が実在しない日を空文字へ落とす仕様と、素通しした場合の
 * 「入力欄は空なのに絞り込みが効いている」食い違いを避けるため）。
 *
 * **issue #2156 で `usageDateSchema` 自身が `isRealUsageDate` で実在検査を
 * 持つようになり（デーモンの `GET /usage` も実在しない日を 400 で弾く）、
 * その判定がブラウザ向けの軽い口（`@alteroid/core/usage` =
 * `usage-format.ts`）から `USAGE_DATE_PATTERN` / `isRealUsageDate` として
 * 直接読めるようになった。issue #2166 で、画面はこの2つを import する形に
 * 寄せ、書き写し（旧 `isRealCalendarDate`）を削った。** いまは画面とデーモンの
 * 判定が同じ関数から出ており、揃っている。
 *
 * 戻り値だけでは「捨てたかどうか」は見分けられない（空文字は「そもそも
 * 無い」と「捨てた」の両方で起こる）。捨てたことを画面に出す判定は、
 * 呼び出し側で `raw` と戻り値を突き合わせて行う。
 *
 * **export しているのはテストのためだけである（issue #2166。「テストを
 * 弱めずに直す」の「テスト可能にするための構造変更」）。** 出力・挙動は
 * 1文字も変えていない——`export` を足しただけで、呼び出し側
 * （`Usage` 内の `parseUsageDate(rawFrom)` / `parseUsageDate(rawTo)`）は
 * そのままである。`usage.date-schema-parity.test.ts` が、この関数が
 * `USAGE_DATE_PATTERN` / `isRealUsageDate`（core）へそのまま委譲している
 * ことを直接測る（画面が私家版の判定へ後戻りしていないかを見る歯）。
 */
export function parseUsageDate(raw: string | null): string {
  if (raw === null || raw === '') return '';
  if (!USAGE_DATE_PATTERN.test(raw)) return '';
  return isRealUsageDate(raw) ? raw : '';
}

const UNKNOWN_MANAGER = '（一覧に無い委譲）';
const UNKNOWN_TOKEN = '（一覧に無い認証トークン）';

interface IdLabels {
  manager: (id: string) => string;
  token: (id: string) => string;
}

/** 委譲の依頼文を、選択肢に収まる長さへ縮める（改行は空白へ）。 */
function shortenRequest(request: string): string {
  const flat = request.replace(/\s+/g, ' ').trim();
  if (flat === '') return '（依頼文なし）';
  return flat.length > 28 ? `${flat.slice(0, 28)}…` : flat;
}

/** 絞り込みの1欄。`<label for>` で入力欄に結ぶ（ラベルを押すと欄へ移る・読み上げられる）。 */
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
 * 候補から選ぶ欄。**現在の値が候補に無くても、その値を消さない**——URL で渡された
 * id がまだ一覧に載っていない（一覧が読めていない・外れた）ときに、選択が黙って
 * 「すべて」へ見えると、絞り込みが効いているのに欄は空という食い違いになる。
 */
function CandidateSelect({
  id,
  value,
  options,
  unknownLabel,
  onChange,
}: {
  id: string;
  value: string;
  options: readonly { value: string; label: string }[];
  unknownLabel: string;
  onChange: (value: string) => void;
}) {
  const known = value === '' || options.some((option) => option.value === value);
  return (
    <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">すべて</option>
      {!known && <option value={value}>{unknownLabel}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}

export default function Usage() {
  /*
   * **絞り込みの正本は URL である（issue #2050）。** `journal.tsx`（#2029）・
   * `managers.tsx`（#2030）と同じ理由——画面の state に閉じ込めると、
   * 絞り込んだ状態を人へ渡せない（開き直すと消える・戻るで戻れない・
   * リンクで共有できない）。
   *
   * **debounce はしない。** 元の実装（`useState`）にも無かった——入力欄を
   * 変えるたびに `query` が変わり、そのまま `useUsage` へ渡っていた。
   * URL へ載せ替えても同じ頻度で書き換えるだけで、表示や問い合わせの
   * タイミングは変えない。
   *
   * **`replace: true` にする。** 検索語・チップの絞り込みと同じ判断——
   * 打鍵・選択のたびに履歴が積まれると「戻る」が使い物にならなくなる。
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const rawFrom = searchParams.get(FROM_PARAM);
  const rawTo = searchParams.get(TO_PARAM);
  const from = parseUsageDate(rawFrom);
  const to = parseUsageDate(rawTo);
  /**
   * **読めなかった生の値だけを持つ（捨てて終わりにしない。issue #2133）。**
   * `rawFrom` / `rawTo` が非空なのに `from` / `to` が空文字に落ちたときだけ
   * 「読めなかった」——空文字そのもの（絞り込み無し）とは区別する。
   */
  const invalidFrom = rawFrom !== null && rawFrom !== '' && from === '' ? rawFrom : null;
  const invalidTo = rawTo !== null && rawTo !== '' && to === '' ? rawTo : null;
  const managerId = searchParams.get(MANAGER_ID_PARAM) ?? '';
  const layer = parseUsageLayer(searchParams.get(LAYER_PARAM));
  const site = parseUsageSite(searchParams.get(SITE_PARAM));
  // **マネージャーと認証トークンは、一覧から選べるようにする（#2795）。** id を手で
  // 入れさせない。ただし一覧が取れなくても URL の値は効く（下の `CandidateSelect`）。
  const tokenId = searchParams.get(TOKEN_ID_PARAM) ?? '';
  const idPrefix = useId();
  // 候補は「あれば選べる」だけにする。**取れなくても絞り込みは使える**（URL の値は
  // そのまま効く）ので、一覧の失敗は画面のエラーにしない。
  const { data: managersData } = useManagers();
  const { data: tokensData } = useTokens();
  const managerOptions = (managersData?.managers ?? []).map((manager) => ({
    value: manager.managerId,
    label: `${shortenRequest(manager.request)}（${formatDateTime(manager.startedAt)}）`,
  }));
  const tokenOptions = (tokensData?.tokens ?? []).map((token) => ({
    value: token.id,
    label: token.label,
  }));
  // 軸の行・一覧の見出しに、id でなく名前を出すための引き表（無いものは id を見せない）。
  const labels: IdLabels = {
    manager: (id) => managerOptions.find((option) => option.value === id)?.label ?? UNKNOWN_MANAGER,
    token: (id) => tokenOptions.find((option) => option.value === id)?.label ?? UNKNOWN_TOKEN,
  };

  /** 1つの絞り込みを変える。空文字なら URL からそのパラメタを消す。 */
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
  const { data, error, isLoading } = useUsage(query);

  /**
   * **黙って捨てない（issue #2133）。** `layer` / `site` は捨てて終わりだが
   * （`journal.tsx` / `managers.tsx` と同じ線・#2010）、`from` / `to` は人間が
   * URL を手で書き換える・古いブックマークを開く・別画面の組み立てが誤った
   * リンクを踏む、のどれでも起こりうるので、読めなかった生の値をそのまま
   * 画面に出す（人間が書いた URL の値であって秘密ではない）。
   */
  const dateNotices: string[] = [];
  if (invalidFrom !== null) {
    dateNotices.push(
      `開始日に指定された値（${invalidFrom}）は日付として読めないので、絞り込みに使っていません`,
    );
  }
  if (invalidTo !== null) {
    dateNotices.push(
      `終了日に指定された値（${invalidTo}）は日付として読めないので、絞り込みに使っていません`,
    );
  }
  /**
   * **`to` が `from` より前だと、絞り込みは常に空を返す（issue #2155）。**
   * デーモンの `usageQuery`（`apps/daemon/src/app.ts`）は `from` / `to` の
   * 前後を検査せず、`date >= from AND date <= to` で絞るだけなので、
   * `to < from` のときは例外にならず単に0件になる——「期間の指定が逆」と
   * 「その期間に本当に記録が無い」が、画面の側で何も足さなければ同じ
   * 「その範囲には記録が無い。」という文言で出て区別が付かない。
   *
   * **`UsageBody` 側の「その範囲には記録が無い。」はそのまま残す。** 0件で
   * あること自体は事実として正しく、`beforeLedger` 等の既存の注記と同じ
   * 並びに置けば読み違いは防げる——ここは削るのではなく、隣に理由を足す形
   * を選ぶ。
   *
   * **文言と判定は core の {@link describeUsageDateOrder} が持つ（issue
   * #2211）。** CLI（`alteroid usage` / chat の `/usage`）・クローンの
   * `usage_read` と同じ関数——`from` / `to` がどちらも空文字（絞り込み無し・
   * `invalidFrom` / `invalidTo` で読めなかった場合を含む）なら `undefined` を
   * 渡す。判定そのもの（`YYYY-MM-DD` の辞書式比較）は core 側の doc を見ること。
   */
  const dateOrderNotice = describeUsageDateOrder(
    from === '' ? undefined : from,
    to === '' ? undefined : to,
  );
  if (dateOrderNotice !== null) {
    dateNotices.push(dateOrderNotice);
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
          `sm` 未満にはこの容器へ `grid-template-columns` の指定が1つも無い
          （旧: `grid gap-3 sm:grid-cols-3`）。無い場合の暗黙の単一トラックは
          `auto`＝max-content になるので、**中身の内在幅がそのままトラック幅**
          になり `Card` の枠を超える。`sm` 以上で出ないのは `minmax(0,1fr)` の
          `0` がトラックの下限を潰しているからで、狭い画面だけその傘が無い穴
          だった（#265 と同じ形の欠落）。`grid-cols-1` を足して傘を掛けるのが
          根の直し（#265 の `login.tsx` / `manager-detail.tsx` / `settings.tsx`
          が `dl` でやっているのと同じ流儀。別解は持ち込まない）。

          **`type="date"` の2つの `Input` にだけ `min-w-0` も足してある。**
          `input[type=date]` は内在幅が大きく（特に iOS Safari）、アプリ内で
          `type="date"` を使うのはここの2箇所だけ（`manager` は素のテキスト、
          `layer`/`site` は `Select` で内在幅が小さい）。1で足りるはずだが
          実機で確かめられないので二重に押さえてある。

          **jsdom はレイアウトを持たないので、この修正が実機で効いていること
          はテストでは確かめられない。** 下のテストが保証するのはクラスが
          当たっていることまでである。
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
              unknownLabel={UNKNOWN_MANAGER}
              onChange={(value) => setFilter(MANAGER_ID_PARAM, value)}
            />
          </FilterField>
          {/*
            **選択肢は core の一覧から作る**（`USAGE_LAYERS` / `USAGE_SITES`）。
            画面に値を書き写すと、値が増えたときにここだけ古くなる。表示名は
            `@alteroid/logic` の対応表が持つ（知らない値は値のまま出る）。
          */}
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
              unknownLabel={UNKNOWN_TOKEN}
              onChange={(value) => setFilter(TOKEN_ID_PARAM, value)}
            />
          </FilterField>
        </div>
      </Card>

      {dateNotices.map((line) => (
        <p key={line} className="mb-4 text-xs text-warn">
          {line}
        </p>
      ))}

      <ErrorNote error={error} className="mb-4" />

      {isLoading ? (
        <Spinner />
      ) : data === undefined ? null : (
        <div className="flex flex-col gap-4">
          {/*
            **アカウント全体の残りは、台帳が空でも出す。** 台帳が空であることと、
            アカウントの枠が分からないことは別の事実である（片方を理由にもう片方を
            隠すと、枠の状態が画面から消える）。
          */}
          <AccountCard account={data.account} />
          {data.since === null ? (
            <>
              {/* **`$0.00` と出さない。** まだ1件も無いのを「使っていない」に見せない。 */}
              <Card>
                <Empty inset="card">
                  まだ使用量の記録がありません。会話を始めると、ここに出ます。
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
 * アカウント全体の残り（claude.ai 側の値）。
 *
 * **文言を画面で書き直さない。** 同じ値を読む口は4つある（クローンの `usage_read` /
 * CLI の `alteroid usage` と `/usage` / この画面）。面ごとに書くと「取れなかった」の
 * 言い方が分かれ、いつか片方だけが 0 と描く。だから core の
 * `describeAccountUsage` が出した行をそのまま並べる（Markdown は解釈しないので
 * 強調だけ落とす）。
 *
 * **台帳のカードと同じ見た目に混ぜないこと。** 一方は自分で数えた推定値、もう一方は
 * 向こうが言っている値で、一致する保証がない。題で区別が付くようにしてある。
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

/** 折りたたみの「記録の読み方」。注記が無ければ何も出さない。 */
function ReadingGuide({ children }: { children: ReactNode }) {
  return (
    <details className="border-t px-4 py-3 text-xs text-muted-foreground">
      <summary className="cursor-pointer">記録の読み方</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5">{children}</ul>
    </details>
  );
}

/**
 * 台帳に1行も無い委譲（Issue #98「台帳が取りこぼした委譲」）。
 *
 * **文言を画面で書き直さない。** `describeUnrecordedManagers`（core）が出した行を
 * そのまま並べる——CLI（`alteroid usage`）・クローンの `usage_read` と同じ言葉に
 * なる（片方だけ「0件」の言い方が違う、が起きないようにするため）。
 *
 * **0件でも必ず出す。** 空配列は「取りこぼしが無い」であって「調べていない」では
 * ないので、そう読める形で1行返る（`describeUnrecordedManagers` の doc）。
 */
function UnrecordedManagersCard({
  unrecordedManagers,
  labels,
}: {
  unrecordedManagers: readonly UnrecordedManager[];
  labels: IdLabels;
}) {
  // 0件は「取りこぼしが無い」と、そう読める形で言う（黙らない）。
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
  // **回数（`turnRows`）を渡すだけで、画面の表示そのものは変えない**（core への
  // 算術の集約を保つためだけの追随。CLI と同じ判断）。
  const summary = summarizeUsage(rows, turnRows);

  return (
    <div className="flex flex-col gap-4">
      {/* **合計の上に出す**（Issue #2427）。外した行の値は合計に足していない。 */}
      <UnreadableUsageRowsNote rows={unreadableRows} />
      <UnmeteredUsageNote rows={unmeteredRows} />
      <Card>
        <CardHeader title="合計" subtitle={`記録の始まり: ${formatDateTime(since)}`} />
        <div className="px-4 py-3">
          {rows.length === 0 ? (
            <Empty inset="none">この期間の使用量の記録はありません。</Empty>
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
          {/* **0 と言わない。** 記録が始まる前の期間を「使っていない期間」と読ませない。
              記録が1件も無いとき（rows が空）は、下の「記録の読み方」へ寄せる。 */}
          {beforeLedger && rows.length > 0 && (
            <p className="mt-3 text-xs text-warn">
              指定した範囲の一部は、記録が始まる前の期間です。その分は 0 ではなく「記録なし」です。
            </p>
          )}
          {/* **取れなかった区切りが在れば、その旨を1行**（Issue #2086）。 */}
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
              // **層の始点を記録の始点と混ぜない。** 層と場所の軸は後から入ったので、
              // それより前の行の層と場所は、記録時に埋めた初期値であって観測ではない。
              <li>
                指定した範囲は、「誰が・どこで」を記録し始める前（
                {layersSince === null ? 'まだ記録なし' : formatDateTime(layersSince)}
                ）にかかっています。その分の「誰が・どこで」は、実際に観測した値ではありません。
              </li>
            )}
            {beforeTokens && (
              // **null は記録が1件も無いときだけでなく、プールを使っていない構成でも
              // 最後まで null**——それが正常でありうると書く。
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

      {/* **合計値の隣に必ず出す（Issue #98）。** */}
      <UnrecordedManagersCard unrecordedManagers={unrecordedManagers} labels={labels} />

      {rows.length > 0 && (
        // ⚠️ #295: この grid には基底の `grid-cols-*` が無いので、暗黙トラック
        // の幅は各アイテムの min-content 寄与の最大値（＝ auto）で決まる。
        //
        // 膨らまない理由 — 直接の子（`<AxisCard>` が返す `<Card>`。
        // className 未指定）自身は緩和クラスを持たない。膨らみを止めている
        // のは `AxisCard`（このファイル内、下に定義）が並べる `BarList`
        // （`packages/ui/src/components/features/charts/bar-list.tsx`）の
        // 行の名前 `<span className="min-w-0 truncate" ...>` である。`truncate` は
        // `overflow: hidden` と `white-space: nowrap` を含む（実測:
        // `tailwindcss@4.3.3` のユーティリティ定義を grep で確認 —
        // `truncate` → `overflow:hidden` / `text-overflow:ellipsis` /
        // `white-space:nowrap`）。`overflow: hidden` と `min-width: 0` が
        // 揃うと、その要素自身の自動最小サイズが 0 に落ち、祖先の
        // min-content 計算への寄与も 0 になる。
        //
        // **usage.tsx はこの機構で一度実際に壊れている**（#282。人間の実機
        // 報告「モバイルで見た時利用状況の from と to 両方とも枠から出てる」
        // から発覚した）。
        //
        // ⚠️ 上の「寄与が0に落ちる」は CSS の記述からの読みであって実測で
        // はない。jsdom はレイアウトを持たず（offsetWidth /
        // getBoundingClientRect が常に 0、CSS も適用されない）、視覚回帰の
        // 道具（Playwright / Storybook / Chromatic）も無く、Vercel の
        // preview は release/prod へ push されるまで出ない。詳細と再オープ
        // ン条件は #295。
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <AxisCard
            title="日別"
            entries={[...summary.byDate]
              .reverse()
              .map((entry) => ({ label: entry.date, costUsd: entry.totals.costUsd }))}
          />
          {/*
            **マネージャーの行だけを委譲の詳細へつなぐ（issue #2046）。** この軸の
            `managerId` は「誰の分か」の一般名で、クローンの分は `CLONE_ACTOR_ID`
            になる（`packages/core/src/usage.ts` の `usageRowSchema` の doc）。
            その行は委譲ではないので `/managers/<id>` へは飛ばさない。

            **クローンの id（`CLONE_ACTOR_ID`）ではないものを委譲とする**
            （`isDelegationActorId`。日誌のリンクと同じ1つの関数。`mgr-` の接頭辞では
            見分けない — Issue #2269）。この軸には層が無く、クローンの分は
            `CLONE_ACTOR_ID` に決まっている（`usage.ts` の `CLONE_ACTOR_ID` の doc）。
          */}
          <AxisCard
            title="マネージャー別"
            entries={[...summary.byManager]
              .sort((a, b) => b.totals.costUsd - a.totals.costUsd)
              .map((entry) => ({
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
            entries={[...summary.byModel]
              .sort((a, b) => b.totals.costUsd - a.totals.costUsd)
              .map((entry) => ({ label: entry.model, costUsd: entry.totals.costUsd }))}
          />
          {/*
            **モデル別と層別を1つにしない。** 既定でクローンとマネージャーは
            どちらも opus で同じモデル帯に並ぶので、モデル名では
            「誰が使ったか」に答えられない。
          */}
          <AxisCard
            title="誰が使ったか"
            entries={[...summary.byLayer]
              .sort((a, b) => b.totals.costUsd - a.totals.costUsd)
              .map((entry) => ({
                label: usageLayerLabel(entry.layer),
                costUsd: entry.totals.costUsd,
              }))}
          />
          <AxisCard
            title="どこで使ったか"
            entries={[...summary.bySite]
              .sort((a, b) => b.totals.costUsd - a.totals.costUsd)
              .map((entry) => ({
                label: usageSiteLabel(entry.site),
                costUsd: entry.totals.costUsd,
              }))}
          />
          {/*
            **`tokenId` が null の要素を落とさない。** 落とすとこの軸だけ合計に
            足し合わなくなり、しかも他の軸は「出てこない値を 0 で補わない」約束
            なので、読み手には足りないことに気づく手がかりが無い。

            **帰属のある行だけ `/tokens` へ飛ばす（issue #2100 段1）。** `null`
            の行（「（トークンの帰属が無い分）」）には飛び先の id が無いので
            リンクにしない。

            **飛び先はその id の行そのもの（issue #2109。#2100 の段2）。**
            `tokens.tsx` の `TokenRow` に飛び先（DOM の id・スクロール・
            控えめな強調）が入ったので、`/tokens` 止まりだった飛び先を行へ
            向け直した。href の組み立てと URL の欄名は `packages/logic/src/tokens-links.ts`
            に1本化してある（`usage-links.ts` / `managers-links.ts` と同じ
            慣習——欄名を呼び出し側とここの両方で書き写さない）。プールから
            外れた id（使用量には残っているが、いまの `GET /tokens` に居ない）
            で飛んだときの倒れ先は `tokens.tsx` 側が持つ。
          */}
          <AxisCard
            title="認証トークン別"
            entries={[...summary.byToken]
              .sort((a, b) => b.totals.costUsd - a.totals.costUsd)
              .map((entry) => ({
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

      {/* **省略・要約しない。数字を出すところには必ず添える。** */}
      <p className="text-xs text-muted-foreground">{notice}</p>
    </div>
  );
}

function AxisCard({
  title,
  entries,
}: {
  title: string;
  /** `href` を持つ行だけ `label` を `<Link>` にする（issue #2046）。文言は変えない。 */
  entries: { label: string; costUsd: number; href?: string }[];
}) {
  return (
    <Card>
      <CardHeader title={title} action={<Badge>{entries.length}</Badge>} />
      {/*
        **打ち切ったら必ずそう書く。** 黙って切り捨てると「全部でこれだけ」と読める
        出力が嘘になる。切り詰めと注記（`TruncationNote`）・空のときの `無し。` は
        `BarList` が持つ（面ごとに書き分けると、片方だけ直したときに「同じ切り方
        なのに片方だけ黙る」が生まれる）。

        **帯の値は `costUsd` そのもの**（core の `usageTotalsSchema` が非負の数に
        限っている）。値の無い項目はこの軸には来ないので、0 の帯で補う場面は無い。
        金額の文字は今までどおり `formatUsd` が出す（帯は文字を持たない）。
      */}
      <BarList
        limit={AXIS_LIMIT}
        formatValue={formatUsd}
        empty="無し。"
        items={entries.map((entry) => {
          const { href } = entry;
          return {
            label: entry.label,
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
    </Card>
  );
}
