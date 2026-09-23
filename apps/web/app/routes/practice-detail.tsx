import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Tabs } from 'radix-ui';

import { Markdown } from '~/components/markdown';
import { Page } from '~/components/page';
import {
  Button,
  ErrorNote,
  Input,
  Spinner,
  TAB_TRIGGER_ACTIVE_CLASS,
  TAB_TRIGGER_CLASS,
  Textarea,
} from '~/components/ui';
import { useDeletePractice, useSavePractice } from '~/hooks/mutations';
import { usePractice, usePracticeVersion, usePracticeVersions } from '~/hooks/queries';
import { cn } from '~/lib/cn';
import { formatDateTime } from '~/lib/format';

import type { Route } from './+types/practice-detail';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { slug: params.slug };
}

/**
 * やり方の詳細（#1055 段3③）。`memory-detail.tsx` と同じ骨組み
 * （プレビュー / 編集タブ、書きかけを state 側に置いてタブ往復で失わない）。
 *
 * **`memory-detail.tsx` との違いは、書く欄が本文だけではないこと。**
 * `PracticeStore.write` は `slug` / `kind` / `title` / `content` の全文置換
 * なので（部分更新の口を持たない——`practiceSchema` の doc）、`kind` と
 * `title` も編集タブに置く。**`kind` は自由入力にする**——プルダウンの固定
 * リストにすると、`practiceKindSchema` を enum にしないと決めた理由
 * （仕事の型を実装専用に狭めない）が画面側で骨抜きになる。
 *
 * **「履歴」タブが3つ目に増えた（#1309）。** `PracticeStore.write` は全文置換
 * だが、書いた後の本文は追記専用の版として残る——このタブは版の一覧（メタだけ）
 * と、選んだ版の本文（読み取り専用）を出す。**ここに「この版へ戻す」ボタンは
 * 置かない**——版を戻す操作は結局 `write()`（全文置換）を1回呼ぶのと同じなので、
 * 人間は中身を見て「編集」タブへ手でコピーすればよく、専用の口を増やす理由が無い。
 */
export default function PracticeDetail({ loaderData }: Route.ComponentProps) {
  const { slug } = loaderData;
  const { data, error, isLoading } = usePractice(slug);
  const savePractice = useSavePractice();
  const deletePractice = useDeletePractice();
  const navigate = useNavigate();

  const [historyVersion, setHistoryVersion] = useState<number | undefined>(undefined);
  const { data: history } = usePracticeVersions(slug);
  const { data: historyDetail, isLoading: historyDetailLoading } = usePracticeVersion(
    slug,
    historyVersion,
  );
  // **⚠️ すべてのタブが常にマウントされている（radix-ui の Tabs.Content は
  // `hidden` 属性で隠すだけで、非活性でも DOM から外れない——Presence の
  // 内部実装が children を関数として渡すことで自身の forceMount を立てる）。**
  // ⟹ 履歴タブを開いていない試験でもこのコードは評価される。応答の形が想定と
  // 違っても（例: 試験のスタブが `/versions` 宛の応答を素通りさせた場合）
  // クラッシュしない形にする。
  const historyVersions = history?.versions ?? [];

  // `undefined` は「まだ人間が触っていない」——`memory-detail.tsx` と同じ作法。
  // 取得した値を state へ写さないので、SSE が無効化を回して再取得が走っても
  // 書きかけが消えない。
  const [draftKind, setDraftKind] = useState<string | undefined>(undefined);
  const [draftTitle, setDraftTitle] = useState<string | undefined>(undefined);
  const [draftContent, setDraftContent] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [savedAt, setSavedAt] = useState<string | undefined>(undefined);

  const loadedKind = data?.practice.kind ?? '';
  const loadedTitle = data?.practice.title ?? '';
  const loadedContent = data?.practice.content ?? '';

  const kind = draftKind ?? loadedKind;
  const title = draftTitle ?? loadedTitle;
  const content = draftContent ?? loadedContent;

  const dirty =
    (draftKind !== undefined && draftKind !== loadedKind) ||
    (draftTitle !== undefined && draftTitle !== loadedTitle) ||
    (draftContent !== undefined && draftContent !== loadedContent);

  // やり方が無い slug は 404 になる。それは「これから書く」場合なので、
  // 失敗ではなく空の編集画面として扱う（`memory-detail.tsx` と同じ理由）。
  const missing = error !== undefined && (error as { status?: number }).status === 404;

  // `kind` は必須（`practiceKindSchema` が `min(1)`）。空のまま送ると 400 が
  // 返るだけなので、ここで弾いて待たせない。
  const canSave = dirty && kind.trim() !== '';

  const [tab, setTab] = useState<string | undefined>(undefined);
  const activeTab = tab ?? (missing || content.trim() === '' ? 'edit' : 'preview');

  function save() {
    if (!canSave) return;
    setBusy(true);
    setFailure(undefined);
    savePractice(slug, kind, title, content)
      .then((practice) => {
        setSavedAt(practice.updatedAt);
        // 保存できたら下書きを畳んで、またサーバの値に追従させる。
        setDraftKind(undefined);
        setDraftTitle(undefined);
        setDraftContent(undefined);
      })
      .catch(setFailure)
      .finally(() => setBusy(false));
  }

  return (
    <Page
      title={
        <span className="flex items-center gap-2">
          <Link to="/practices" className="text-muted hover:text-fg">
            やり方
          </Link>
          <span className="text-muted">/</span>
          <span className="min-w-0 font-mono text-sm break-all">{slug}</span>
        </span>
      }
      description={
        savedAt !== undefined
          ? `保存した（${formatDateTime(savedAt)}）` +
            (data !== undefined ? ` · 作成 ${formatDateTime(data.practice.createdAt)}` : '')
          : data !== undefined
            ? `作成 ${formatDateTime(data.practice.createdAt)} · 更新 ${formatDateTime(data.practice.updatedAt)}`
            : missing
              ? 'まだ無いやり方。書けば作られる'
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
                deletePractice(slug)
                  .then(() => navigate('/practices'))
                  .catch(setFailure)
                  .finally(() => setBusy(false));
              }}
            >
              削除
            </Button>
          )}
          <Button variant="primary" size="sm" loading={busy} disabled={!canSave} onClick={save}>
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
            <Tabs.Trigger
              value="history"
              className={cn(TAB_TRIGGER_CLASS, activeTab === 'history' && TAB_TRIGGER_ACTIVE_CLASS)}
            >
              履歴
            </Tabs.Trigger>
          </Tabs.List>

          {/*
            **`draftKind` / `draftTitle` / `draftContent` はこの `Tabs.Root` の外
            （コンポーネント自身）に在る。** 非活性の `Tabs.Content` は既定で
            unmount されるが、書きかけの実体は state 側に残るので、タブを行き来
            しても消えない（`memory-detail.tsx` と同じ作法）。
          */}
          <Tabs.Content value="preview" className="min-h-0 flex-1 overflow-y-auto">
            <p className="mb-2 text-xs text-muted">
              <span className="mr-1.5 text-[10px]">[{kind || '（種類未設定）'}]</span>
              {title}
            </p>
            <Markdown>{content}</Markdown>
          </Tabs.Content>

          <Tabs.Content value="edit" className="flex min-h-0 flex-1 flex-col gap-3">
            <p className="shrink-0 text-xs text-muted">
              ここで書き換えたものは日誌に残る（人間が API/画面から操作したと分かる形で）。
              種類（kind）は自由文字列——一覧の固定リストから選ぶのではない。
            </p>
            <label className="shrink-0 text-xs text-muted">
              種類（kind）
              <Input
                className="mt-1"
                value={kind}
                placeholder="例: 実装・調査・相談・レビュー・日報"
                onChange={(event) => setDraftKind(event.target.value)}
              />
            </label>
            <label className="shrink-0 text-xs text-muted">
              題（title）
              <Input
                className="mt-1"
                value={title}
                placeholder="一覧で見る短い題"
                onChange={(event) => setDraftTitle(event.target.value)}
              />
            </label>
            <label className="flex min-h-0 flex-1 flex-col text-xs text-muted">
              本文（content）
              <Textarea
                className="mt-1 min-h-[50vh] flex-1 font-mono text-xs leading-relaxed"
                value={content}
                spellCheck={false}
                onChange={(event) => setDraftContent(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 's') {
                    event.preventDefault();
                    save();
                  }
                }}
              />
            </label>
          </Tabs.Content>

          <Tabs.Content value="history" className="flex min-h-0 flex-1 gap-4 overflow-y-auto">
            <div className="w-64 shrink-0 overflow-y-auto border-r border-border pr-3">
              <p className="mb-2 text-xs text-muted">
                write のたびに版が1つ増える。remove しても版は消えない（#1309）。
              </p>
              {history === undefined ? (
                <Spinner />
              ) : historyVersions.length === 0 ? (
                <p className="text-xs text-muted">まだ版が無い（一度も書かれていない）。</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {[...historyVersions].reverse().map((v) => (
                    <li key={v.version}>
                      <button
                        type="button"
                        className={cn(
                          'w-full rounded px-2 py-1 text-left text-xs hover:bg-surface-2',
                          historyVersion === v.version && 'bg-surface-2 font-medium',
                        )}
                        onClick={() => setHistoryVersion(v.version)}
                      >
                        <span className="mr-1.5 font-mono">版{v.version}</span>
                        <span className="mr-1.5 text-[10px] text-muted">[{v.kind}]</span>
                        <span>{v.title}</span>
                        <span className="block text-[10px] text-muted">
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
                <p className="text-xs text-muted">
                  左の一覧から版を選ぶと、本文をここに読み取り専用で出す。
                </p>
              ) : historyDetailLoading || historyDetail === undefined ? (
                <Spinner />
              ) : (
                <>
                  <p className="mb-2 text-xs text-muted">
                    版{historyDetail.version.version}（{historyDetail.version.kind}）
                    {historyDetail.version.title} · {formatDateTime(historyDetail.version.at)}
                  </p>
                  <Markdown>{historyDetail.version.content}</Markdown>
                </>
              )}
            </div>
          </Tabs.Content>
        </Tabs.Root>
      )}
    </Page>
  );
}
