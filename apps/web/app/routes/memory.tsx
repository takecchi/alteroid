import { MemoryTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { NewSlugForm } from '~/components/new-slug-form';
import { Link, Outlet, useParams } from 'react-router';

import { Page, Empty, ListDetail, ListDetailItems, Spinner } from '@alteroid/ui';
import { useMemoryDocuments } from '@alteroid/swr';
import {
  describeMemoryDescriptionDrift,
  formatBytes,
  formatCreatedAtRelative,
  formatMemoryStaleness,
  formatRelative,
  redactBody,
} from '@alteroid/logic';
import type { MemorySummary } from '@alteroid/logic';

export default function Memory() {
  const { data, error, isLoading, isValidating, mutate } = useMemoryDocuments();
  const { slug: selectedSlug } = useParams();

  const documents = data?.documents ?? [];
  // 取れなかったのを0件と描かない: 「正しい動作」は言い切りになるため
  const listUnavailable = data === undefined && error !== undefined;

  return (
    <Page
      tabs={<MemoryTabs />}
      title="記憶"
      description="クローンの価値観そのもの。人間がいつでも読んで直せる"
      className="overflow-hidden p-0 md:p-0"
    >
      <div className="flex h-full flex-col">
        <NewSlugForm heading="新しい記憶を書く" basePath="/memory" selectedSlug={selectedSlug} />

        <ListDetail
          className="min-h-0 flex-1"
          listLabel="記憶の一覧"
          detailLabel="記憶の中身"
          hasSelection={selectedSlug !== undefined}
          selectionKey={selectedSlug}
          emptyDetail={<Empty>左の一覧から記憶を選ぶと、その中身がここに出る。</Empty>}
          list={
            <>
              <LoadError
                what="記憶の一覧"
                error={error}
                onRetry={() => mutate()}
                retrying={isValidating}
                className="m-3"
              />
              {isLoading ? (
                <Spinner />
              ) : listUnavailable ? null : documents.length === 0 ? (
                <Empty inset="card">
                  まだ空。起動直後に人間の登場が多いのは正しい動作で、価値観が溜まるほど確認は減る。
                </Empty>
              ) : (
                <ListDetailItems
                  label="記憶"
                  items={documents.map((document) => ({
                    key: document.slug,
                    href: `/memory/${document.slug}`,
                    current: document.slug === selectedSlug,
                    children: (
                      <>
                        <span className="flex items-baseline">
                          <span
                            className="mr-1.5 shrink-0 text-[10px] text-muted-foreground"
                            title={kindHint(document.kind)}
                          >
                            {kindLabel(document.kind)}
                          </span>
                          {/* 伏せる: 題と説明は人間かクローンが書いた文で、本文（<Markdown>）と揃えるため */}
                          <span className="min-w-0 flex-1 truncate">
                            {redactBody(document.title)}
                          </span>
                        </span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">
                          {document.slug}
                        </span>
                        {document.description !== undefined && (
                          <span className="line-clamp-2 break-words text-[11px] text-muted-foreground">
                            {freshnessMark(document.descriptionFreshness)}
                            {redactBody(document.description)}
                          </span>
                        )}
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                          {formatBytes(document.bytes)} · 作成{' '}
                          {formatCreatedAtRelative(document.createdAt)} · 更新{' '}
                          {formatRelative(document.updatedAt)}
                        </span>
                      </>
                    ),
                  }))}
                  renderLink={({ href, ...rest }) => <Link to={href} {...rest} />}
                />
              )}
            </>
          }
          detail={<Outlet />}
        />
      </div>
    </Page>
  );
}

function kindLabel(kind: 'premise' | 'fact' | 'indexed'): string {
  switch (kind) {
    case 'premise':
      return '前提';
    case 'indexed':
      return '特定の作業用';
    case 'fact':
      return '事実';
    default:
      return kind;
  }
}

function kindHint(kind: 'premise' | 'fact' | 'indexed'): string {
  switch (kind) {
    case 'premise':
      return '前提: 判断のよりどころ。クローンは毎回、要旨と見出しの一覧を見ている（本文は開いたときだけ読む）。';
    case 'indexed':
      return '特定の作業用: その作業のときにだけ使う記憶。クローンは毎回、要旨だけを見ている（見出しは必要なときに確かめる）。';
    case 'fact':
      return '事実: 事実の蓄積。クローンは毎回、目次の1行だけを見ている（本文は開いたときだけ読む）。';
    default:
      return '';
  }
}

// absent 以外の3状態は必ず何か言う: fresh を空文字にすると、ほぼ常に ⚠ が付いて読み手が常に鳴る印に慣れ、他の印にも鈍くなるため
// 期間フレーズは置き換えず変化量を追記する: 時間差だけでは「いちばん手が入っている文書がいちばん新しく見える」ため
function freshnessMark(freshness: MemorySummary['descriptionFreshness']): string {
  switch (freshness.kind) {
    case 'stale':
      return (
        `要旨は本文より${formatMemoryStaleness(freshness.staleForMs)}古い` +
        `（${describeMemoryDescriptionDrift(freshness.drift)}）: `
      );
    case 'unknown':
      return '要旨を書いた時刻が記録されていない: ';
    case 'fresh':
      return '要旨の後に本文は動いていない: ';
    case 'absent':
      return '';
  }
}
