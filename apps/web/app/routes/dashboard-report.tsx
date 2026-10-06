import { BookText } from 'lucide-react';
import { Link } from 'react-router';

import {
  ErrorNote,
  HOME_LINK_CLASS,
  HomeReportCard,
  HomeTileNote,
  Markdown,
  Spinner,
} from '@alteroid/ui';
import { useReports } from '@alteroid/swr';
import { redactBody } from '@alteroid/logic';

// **表示の正本は `reports.tsx` の側に置く。** 日報の面が2つ（ここと `/reports`）
// あるので、判定と文言を書き写すと片方だけが古びる（本文がエラー文のまま出る側が
// 静かに残る）。
import { isUnavailable, UnavailableNote } from './reports';

/**
 * 最新の日報。ホームの主役のひとつなので、小さなカードの抜粋ではなく **全幅の枠で本文を
 * Markdown として描く**（`/reports` と同じ `Markdown` 部品と `redactBody`）。長い本文は
 * 枠の側（`HomeReportCard`）が高さで切り、本文の下のボタンでその場に全文へ広げる。日報のページへの入口は右上の「日報一覧」に残す。
 *
 * **印の付いた行（日報が書けなかった日）を日報として描かない**（`reports.tsx` の
 * `isUnavailable` / `UnavailableNote` の doc が経緯）。ここは人間が最初に開く面なので、
 * エラー文が「最新の日報」として出ると、塞いだ穴のうち人間に見える側だけが残る。
 * 印の行は本文を Markdown にしない（SDK のエラー文であって、クローンの文章ではない）。
 *
 * **取り直しの失敗は、前に読めた本文を残したまま、その場で言う**（issue #3346。進捗のタイルの
 * #3069 と同じ形）。`data` が無いときだけエラーにする。
 */
export function LatestReport() {
  const reports = useReports(1);
  const latest = reports.data?.reports[0];
  const readable = latest !== undefined && !isUnavailable(latest);
  return (
    <HomeReportCard
      icon={BookText}
      title="最新の日報"
      meta={readable ? latest.date : undefined}
      action={
        <Link to="/reports" className={HOME_LINK_CLASS}>
          日報一覧
        </Link>
      }
    >
      {reports.error !== undefined && reports.data !== undefined && (
        <HomeTileNote tone="warn">
          最新の日報を取り直せなかった。下は前に読めたときのもの。
        </HomeTileNote>
      )}
      {reports.error !== undefined && reports.data === undefined ? (
        <ErrorNote error={reports.error} />
      ) : reports.data === undefined ? (
        <Spinner />
      ) : latest === undefined ? (
        <p className="text-sm text-muted-foreground">
          まだ日報がない。締め時刻を待つか、スケジュールから今すぐ回せる。
        </p>
      ) : isUnavailable(latest) ? (
        <UnavailableNote reason={latest.unavailable} />
      ) : (
        <Markdown>{redactBody(latest.body)}</Markdown>
      )}
    </HomeReportCard>
  );
}
