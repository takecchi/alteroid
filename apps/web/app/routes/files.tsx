import { File as FileIcon, Search } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useSearchParams } from 'react-router';

import { LoadError } from '~/components/load-error';
import { saveBlob } from '~/lib/save-blob';
import {
  ApiError,
  AttachmentGoneError,
  fetchAttachment,
  useApi,
  useAttachmentLimits,
  useAttachments,
  useDeleteAttachment,
  useSetAttachmentKept,
  useUploadKeptAttachment,
} from '@alteroid/swr';
import {
  ATTACHMENT_FROM_LABELS,
  ATTACHMENT_FROM_ORDER,
  attachmentFromOf,
  attachmentMediaType,
  checkAttachments,
  describeAttachmentLifetime,
  formatBytes,
  formatDateTime,
  isAttachmentFrom,
  isPreviewableImage,
  redactError,
} from '@alteroid/logic';
import type { AttachmentFrom, AttachmentItem } from '@alteroid/logic';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Empty,
  ErrorNote,
  Input,
  Page,
  Select,
  Spinner,
  Stat,
  ZoomableImage,
} from '@alteroid/ui';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

const KEPT_PARAM = 'kept';
const FROM_PARAM = 'from';
const SEARCH_PARAM = 'q';
const CONVERSATION_PARAM = 'conversation';

function describeFailure(error: unknown): string {
  return error instanceof AttachmentGoneError
    ? '取り出せない（期限切れの可能性）'
    : redactError(error instanceof Error ? error.message : String(error));
}

function isGone(error: unknown): boolean {
  return (
    error instanceof AttachmentGoneError || (error instanceof ApiError && error.status === 404)
  );
}

export default function Files() {
  // 絞り込みの正本は URL（開き直しても戻るでも消えず、リンクで共有できる）。操作ごとに履歴を積まないよう replace: true
  const [searchParams, setSearchParams] = useSearchParams();
  const keptParam = searchParams.get(KEPT_PARAM);
  const kept = keptParam === '1' ? true : keptParam === '0' ? false : undefined;
  const fromParam = searchParams.get(FROM_PARAM);
  const from = isAttachmentFrom(fromParam) ? fromParam : undefined;
  const committed = searchParams.get(SEARCH_PARAM) ?? '';
  const conversationId = searchParams.get(CONVERSATION_PARAM) ?? undefined;

  const [draft, setDraft] = useState(committed);
  useEffect(() => {
    if (draft === committed) return;
    const timer = setTimeout(() => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (draft === '') next.delete(SEARCH_PARAM);
          else next.set(SEARCH_PARAM, draft);
          return next;
        },
        { replace: true },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [draft, committed, setSearchParams]);

  function setParam(name: string, value: string | undefined) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value === undefined || value === '') next.delete(name);
        else next.set(name, value);
        return next;
      },
      { replace: true },
    );
  }

  // 頁の数は絞り込みごとに先頭へ戻す（絞り込みが変わったのに前の頁数のまま辿らない）
  const filterKey = JSON.stringify([kept, from, committed, conversationId]);
  const [paging, setPaging] = useState({ key: filterKey, pages: 1 });
  const pages = paging.key === filterKey ? paging.pages : 1;

  const { data, error, isLoading, isValidating, mutate } = useAttachments(
    {
      ...(kept === undefined ? {} : { kept }),
      ...(from === undefined ? {} : { from }),
      ...(committed === '' ? {} : { q: committed }),
      ...(conversationId === undefined ? {} : { conversationId }),
    },
    { pages, limit: PAGE_SIZE },
  );

  // 期限切れで先に消えていた行の案内（一覧は取り直し済みで、行はもう無い）
  const [gone, setGone] = useState<string[]>([]);
  function onGone(name: string) {
    setGone((current) => [...current, name]);
    void mutate();
  }

  const filtered = kept !== undefined || from !== undefined || committed !== '';

  return (
    <Page
      title="ファイル"
      description="預かっているファイルの一覧です。会話に添えられたもの・クローンや連携が置いたものも並びます"
    >
      <div className="flex flex-col gap-4">
        <UsageCard usage={error === undefined ? data?.usage : undefined} />
        <UploadCard />
        <Card>
          <CardHeader
            title="一覧"
            subtitle="新しい順"
            action={data === undefined ? undefined : <Badge>{data.items.length} 件表示</Badge>}
          />
          <div className="flex flex-col gap-2 border-b border-border p-4 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                type="search"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="名前で探す"
                aria-label="ファイルを名前で探す"
                className="pl-8"
              />
            </div>
            <Select
              aria-label="保存の有無で絞り込む"
              className="sm:w-40"
              value={kept === undefined ? '' : kept ? '1' : '0'}
              onChange={(event) => setParam(KEPT_PARAM, event.target.value)}
            >
              <option value="">すべて</option>
              <option value="1">保存中</option>
              <option value="0">保存していない</option>
            </Select>
            <Select
              aria-label="出所で絞り込む"
              className="sm:w-40"
              value={from ?? ''}
              onChange={(event) => setParam(FROM_PARAM, event.target.value)}
            >
              <option value="">出所: すべて</option>
              {ATTACHMENT_FROM_ORDER.map((value) => (
                <option key={value} value={value}>
                  {ATTACHMENT_FROM_LABELS[value]}
                </option>
              ))}
            </Select>
          </div>
          {conversationId !== undefined && (
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
              <span>
                会話で絞り込み中: <span className="font-mono break-all">{conversationId}</span>
              </span>
              <Button
                size="sm"
                aria-label="会話の絞り込みを解除"
                onClick={() => setParam(CONVERSATION_PARAM, undefined)}
              >
                解除
              </Button>
            </div>
          )}
          {gone.length > 0 && (
            <div
              role="status"
              className="flex flex-col gap-1 border-b border-border px-4 py-2 text-xs text-warn"
            >
              {gone.map((name, index) => (
                <p key={`${name}-${index}`} className="break-words">
                  「{name}」は期限切れで、すでに消えていました。一覧を更新しました。
                </p>
              ))}
              <div>
                <Button size="sm" onClick={() => setGone([])}>
                  閉じる
                </Button>
              </div>
            </div>
          )}
          <LoadError
            what="ファイルの一覧"
            error={error}
            onRetry={() => mutate()}
            retrying={isValidating}
            className="m-4"
          />
          {error !== undefined ? null : isLoading || data === undefined ? (
            <div className="p-4">
              <Spinner />
            </div>
          ) : data.items.length === 0 ? (
            <Empty inset="card">
              {filtered || conversationId !== undefined
                ? '条件に合うファイルはありません'
                : 'ファイルはまだありません'}
            </Empty>
          ) : (
            <>
              <ul aria-label="ファイル" aria-busy={isValidating}>
                {data.items.map((item) => (
                  <FileRow key={item.id} item={item} onGone={onGone} />
                ))}
              </ul>
              {data.nextCursor !== undefined && (
                <div className="p-4">
                  <Button
                    loading={isValidating}
                    onClick={() => setPaging({ key: filterKey, pages: pages + 1 })}
                  >
                    もっと見る
                  </Button>
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </Page>
  );
}

function UsageCard({
  usage,
}: {
  usage:
    | {
        count: number;
        totalBytes: number;
        byFrom: Record<AttachmentFrom, { count: number; totalBytes: number }>;
      }
    | undefined;
}) {
  return (
    <Card>
      <CardHeader
        title="使用量"
        subtitle="期限内の全体です（絞り込みには左右されません）。保存したものに期限は無く、全体の上限もありません"
      />
      {usage === undefined ? (
        <Empty inset="card">使用量は一覧を読み込むと出ます</Empty>
      ) : (
        <div
          data-testid="usage"
          className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3 lg:grid-cols-6"
        >
          <Stat
            label="合計"
            value={usage.count}
            unit="件"
            hint={formatBytes(usage.totalBytes)}
            tone="accent"
          />
          {ATTACHMENT_FROM_ORDER.map((from) => (
            <Stat
              key={from}
              label={ATTACHMENT_FROM_LABELS[from]}
              value={usage.byFrom[from].count}
              unit="件"
              hint={formatBytes(usage.byFrom[from].totalBytes)}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function UploadCard() {
  const upload = useUploadKeptAttachment();
  const { data: limits } = useAttachmentLimits();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<{ done: number; problems: string[] }>();

  async function run(files: File[]) {
    if (files.length === 0) return;
    // 上げる前の検査はチャットと同じ（`checkAttachments`。0 バイト・上限超えはここで断る。最終判定はサーバ）
    const { accepted, rejected } = checkAttachments([], files, limits);
    const problems = rejected.map((item) => `${item.name}: ${item.reason}`);
    let done = 0;
    setBusy(true);
    setResult(undefined);
    try {
      for (const file of accepted) {
        try {
          await upload(file, attachmentMediaType(file));
          done += 1;
        } catch (caught) {
          problems.push(`${file.name}: ${describeFailure(caught)}`);
        }
      }
    } finally {
      setBusy(false);
      setResult({ done, problems });
    }
  }

  function carriesFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer.types).includes('Files');
  }

  return (
    <Card>
      <CardHeader
        title="アップロード"
        subtitle="上げたファイルは保存の印つきで預かります（期限なし。消すのは人間かクローンです）"
      />
      <div
        data-testid="file-drop"
        className={`m-4 flex flex-col items-start gap-2 rounded-md border border-dashed p-4 text-sm ${dragging ? 'border-primary bg-primary/10' : 'border-border'}`}
        onDragOver={(event) => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          setDragging(false);
          void run(Array.from(event.dataTransfer.files));
        }}
      >
        <p className="text-muted-foreground">ここへファイルをドロップするか、選んで上げます</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          aria-label="アップロードするファイル"
          tabIndex={-1}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            void run(files);
          }}
        />
        <Button loading={busy} onClick={() => inputRef.current?.click()}>
          ファイルを選ぶ
        </Button>
        {result !== undefined && (
          <div role="status" className="flex min-w-0 flex-col gap-1 text-xs">
            {result.done > 0 && <p>{result.done} 件を上げました（保存中）</p>}
            {result.problems.map((problem, index) => (
              <p key={`${problem}-${index}`} className="break-words text-destructive">
                {problem}
              </p>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function FileRow({ item, onGone }: { item: AttachmentItem; onGone: (name: string) => void }) {
  const api = useApi();
  const setKept = useSetAttachmentKept();
  const remove = useDeleteAttachment();
  const [busy, setBusy] = useState<'download' | 'kept' | 'delete'>();
  const [failure, setFailure] = useState<unknown>(undefined);
  const [confirming, setConfirming] = useState(false);

  const life = describeAttachmentLifetime(item);
  const fromLabel = ATTACHMENT_FROM_LABELS[attachmentFromOf(item.uploadedBy)];

  async function guarded(kind: 'download' | 'kept' | 'delete', action: () => Promise<void>) {
    setBusy(kind);
    setFailure(undefined);
    try {
      await action();
    } catch (caught) {
      if (isGone(caught)) onGone(item.name);
      else setFailure(caught);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <li className="flex flex-col gap-2 border-b border-border px-4 py-3 text-xs last:border-b-0 sm:flex-row sm:items-start">
      <Thumbnail item={item} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium break-all">{item.name}</span>
          <Badge tone={life.kept ? 'ok' : 'warn'}>{life.text}</Badge>
        </div>
        <div className="mt-1 text-muted-foreground" data-numeric>
          {item.mediaType} / {formatBytes(item.size)} / 出所: {fromLabel} /{' '}
          {formatDateTime(item.createdAt)}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            loading={busy === 'download'}
            disabled={busy !== undefined}
            aria-label={`${item.name} をダウンロード`}
            onClick={() =>
              void guarded('download', async () => {
                saveBlob(await fetchAttachment(api, item.id), item.name);
              })
            }
          >
            ダウンロード
          </Button>
          <Button
            size="sm"
            loading={busy === 'kept'}
            disabled={busy !== undefined}
            aria-label={`${item.name} の保存を${life.kept ? '外す' : 'する'}`}
            onClick={() =>
              void guarded('kept', async () => {
                await setKept(item.id, !life.kept);
              })
            }
          >
            {life.kept ? '保存を外す' : '保存する'}
          </Button>
          <Button
            size="sm"
            variant="danger"
            loading={busy === 'delete'}
            disabled={busy !== undefined}
            aria-label={`${item.name} を削除`}
            onClick={() => setConfirming(true)}
          >
            削除
          </Button>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title="ファイルを削除しますか"
            description={`「${item.name}」を削除します。取り消せません。保存中のものでも消えます。`}
            confirmLabel="削除する"
            destructive
            onConfirm={() => void guarded('delete', () => remove(item.id))}
          />
        </div>
        <ErrorNote error={failure} className="mt-2" />
      </div>
    </li>
  );
}

// サムネは見えている行だけ取る（IntersectionObserver が無い環境では最初から見えている扱い）。
// 取った `blob:` URL は行が外れたとき（アンマウント・取り直しで id が変わったとき）に解放する
function Thumbnail({ item }: { item: AttachmentItem }) {
  const image = isPreviewableImage(item.mediaType);
  const api = useApi();
  const boxRef = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  const [state, setState] = useState<{ url: string } | { error: true } | undefined>();

  useEffect(() => {
    if (!image || visible) return;
    const box = boxRef.current;
    if (box === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [image, visible]);

  useEffect(() => {
    if (!image || !visible) return;
    const controller = new AbortController();
    let created: string | undefined;
    fetchAttachment(api, item.id, { signal: controller.signal }).then(
      (blob) => {
        // 片付けの後に届いた分は URL を作らない（作ると誰も解放しない）
        if (controller.signal.aborted) return;
        created = URL.createObjectURL(blob);
        setState({ url: created });
      },
      () => {
        if (!controller.signal.aborted) setState({ error: true });
      },
    );
    return () => {
      controller.abort();
      if (created !== undefined) URL.revokeObjectURL(created);
      setState(undefined);
    };
  }, [api, item.id, image, visible]);

  return (
    <span
      ref={boxRef}
      className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted text-muted-foreground"
    >
      {state !== undefined && 'url' in state ? (
        <ZoomableImage
          src={state.url}
          alt={item.name}
          title={`${item.name}（${formatBytes(item.size)}）`}
          className="size-14 object-cover"
        />
      ) : (
        <FileIcon className="size-5" aria-hidden />
      )}
    </span>
  );
}
