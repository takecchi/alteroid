import { MemoryTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { AlertTriangle } from 'lucide-react';
import { useId, useState } from 'react';
import { Link, Outlet, useNavigate, useParams } from 'react-router';

import {
  Page,
  Button,
  Empty,
  FieldHint,
  Input,
  isImeConfirmEnter,
  ListDetail,
  ListDetailItems,
  Spinner,
  cn,
} from '@alteroid/ui';
import { usePractices } from '@alteroid/swr';
import { formatRelative } from '@alteroid/logic';
import type { UnreadablePractice } from '@alteroid/logic';

/**
 * 読めないやり方の行の断り（issue #2346。`tokens.tsx` の `UnreadableRowsNote` /
 * `commitments.tsx` の `UnreadableNote` と同じ形）。
 *
 * **「消えたのではなく、読めない形で入っている」と言う。** 題・本文は出ない（デーモンが
 * 返さない）。slug が取れた行は、その slug を開いて書き直すか消せる。
 */
function UnreadablePracticesNote({ unreadable }: { unreadable: readonly UnreadablePractice[] }) {
  return (
    <div
      role="status"
      className="m-3 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 break-words">
        <p>
          読めないやり方が {unreadable.length} 件ある（消えたのではなく、読めない形で入っている）。
          この一覧には載っていない。
        </p>
        <ul className="mt-1 list-disc pl-5">
          {unreadable.map((row, index) => (
            <li key={`${row.slug ?? ''}:${index}`}>
              {row.slug === undefined ? (
                '（名前も取れない）'
              ) : (
                <Link to={`/practices/${row.slug}`} className="font-mono underline break-all">
                  {row.slug}
                </Link>
              )}
              {' — '}
              {row.reason}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** サーバ側と同じ規則（`practiceSlugSchema`）。ここで弾いて 400 を待たない。 */
/** やり方の種類。知っている内部の語は利用者向けの名前にし、自由に付けられた種類はそのまま出す。 */
export function practiceKindLabel(kind: string): string {
  if (kind === 'procedure') return '手順';
  if (kind === 'routine') return '定例';
  return kind;
}

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
  const { data, error, isLoading, isValidating, mutate } = usePractices();
  const navigate = useNavigate();
  const slugId = useId();
  const [slug, setSlug] = useState('');
  const { slug: selectedSlug } = useParams();

  const practices = data?.practices ?? [];
  // **読めなかった行**（`GET /practices` の `unreadable`。issue #2346）。1件でも在るときだけ
  // 載る——無ければ空配列として扱う（0件のとき何も出さない）。
  const unreadable = data?.unreadable ?? [];
  const hintId = useId();
  const valid = SLUG_PATTERN.test(slug) && slug.length <= 128;
  /**
   * **取れなかったのを0件と描かない**（issue #2324）。一覧をまだ一度も読めていないまま
   * 失敗したとき、失敗は `LoadError` が言う。「正常な状態」は言い切りになる。
   * 再検証の失敗で `data` が残っているときは当たらず、一覧をそのまま出す。
   */
  const listUnavailable = data === undefined && error !== undefined;

  return (
    /*
      一覧と中身は1画面（`ListDetail`）。この経路は `practices/:slug` の親（layout route）で、右の中身は
      子の経路（`practice-detail.tsx`）が `<Outlet />` に出る。URL は今までどおり。本文の余白と
      スクロールは外す（`overflow-hidden p-0 md:p-0`）。左右のペインがそれぞれスクロールする。
    */
    <Page
      tabs={<MemoryTabs />}
      title="やり方"
      description="仕事のやり方の控え。読んで従うかどうかは毎回クローンが決める。alteroid が自動で実行するものではない"
      className="overflow-hidden p-0 md:p-0"
    >
      <div className="flex h-full flex-col">
        {/*
          名前を入れて開く欄は、ペイン幅（288px）に収まらないので、一覧の上の帯に置く。
          狭い画面でやり方を開いているあいだは畳む（中身の領域を広く使う。「やり方」のタブで一覧へ戻れば出る）。
        */}
        <div
          className={cn(
            'shrink-0 border-b border-border px-4 py-3 md:px-6',
            selectedSlug !== undefined && 'hidden md:block',
          )}
        >
          <div className="md:flex md:items-end md:gap-6">
            <div className="md:shrink-0">
              <p className="mb-2 text-sm font-medium md:mb-1">新しいやり方を書く</p>
              <label htmlFor={slugId} className="mb-1 block text-xs text-muted-foreground md:mb-0">
                名前（半角の英小文字・数字・. _ - のみ）
              </label>
            </div>
            <div className="flex gap-2 md:w-96">
              <Input
                id={slugId}
                aria-describedby={hintId}
                value={slug}
                placeholder="例: work-style"
                onChange={(event) => setSlug(event.target.value)}
                onKeyDown={(event) => {
                  // IME の変換を確定する Enter では遷移しない（`isImeConfirmEnter` の注釈）。
                  if (isImeConfirmEnter(event)) return;
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
          </div>
          <FieldHint id={hintId} className="mt-1.5">
            先頭は英数字で、128 文字まで。
          </FieldHint>
          {slug !== '' && !valid && (
            <p className="mt-1.5 text-xs text-destructive">
              使えるのは半角の英小文字・数字と . _ - で、先頭は英数字。128 文字まで。
            </p>
          )}
        </div>

        <ListDetail
          className="min-h-0 flex-1"
          listLabel="やり方の一覧"
          detailLabel="やり方の中身"
          hasSelection={selectedSlug !== undefined}
          selectionKey={selectedSlug}
          emptyDetail={<Empty>左の一覧からやり方を選ぶと、その中身がここに出る。</Empty>}
          list={
            <>
              <LoadError
                what="やり方の一覧"
                error={error}
                onRetry={() => mutate()}
                retrying={isValidating}
                className="m-3"
              />
              {isLoading || listUnavailable || unreadable.length === 0 ? null : (
                <UnreadablePracticesNote unreadable={unreadable} />
              )}
              {isLoading ? (
                <Spinner />
              ) : listUnavailable ? null : practices.length === 0 ? (
                unreadable.length > 0 ? (
                  // **「まだ1件も無い」「正常」と言えるのは、読めない行が0件のときだけ**
                  // （issue #2346）。読めない行が在れば、読めた行が無いとしか言えない。
                  <Empty inset="card">
                    読めたやり方は無い。無いとも、正常だとも言えない（読めない行が在る）。
                  </Empty>
                ) : (
                  <Empty inset="card">
                    まだ1件も無い。これは正常な状態——やり方が書かれていない仕事も普通に進む。
                  </Empty>
                )
              ) : (
                <ListDetailItems
                  label="やり方"
                  items={practices.map((practice) => ({
                    key: practice.slug,
                    href: `/practices/${practice.slug}`,
                    current: practice.slug === selectedSlug,
                    // 行全体をリンクにする（#3107）。ほかの一覧（マネージャー・日報）と同じく、行のどこを
                    // 押しても開く。かつては題だけをリンクにして、名前・文字数・日時を選択・コピーできる
                    // 文字にしていた（#2808。`ListDetailItems` の `lead` / `extra`）が、題の文字の上で
                    // しか開かず、ほかの一覧と使用感がずれていた。
                    children: (
                      <>
                        <span className="flex items-baseline">
                          <span className="mr-1.5 shrink-0 text-[10px] text-muted-foreground">
                            {practiceKindLabel(practice.kind)}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{practice.title}</span>
                        </span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">
                          {practice.slug}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                          {/* `chars` は本文の文字数（コードポイント数。`practiceMetaSchema` の
                              doc）。`formatBytes` を当てると「B / KB」と名乗ってしまっていた
                              （#1340）。CLI とクローンの道具と同じく「文字」と刷る。 */}
                          {practice.chars} 文字 · 作成 {formatRelative(practice.createdAt)} · 更新{' '}
                          {formatRelative(practice.updatedAt)}
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
