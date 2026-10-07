import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';

import { LoadError } from '~/components/load-error';

import { Badge, Button, Card, CardHeader, Empty, Page, Spinner } from '@alteroid/ui';
import { ApiError, useArchive, useArchiveBody } from '@alteroid/swr';
import { formatBytes, formatDateTime, redactBody } from '@alteroid/logic';

// 大きな本文を一度に DOM へ載せない: 全部を1つの <pre> に入れるとブラウザが固まるため
// 伏せ字は窓で切る前の全体に掛ける: 複数行にまたがる秘密（鍵のブロック等）を取りこぼさないため
const CHUNK_CHARS = 100_000;

function cutAt(text: string, from: number, limit: number): number {
  const hard = from + limit;
  if (hard >= text.length) return text.length;
  const newline = text.lastIndexOf('\n', hard - 1);
  return newline >= from + limit / 2 ? newline + 1 : hard;
}

export default function ArchiveDetail() {
  const { id } = useParams();
  return (
    <Page
      title="アーカイブの本文"
      description="退避した会話の生ログです（読むだけ。本文を消す操作は一覧にあります）"
    >
      <div className="flex flex-col gap-4">
        <Link to="/archive" className="text-sm underline">
          アーカイブの一覧へ戻る
        </Link>
        {id === undefined ? <NotFound /> : <Body key={id} id={id} />}
      </div>
    </Page>
  );
}

function NotFound() {
  return (
    <Card>
      <Empty inset="card">その生ログはありません</Empty>
    </Card>
  );
}

function Body({ id }: { id: string }) {
  const { data, error, isLoading, isValidating, mutate } = useArchiveBody(id);
  // 失敗を出さない: 見出しの添え物（日時・使用量）が取れなくても本文は読めるため
  const { data: list } = useArchive();
  const entry = list?.entries.find((candidate) => candidate.id === id);

  const notFound = error instanceof ApiError && error.status === 404;
  const unavailable = data === undefined && error !== undefined;

  return (
    <Card>
      <CardHeader
        title={entry === undefined ? '生ログ' : `${formatDateTime(entry.at)} の会話`}
        {...(entry === undefined ? {} : { subtitle: `使用量 ${formatBytes(entry.storedBytes)}` })}
      />
      {notFound && data === undefined ? (
        <Empty inset="card">その生ログはありません</Empty>
      ) : (
        <>
          <LoadError
            what="生ログの本文"
            error={error}
            onRetry={() => mutate()}
            retrying={isValidating}
            className="m-4"
          />
          {isLoading ? (
            <div className="p-4">
              <Spinner />
            </div>
          ) : unavailable || data === undefined ? null : data.kind === 'removed' ? (
            <Removed removedAt={data.removedAt} bytes={data.bytes} />
          ) : (
            <Text body={data.body} />
          )}
        </>
      )}
    </Card>
  );
}

function Removed({ removedAt, bytes }: { removedAt: string; bytes: number }) {
  return (
    <div className="p-4 text-sm">
      <Badge tone="warn">本文は削除済み</Badge>
      <p className="mt-2 text-muted-foreground">
        {formatDateTime(removedAt)} に本文を消しました（消した本文は {formatBytes(bytes)}）。
        一覧の行は残っていますが、中身は戻せません。
      </p>
    </div>
  );
}

function Text({ body }: { body: string }) {
  const text = useMemo(() => redactBody(body), [body]);
  const [shown, setShown] = useState(() => cutAt(text, 0, CHUNK_CHARS));
  const end = Math.min(shown, text.length);

  if (text === '') {
    return <Empty inset="card">本文は空です</Empty>;
  }
  return (
    <div className="px-4 py-3">
      <pre
        data-testid="archive-body"
        className="max-h-[70vh] overflow-auto rounded border border-border bg-background p-2 text-[11px] break-words whitespace-pre-wrap text-muted-foreground select-text"
      >
        {text.slice(0, end)}
      </pre>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {end >= text.length
            ? `全体を表示しています（${formatBytes(new Blob([text]).size)}）`
            : `先頭の ${end.toLocaleString()} 文字 / 全体 ${text.length.toLocaleString()} 文字を表示しています（長いので少しずつ出します）`}
        </span>
        {end < text.length && (
          <Button size="sm" onClick={() => setShown(cutAt(text, end, CHUNK_CHARS))}>
            続きを表示
          </Button>
        )}
      </div>
    </div>
  );
}
