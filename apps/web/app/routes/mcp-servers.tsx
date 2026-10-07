// URL の伏せ字を自前で書かない: CLI と別々に同じ判定を持つと、どちらも password だけの userinfo を素通ししていたため
import { SettingsTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { settingsDocumentTitle } from '~/lib/nav';
import { LeaveGuardScope, useReportDirty } from '~/lib/leave-guard';
import { useLatest } from '~/lib/use-latest';
import { maskUrl } from '@alteroid/core/mask-url';
import { useState } from 'react';

import {
  Page,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  ErrorNote,
  KeyValueList,
  Spinner,
  SubmitHint,
  Textarea,
} from '@alteroid/ui';
import { useSetMcpServers, useMcpServers, ApiError } from '@alteroid/swr';
import { formatDateTime, hasMcpPushProblem } from '@alteroid/logic';
import type {
  McpServerEntry,
  McpServers,
  McpServersState,
  McpServersUpdateResult,
} from '@alteroid/logic';

// 値は押すまで描かない: GET /mcp-servers は env / headers / args を丸ごと返し、鍵が入りうるため
// 保存の確認を省かない: サーバ側に確認の印は無く、押す前の確認だけが網になるため
export default function McpServersPage() {
  const { data, error, isLoading, isValidating, mutate } = useMcpServers();

  return (
    <Page
      tabs={<SettingsTabs />}
      documentTitle={settingsDocumentTitle('/mcp-servers')}
      title="MCP 連携"
      description="クローン・マネージャー・作業者がつなぐ MCP サーバ（外部の道具や情報源につなぐ仕組み）の登録。書き方は .mcp.json と同じ"
    >
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="現在の登録内容" subtitle="いま登録されている MCP サーバ" />
          <div className="flex flex-col gap-3 px-4 py-3">
            <LoadError
              what="MCP 連携の登録内容"
              error={error}
              onRetry={() => mutate()}
              retrying={isValidating}
            />
            {isLoading ? <Spinner /> : data !== undefined && <McpServersView state={data} />}
          </div>
        </Card>
        {data !== undefined && (
          <LeaveGuardScope>
            <McpServersEditor current={data} />
          </LeaveGuardScope>
        )}
      </div>
    </Page>
  );
}

function McpServersView({ state }: { state: McpServersState }) {
  const [shown, setShown] = useState(false);
  const names = Object.keys(state.mcpServers).sort();
  const empty = names.length === 0;

  return (
    <div className="flex flex-col gap-3 text-sm">
      <KeyValueList
        labelWidth="6rem"
        items={[
          {
            label: '状態',
            value: empty ? (
              <Badge>置かれていない</Badge>
            ) : (
              <Badge tone="accent">{`${String(names.length)} 件`}</Badge>
            ),
          },
          ...(state.updatedAt !== undefined
            ? [{ label: '更新', value: formatDateTime(state.updatedAt) }]
            : []),
        ]}
      />

      {!empty && (
        <ul className="flex flex-col gap-2" aria-label="MCP サーバの登録の一覧">
          {names.map((name) => (
            <EntrySummary key={name} name={name} entry={state.mcpServers[name]} />
          ))}
        </ul>
      )}

      {!empty && (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] break-words text-warn">
            ⚠ 環境変数・ヘッダ・引数
            には鍵が丸ごと入っていることがある。表示するのは、周りに見られない場所で。
          </p>
          <div>
            <Button size="sm" onClick={() => setShown((value) => !value)}>
              {shown ? '値を隠す' : '値を表示する'}
            </Button>
          </div>
          {shown && (
            <pre
              aria-label="登録の本文（値を含む）"
              className="max-h-96 overflow-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap"
            >
              {toJson(state.mcpServers)}
            </pre>
          )}
        </div>
      )}

      <p className="text-[11px] break-words text-muted-foreground">
        各実行環境へ届いているかは「設定」の実行環境の欄（直近の反映）に出る。
      </p>
    </div>
  );
}

function EntrySummary({ name, entry }: { name: string; entry: McpServerEntry | undefined }) {
  if (entry === undefined) return null;
  const transport = entry.type ?? 'stdio';
  const where = 'url' in entry ? maskUrl(entry.url) : entry.command;
  const args = 'args' in entry ? (entry.args ?? []) : [];
  const keys =
    'headers' in entry
      ? { label: 'ヘッダ', names: Object.keys(entry.headers ?? {}).sort() }
      : 'env' in entry
        ? { label: '環境変数', names: Object.keys(entry.env ?? {}).sort() }
        : { label: '', names: [] };

  return (
    <li className="flex flex-col gap-1 rounded-md border border-border px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono font-medium break-all">{name}</span>
        <Badge>{transport}</Badge>
      </div>
      <span className="font-mono break-all text-muted-foreground">{where}</span>
      {args.length > 0 && (
        <span className="text-muted-foreground">{`引数: ${String(args.length)} 個（値は伏せた）`}</span>
      )}
      {keys.names.length > 0 && (
        <span className="font-mono break-all text-muted-foreground">{`${keys.label}: ${keys.names.join(', ')}`}</span>
      )}
    </li>
  );
}

function McpServersEditor({ current }: { current: McpServersState }) {
  const setMcpServers = useSetMcpServers();
  const [draft, setDraft] = useState<string | null>(null);
  const latestDraft = useLatest(draft);
  const [confirming, setConfirming] = useState<'save' | 'clear' | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    before: string[];
    update: McpServersUpdateResult;
  } | null>(null);

  const editing = draft !== null;
  const empty = Object.keys(current.mcpServers).length === 0;
  const original = toMcpJson(current.mcpServers);
  const unchanged = editing && draft === original;
  const parsed = editing ? parseMcpJson(draft) : null;
  const dirty = editing && !unchanged;
  const [confirmingClose, setConfirmingClose] = useState(false);
  useReportDirty('editor', dirty);
  const draftClears = parsed !== null && parsed.ok && Object.keys(parsed.servers).length === 0;

  async function submit(servers: McpServers) {
    const sent = draft;
    setBusy(true);
    setFailure(undefined);
    try {
      const before = Object.keys(current.mcpServers);
      const update = await setMcpServers(servers);
      setResult({ before, update });
      setConfirming(null);
      if (latestDraft.current === sent) setDraft(null);
    } catch (caught) {
      setFailure(caught);
      // 確認は畳む: 直したつもりで1回で送る形にしないため
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  }

  function startEditing() {
    setDraft(original);
    setConfirming(null);
    setFailure(undefined);
    setParseError(null);
    setResult(null);
  }

  function askSave() {
    if (parsed === null) return;
    if (!parsed.ok) {
      setParseError(parsed.error);
      return;
    }
    setParseError(null);
    setConfirming('save');
  }

  return (
    <Card>
      <CardHeader title="登録内容を置き換える" subtitle="登録内容を丸ごと置き換える" />
      <div className="flex flex-col gap-3 px-4 py-3 text-sm">
        <p className="text-xs leading-relaxed break-words text-muted-foreground">
          登録内容を JSON で書く（.mcp.json をそのまま貼れる形。{'{ "mcpServers": { … } }'}
          ）。保存する前に接続先のサーバが形を確かめ、通らなければ保存も反映もしない（前のものが残る）。コマンドで起動する形（stdio）の登録は、次のセッションでクローンやマネージャーが起動するコマンドになる。
        </p>

        {!editing ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={startEditing}>
              編集する
            </Button>
            {!empty && confirming !== 'clear' && (
              <Button variant="danger" size="sm" onClick={() => setConfirming('clear')}>
                登録を全部外す
              </Button>
            )}
          </div>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                登録内容（JSON。.mcp.json と同じ形）
              </span>
              <Textarea
                aria-label="MCP サーバの新しい登録"
                className="min-h-64 font-mono text-xs"
                maxHeight="60vh"
                onSubmitShortcut={askSave}
                submitDisabled={unchanged || busy || confirming === 'save'}
                spellCheck={false}
                autoComplete="off"
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setConfirming(null);
                  setParseError(null);
                }}
              />
            </label>
            {parseError !== null && (
              <p role="alert" className="text-[11px] break-words text-destructive">
                {parseError}
              </p>
            )}
            {confirming !== 'save' && (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" size="sm" disabled={unchanged} onClick={askSave}>
                  {draftClears ? '空で保存する（外す）' : '保存する'}
                </Button>
                <SubmitHint action="保存" />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    if (dirty) setConfirmingClose(true);
                    else setDraft(null);
                  }}
                >
                  編集を閉じる
                </Button>
                {unchanged && (
                  <span className="text-[11px] text-muted-foreground">変更はまだ無い。</span>
                )}
              </div>
            )}
          </>
        )}

        {confirming === 'save' && parsed !== null && parsed.ok && (
          <div className="flex flex-col gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2">
            <p className="text-[11px] break-words text-warn">
              {draftClears
                ? 'MCP 連携の登録を全部外す。次のセッションから、クローン・マネージャー・作業者はこれらの連携を使えなくなる。'
                : 'この登録で丸ごと置き換え、繋がっている実行環境へ渡す。クローンは次のセッションから、マネージャー・作業者は次に開くセッションから使う。'}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="danger"
                size="sm"
                loading={busy}
                onClick={() => void submit(parsed.servers)}
              >
                {draftClears ? '本当に外す' : '本当に保存する'}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(null)}>
                保存をやめる
              </Button>
            </div>
          </div>
        )}

        {confirming === 'clear' && !editing && (
          <div className="flex flex-col gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2">
            <p className="text-[11px] break-words text-warn">
              MCP 連携の登録を全部外す。次のセッションから、
              クローン・マネージャー・作業者はこれらの連携を使えなくなる。
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="danger" size="sm" loading={busy} onClick={() => void submit({})}>
                本当に外す
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(null)}>
                外すのをやめる
              </Button>
            </div>
          </div>
        )}

        <ErrorNote error={failure} />
        {failure instanceof ApiError && failure.status === 400 && (
          <p className="text-[11px] text-muted-foreground">前の登録がそのまま残っている。</p>
        )}

        {result !== null && <UpdateReport before={result.before} update={result.update} />}
      </div>
      <ConfirmDialog
        open={confirmingClose}
        onOpenChange={setConfirmingClose}
        title="書きかけの編集があります"
        description="このまま閉じると、いま書いている内容は失われます。"
        confirmLabel="破棄して閉じる"
        destructive
        onConfirm={() => {
          setDraft(null);
          setConfirmingClose(false);
        }}
      />
    </Card>
  );
}

// runner ごとの成否を小さく出さない: 配り損ねた runner を小さく出すと、マネージャーが古い登録のまま走り続けることに誰も気づけないため
function UpdateReport({ before, update }: { before: string[]; update: McpServersUpdateResult }) {
  const beforeSet = new Set(before);
  const afterSet = new Set(update.names);
  const added = update.names.filter((name) => !beforeSet.has(name));
  const removed = before.filter((name) => !afterSet.has(name)).sort();
  const cleared = update.names.length === 0;
  const partial = hasMcpPushProblem(update);

  return (
    <div className="flex flex-col gap-2 text-xs">
      {partial ? (
        <p role="alert" className="font-medium text-warn">
          {cleared
            ? 'MCP 連携の登録は外したが、一部の実行環境へ反映できていない（保存はできている）。'
            : `MCP 連携の登録は保存したが、一部の実行環境へ反映できていない（確認用の値 ${update.sha256 ?? '?'}）。`}
        </p>
      ) : (
        <p className="font-medium text-ok">
          {cleared
            ? 'MCP 連携の登録を外した。'
            : `MCP 連携の登録を差し替えた（確認用の値 ${update.sha256 ?? '?'}）。`}
        </p>
      )}
      {added.length > 0 && <p className="break-words">足した: {added.join(', ')}</p>}
      {removed.length > 0 && <p className="break-words">外した: {removed.join(', ')}</p>}
      <ul className="flex flex-col gap-1" aria-label="実行環境ごとの反映結果">
        {update.runners.length === 0 && (
          <li className="text-muted-foreground">
            いま渡した実行環境は無い（繋がった実行環境へは、つなぎ直したときに渡す）。
          </li>
        )}
        {update.runners.map((runner) => (
          <li key={runner.runnerId} className="break-words">
            <span className="font-mono break-all">{runner.runnerId}</span>:{' '}
            {!runner.ok ? (
              <span className="text-destructive">
                {runner.unsupported === true
                  ? '受け取る機能が無い（古い実行環境）'
                  : '届かなかった'}{' '}
                — {runner.error ?? '理由不明'}
              </span>
            ) : runner.mcpServers === undefined ? (
              <span className="text-ok">
                {cleared ? '外した' : '届いた（確認用の値は返らなかった）'}
              </span>
            ) : update.sha256 !== undefined && runner.mcpServers.sha256 !== update.sha256 ? (
              <span className="text-destructive">
                届いたが確認用の値が違う（実行環境 {runner.mcpServers.sha256} / 保存 {update.sha256}
                ）
              </span>
            ) : (
              <span className="text-ok">届いた（確認用の値 {runner.mcpServers.sha256}）</span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">いつから効くか: {update.appliesFrom}</p>
    </div>
  );
}

function toJson(servers: McpServers): string {
  return JSON.stringify(servers, null, 2);
}

function toMcpJson(servers: McpServers): string {
  return `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
}

// 中身の検査をここでしない: 形の検査はデーモンの parseMcpServers が正本のため
function parseMcpJson(
  text: string,
): { ok: true; servers: McpServers } | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: `JSON として読めない（送っていない）: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const servers =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as { mcpServers?: unknown }).mcpServers
      : undefined;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    return {
      ok: false,
      error: '{ "mcpServers": { … } } の形で書くこと（.mcp.json と同じ形。送っていない）',
    };
  }
  return { ok: true, servers: servers as McpServers };
}
