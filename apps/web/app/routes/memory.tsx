import { MemoryTabs } from '~/components/group-tabs';
import { useId, useState } from 'react';
import { Link, Outlet, useNavigate, useParams } from 'react-router';

import {
  Page,
  Button,
  Empty,
  ErrorNote,
  Input,
  ListDetail,
  ListDetailItems,
  Spinner,
} from '@alteroid/ui';
import { useMemoryDocuments } from '@alteroid/swr';
import {
  describeMemoryDescriptionDrift,
  formatBytes,
  formatCreatedAtRelative,
  formatMemoryStaleness,
  formatRelative,
} from '@alteroid/logic';
import type { MemorySummary } from '@alteroid/logic';

/** サーバ側と同じ規則（`memorySlugSchema`）。ここで弾いて 400 を待たない。 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * 記憶の一覧と中身は1画面（`ListDetail`）。この経路は `memory/:slug` の親（layout route）で、
 * 右の中身は子の経路（`memory-detail.tsx`）が `<Outlet />` に出る。URL は今までどおり
 * （`/memory`・`/memory/:slug`）。選択は子の `:slug` から読む。
 */
export default function Memory() {
  const { data, error, isLoading } = useMemoryDocuments();
  const navigate = useNavigate();
  const slugId = useId();
  const [slug, setSlug] = useState('');
  const { slug: selectedSlug } = useParams();

  const documents = data?.documents ?? [];
  const valid = SLUG_PATTERN.test(slug) && slug.length <= 128;
  /**
   * **取れなかったのを0件と描かない**（issue #2324）。一覧をまだ一度も読めていないまま
   * 失敗したとき、失敗は上の `ErrorNote` が言う。「正しい動作」は言い切りになる。
   * 再検証の失敗で `data` が残っているときは当たらず、一覧をそのまま出す。
   */
  const listUnavailable = data === undefined && error !== undefined;

  return (
    /*
      本文の余白とスクロールは外す（`overflow-hidden p-0 md:p-0`）。`ListDetail` が左右のペインを
      それぞれスクロールさせるため。
    */
    <Page
      tabs={<MemoryTabs />}
      title="記憶"
      description="クローンの価値観そのもの。人間がいつでも読んで直せる"
      className="overflow-hidden p-0 md:p-0"
    >
      <div className="flex h-full flex-col">
        {/* 名前を入れて開く欄は、ペイン幅（288px）に収まらないので、一覧の上の帯に置く。 */}
        <div className="shrink-0 border-b border-border px-4 py-3 md:px-6">
          <p className="mb-2 text-sm font-medium">新しい記憶を書く</p>
          <label htmlFor={slugId} className="mb-1 block text-xs text-muted-foreground">
            名前（半角の英小文字・数字・. _ - のみ）
          </label>
          <div className="flex gap-2 md:max-w-md">
            <Input
              id={slugId}
              value={slug}
              placeholder="例: work-style"
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
            <p className="mt-1.5 text-xs text-destructive">
              使えるのは半角の英小文字・数字と . _ - で、先頭は英数字。128 文字まで。
            </p>
          )}
        </div>

        <ListDetail
          className="min-h-0 flex-1"
          listLabel="記憶の一覧"
          detailLabel="記憶の中身"
          hasSelection={selectedSlug !== undefined}
          selectionKey={selectedSlug}
          emptyDetail={<Empty>左の一覧から記憶を選ぶと、その中身がここに出る。</Empty>}
          list={
            <>
              <ErrorNote error={error} className="m-3" />
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
                        {/* 一覧の1行は Markdown 化の対象外（`components/markdown.tsx` の doc） */}
                        <div className="flex items-baseline">
                          <span
                            className="mr-1.5 shrink-0 text-[10px] text-muted-foreground"
                            title={kindHint(document.kind)}
                          >
                            {kindLabel(document.kind)}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{document.title}</span>
                        </div>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">
                          {document.slug}
                        </p>
                        {document.description !== undefined && (
                          // 一覧の1行は Markdown 化の対象外（`components/markdown.tsx` の doc）
                          <p className="line-clamp-2 break-words text-[11px] text-muted-foreground">
                            {freshnessMark(document.descriptionFreshness)}
                            {document.description}
                          </p>
                        )}
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {formatBytes(document.bytes)} · 作成{' '}
                          {formatCreatedAtRelative(document.createdAt)} · 更新{' '}
                          {formatRelative(document.updatedAt)}
                        </p>
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

/**
 * `[premise]` / `[fact]` / `[indexed]` タグに付ける、人間向けの1行説明
 * （`title` 属性・ホバーで出る）。
 *
 * **人間が `~/.alteroid/memory/*.md` を直接開いたときの `type:` frontmatter
 * と対応させてある。** 一覧の1行は Markdown 化の対象外（タグの文字だけでは
 * 「indexed」が何を意味するか分からないので、ここで意味を持たせる
 * （`packages/core/src/memory.ts` の `renderIndexedCard` の doc と同じ説明）。
 */
/** 記憶の種別（内部の語）を利用者向けの名前にする。 */
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
 *
 * **`stale` は本文の変化量（`drift`、#913）も期間に並べて言う。** 時間差
 * だけでは「いちばん手が入っている文書がいちばん新しく見える」ので、
 * 期間フレーズは置き換えず追記する。
 */
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
