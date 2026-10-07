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

// 判定と文言を書き写さず reports.tsx を正本にする: 日報の面が2つあり、書き写すと片方だけが古びるため
import { isUnavailable, UnavailableNote } from './reports';

const REPORTS_MALFORMED_MESSAGE = '最新の日報を読めていない（応答の形が想定と違う）';

// 印の付いた行（日報が書けなかった日）を日報として描かない: 人間が最初に開く面で、エラー文が「最新の日報」として出てしまうため
export function LatestReport() {
  const reports = useReports(1);
  // ?? [] で0件にしない: 配列でない応答は読めていないものとして扱うため
  const list = Array.isArray(reports.data?.reports) ? reports.data.reports : undefined;
  const malformed = reports.data !== undefined && list === undefined;
  const latest = list?.[0];
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
      ) : malformed ? (
        <ErrorNote error={new Error(REPORTS_MALFORMED_MESSAGE)} />
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
