import { useEffect, useRef, useState } from 'react';
import { useBlocker, useNavigate } from 'react-router';

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

import type { Route } from './+types/memory-detail';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { slug: params.slug };
}

/**
 * 一覧の右のペインに出る（親の経路 `memory.tsx` の `ListDetail`）。**親は同じままで子の `:slug` だけが
 * 変わる**ので、素のままだと別の記憶へ移っても同じ部品が使い回され、下書き・保存時刻・版の控え・
 * 衝突の表示が次の記憶へ持ち越される。**`key={slug}` で作り直す。** 未保存の編集があるときは、
 * 作り直しの前に `useBlocker` が移動そのものを止めて確認を出す（確認で「破棄して離れる」を
 * 選んだときだけ移り、作り直される）。
 */
export default function MemoryDetail({ loaderData }: Route.ComponentProps) {
  return <MemoryDetailBody key={loaderData.slug} slug={loaderData.slug} />;
}

function MemoryDetailBody({ slug }: { slug: string }) {
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
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [savedAt, setSavedAt] = useState<string | undefined>(undefined);
  /**
   * 下書きを書き始めた時点で読んでいた版（`ifMatch` に送る。#2743）。`undefined` は下書き無し。
   * **取得した版へ追従させない**——クローンが書いた後に再取得が走っても、人間が見て書き始めた版を
   * 前提にし続けるから、衝突が検出できる。`null` は「読んだ時には無かった」。
   */
  const [baseVersion, setBaseVersion] = useState<string | null | undefined>(undefined);
  /**
   * 直前の保存の応答が返した版（`replaces` はそのとき前提にした版）。再取得が追いつく前に編集を
   * 再開しても、古い `data.version` を前提にして偽の 409 を起こさないために持つ。
   * 再取得が `replaces` 以外の版を返したら（別の書き手が書いた）、そちらを信じる。
   */
  const [lastSaved, setLastSaved] = useState<
    { replaces: string | null; version: string } | undefined
  >(undefined);
  /** 保存が 409 で断られたときの、いまの版（下書きは捨てずに残す。#2764）。 */
  const [conflict, setConflict] = useState<MemoryConflictError | undefined>(undefined);
  /** 削除が 409 で断られたときの、いまの版（消していない。自動では再送しない。#2916）。 */
  const [deleteConflict, setDeleteConflict] = useState<MemoryConflictError | undefined>(undefined);

  const loaded = data?.document.content ?? '';
  const value = draft ?? loaded;
  const dirty = draft !== undefined && draft !== loaded;

  // 記憶が無い slug は 404 になる。それは「これから書く」場合なので、
  // 失敗ではなく空の編集画面として扱う。
  const notFound = error !== undefined && (error as { status?: number }).status === 404;
  const missing = notFound && data === undefined;
  /**
   * 読めた後の取り直しが 404（別の手段で消された。issue #3092）。`data` が残っているので
   * `missing` には含めない（「これから書く」ではない）。
   */
  const goneAfterRead = notFound && data !== undefined;

  /**
   * **取れなかったのを空の記憶と描かない**（issue #2319）。本文をまだ一度も
   * 読めていないまま404以外で失敗したとき、失敗は上の `ErrorNote` が言う。
   * ここで空の編集欄と保存ボタンを出すと、既存の記憶を空のまま上書き保存
   * できてしまう。404（これから書く）と、再検証の失敗で `data` が残って
   * いるときは当たらず、編集欄をそのまま出す（#2266 と同じ）。
   */
  const loadFailed = data === undefined && error !== undefined && !missing;

  /**
   * `undefined` は「まだ人間がタブに触っていない」— `draft` と同じ作法。
   *
   * データが届く前に既定タブを確定させない。届いたら、**読むものが在れば
   * プレビュー、無ければ編集**を既定にする。
   *
   * 「無い」は2つある。404（これから書く記憶）と、**在るが本文が空**である。
   * 後者は実在しうる状態で、`PUT /memory/:slug` の body スキーマは
   * `z.object({ content: z.string() })`（`apps/daemon/src/app.ts`）— 隣の
   * `answerBody` と違って `.min(1)` が無いので、空の記憶は API として正当に
   * 作れる。**この2つを分けると、プレビューが真っ白な画面が既定で開く。**
   */
  const [tab, setTab] = useState<MarkdownEditorMode | undefined>(undefined);
  const defaultTab: MarkdownEditorMode = missing || loaded.trim() === '' ? 'edit' : 'preview';

  /**
   * いまの下書き。保存の応答が返った時点の値と、送った値を突き合わせるために持つ
   * （`.then` の中の `draft` は送った時点のもので、保存中の追記は見えない）。
   */
  const latestDraft = useRef<string | undefined>(undefined);

  function edit(next: string) {
    latestDraft.current = next;
    // 書き始めた瞬間に、いま読んでいる版を前提として控える。
    if (draft === undefined) {
      const fetched = data === undefined ? null : data.version;
      setBaseVersion(
        lastSaved !== undefined && lastSaved.replaces === fetched ? lastSaved.version : fetched,
      );
    }
    setDraft(next);
  }

  /** `ifMatch` を渡して保存する。衝突したら下書きを残して、いまの版を見せる。 */
  function save(ifMatch: string | null | undefined = baseVersion) {
    // 保存中は何もしない。ボタン・⌘/Ctrl+Enter・⌘/Ctrl+S のどの経路もここを通る（#3300）。
    if (busy) return;
    if (draft === undefined) return;
    setBusy(true);
    setFailure(undefined);
    const sent = draft;
    saveMemory(slug, sent, ifMatch)
      .then(({ document, version }) => {
        setSavedAt(document.updatedAt);
        setLastSaved({ replaces: data === undefined ? null : data.version, version });
        setConflict(undefined);
        if (latestDraft.current === sent) {
          // 保存できたら下書きを畳んで、またサーバの値に追従させる。
          latestDraft.current = undefined;
          setDraft(undefined);
          setBaseVersion(undefined);
        } else {
          // 保存中に追記があった。追記は消さず、次の保存の基準だけ今回保存した版へ進める
          // （古い版のままだと次の保存が偽の 409 になる）。
          setBaseVersion(version);
        }
      })
      .catch((caught: unknown) => {
        if (caught instanceof MemoryConflictError) setConflict(caught);
        else setFailure(caught);
      })
      .finally(() => setBusy(false));
  }

  /** 最新を読み直す＝自分の下書きを捨てて、いまの版に追従する。 */
  function discardDraft() {
    latestDraft.current = undefined;
    setDraft(undefined);
    setBaseVersion(undefined);
    setConflict(undefined);
  }

  /**
   * **未保存の変更があるまま離れない（#2764）。** アプリ内の移動（リンク・戻る）は確認を挟み、
   * タブを閉じる・再読み込みはブラウザの警告に任せる。削除が通った後の移動は止めない。
   */
  const leaving = useRef(false);
  const blocker = useBlocker(() => dirty && !leaving.current);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // 古いブラウザは returnValue を入れないと出さない。
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const description =
    savedAt !== undefined
      ? `保存した（${formatDateTime(savedAt)}）` +
        // 保存直後でも作成時刻は画面から消さない（`data` が届いていれば足す）。
        (data !== undefined ? ` · 作成 ${formatCreatedAt(data.document.createdAt)}` : '')
      : data !== undefined
        ? `作成 ${formatCreatedAt(data.document.createdAt)} · 更新 ${formatDateTime(data.document.updatedAt)}`
        : missing
          ? 'まだ無い記憶。書けば作られる'
          : undefined;

  return (
    <div className="flex min-h-full flex-col">
      {/*
        詳細は一覧の右のペインに出る（親の経路 `memory.tsx` の `ListDetail`）ので、画面の枠
        （`Page`）も戻るリンクも持たない。画面の h1 は親が持ち、ここの見出しは h2。狭い画面では
        `ListDetail` の「記憶の一覧を開く」が一覧への戻り口になる。
      */}
      <DocumentTitle>{`${slug} - 記憶`}</DocumentTitle>
      <header className="mb-4 flex shrink-0 items-start justify-between gap-4">
        <div className="min-w-0">
          {/* 名前は最大128文字・空白なし。`break-all` で幅に収める（#2763） */}
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
              {/* 取り消せない操作（本文ごと消える）なので、押した瞬間には実行せず確認を挟む（#2781） */}
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
                  // 読んだ版を送る（#2916）。衝突のあとに開き直したときは、見せたいまの版を送る。
                  deleteMemory(slug, deleteConflict?.current?.version ?? data.version)
                    .then(() => {
                      leaving.current = true;
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
      {/*
        **読めた後の取り直しが 404 のとき（issue #3092）。** この記憶が別の手段で消された（または
        見つからなくなった）。`missing`（まだ無い＝これから書く）とは別で、本文と書きかけは消さずに
        残し、その旨を注記する。保存は読んだ版を `ifMatch` に送る既存の経路のままなので、消された
        ものを黙って蘇らせず、「ほかで消された」の確認（自分の内容で上書きする）に当たる。
      */}
      {goneAfterRead && (
        <p role="alert" className="mb-3 rounded-lg border border-warn/50 p-3 text-sm text-warn">
          この記憶は、読んだ後に別の手段で消された（または見つからない）。下の内容は前に読めたときのもので、書きかけもそのまま残してある。保存するときは、消されたものを書き戻すかどうかを確認する。
        </p>
      )}
      <ErrorNote error={failure} className="mb-3" />
      {deleteConflict !== undefined && (
        <div role="alert" className="mb-3 rounded-lg border border-destructive/50 p-3 text-sm">
          <p className="font-medium text-destructive">
            読んだ後に、この記憶がほかで書き換えられた。消していない。
          </p>
          {deleteConflict.current !== null && (
            <>
              <p className="mt-2 text-xs text-muted-foreground">
                いまの内容（{formatDateTime(deleteConflict.current.document.updatedAt)} に更新）
              </p>
              <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs break-words whitespace-pre-wrap select-text">
                {deleteConflict.current.document.content}
              </pre>
            </>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            この内容でも消すなら、もう一度「削除」を押して確認してください。
          </p>
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
      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(open) => {
          if (!open && blocker.state === 'blocked') blocker.reset();
        }}
        title="保存していない変更があります"
        description="このまま離れると、書きかけの内容は失われます。"
        confirmLabel="破棄して離れる"
        destructive
        onConfirm={() => {
          if (blocker.state === 'blocked') blocker.proceed();
        }}
      />

      {isLoading && !missing ? (
        <Spinner />
      ) : loadFailed ? null : (
        <MarkdownEditor
          value={value}
          onChange={edit}
          onSave={() => save()}
          saveDisabled={!dirty || busy}
          // 出すタブとその並びは今の画面のまま（プレビュー → 編集）。並べては出さない。
          modes={['preview', 'edit']}
          mode={tab}
          defaultMode={defaultTab}
          onModeChange={setTab}
          hint="ここで書き換えたものは、人間が直した記録として日誌に残る。"
          // 今の画面に無かったものは出さない（文言は変えない）。
          saveHint={null}
          emptyPreview={null}
          placeholder=""
        />
      )}
    </div>
  );
}
