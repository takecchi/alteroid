import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Tabs } from 'radix-ui';

import {
  DocumentTitle,
  Markdown,
  Button,
  ConfirmDialog,
  ErrorNote,
  Input,
  Spinner,
  TAB_TRIGGER_ACTIVE_CLASS,
  TAB_TRIGGER_CLASS,
  SubmitHint,
  Textarea,
  cn,
} from '@alteroid/ui';
import {
  useDeletePractice,
  PracticeConflictError,
  useSavePractice,
  usePractice,
  usePracticeVersion,
  usePracticeVersions,
} from '@alteroid/swr';
import { formatDateTime } from '@alteroid/logic';
import { practiceKindLabel } from './practices';

import {
  LeaveGuardScope,
  useIsMounted,
  useReleaseLeaveGuard,
  useReportDirty,
} from '~/lib/leave-guard';
import { useLatest } from '~/lib/use-latest';

import type { Route } from './+types/practice-detail';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { slug: params.slug };
}

// `kind` は自由入力にする: プルダウンの固定リストにすると、`practiceKindSchema` を enum にしないと決めた理由（仕事の型を実装専用に狭めない）が骨抜きになる。
// 履歴タブに「この版へ戻す」は置かない: 戻す操作は `write()` の全文置換と同じで、中身を見て「編集」タブへ手でコピーすれば足りる。
// `key={slug}` で作り直す: 親は同じで `:slug` だけ変わるので、素のままだと下書き・開いていた版・タブが次のやり方へ持ち越される。
export default function PracticeDetail({ loaderData }: Route.ComponentProps) {
  return (
    <LeaveGuardScope key={loaderData.slug}>
      <PracticeDetailBody slug={loaderData.slug} />
    </LeaveGuardScope>
  );
}

function PracticeDetailBody({ slug }: { slug: string }) {
  const { data, error, isLoading } = usePractice(slug);
  const savePractice = useSavePractice();
  const deletePractice = useDeletePractice();
  const navigate = useNavigate();
  const mounted = useIsMounted();

  const [historyVersion, setHistoryVersion] = useState<number | undefined>(undefined);
  const { data: history, error: historyError } = usePracticeVersions(slug);
  const {
    data: historyDetail,
    error: historyDetailError,
    isLoading: historyDetailLoading,
  } = usePracticeVersion(slug, historyVersion);
  // 全タブが常にマウントされる（radix-ui の Tabs.Content は `hidden` で隠すだけ）ので、履歴タブを開いていなくても評価される。応答の形が想定と違ってもクラッシュしない形にする。
  const historyVersions = history?.versions ?? [];

  // 取得した値を state へ写さない: SSE の無効化で再取得が走っても書きかけが消えないように。
  const [draftKind, setDraftKind] = useState<string | undefined>(undefined);
  const [draftTitle, setDraftTitle] = useState<string | undefined>(undefined);
  const [draftContent, setDraftContent] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [savedAt, setSavedAt] = useState<string | undefined>(undefined);
  // 取得した版へ追従させない: 別の書き手が書いた後に再取得が走っても、人間が見て書き始めた版を前提にし続けないと衝突を検出できない。
  const [baseVersion, setBaseVersion] = useState<string | null | undefined>(undefined);
  // 再取得が追いつく前に編集を再開しても、古い `data.version` を前提にして偽の 409 を起こさないために持つ。
  const [lastSaved, setLastSaved] = useState<
    { replaces: string | null; version: string } | undefined
  >(undefined);
  const [conflict, setConflict] = useState<PracticeConflictError | undefined>(undefined);
  const [deleteConflict, setDeleteConflict] = useState<PracticeConflictError | undefined>(
    undefined,
  );

  const loadedKind = data?.practice.kind ?? '';
  const loadedTitle = data?.practice.title ?? '';
  const loadedContent = data?.practice.content ?? '';

  const hasDraft =
    draftKind !== undefined || draftTitle !== undefined || draftContent !== undefined;
  function touch() {
    if (hasDraft) return;
    const fetched = data === undefined ? null : data.version;
    setBaseVersion(
      lastSaved !== undefined && lastSaved.replaces === fetched ? lastSaved.version : fetched,
    );
  }

  const kind = draftKind ?? loadedKind;
  const title = draftTitle ?? loadedTitle;
  const content = draftContent ?? loadedContent;
  const latestFields = useLatest({ kind, title, content });

  const dirty =
    (draftKind !== undefined && draftKind !== loadedKind) ||
    (draftTitle !== undefined && draftTitle !== loadedTitle) ||
    (draftContent !== undefined && draftContent !== loadedContent);

  const notFound = error !== undefined && (error as { status?: number }).status === 404;
  const missing = notFound && data === undefined;
  const goneAfterRead = notFound && data !== undefined;

  // 取れなかったのを空のやり方と描かない: 空の編集欄と保存ボタンを出すと、既存のやり方を空で上書きできてしまうため。
  const loadFailed = data === undefined && error !== undefined && !missing;

  // `kind` が空だと 400 が返るだけなので、ここで弾いて待たせない。
  const canSave = dirty && kind.trim() !== '';

  const [tab, setTab] = useState<string | undefined>(undefined);
  const activeTab = tab ?? (missing || content.trim() === '' ? 'edit' : 'preview');

  const releaseLeaveGuard = useReleaseLeaveGuard();
  useReportDirty('draft', dirty);

  function save(ifMatch: string | null | undefined = baseVersion) {
    // ボタン・⌘/Ctrl+Enter・⌘/Ctrl+S のどの経路もここを通るので、保存中の弾きはここに置く。
    if (busy) return;
    // 衝突のあとは、再取得で「変更なし」に見えても、人間が選んだ上書きは通す。
    if (!canSave && !(conflict !== undefined && hasDraft && kind.trim() !== '')) return;
    setBusy(true);
    setFailure(undefined);
    const sent = { kind, title, content };
    savePractice(slug, sent.kind, sent.title, sent.content, ifMatch)
      .then(({ practice, version }) => {
        setSavedAt(practice.updatedAt);
        setLastSaved({ replaces: data === undefined ? null : data.version, version });
        // 残すと次の削除が古い版を送る。
        setDeleteConflict(undefined);
        const now = latestFields.current;
        if (now.kind === sent.kind && now.title === sent.title && now.content === sent.content) {
          discardDraft();
        } else {
          // 打ち足した分を残すので、保存できた版を前提にする。さもないと次の保存が自分の保存と衝突する。
          setBaseVersion(version);
          setConflict(undefined);
        }
      })
      .catch((caught: unknown) => {
        if (caught instanceof PracticeConflictError) setConflict(caught);
        else setFailure(caught);
      })
      .finally(() => setBusy(false));
  }

  function discardDraft() {
    setDraftKind(undefined);
    setDraftTitle(undefined);
    setDraftContent(undefined);
    setBaseVersion(undefined);
    setConflict(undefined);
  }

  const description =
    savedAt !== undefined
      ? `保存した（${formatDateTime(savedAt)}）` +
        (data !== undefined ? ` · 作成 ${formatDateTime(data.practice.createdAt)}` : '')
      : data !== undefined
        ? `作成 ${formatDateTime(data.practice.createdAt)} · 更新 ${formatDateTime(data.practice.updatedAt)}`
        : missing
          ? 'まだ無いやり方。書けば作られる'
          : undefined;

  return (
    <div className="flex min-h-full flex-col">
      <DocumentTitle>{`${slug} - やり方`}</DocumentTitle>
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
                description="このやり方は本文ごと消え、元に戻せません。"
                confirmLabel="削除する"
                destructive
                onConfirm={() => {
                  setBusy(true);
                  setConfirmingDelete(false);
                  deletePractice(slug, deleteConflict?.current?.version ?? data.version)
                    .then(() => {
                      // 応答待ちに別のやり方へ移っていたら、その画面を動かさない。
                      if (!mounted.current) return;
                      releaseLeaveGuard();
                      navigate('/practices');
                    })
                    .catch((caught: unknown) => {
                      if (caught instanceof PracticeConflictError) setDeleteConflict(caught);
                      else setFailure(caught);
                    })
                    .finally(() => setBusy(false));
                }}
              />
            </>
          )}
          {!loadFailed && (
            <>
              {activeTab === 'edit' && <SubmitHint action="保存" />}
              <Button
                variant="primary"
                size="sm"
                loading={busy}
                disabled={!canSave}
                onClick={() => save()}
              >
                {dirty ? '保存する' : '変更なし'}
              </Button>
            </>
          )}
        </div>
      </header>

      {!missing && !goneAfterRead && <ErrorNote error={error} className="mb-3" />}
      {goneAfterRead && (
        <p role="alert" className="mb-3 rounded-lg border border-warn/50 p-3 text-sm text-warn">
          このやり方は、読んだ後に別の手段で消された（または見つからない）。下の内容は前に読めたときのもので、書きかけもそのまま残してある。保存するときは、消されたものを書き戻すかどうかを確認する。
        </p>
      )}
      <ErrorNote error={failure} className="mb-3" />
      {deleteConflict !== undefined && (
        <div role="alert" className="mb-3 rounded-lg border border-destructive/50 p-3 text-sm">
          <p className="font-medium text-destructive">
            {deleteConflict.current === null
              ? '読んだ後に、このやり方はほかで消された。こちらでは消していない。'
              : '読んだ後に、このやり方がほかで書き換えられた。消していない。'}
          </p>
          {deleteConflict.current !== null && (
            <>
              <p className="mt-2 text-xs text-muted-foreground">
                いまの内容（{formatDateTime(deleteConflict.current.practice.updatedAt)} に更新）
              </p>
              <p className="mt-1 text-xs break-words">
                種類: {practiceKindLabel(deleteConflict.current.practice.kind)} / 題:{' '}
                {deleteConflict.current.practice.title}
              </p>
              <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs break-words whitespace-pre-wrap select-text">
                {deleteConflict.current.practice.content}
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
              ? '読んだ後に、このやり方がほかで消された。保存していない（下書きはそのまま残してある）。'
              : '読んだ後に、このやり方がほかで書き換えられた。保存していない（下書きはそのまま残してある）。'}
          </p>
          {conflict.current !== null && (
            <>
              <p className="mt-2 text-xs text-muted-foreground">
                いまの内容（{formatDateTime(conflict.current.practice.updatedAt)} に更新）
              </p>
              <p className="mt-1 text-xs break-words">
                種類: {practiceKindLabel(conflict.current.practice.kind)} / 題:{' '}
                {conflict.current.practice.title}
              </p>
              <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs break-words whitespace-pre-wrap select-text">
                {conflict.current.practice.content}
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
        <Tabs.Root value={activeTab} onValueChange={setTab} className="flex flex-1 flex-col">
          <Tabs.List className="mb-2 flex shrink-0 gap-1 border-b border-border">
            <Tabs.Trigger
              value="preview"
              className={cn(TAB_TRIGGER_CLASS, activeTab === 'preview' && TAB_TRIGGER_ACTIVE_CLASS)}
            >
              プレビュー
            </Tabs.Trigger>
            <Tabs.Trigger
              value="edit"
              className={cn(TAB_TRIGGER_CLASS, activeTab === 'edit' && TAB_TRIGGER_ACTIVE_CLASS)}
            >
              編集
            </Tabs.Trigger>
            <Tabs.Trigger
              value="history"
              className={cn(TAB_TRIGGER_CLASS, activeTab === 'history' && TAB_TRIGGER_ACTIVE_CLASS)}
            >
              履歴
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="preview" className="min-h-0 flex-1 overflow-y-auto">
            <p className="mb-2 text-xs text-muted-foreground">
              <span className="mr-1.5 text-[10px]">
                {kind === '' ? '（種類未設定）' : practiceKindLabel(kind)}
              </span>
              {title}
            </p>
            {/* 外部の画像は読み込まない: やり方はクローンも書き、開いた瞬間に閲覧の時刻・IP が画像の置き場へ漏れるため */}
            <Markdown remoteImages={false}>{content}</Markdown>
          </Tabs.Content>

          <Tabs.Content value="edit" className="flex min-h-0 flex-1 flex-col gap-3">
            <p className="shrink-0 text-xs text-muted-foreground">
              ここで書き換えたものは、人間が直した記録として日誌に残る。
              種類は自由に書ける（一覧から選ぶのではない）。
            </p>
            <label className="shrink-0 text-xs text-muted-foreground">
              種類
              <Input
                className="mt-1"
                value={kind}
                placeholder="例: 実装・調査・相談・レビュー・日報"
                onChange={(event) => {
                  touch();
                  setDraftKind(event.target.value);
                }}
              />
            </label>
            <label className="shrink-0 text-xs text-muted-foreground">
              題
              <Input
                className="mt-1"
                value={title}
                placeholder="一覧で見る短い題"
                onChange={(event) => {
                  touch();
                  setDraftTitle(event.target.value);
                }}
              />
            </label>
            <label className="flex min-h-0 flex-1 flex-col text-xs text-muted-foreground">
              本文
              <Textarea
                className="mt-1 min-h-[50vh] font-mono text-xs leading-relaxed"
                value={content}
                spellCheck={false}
                onChange={(event) => {
                  touch();
                  setDraftContent(event.target.value);
                }}
                // `flex-1` にしない: 伸びる欄には固定の flex 基準が邪魔になる。
                maxHeight="60vh"
                onSubmitShortcut={() => save()}
                submitDisabled={!canSave || busy}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 's') {
                    event.preventDefault();
                    save();
                  }
                }}
              />
            </label>
          </Tabs.Content>

          <Tabs.Content
            value="history"
            className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto md:flex-row"
          >
            <div className="shrink-0 overflow-y-auto border-b border-border pb-3 md:w-64 md:border-r md:border-b-0 md:pr-3 md:pb-0">
              <p className="mb-2 text-xs text-muted-foreground">
                保存のたびに版が1つ増える。削除しても版は消えない。
              </p>
              {historyError !== undefined && history !== undefined && (
                <ErrorNote error={historyError} className="mb-2" />
              )}
              {historyError !== undefined && history === undefined ? (
                // 取れなかったのを読み込み中と区別する: `Spinner` のまま回り続けないように。
                <ErrorNote error={historyError} />
              ) : history === undefined ? (
                <Spinner />
              ) : historyVersions.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  まだ版が無い（一度も書かれていない）。
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {[...historyVersions].reverse().map((v) => (
                    <li key={v.version}>
                      <button
                        type="button"
                        className={cn(
                          'w-full rounded px-2 py-1 text-left text-xs hover:bg-muted',
                          historyVersion === v.version && 'bg-muted font-medium',
                        )}
                        onClick={() => setHistoryVersion(v.version)}
                      >
                        <span className="mr-1.5 font-mono">版{v.version}</span>
                        <span className="mr-1.5 text-[10px] text-muted-foreground">
                          {practiceKindLabel(v.kind)}
                        </span>
                        <span>{v.title}</span>
                        <span className="block text-[10px] text-muted-foreground">
                          {formatDateTime(v.at)} · {v.chars} 文字
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="min-w-0 flex-1 overflow-y-auto">
              {historyVersion === undefined ? (
                <p className="text-xs text-muted-foreground">
                  左の一覧から版を選ぶと、本文をここに読み取り専用で出す。
                </p>
              ) : historyDetailError !== undefined && historyDetail === undefined ? (
                // 取れなかったのを読み込み中と区別する: `Spinner` のまま回り続けないように。
                <ErrorNote error={historyDetailError} />
              ) : historyDetailLoading || historyDetail === undefined ? (
                <Spinner />
              ) : (
                <>
                  {historyDetailError !== undefined && (
                    <ErrorNote error={historyDetailError} className="mb-2" />
                  )}
                  <p className="mb-2 text-xs text-muted-foreground">
                    版{historyDetail.version.version}（
                    {practiceKindLabel(historyDetail.version.kind)}）{historyDetail.version.title} ·{' '}
                    {formatDateTime(historyDetail.version.at)}
                  </p>
                  <Markdown remoteImages={false}>{historyDetail.version.content}</Markdown>
                </>
              )}
            </div>
          </Tabs.Content>
        </Tabs.Root>
      )}
    </div>
  );
}
