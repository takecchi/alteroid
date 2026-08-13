import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { Page } from '~/components/page';
import { Button, ErrorNote, Spinner, Textarea } from '~/components/ui';
import { useDeleteMemory, useSaveMemory } from '~/hooks/mutations';
import { useMemoryDocument } from '~/hooks/queries';
import { formatDateTime } from '~/lib/format';

import type { Route } from './+types/memory-detail';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { slug: params.slug };
}

export default function MemoryDetail({ loaderData }: Route.ComponentProps) {
  const { slug } = loaderData;
  const { data, error, isLoading } = useMemoryDocument(slug);
  const saveMemory = useSaveMemory();
  const deleteMemory = useDeleteMemory();
  const navigate = useNavigate();

  /**
   * `undefined` は「まだ人間が触っていない」。
   *
   * 取得した内容を state へ**写さない**ので、SSE が無効化を回して再取得が
   * 走っても書きかけが消えない。触っていない間はサーバの値をそのまま映し、
   * 触った瞬間から下書きが勝つ。
   */
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [savedAt, setSavedAt] = useState<string | undefined>(undefined);

  const loaded = data?.document.content ?? '';
  const value = draft ?? loaded;
  const dirty = draft !== undefined && draft !== loaded;

  // 記憶が無い slug は 404 になる。それは「これから書く」場合なので、
  // 失敗ではなく空の編集画面として扱う。
  const missing = error !== undefined && (error as { status?: number }).status === 404;

  function save() {
    if (draft === undefined) return;
    setBusy(true);
    setFailure(undefined);
    saveMemory(slug, draft)
      .then((document) => {
        setSavedAt(document.updatedAt);
        // 保存できたら下書きを畳んで、またサーバの値に追従させる。
        setDraft(undefined);
      })
      .catch(setFailure)
      .finally(() => setBusy(false));
  }

  return (
    <Page
      title={
        <span className="flex items-center gap-2">
          <Link to="/memory" className="text-muted hover:text-fg">
            記憶
          </Link>
          <span className="text-muted">/</span>
          <span className="font-mono text-sm">{slug}</span>
        </span>
      }
      description={
        savedAt !== undefined
          ? `保存した（${formatDateTime(savedAt)}）`
          : data !== undefined
            ? `更新 ${formatDateTime(data.document.updatedAt)}`
            : missing
              ? 'まだ無い記憶。書けば作られる'
              : undefined
      }
      action={
        <div className="flex items-center gap-2">
          {!missing && data !== undefined && (
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                deleteMemory(slug)
                  .then(() => navigate('/memory'))
                  .catch(setFailure)
                  .finally(() => setBusy(false));
              }}
            >
              削除
            </Button>
          )}
          <Button variant="primary" size="sm" loading={busy} disabled={!dirty} onClick={save}>
            {dirty ? '保存する' : '変更なし'}
          </Button>
        </div>
      }
      className="flex flex-col"
    >
      {!missing && <ErrorNote error={error} className="mb-3" />}
      <ErrorNote error={failure} className="mb-3" />

      {isLoading && !missing ? (
        <Spinner />
      ) : (
        <>
          <p className="mb-2 text-xs text-muted">
            ここで書き換えたものは `memory_update`（cause: human）として日誌に残る。
          </p>
          <Textarea
            className="min-h-[60vh] flex-1 font-mono text-xs leading-relaxed"
            value={value}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 's') {
                event.preventDefault();
                save();
              }
            }}
          />
        </>
      )}
    </Page>
  );
}
