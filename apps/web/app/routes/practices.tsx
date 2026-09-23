import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { Page } from '~/components/page';
import { Button, Card, Empty, ErrorNote, Input, Spinner } from '~/components/ui';
import { usePractices } from '~/hooks/queries';
import { formatRelative } from '~/lib/format';

/** サーバ側と同じ規則（`practiceSlugSchema`）。ここで弾いて 400 を待たない。 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * 仕事のやり方の一覧（#1055 段3③）。`memory.tsx` と同じ形——一覧はメタ情報
 * だけで、本文は個別の画面で開く。
 *
 * **種類（`kind`）はプルダウンの固定リストにしない。** `practiceKindSchema` は
 * 自由文字列で、列挙にすると仕事の型を実装専用に狭めることになる
 * （`practiceKindSchema` の doc「⛔ ここを `z.enum` にしないこと」）。一覧の
 * `[種類]` タグは既に付いた値をそのまま出すだけで、選ばせる欄ではない。
 */
export default function Practices() {
  const { data, error, isLoading } = usePractices();
  const navigate = useNavigate();
  const [slug, setSlug] = useState('');

  const practices = data?.practices ?? [];
  const valid = SLUG_PATTERN.test(slug) && slug.length <= 128;

  return (
    <Page
      title="やり方"
      description="仕事のやり方（#1055 段3）。読んで従うかどうかは毎回クローンが決める——器はこれを実行しない"
    >
      <ErrorNote error={error} className="mb-4" />

      <Card className="mb-4 p-4">
        <p className="mb-2 text-sm font-medium">新しいやり方を書く</p>
        <div className="flex gap-2">
          <Input
            value={slug}
            placeholder="slug（英小文字・数字・. _ - のみ）"
            onChange={(event) => setSlug(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && valid) void navigate(`/practices/${slug}`);
            }}
          />
          <Button
            variant="primary"
            disabled={!valid}
            onClick={() => void navigate(`/practices/${slug}`)}
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
      ) : practices.length === 0 ? (
        <Card>
          <Empty>まだ1件も無い。これは正常な状態——やり方が書かれていない仕事も普通に進む。</Empty>
        </Card>
      ) : (
        <Card>
          <ul>
            {practices.map((practice) => (
              <li key={practice.slug} className="border-b border-border last:border-b-0">
                <Link
                  to={`/practices/${practice.slug}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      <span className="mr-1.5 text-[10px] text-muted">[{practice.kind}]</span>
                      {practice.title}
                    </p>
                    <p className="truncate font-mono text-[11px] text-muted">{practice.slug}</p>
                  </div>
                  <span className="shrink-0 text-[11px] text-muted">
                    {/* `chars` は本文の文字数（コードポイント数。`practiceMetaSchema` の
                        doc）。`formatBytes` を当てると「B / KB」と名乗ってしまっていた
                        （#1340）。CLI とクローンの道具と同じく「文字」と刷る。 */}
                    {practice.chars} 文字 · 作成 {formatRelative(practice.createdAt)} · 更新{' '}
                    {formatRelative(practice.updatedAt)}
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
