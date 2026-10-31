import { useState } from 'react';
import { useNavigate } from 'react-router';

import {
  DocumentTitle,
  MarkdownEditor,
  type MarkdownEditorMode,
  Button,
  ConfirmDialog,
  ErrorNote,
  Spinner,
} from '@alteroid/ui';
import {
  MemoryConflictError,
  useDeleteMemory,
  useSaveMemory,
  useMemoryDocument,
} from '@alteroid/swr';
import { formatCreatedAt, formatDateTime } from '@alteroid/logic';

import {
  LeaveGuardScope,
  useIsMounted,
  useReleaseLeaveGuard,
  useReportDirty,
} from '~/lib/leave-guard';
import { ConflictNotice, DeleteConflictNotice } from '~/components/conflict-notice';
import { GoneAfterReadNote } from '~/components/gone-after-read-note';
import { InvalidSlugNote } from '~/components/invalid-slug-note';
import { isNotFound } from '~/lib/is-not-found';
import { isValidSlug } from '~/lib/slug';
import { useVersionedDraft } from '~/lib/use-versioned-draft';

import type { Route } from './+types/memory-detail';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { slug: params.slug };
}

// `key={slug}` で作り直す: 親は同じで `:slug` だけ変わるので、素のままだと下書き・版の控え・衝突の表示が次の記憶へ持ち越される。
export default function MemoryDetail({ loaderData }: Route.ComponentProps) {
  return (
    <LeaveGuardScope key={loaderData.slug}>
      {isValidSlug(loaderData.slug) ? (
        <MemoryDetailBody slug={loaderData.slug} />
      ) : (
        <InvalidSlugNote kind="記憶" slug={loaderData.slug} />
      )}
    </LeaveGuardScope>
  );
}

function MemoryDetailBody({ slug }: { slug: string }) {
  const { data, error, isLoading } = useMemoryDocument(slug);
  const saveMemory = useSaveMemory();
  const deleteMemory = useDeleteMemory();
  const navigate = useNavigate();
  const mounted = useIsMounted();

  // 取得した内容を state へ写さない: SSE の無効化で再取得が走っても書きかけが消えないように。
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const {
    busy,
    failure,
    savedAt,
    conflict,
    deleteConflict,
    setDeleteConflict,
    createdWhileDrafting,
    touch,
    save,
    discardDraft,
    deleteVersion,
    runDelete,
  } = useVersionedDraft({
    read: data,
    hasDraft: draft !== undefined,
    fields: draft,
    sameFields: (a, b) => a === b,
    canSave: () => draft !== undefined,
    isConflict: (caught): caught is MemoryConflictError => caught instanceof MemoryConflictError,
    // 保存の門が下書きの有無を見ているので、ここで undefined にはならない
    send: (sent, ifMatch) =>
      saveMemory(slug, sent ?? '', ifMatch).then(({ document, version }) => ({
        updatedAt: document.updatedAt,
        version,
      })),
    clearFields: () => setDraft(undefined),
  });

  const loaded = data?.document.content ?? '';
  const value = draft ?? loaded;
  const dirty = draft !== undefined && draft !== loaded;

  const notFound = isNotFound(error);
  const missing = notFound && data === undefined;
  const goneAfterRead = notFound && data !== undefined;

  // 取れなかったのを空の記憶と描かない: 空の編集欄と保存ボタンを出すと、既存の記憶を空で上書きできてしまうため。
  const loadFailed = data === undefined && error !== undefined && !missing;

  // 「無い」は404（これから書く）と、在るが本文が空の2つ。分けるとプレビューが真っ白な画面が既定で開く。
  const [tab, setTab] = useState<MarkdownEditorMode | undefined>(undefined);
  const defaultTab: MarkdownEditorMode = missing || loaded.trim() === '' ? 'edit' : 'preview';

  function edit(next: string) {
    touch();
    setDraft(next);
  }

  const releaseLeaveGuard = useReleaseLeaveGuard();
  useReportDirty('draft', dirty);

  const description =
    savedAt !== undefined
      ? `保存した（${formatDateTime(savedAt)}）` +
        (data !== undefined ? ` · 作成 ${formatCreatedAt(data.document.createdAt)}` : '')
      : data !== undefined
        ? `作成 ${formatCreatedAt(data.document.createdAt)} · 更新 ${formatDateTime(data.document.updatedAt)}`
        : missing
          ? 'まだ無い記憶。書けば作られる'
          : undefined;

  return (
    <div className="flex min-h-full flex-col">
      <DocumentTitle>{`${slug} - 記憶`}</DocumentTitle>
      <header className="mb-4 flex shrink-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-mono text-base font-semibold break-all">{slug}</h2>
          {description !== undefined && (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!missing && !goneAfterRead && data !== undefined && (
            <>
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmingDelete(true)}
              >
                削除
              </Button>
              <ConfirmDialog
                open={confirmingDelete}
                onOpenChange={setConfirmingDelete}
                title={`「${slug}」を削除しますか`}
                description="この記憶は本文ごと消え、元に戻せません。"
                confirmLabel="削除する"
                destructive
                onConfirm={() => {
                  setConfirmingDelete(false);
                  // 書き始めた時点に無かった記憶が、いまはある（#4802）: いまの内容は人が見ていないので、送らずに 409 と同じ形で見せる（削除の口の版は文字列だけで「無いはず」を表せないため）。見たうえでもう一度押せば、見せた版で消す
                  if (createdWhileDrafting) {
                    setDeleteConflict(
                      new MemoryConflictError(
                        '書き始めた後にこの記憶が作られた（見ていない内容は消していない）',
                        {
                          document: data.document,
                          version: data.version,
                        },
                      ),
                    );
                    return;
                  }
                  runDelete(
                    () => deleteMemory(slug, deleteVersion()),
                    () => {
                      // 応答待ちに別の記憶へ移っていたら、その画面を動かさない。
                      if (!mounted.current) return;
                      releaseLeaveGuard();
                      navigate('/memory');
                    },
                  );
                }}
              />
            </>
          )}
          {!loadFailed && (
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={!dirty}
              onClick={() => save()}
            >
              {dirty ? '保存する' : '変更なし'}
            </Button>
          )}
        </div>
      </header>

      {!missing && !goneAfterRead && <ErrorNote error={error} className="mb-3" />}
      {goneAfterRead && <GoneAfterReadNote noun="記憶" />}
      <ErrorNote error={failure} className="mb-3" />
      {deleteConflict !== undefined && (
        <DeleteConflictNotice
          noun="記憶"
          current={deleteConflict.current === null ? null : deleteConflict.current.document}
          onClose={() => setDeleteConflict(undefined)}
        />
      )}
      {conflict !== undefined && (
        <ConflictNotice
          noun="記憶"
          current={conflict.current === null ? null : conflict.current.document}
          busy={busy}
          onOverwrite={() => save(conflict.current === null ? null : conflict.current.version)}
          onDiscard={discardDraft}
        />
      )}

      {isLoading && !missing ? (
        <Spinner />
      ) : loadFailed ? null : (
        <MarkdownEditor
          value={value}
          onChange={edit}
          onSave={() => save()}
          saveDisabled={!dirty || busy}
          modes={['preview', 'edit']}
          mode={tab}
          defaultMode={defaultTab}
          onModeChange={setTab}
          hint="ここで書き換えたものは、人間が直した記録として日誌に残る。"
          saveHint={null}
          emptyPreview={null}
          placeholder=""
          // 外部の画像は読み込まない: 記憶はクローンも書き、プレビューを開いた瞬間に閲覧の時刻・IP が画像の置き場へ漏れるため
          remoteImages={false}
        />
      )}
    </div>
  );
}
