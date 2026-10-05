import { useEffect, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate } from 'react-router';

import {
  MarkdownEditor,
  type MarkdownEditorMode,
  Page,
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

  const loaded = data?.document.content ?? '';
  const value = draft ?? loaded;
  const dirty = draft !== undefined && draft !== loaded;

  // 記憶が無い slug は 404 になる。それは「これから書く」場合なので、
  // 失敗ではなく空の編集画面として扱う。
  const missing = error !== undefined && (error as { status?: number }).status === 404;

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

  function edit(next: string) {
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
    if (draft === undefined) return;
    setBusy(true);
    setFailure(undefined);
    saveMemory(slug, draft, ifMatch)
      .then(({ document, version }) => {
        setSavedAt(document.updatedAt);
        setLastSaved({ replaces: data === undefined ? null : data.version, version });
        // 保存できたら下書きを畳んで、またサーバの値に追従させる。
        setDraft(undefined);
        setBaseVersion(undefined);
        setConflict(undefined);
      })
      .catch((caught: unknown) => {
        if (caught instanceof MemoryConflictError) setConflict(caught);
        else setFailure(caught);
      })
      .finally(() => setBusy(false));
  }

  /** 最新を読み直す＝自分の下書きを捨てて、いまの版に追従する。 */
  function discardDraft() {
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

  return (
    <Page
      documentTitle={`${slug} - 記憶`}
      title={
        // `Page` の title は h1 の親（div）が既に `min-w-0` を持つので、この
        // flex 行自体は絞られる側に居る。slug は `break-all` 済み（最大128
        // 文字・空白なし、本2）で、break-all は最小コンテンツ幅を1文字ぶんまで
        // 縮めるので理屈のうえでは既にはみ出さない。それでも flex item の
        // `min-width: auto`（既定は min-content 依存）に頼らせず、
        // `min-w-0` を明示して縮む先を固定する — `connection.tsx` の入力欄・
        // `schedule.tsx` の本文欄と同じ、縮める側に `min-w-0` を明示する流儀
        // に揃えた。`flex-wrap` は付けていない: 折り返すと1行に収まる
        // 「記憶 / slug」の見た目が崩れ、items-center との組み合わせで
        // リンクが複数行の slug の縦中央に浮く見た目になる（stackingの利点が
        // 無いのに見た目だけ悪くなる）。見出しの「記憶」「/」は `shrink-0 whitespace-nowrap`
        // で狭い幅でも縦に割らず、slug が複数行になっても先頭行の基線に揃える（#2763）。
        <span className="flex items-baseline gap-2">
          <Link
            to="/memory"
            className="shrink-0 whitespace-nowrap text-muted-foreground hover:text-foreground pointer-coarse:-mx-2 pointer-coarse:-my-2.5 pointer-coarse:px-2 pointer-coarse:py-2.5"
          >
            記憶
          </Link>
          <span className="shrink-0 text-muted-foreground">/</span>
          <span className="min-w-0 font-mono text-sm break-all">{slug}</span>
        </span>
      }
      description={
        savedAt !== undefined
          ? `保存した（${formatDateTime(savedAt)}）` +
            // 保存直後でも作成時刻は画面から消さない（`data` が届いていれば足す）。
            (data !== undefined ? ` · 作成 ${formatCreatedAt(data.document.createdAt)}` : '')
          : data !== undefined
            ? `作成 ${formatCreatedAt(data.document.createdAt)} · 更新 ${formatDateTime(data.document.updatedAt)}`
            : missing
              ? 'まだ無い記憶。書けば作られる'
              : undefined
      }
      action={
        <div className="flex items-center gap-2">
          {!missing && data !== undefined && (
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
                  deleteMemory(slug)
                    .then(() => {
                      leaving.current = true;
                      navigate('/memory');
                    })
                    .catch(setFailure)
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
      }
      className="flex flex-col"
    >
      {!missing && <ErrorNote error={error} className="mb-3" />}
      <ErrorNote error={failure} className="mb-3" />
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
    </Page>
  );
}
