import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import {
  MarkdownEditor,
  type MarkdownEditorMode,
  Page,
  Button,
  ConfirmDialog,
  ErrorNote,
  Spinner,
} from '@alteroid/ui';
import { useDeleteMemory, useSaveMemory, useMemoryDocument } from '@alteroid/swr';
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
        // 無いのに見た目だけ悪くなる）。
        <span className="flex items-center gap-2">
          <Link to="/memory" className="text-muted-foreground hover:text-foreground">
            記憶
          </Link>
          <span className="text-muted-foreground">/</span>
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
                    .then(() => navigate('/memory'))
                    .catch(setFailure)
                    .finally(() => setBusy(false));
                }}
              />
            </>
          )}
          {!loadFailed && (
            <Button variant="primary" size="sm" loading={busy} disabled={!dirty} onClick={save}>
              {dirty ? '保存する' : '変更なし'}
            </Button>
          )}
        </div>
      }
      className="flex flex-col"
    >
      {!missing && <ErrorNote error={error} className="mb-3" />}
      <ErrorNote error={failure} className="mb-3" />

      {isLoading && !missing ? (
        <Spinner />
      ) : loadFailed ? null : (
        <MarkdownEditor
          value={value}
          onChange={setDraft}
          onSave={save}
          // 出すタブとその並びは今の画面のまま（プレビュー → 編集）。並べては出さない。
          modes={['preview', 'edit']}
          mode={tab}
          defaultMode={defaultTab}
          onModeChange={setTab}
          hint="ここで書き換えたものは `memory_update`（cause: human）として日誌に残る。"
          // 今の画面に無かったものは出さない（文言は変えない）。
          saveHint={null}
          emptyPreview={null}
          placeholder=""
        />
      )}
    </Page>
  );
}
