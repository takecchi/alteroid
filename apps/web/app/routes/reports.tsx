import { useId } from 'react';
import { Link } from 'react-router';

import {
  markdownComponents,
  toReact,
  Page,
  ListDetail,
  ListDetailItems,
  Empty,
  ErrorNote,
  Spinner,
  cn,
} from '@alteroid/ui';
import { useReport, useReports } from '@alteroid/swr';
import { formatDateTime, redactBody } from '@alteroid/logic';

import type { DailyReport } from '@alteroid/logic';

import type { Route } from './+types/reports';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { date: params.date, reportId: params.reportId };
}

/**
 * その行が「日報が書けなかった」印か（`packages/core/src/schema.ts` の
 * `unavailable` の doc が正本）。
 *
 * **印の行を日報として描かないため**だけに要る。実際に起きた壊れ方は、日報の
 * 本文が丸ごと `You've hit your org's monthly spend limit …` になっていた、という
 * ものである。いま本文には「（この日の日報は作れなかった…）」が入っているが、
 * **本文の文言で判定しないこと** — 判定は構造化された印で行い、文言は表示に
 * だけ使う（`packages/core/src/sdk-failure.ts` が固定した順序と同じ）。
 *
 * **印の行を一覧から隠さないこと。** 隠すと、人間の側からはその日が「まだ来て
 * いない日」と区別できなくなる。器の側は同じ行を「日報はまだ無い」と数えている
 * （`isWrittenDailyReport`）ので、**人間には見えたまま、機構は書き直せる**という
 * 両立がこの印の存在理由そのものである。
 */
export function isUnavailable(
  report: DailyReport,
): report is DailyReport & { unavailable: string } {
  return typeof report.unavailable === 'string' && report.unavailable !== '';
}

/**
 * 日報の代わりに置かれた印を、**日報ではないと分かる形で**出す。
 *
 * **`Markdown` で描かないこと。** 中身は SDK が出したエラー文であって、クローンが
 * 書いた文章ではない。Markdown として描くと、記法が混ざっていた場合に体裁まで
 * 日報と同じ顔になる。
 *
 * **理由は言い換えずにそのまま出す。** SDK の文言で人間が検索できることが要件
 * である（`usage-limits.ts` の「言い換えないこと」と同じ約束）。
 *
 * **降りる先を名指しする。** 「作れなかった」だけで終わると、その日の記録ごと
 * 失われたと読める。実際には日誌に全部残っており、原因が解ければ本物を書き直せる
 * （印の行は「日報がある」と数えられていないので、その道は閉じていない）。
 */
export function UnavailableNote({ reason }: { reason: string }) {
  return (
    <div className="min-w-0">
      <p className="text-sm text-destructive">
        ⚠ <strong className="font-medium">この日の日報は作れなかった</strong>
        。以下はクローンが書いたまとめではなく、書けなかった理由である。
      </p>
      <pre className="mt-2 overflow-x-auto rounded border border-border bg-background p-2 text-[11px] break-words whitespace-pre-wrap text-muted-foreground">
        {reason}
      </pre>
      <p className="mt-2 text-xs text-muted-foreground">
        この日の記録は
        <Link to="/journal" className="text-primary hover:underline">
          日誌
        </Link>
        に残っている。書けていないだけなので、原因が解ければ
        <Link to="/schedule" className="text-primary hover:underline">
          スケジュール
        </Link>
        から作り直せる。
      </p>
    </div>
  );
}

/**
 * 一覧に並べる1行の見出し。
 *
 * **日の部分は `report.date` から出し、`at` から導かないこと。** この2つは同じ日
 * とは限らない — 日報が複数ある日を作っている経路そのものが「起動時の遡り生成」
 * （`schedule.ts` の `missingDailyReportDates` → `clone.ts` の `#dailyReport`）で、
 * そこでは**前日ぶんの日報が今日書かれる**。`at`（書いた時刻）を整形すると、
 * 2026-08-20 の日報が `08/21 …` と出て、隣に並ぶ 2026-08-21 の日報と同じ日付に
 * 見える。**人間が困っていた「見分けが付かない」がそのまま戻る。**
 *
 * だから日は `date`（その日報が何日について書かれたか）、時刻は `at`（いつ書か
 * れたか）で、2つは別の軸として並べる。
 */
function reportTitle(date: string): string {
  return `${date} の日報`;
}

/**
 * 「いつ書かれたか」。**日付つきで出す**（時:分だけだと、翌日に書かれた1件が
 * 日報の日の 00:30 に書かれたように読める。#2779）。端末の時間帯の時刻で出す
 * （`formatDateTime`）。
 */
function writtenAt(report: DailyReport): string {
  return `${formatDateTime(report.at)} に書かれた`;
}

/**
 * 本文の見出しを**1段下げて**描く。画面の見出し（h1「日報」）・カードの見出し（h2）
 * の下に本文の `#` が h1 で並ばないようにする（#2780）。`Markdown`（共通部品）は
 * 本文の見出しを書かれたとおりの段で描くので、この画面だけ見出しの部品を差し替える
 * （共通部品は変えていない）。h1→h3 … h4→h6、h5・h6 は h6 に畳む（HTML に h7 は無い）。
 * 見た目は差し替え先の段の部品のものになる。
 */
const reportMarkdownComponents: typeof markdownComponents = {
  ...markdownComponents,
  h1: markdownComponents.h3,
  h2: markdownComponents.h4,
  h3: markdownComponents.h5,
  h4: markdownComponents.h6,
  h5: markdownComponents.h6,
  h6: markdownComponents.h6,
};

function ReportMarkdown({ children }: { children: string }) {
  const prefix = 'md' + useId().replace(/[^A-Za-z0-9_-]/g, '') + '-';
  return (
    <div className="min-w-0 text-sm break-words">
      {toReact(children, reportMarkdownComponents, prefix)}
    </div>
  );
}

/**
 * 一覧に読む件数。**窓の大きさそのものは変えない**（Issue #426 の G3。
 * 決め方が未決なので、決まっていない基準で動かすより「切ったことと定量を
 * 言う」ほうを先に片付ける）。ここで名前を付けるのは、切ったかどうかの
 * 判定（下の `isReportsWindowFull`）と読む件数を同じ値に揃えるためで、
 * 生の `60` を2箇所に書くと片方だけ直して食い違う。
 */
const REPORTS_LIMIT = 60;

/**
 * 返ってきた件数が要求した上限とちょうど一致するか——**これより古い日報が
 * あるかもしれない**という唯一の合図である。
 *
 * **`GET /reports` は総件数を返さない。** `apps/daemon/src/app.ts` の
 * `/reports` の `describeRoute` が逐語で言っている——
 * 「**封筒は持たない** — 続きが在るかは `limit` 件ちょうど返ったかで判る。」
 * （`grep -Fn -- 'ちょうど返ったかで判る' apps/daemon/src/app.ts` で当たる）。だから
 * `TruncationNote`（正確な `total` が要る）は使えない——`tokens.tsx` の
 * `RotationHistory` が `GET /journal` に対して既にこの形を採っている。
 * 日報は日次で単調増加するので、運用日数が `REPORTS_LIMIT` を超えた時点で
 * この判定は常に真になる（Issue 本文の指摘そのもの）。
 */
function isReportsWindowFull(count: number): boolean {
  return count === REPORTS_LIMIT;
}

export default function Reports({ loaderData }: Route.ComponentProps) {
  const { date, reportId } = loaderData;
  const list = useReports(REPORTS_LIMIT);

  /*
    **並べ直さない。** 並びはデーモンが決める（`apps/daemon/src/reports.ts` が
    日付の新しい順・同じ日は書いた時刻の新しい順に返す）。ここで並べ直すと、
    「最新の日報」が CLI・クローンとこの画面で食い違う。
  */
  const reports = list.data?.reports ?? [];
  // 日付の指定が無ければ最新を出す。空の画面から始めない。
  const selectedDate = date ?? reports[0]?.date;
  /*
    **選択は日付では定まらない。** 同じ日に複数あるので、`date` だけで選ぶと
    その日の全部が「選択中」になり、本文にも全部が並ぶ（人間からの申告そのもの）。
    選ぶ単位は `id` である。

    指定が無いとき（`/reports` や `/reports/<日付>` を直に開いたとき）は、その日の
    先頭を選ぶ — 一覧は日付の新しい順・同じ日は書いた時刻の新しい順なので
    「その日の最後に書かれたもの」になる（並びはデーモンが決める。
    `apps/daemon/src/reports.ts`。**ここで並べ直さないこと** — 並べ直すと
    「最新の日報」が CLI とここで食い違う）。
    `selectedDate` が一覧の窓（60件）の外なら見つからず `undefined` になるが、
    そのときは本文側が取得した中の先頭に落ちる。
  */
  const selectedId = reportId ?? reports.find((report) => report.date === selectedDate)?.id;
  /**
   * **取れなかったのを0件と描かない**（issue #2324）。一覧をまだ一度も読めていないまま
   * 失敗したとき、失敗は上の `ErrorNote` が言う。一覧の「まだ無い」も、右の
   * 「日報が1件も無い」も並べない（どちらも一覧が空であることに乗っている）。再検証の
   * 失敗で `data` が残っているときは当たらず、一覧をそのまま出す。
   */
  const listUnavailable = list.data === undefined && list.error !== undefined;

  /*
    一覧の行ごとの見え方。`ListDetailItems` の `renderLink` は行の添字を渡さないので、
    隣との関係（同じ日か）は `href` を鍵にして先に数えておく。
  */
  const hrefOf = (report: DailyReport) =>
    `/reports/${report.date}/${encodeURIComponent(report.id)}`;
  const sameDayAsNext = new Set<string>();
  const latestOfManyInDay = new Set<string>();
  reports.forEach((report, index) => {
    const sameAsNext = reports[index + 1]?.date === report.date;
    if (sameAsNext) sameDayAsNext.add(hrefOf(report));
    // 同じ日が複数あるとき、**並びの先頭（書かれたのが最も新しい）にだけ**「最新」を付ける。
    // 並びはデーモンが決めている（上）。
    if (sameAsNext && reports[index - 1]?.date !== report.date) {
      latestOfManyInDay.add(hrefOf(report));
    }
  });

  return (
    /*
      本文の余白とスクロールは外す（`overflow-hidden p-0 md:p-0`。`cn` は後勝ちなので、
      safe-area の `pl`/`pr`/`pb` も `p-0` と一緒に消える）。`ListDetail` が左右のペインを
      それぞれスクロールさせるため。`Page` 自体に足さないのは、枠は他の変更も触っているので
      ここだけ呼ぶ側で上書きして済ませるため。
    */
    <Page
      title="日報"
      description="普段の接点はほぼこれだけでよい。掘りたくなったら日誌へ降りる"
      className="overflow-hidden p-0 md:p-0"
    >
      <div className="flex h-full flex-col">
        <ErrorNote error={list.error} className="mx-4 mt-4 shrink-0 md:mx-6" />
        <ListDetail
          className="min-h-0 flex-1"
          listLabel="日報の一覧"
          hasSelection={selectedDate !== undefined}
          selectionKey={selectedId}
          list={
            list.isLoading ? (
              <Spinner />
            ) : listUnavailable ? null : reports.length === 0 ? (
              <Empty>まだ無い。</Empty>
            ) : (
              <ListDetailItems
                label="日報"
                items={reports.map((report) => ({
                  key: report.id,
                  href: hrefOf(report),
                  current: report.id === selectedId,
                  children: (
                    <>
                      <span className="block">{reportTitle(report.date)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {writtenAt(report)}
                        {latestOfManyInDay.has(hrefOf(report)) && (
                          <span className="ml-1 rounded border border-border px-1 text-[11px]">
                            最新
                          </span>
                        )}
                      </span>
                      {/*
                        **印の付いた行は、開く前に分かる形にする。** 印を出さないと
                        「日報がある行」と同じ顔になり、人間は開くまで気づけない
                        （本文がエラー文だった穴と同じ形が、一覧の側に残る）。
                      */}
                      {isUnavailable(report) && (
                        <span className="ml-1 text-destructive" title="この日の日報は作れなかった">
                          ⚠
                        </span>
                      )}
                    </>
                  ),
                }))}
                renderLink={({ href, className, children, ...rest }) => (
                  <Link
                    to={href}
                    {...rest}
                    className={cn(
                      className,
                      /*
                        **罫線は日付の変わり目にだけ引く。** 同じ日のものが1つの塊に
                        見えるので、時刻だけが違う行が並んでいることが形から分かる
                        （1日1件の日は今までと同じ見え方になる）。

                        **これは「同じ日の行が隣り合っている」ことに乗っている。**
                        並びが書いた順だった間は隣り合う保証が無く、遡り生成の日報が
                        別の日付を挟んで離れると、同じ日に何本も罫線が引かれた。
                        保証は `apps/daemon/src/reports.ts` が持つ（日付の新しい順）。
                      */
                      sameDayAsNext.has(href) && 'border-b-0',
                    )}
                  >
                    {children}
                  </Link>
                )}
              />
            )
          }
          listFooter={
            /*
              **`GET /reports` は総件数を返さないので `TruncationNote` は
              使えない**（あちらは正確な `total` が要る）。取れた件数が
              要求した上限とちょうど一致するときだけ、「これより古い日報が
              あるかもしれない」と明示する——黙って切り捨てない
              （`tokens.tsx` の `RotationHistory` と同じ形。Issue #426 の G3）。
            */
            isReportsWindowFull(reports.length) ? (
              <p className="px-4 py-2 text-[11px] text-muted-foreground">
                直近 {REPORTS_LIMIT} 件のみ表示している。これより古い日報があるかもしれない。
              </p>
            ) : undefined
          }
          emptyDetail={
            listUnavailable ? null : list.isLoading ? (
              /*
                **読み込み中に「1件も無い」と言わない**（#2803）。一覧がまだ来ていないだけで
                `selectedDate` が無いので、「無い」と区別できない。一覧の取得が終わって0件だった
                ときだけ「1件も無い」を出す。
              */
              <Spinner />
            ) : (
              <Empty>
                日報が1件も無い。クローンが締め時刻にまとめる（スケジュールから今すぐ回せる）。
              </Empty>
            )
          }
          detail={
            selectedDate === undefined ? null : (
              <ReportBody date={selectedDate} reportId={selectedId} />
            )
          }
        />
      </div>
    </Page>
  );
}

function ReportBody({ date, reportId }: { date: string; reportId: string | undefined }) {
  const { data, error, isLoading } = useReport(date);

  const reports = data?.reports ?? [];
  /*
    **1件だけ出す。**

    以前はここでその日の全部を縦に並べていた。理由は「片方だけ出すと『書き換わった』
    ように見える」というもので、同じ日に複数あること自体は正しい（起動時の遡り生成と、
    その日の締め）。**ところが実際に人間が困ったのは逆だった** — 一覧が日付しか出して
    いなかったので同じ日の項目が見分けられず、どれを選んでも2件が同時に開いて読みにく
    かった。

    **もう片方が消えたわけではない。** 一覧が日時で1行ずつ並ぶようになったので、
    その隣の行から開ける。「全部並べる」が守っていた「隠さない」は一覧の側が持つ。

    `reportId` が古い URL などで見つからないときは、その日の先頭に落とす（空の画面を
    出すより、その日の日報を出すほうが人間の役に立つ）。
  */
  const report = reports.find((entry) => entry.id === reportId) ?? reports[0];
  /**
   * **取れなかったのを「この日の日報は無い」と描かない**（issue #2324）。本文をまだ一度も
   * 読めていないまま失敗したとき、失敗は上の `ErrorNote` が言う。再検証の失敗で `data` が
   * 残っているときは当たらず、本文をそのまま出す。
   */
  const bodyUnavailable = data === undefined && error !== undefined;

  return (
    <div className="min-w-0">
      <div className="border-b border-border pb-3">
        <h2 className="text-sm font-semibold">{reportTitle(date)}</h2>
      </div>
      <ErrorNote error={error} className="m-4" />
      {isLoading ? (
        <Spinner />
      ) : bodyUnavailable ? null : report === undefined ? (
        <Empty>この日の日報は無い。</Empty>
      ) : (
        <article className="min-w-0 px-4 py-3">
          {/*
            **「書かれたのは」を省かないこと。** 見出しは「何日ぶんの日報か」
            （`date`）で、ここは「いつ書かれたか」（`at`）である。遡り生成では
            この2つの日が食い違う（前日ぶんが翌日に書かれる）ので、裸の時刻を
            置くと見出しと矛盾しているように見える。
          */}
          <p className="mb-2 text-[11px] text-muted-foreground">
            書かれたのは {formatDateTime(report.at)}
          </p>
          {isUnavailable(report) ? (
            <UnavailableNote reason={report.unavailable} />
          ) : (
            <ReportMarkdown>{redactBody(report.body)}</ReportMarkdown>
          )}
        </article>
      )}
    </div>
  );
}
