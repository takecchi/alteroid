import { MemoryTabs } from '~/components/group-tabs';
import { AlertTriangle } from 'lucide-react';
import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { Page, Button, Card, Empty, ErrorNote, FieldHint, Input, Spinner } from '@alteroid/ui';
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
      className="mb-4 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn"
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
  const { data, error, isLoading } = usePractices();
  const navigate = useNavigate();
  const slugId = useId();
  const [slug, setSlug] = useState('');

  const practices = data?.practices ?? [];
  // **読めなかった行**（`GET /practices` の `unreadable`。issue #2346）。1件でも在るときだけ
  // 載る——無ければ空配列として扱う（0件のとき何も出さない）。
  const unreadable = data?.unreadable ?? [];
  const hintId = useId();
  const valid = SLUG_PATTERN.test(slug) && slug.length <= 128;
  /**
   * **取れなかったのを0件と描かない**（issue #2324）。一覧をまだ一度も読めていないまま
   * 失敗したとき、失敗は上の `ErrorNote` が言う。「正常な状態」は言い切りになる。
   * 再検証の失敗で `data` が残っているときは当たらず、一覧をそのまま出す。
   */
  const listUnavailable = data === undefined && error !== undefined;

  return (
    <Page
      tabs={<MemoryTabs />}
      title="やり方"
      description="仕事のやり方の控え。読んで従うかどうかは毎回クローンが決める。alteroid が自動で実行するものではない"
    >
      <ErrorNote error={error} className="mb-4" />

      <Card className="mb-4 p-4">
        <p className="mb-2 text-sm font-medium">新しいやり方を書く</p>
        <label htmlFor={slugId} className="mb-1 block text-xs text-muted-foreground">
          名前（半角の英小文字・数字・. _ - のみ）
        </label>
        <div className="flex gap-2">
          <Input
            id={slugId}
            aria-describedby={hintId}
            value={slug}
            placeholder="例: work-style"
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
        <FieldHint id={hintId} className="mt-1.5">
          先頭は英数字で、128 文字まで。
        </FieldHint>
        {slug !== '' && !valid && (
          <p className="mt-1.5 text-xs text-destructive">
            使えるのは半角の英小文字・数字と . _ - で、先頭は英数字。128 文字まで。
          </p>
        )}
      </Card>

      {isLoading || listUnavailable || unreadable.length === 0 ? null : (
        <UnreadablePracticesNote unreadable={unreadable} />
      )}

      {isLoading ? (
        <Spinner />
      ) : listUnavailable ? null : practices.length === 0 ? (
        <Card>
          {unreadable.length > 0 ? (
            // **「まだ1件も無い」「正常」と言えるのは、読めない行が0件のときだけ**
            // （issue #2346）。読めない行が在れば、読めた行が無いとしか言えない。
            <Empty>読めたやり方は無い。無いとも、正常だとも言えない（読めない行が在る）。</Empty>
          ) : (
            <Empty>まだ1件も無い。これは正常な状態——やり方が書かれていない仕事も普通に進む。</Empty>
          )}
        </Card>
      ) : (
        <Card>
          <ul>
            {practices.map((practice) => (
              <li key={practice.slug} className="border-b border-border last:border-b-0">
                {/* 行全体をリンクにしない（#2808）。リンクは題名だけにして、slug・サイズ・日時は
                    選択・コピーできる文字にする。 */}
                <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline text-sm">
                      <span className="mr-1.5 shrink-0 text-[10px] text-muted-foreground">
                        {practiceKindLabel(practice.kind)}
                      </span>
                      {/* 押せる範囲は題名の行いっぱい（縦は上下に 4px ずつ足して 28px。-my で行の高さは変えない） */}
                      <Link
                        to={`/practices/${practice.slug}`}
                        className="-my-1 block min-w-0 truncate py-1 underline-offset-2 hover:underline"
                      >
                        {practice.title}
                      </Link>
                    </div>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {practice.slug}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {/* `chars` は本文の文字数（コードポイント数。`practiceMetaSchema` の
                        doc）。`formatBytes` を当てると「B / KB」と名乗ってしまっていた
                        （#1340）。CLI とクローンの道具と同じく「文字」と刷る。 */}
                    {practice.chars} 文字 · 作成 {formatRelative(practice.createdAt)} · 更新{' '}
                    {formatRelative(practice.updatedAt)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}
