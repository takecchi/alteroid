import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Tabs } from 'radix-ui';

import { Markdown } from '~/components/markdown';
import { Page } from '~/components/page';
import {
  Button,
  ErrorNote,
  Spinner,
  TAB_TRIGGER_ACTIVE_CLASS,
  TAB_TRIGGER_CLASS,
  Textarea,
} from '~/components/ui';
import { useDeleteMemory, useSaveMemory } from '~/hooks/mutations';
import { useMemoryDocument } from '~/hooks/queries';
import { cn } from '~/lib/cn';
import { formatCreatedAt, formatDateTime } from '~/lib/format';

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
  const [tab, setTab] = useState<string | undefined>(undefined);
  const activeTab = tab ?? (missing || loaded.trim() === '' ? 'edit' : 'preview');

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
          <Link to="/memory" className="text-muted hover:text-fg">
            記憶
          </Link>
          <span className="text-muted">/</span>
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
          </Tabs.List>

          {/*
            **`draft` はこの `Tabs.Root` の外（コンポーネント自身）に在る。**
            非活性の `Tabs.Content` は既定で unmount されるが、書きかけの実体は
            state 側に残るので、タブを行き来しても消えない。プレビューが映すのは
            保存前の `value`（= draft ?? loaded）そのもの — 本文を書き換えない。
          */}
          <Tabs.Content value="preview" className="min-h-0 flex-1 overflow-y-auto">
            <Markdown>{value}</Markdown>
          </Tabs.Content>

          <Tabs.Content value="edit" className="flex min-h-0 flex-1 flex-col">
            <p className="mb-2 shrink-0 text-xs text-muted">
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
          </Tabs.Content>
        </Tabs.Root>
      )}
    </Page>
  );
}
