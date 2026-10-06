// URL の伏せ字は CLI と同じ1つの実装（`@alteroid/core/mask-url`。issue #1622 ——
// 2つが別々に同じ判定を持ち、どちらも password だけの userinfo を素通ししていた）。
import { SettingsTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { settingsDocumentTitle } from '~/lib/nav';
import { useLatest } from '~/lib/use-latest';
import { maskUrl } from '@alteroid/core/mask-url';
import { useEffect, useState } from 'react';
import { useBlocker } from 'react-router';

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

/**
 * `/mcp-servers` — 人間の MCP 連携の登録（`.mcp.json` 相当）を読む・差し替える画面
 * （#325 段4）。
 *
 * **`alteroid mcp list|show|edit|set|clear` / `GET`・`PUT /mcp-servers` と同じもの
 * を読み書きする。** 経路は新しく足していない——段1〜3 で在る2本を、この画面からも
 * 呼べるようにしただけである（AGENTS.md「画面の都合で API に経路を足さないこと」）。
 * 「外す」も新しい口ではなく、CLI と同じく空の `mcpServers` の `PUT` である。
 *
 * 形は `routes/profile.tsx`（#1122）の写しで、理由も同じ:
 *
 * - **値は押すまで隠す。** `GET /mcp-servers` は `env` / `headers` / `args` を丸ごと返し、
 *   そこには鍵が入りうる。一覧に出すのは名前・種類・宛先（URL はクエリと認証情報を
 *   伏せる）・鍵の名前だけで、「値を表示する」を押したときだけ JSON を出す。編集欄も
 *   「編集する」を押すまで値を流し込まない
 * - **保存は2段で確かめる。** stdio の登録は、次のセッションでクローンの SDK が
 *   起こすコマンドである（`apps/daemon/src/app.ts` の `GET /mcp-servers` の doc）。
 *   サーバ側に確認の印は無いので、押す前の確認だけが網になる
 * - **資格は `requireOwner`**（`/profile` と同じ。中身は素通しで、許可済みでログインできる
 *   アカウントは全員持ち主。#2862）。ボタンは隠さない。403 は `authenticate` の「許可が無い」
 *   ものだけで、持ち主の宣言の案内は出さない
 *
 * **形の検査はデーモンに任せる**（`parseMcpServers` が正本）。この画面が手元で
 * 止めるのは「JSON として読めない」と「`mcpServers` の欄が無い」だけで、これは
 * 送る前に止める（CLI の `parseMcpJson` と同じ線）。
 */
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
        {data !== undefined && <McpServersEditor current={data} />}
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

/**
 * 1件ぶんの要約。**値は1文字も描かない**（鍵の名前と `args` の個数だけ。CLI の
 * `renderMcpList` と同じ線）。
 */
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

/**
 * 差し替え・外す。
 *
 * **編集欄は「編集する」を押すまで出さない**（値を押すまで隠すのと同じ理由。押すと、
 * いま置かれている登録を `.mcp.json` の形で流し込む＝ `alteroid mcp edit` が
 * `$EDITOR` に現在の登録を開くのと同じ）。
 */
function McpServersEditor({ current }: { current: McpServersState }) {
  const setMcpServers = useSetMcpServers();
  const [draft, setDraft] = useState<string | null>(null);
  /** 応答が返った時点の「いまの下書き」（送った時点と比べる。issue #3515）。 */
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
  // 編集欄が開いていて、元の登録から変わっていれば書きかけ（#3370）。
  const dirty = editing && !unchanged;
  const [confirmingClose, setConfirmingClose] = useState(false);
  /**
   * **書きかけがあるまま離れない。** `memory-detail.tsx` と同じ形: アプリ内の移動は確認を挟み、
   * タブを閉じる・再読み込みはブラウザの警告に任せる。
   */
  const blocker = useBlocker(() => dirty);
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
  const draftClears = parsed !== null && parsed.ok && Object.keys(parsed.servers).length === 0;

  async function submit(servers: McpServers) {
    // 送ったときの下書きを控える。成功のあと、いまの下書きがこれと同じときだけ閉じる（issue #3515）。
    const sent = draft;
    setBusy(true);
    setFailure(undefined);
    try {
      const before = Object.keys(current.mcpServers);
      const update = await setMcpServers(servers);
      setResult({ before, update });
      setConfirming(null);
      // 応答を待つ間に打ち足した分は残す（元の登録は、保存できた登録へ追従して再取得される）。
      if (latestDraft.current === sent) setDraft(null);
    } catch (caught) {
      setFailure(caught);
      // **確認は畳む**（`profile.tsx` と同じ —— 直したつもりで1回で送る形にしない）。
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

  /** 送る前に JSON として読めるかだけを見る。読めなければ確認へ進まない。 */
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
                // 保存ボタンと同じ（確認の段へ進むだけ。確認は飛ばさない）。
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
    </Card>
  );
}

/**
 * 差し替えの結果。**足した・外した名前、指紋、runner ごとの成否を全部出す**
 * （CLI の `renderMcpUpdate` と同じ —— 配り損ねた runner を小さく出すと、マネージャーが
 * 古い登録のまま走り続けることに誰も気づけない）。runner が返した指紋が保存した
 * 指紋と違えば、それも言う。
 */
function UpdateReport({ before, update }: { before: string[]; update: McpServersUpdateResult }) {
  const beforeSet = new Set(before);
  const afterSet = new Set(update.names);
  const added = update.names.filter((name) => !beforeSet.has(name));
  const removed = before.filter((name) => !afterSet.has(name)).sort();
  const cleared = update.names.length === 0;
  // 失敗・または届いた指紋が保存と違う実行環境が1台でも在れば、成功の見出しにしない。
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

/** 編集欄に流し込む形（`.mcp.json` そのもの。CLI の `mcpEditCommand` が開く形と同じ）。 */
function toMcpJson(servers: McpServers): string {
  return `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
}

/**
 * 編集欄の本文を読む。**止めるのは JSON として読めないものと `mcpServers` の欄が
 * 無いものだけ**で、中身の検査はデーモンの正本に任せる（CLI の `parseMcpJson` と
 * 同じ線）。
 */
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
