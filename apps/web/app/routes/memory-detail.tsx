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
import { useLatest } from '~/lib/use-latest';

import type { Route } from './+types/memory-detail';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { slug: params.slug };
}

// `key={slug}` で作り直す: 親は同じで `:slug` だけ変わるので、素のままだと下書き・版の控え・衝突の表示が次の記憶へ持ち越される。
export default function MemoryDetail({ loaderData }: Route.ComponentProps) {
  return (
    <LeaveGuardScope key={loaderData.slug}>
      <MemoryDetailBody slug={loaderData.slug} />
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
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [savedAt, setSavedAt] = useState<string | undefined>(undefined);
  // 取得した版へ追従させない: クローンが書いた後に再取得が走っても、人間が見て書き始めた版を前提にし続けないと衝突を検出できない。
  const [baseVersion, setBaseVersion] = useState<string | null | undefined>(undefined);
  // 再取得が追いつく前に編集を再開しても、古い `data.version` を前提にして偽の 409 を起こさないために持つ。
  const [lastSaved, setLastSaved] = useState<
    { replaces: string | null; version: string } | undefined
  >(undefined);
  const [conflict, setConflict] = useState<MemoryConflictError | undefined>(undefined);
  const [deleteConflict, setDeleteConflict] = useState<MemoryConflictError | undefined>(undefined);

  const loaded = data?.document.content ?? '';
  const value = draft ?? loaded;
  const dirty = draft !== undefined && draft !== loaded;
  const latestDraft = useLatest(draft);

  const notFound = error !== undefined && (error as { status?: number }).status === 404;
  const missing = notFound && data === undefined;
  const goneAfterRead = notFound && data !== undefined;

  // 取れなかったのを空の記憶と描かない: 空の編集欄と保存ボタンを出すと、既存の記憶を空で上書きできてしまうため。
  const loadFailed = data === undefined && error !== undefined && !missing;

  // 「無い」は404（これから書く）と、在るが本文が空の2つ。分けるとプレビューが真っ白な画面が既定で開く。
  const [tab, setTab] = useState<MarkdownEditorMode | undefined>(undefined);
  const defaultTab: MarkdownEditorMode = missing || loaded.trim() === '' ? 'edit' : 'preview';

  function edit(next: string) {
    if (draft === undefined) {
      const fetched = data === undefined ? null : data.version;
      setBaseVersion(
        lastSaved !== undefined && lastSaved.replaces === fetched ? lastSaved.version : fetched,
      );
    }
    setDraft(next);
  }

  function save(ifMatch: string | null | undefined = baseVersion) {
    // ボタン・⌘/Ctrl+Enter・⌘/Ctrl+S のどの経路もここを通るので、保存中の弾きはここに置く。
    if (busy) return;
    if (draft === undefined) return;
    const sent = draft;
    setBusy(true);
    setFailure(undefined);
    saveMemory(slug, sent, ifMatch)
      .then(({ document, version }) => {
        setSavedAt(document.updatedAt);
        setLastSaved({ replaces: data === undefined ? null : data.version, version });
        if (latestDraft.current === sent) {
          setDraft(undefined);
          setBaseVersion(undefined);
        } else {
          // 打ち足した分を残すので、保存できた版を前提にする。さもないと次の保存が自分の保存と衝突する。
          setBaseVersion(version);
        }
        setConflict(undefined);
        // 残すと次の削除が古い版を送る。
        setDeleteConflict(undefined);
      })
      .catch((caught: unknown) => {
        if (caught instanceof MemoryConflictError) setConflict(caught);
        else setFailure(caught);
      })
      .finally(() => setBusy(false));
  }

  function discardDraft() {
    setDraft(undefined);
    setBaseVersion(undefined);
    setConflict(undefined);
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
                  setBusy(true);
                  setConfirmingDelete(false);
                  deleteMemory(slug, deleteConflict?.current?.version ?? data.version)
                    .then(() => {
                      // 応答待ちに別の記憶へ移っていたら、その画面を動かさない。
                      if (!mounted.current) return;
                      releaseLeaveGuard();
                      navigate('/memory');
                    })
                    .catch((caught: unknown) => {
                      if (caught instanceof MemoryConflictError) setDeleteConflict(caught);
                      else setFailure(caught);
                    })
                    .finally(() => setBusy(false));
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
      {goneAfterRead && (
        <p role="alert" className="mb-3 rounded-lg border border-warn/50 p-3 text-sm text-warn">
          この記憶は、読んだ後に別の手段で消された（または見つからない）。下の内容は前に読めたときのもので、書きかけもそのまま残してある。保存するときは、消されたものを書き戻すかどうかを確認する。
        </p>
      )}
      <ErrorNote error={failure} className="mb-3" />
      {deleteConflict !== undefined && (
        <div role="alert" className="mb-3 rounded-lg border border-destructive/50 p-3 text-sm">
          <p className="font-medium text-destructive">
            {deleteConflict.current === null
              ? '読んだ後に、この記憶はほかで消された。こちらでは消していない。'
              : '読んだ後に、この記憶がほかで書き換えられた。消していない。'}
          </p>
          {deleteConflict.current !== null && (
            <>
              <p className="mt-2 text-xs text-muted-foreground">
                いまの内容（{formatDateTime(deleteConflict.current.document.updatedAt)} に更新）
              </p>
              <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs break-words whitespace-pre-wrap select-text">
                {deleteConflict.current.document.content}
              </pre>
              <p className="mt-2 text-xs text-muted-foreground">
                この内容でも消すなら、もう一度「削除」を押して確認してください。
              </p>
            </>
          )}
          <div className="mt-3">
            <Button size="sm" onClick={() => setDeleteConflict(undefined)}>
              閉じる
            </Button>
          </div>
        </div>
      )}
      {conflict !== undefined && (
        <div role="alert" className="mb-3 rounded-lg border border-destructive/50 p-3 text-sm">
          <p className="font-medium text-destructive">
            {conflict.current === null
              ? '読んだ後に、この記憶がほかで消された。保存していない（下書きはそのまま残してある）。'
              : '読んだ後に、この記憶がほかで書き換えられた。保存していない（下書きはそのまま残してある）。'}
          </p>
          {conflict.current !== null && (
            <>
              <p className="mt-2 text-xs text-muted-foreground">
                いまの内容（{formatDateTime(conflict.current.document.updatedAt)} に更新）
              </p>
              <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs break-words whitespace-pre-wrap select-text">
                {conflict.current.document.content}
              </pre>
            </>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => save(conflict.current === null ? null : conflict.current.version)}
            >
              自分の内容で上書きする
            </Button>
            <Button size="sm" disabled={busy} onClick={discardDraft}>
              自分の下書きを捨てて、いまの内容を読み直す
            </Button>
          </div>
        </div>
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
