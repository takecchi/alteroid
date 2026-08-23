import { Link } from 'react-router';

import { Markdown } from '~/components/markdown';
import { Page } from '~/components/page';
import { Card, Empty, ErrorNote, Spinner } from '~/components/ui';
import { useReport, useReports } from '~/hooks/queries';
import { cn } from '~/lib/cn';
import { formatDateTime, formatTime } from '~/lib/format';

import type { DailyReport } from '~/lib/types';

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
      <p className="text-sm text-danger">
        ⚠ <strong className="font-medium">この日の日報は作れなかった</strong>
        。以下はクローンが書いたまとめではなく、書けなかった理由である。
      </p>
      <pre className="mt-2 overflow-x-auto rounded border border-border bg-bg p-2 text-[11px] break-words whitespace-pre-wrap text-muted">
        {reason}
      </pre>
      <p className="mt-2 text-xs text-muted">
        この日の記録は
        <Link to="/journal" className="text-accent hover:underline">
          日誌
        </Link>
        に残っている。書けていないだけなので、原因が解ければ
        <Link to="/schedule" className="text-accent hover:underline">
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
function reportLabel(report: DailyReport): string {
  return `${report.date} ${formatTime(report.at)}`;
}

export default function Reports({ loaderData }: Route.ComponentProps) {
  const { date, reportId } = loaderData;
  const list = useReports(60);

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

  return (
    <Page title="日報" description="普段の接点はほぼこれだけでよい。掘りたくなったら日誌へ降りる">
      <ErrorNote error={list.error} className="mb-4" />

      {/*
        `lg` 未満にはこの容器へ `grid-template-columns` の指定が1つも無かった
        （旧: `grid gap-4 lg:grid-cols-[16rem_1fr]`）。無い場合の暗黙の単一
        トラックは `auto`＝max-content になるので、**中身の内在幅がそのまま
        トラック幅**になり枠を超えうる（#265/#282 と同じ形の欠落。#283 で
        特定・追跡）。`grid-cols-1` を足して傘を掛けるのが根の直し。

        **`lg:grid-cols-[16rem_1fr]` の生の `1fr` は `minmax(auto,1fr)` に
        展開される**（#265 で特定済み）ので、`lg` 以上でも2つ目の列（1fr側）の
        自動最小サイズは content-based のままである。1つ目の列（16rem側、
        `<Card className="h-fit">`）は一覧の1行が短い固定フォーマットの文字列
        （日付+時刻）で、空白のところで折り返せるため実害は無いと判断し、
        `min-w-0` は足していない。2つ目の列（1fr側）に来る子には `min-w-0` を
        足す — `<ReportBody>` のルート `Card` には既に付いている。日報が0件の
        ときに出る `<Card><Empty>…</Empty></Card>` はこの列に来る唯一のもう
        1つの分岐で、こちらには付いていなかったので今回足した。

        **jsdom はレイアウトを持たないので、この修正が実機で効いていることは
        テストでは確かめられない。** 下のテストが保証するのはクラスが当たって
        いることまでである。
      */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[16rem_1fr]">
        <Card className="h-fit">
          {list.isLoading ? (
            <Spinner />
          ) : reports.length === 0 ? (
            <Empty>まだ無い。</Empty>
          ) : (
            <ul>
              {reports.map((report, index) => (
                <li key={report.id}>
                  <Link
                    to={`/reports/${report.date}/${encodeURIComponent(report.id)}`}
                    className={cn(
                      'block px-4 py-2 text-sm hover:bg-surface-2',
                      /*
                        **罫線は日付の変わり目にだけ引く。** 同じ日のものが1つの塊に
                        見えるので、時刻だけが違う行が並んでいることが形から分かる
                        （1日1件の日は今までと同じ見え方になる）。

                        **これは「同じ日の行が隣り合っている」ことに乗っている。**
                        並びが書いた順だった間は隣り合う保証が無く、遡り生成の日報が
                        別の日付を挟んで離れると、同じ日に何本も罫線が引かれた。
                        保証は `apps/daemon/src/reports.ts` が持つ（日付の新しい順）。
                      */
                      reports[index + 1]?.date !== report.date && 'border-b border-border',
                      report.id === selectedId && 'bg-surface-2 text-accent',
                    )}
                  >
                    {reportLabel(report)}
                    {/*
                      **印の付いた行は、開く前に分かる形にする。** 印を出さないと
                      「日報がある行」と同じ顔になり、人間は開くまで気づけない
                      （本文がエラー文だった穴と同じ形が、一覧の側に残る）。
                    */}
                    {isUnavailable(report) && (
                      <span className="ml-1 text-danger" title="この日の日報は作れなかった">
                        ⚠
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {selectedDate === undefined ? (
          <Card className="min-w-0">
            <Empty>
              日報が1件も無い。クローンが締め時刻にまとめる（スケジュールから今すぐ回せる）。
            </Empty>
          </Card>
        ) : (
          <ReportBody date={selectedDate} reportId={selectedId} />
        )}
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

  return (
    <Card className="min-w-0">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">
          {report === undefined ? date : reportLabel(report)}
        </h2>
      </div>
      <ErrorNote error={error} className="m-4" />
      {isLoading ? (
        <Spinner />
      ) : report === undefined ? (
        <Empty>この日の日報は無い。</Empty>
      ) : (
        <article className="min-w-0 px-4 py-3">
          {/*
            **「書かれたのは」を省かないこと。** 見出しは「何日ぶんの日報か」
            （`date`）で、ここは「いつ書かれたか」（`at`）である。遡り生成では
            この2つの日が食い違う（前日ぶんが翌日に書かれる）ので、裸の時刻を
            置くと見出しと矛盾しているように見える。
          */}
          <p className="mb-2 text-[11px] text-muted">書かれたのは {formatDateTime(report.at)}</p>
          {isUnavailable(report) ? (
            <UnavailableNote reason={report.unavailable} />
          ) : (
            <Markdown>{report.body}</Markdown>
          )}
        </article>
      )}
    </Card>
  );
}
