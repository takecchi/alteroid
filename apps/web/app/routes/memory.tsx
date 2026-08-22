import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { Page } from '~/components/page';
import { Button, Card, Empty, ErrorNote, Input, Spinner } from '~/components/ui';
import { useMemoryDocuments } from '~/hooks/queries';
import { formatBytes, formatRelative } from '~/lib/format';

/** サーバ側と同じ規則（`memorySlugSchema`）。ここで弾いて 400 を待たない。 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export default function Memory() {
  const { data, error, isLoading } = useMemoryDocuments();
  const navigate = useNavigate();
  const [slug, setSlug] = useState('');

  const documents = data?.documents ?? [];
  const valid = SLUG_PATTERN.test(slug) && slug.length <= 128;

  return (
    <Page
      title="記憶"
      description="クローンの価値観そのもの。人間がいつでも読んで直せることが信頼の要件（提供価値1）"
    >
      <ErrorNote error={error} className="mb-4" />

      <Card className="mb-4 p-4">
        <p className="mb-2 text-sm font-medium">新しい記憶を書く</p>
        <div className="flex gap-2">
          <Input
            value={slug}
            placeholder="slug（英小文字・数字・. _ - のみ）"
            onChange={(event) => setSlug(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && valid) void navigate(`/memory/${slug}`);
            }}
          />
          <Button
            variant="primary"
            disabled={!valid}
            onClick={() => void navigate(`/memory/${slug}`)}
          >
            開く
          </Button>
        </div>
        {slug !== '' && !valid && (
          <p className="mt-1.5 text-xs text-danger">
            使えるのは英小文字・数字・`.` `_` `-` で、先頭は英数字。128 文字まで。
          </p>
        )}
      </Card>

      {isLoading ? (
        <Spinner />
      ) : documents.length === 0 ? (
        <Card>
          <Empty>
            まだ空。起動直後に人間の登場が多いのは正しい動作で、価値観が溜まるほど確認は減る。
          </Empty>
        </Card>
      ) : (
        <Card>
          <ul>
            {documents.map((document) => (
              <li key={document.slug} className="border-b border-border last:border-b-0">
                <Link
                  to={`/memory/${document.slug}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      <span className="mr-1.5 text-[10px] text-muted">[{document.kind}]</span>
                      {document.title}
                    </p>
                    <p className="truncate font-mono text-[11px] text-muted">{document.slug}</p>
                    {document.description !== undefined && (
                      <p className="truncate text-[11px] text-muted">
                        {freshnessMark(document.descriptionFreshness.kind)}
                        {document.description}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-[11px] text-muted">
                    {formatBytes(document.bytes)} · {formatRelative(document.updatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}

/**
 * 印は要旨の前に置く（`packages/core/src/memory.ts` と同じ約束）。
 *
 * **代理指標である。** `fresh`（印なし）は「要旨が最後の本文変更以降に
 * 書かれた」ことしか意味せず、「本文を読み直して書き直した」ことの保証では
 * ない。誤字だけ直しても fresh になる。
 */
function freshnessMark(kind: 'fresh' | 'stale' | 'unknown' | 'absent'): string {
  switch (kind) {
    case 'stale':
      return '⚠古い要旨: ';
    case 'unknown':
      return '？鮮度不明: ';
    default:
      return '';
  }
}
