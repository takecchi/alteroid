import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { Page } from '~/components/page';
import { Button, Card, Empty, ErrorNote, Input, Spinner } from '~/components/ui';
import { useMemoryDocuments } from '~/hooks/queries';
import {
  formatBytes,
  formatCreatedAtRelative,
  formatMemoryStaleness,
  formatRelative,
} from '~/lib/format';
import type { MemorySummary } from '~/lib/types';

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
                    {/* 一覧の1行は Markdown 化の対象外（`components/markdown.tsx` の doc） */}
                    <p className="truncate text-sm">
                      <span
                        className="mr-1.5 text-[10px] text-muted"
                        title={kindHint(document.kind)}
                      >
                        [{document.kind}]
                      </span>
                      {document.title}
                    </p>
                    <p className="truncate font-mono text-[11px] text-muted">{document.slug}</p>
                    {document.description !== undefined && (
                      // 一覧の1行は Markdown 化の対象外（`components/markdown.tsx` の doc）
                      <p className="truncate text-[11px] text-muted">
                        {freshnessMark(document.descriptionFreshness)}
                        {document.description}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-[11px] text-muted">
                    {formatBytes(document.bytes)} · 作成{' '}
                    {formatCreatedAtRelative(document.createdAt)} · 更新{' '}
                    {formatRelative(document.updatedAt)}
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
 * `[premise]` / `[fact]` / `[indexed]` タグに付ける、人間向けの1行説明
 * （`title` 属性・ホバーで出る）。
 *
 * **人間が `~/.alteroid/memory/*.md` を直接開いたときの `type:` frontmatter
 * と対応させてある。** 一覧の1行は Markdown 化の対象外（タグの文字だけでは
 * 「indexed」が何を意味するか分からないので、ここで意味を持たせる
 * （`packages/core/src/memory.ts` の `renderIndexedCard` の doc と同じ説明）。
 */
function kindHint(kind: 'premise' | 'fact' | 'indexed'): string {
  switch (kind) {
    case 'premise':
      return 'premise: 判断の前提。毎ターン要旨と節の目次がクローンのプロンプトへ焼かれる（本文は開くまで載らない）。';
    case 'indexed':
      return 'indexed: 特定の作業でしか使わない記憶。毎ターン要旨だけが焼かれ、節の目次は焼かれない（節は memory_outline で確かめる）。';
    case 'fact':
      return 'fact: 事実の蓄積。毎ターン目次の1行だけが焼かれる（本文は開くまで載らない）。';
    default:
      return '';
  }
}

/**
 * 印は要旨の前に置く（`packages/core/src/memory.ts` と同じ約束）。
 *
 * **代理指標である。** `fresh` は「要旨が最後の本文変更以降に書かれた」
 * ことしか意味せず、「本文を読み直して書き直した」ことの保証ではない。
 * 誤字だけ直しても fresh になる。
 *
 * **`absent` 以外の3状態は必ず何か言う（#821）。** かつて `stale` /
 * `unknown` だけが `⚠` / `？` を出し、`fresh` は空文字だった——本文の変更
 * 頻度が要旨の書き直し頻度を大きく上回るこの記憶の運用下では、その形は
 * ほぼ常に `⚠` が付いた状態を作り、読み手は常に鳴る印に慣れて他の印にも
 * 鈍くなった（#821 の実測: 12/12 文書で `⚠` が付いていた）。`stale` は
 * どれだけ古いかを `formatMemoryStaleness` で言い、`unknown` は「取れな
 * かった」を「0（＝最新）」に見せず別の言葉で言い、`fresh` は「本文は
 * 動いていない」という正直なゼロを、`unknown` とは違う言葉で言う。
 */
function freshnessMark(freshness: MemorySummary['descriptionFreshness']): string {
  switch (freshness.kind) {
    case 'stale':
      return `要旨は本文より${formatMemoryStaleness(freshness.staleForMs)}古い: `;
    case 'unknown':
      return '要旨を書いた時刻が記録されていない: ';
    case 'fresh':
      return '要旨の後に本文は動いていない: ';
    case 'absent':
      return '';
  }
}
