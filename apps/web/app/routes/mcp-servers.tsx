import { useState } from 'react';

import { NotOwnerHint } from '~/components/not-owner-hint';
import { Page } from '~/components/page';
import { Badge, Button, Card, CardHeader, ErrorNote, Spinner, Textarea } from '~/components/ui';
import { useSetMcpServers } from '~/hooks/mutations';
import { useMcpServers } from '~/hooks/queries';
import { ApiError } from '~/lib/api';
import { formatDateTime } from '~/lib/format';
import type {
  McpServerEntry,
  McpServers,
  McpServersState,
  McpServersUpdateResult,
} from '~/lib/types';

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
 * - **資格は `requireOwner`**（`/profile` と同じ）。ボタンは隠さず、宣言していない
 *   アカウントの 403 には宣言の仕方を案内する（`NotOwnerHint`）
 *
 * **形の検査はデーモンに任せる**（`parseMcpServers` が正本）。この画面が手元で
 * 止めるのは「JSON として読めない」と「`mcpServers` の欄が無い」だけで、これは
 * 送る前に止める（CLI の `parseMcpJson` と同じ線）。
 */
export default function McpServersPage() {
  const { data, error, isLoading } = useMcpServers();

  return (
    <Page
      title="MCP 連携"
      description="クローン・マネージャー・作業者に渡す MCP サーバの登録（.mcp.json 相当）。alteroid mcp と同じもの"
    >
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader
            title="いま置かれているもの"
            subtitle="alteroid mcp list / show / GET /mcp-servers と同じもの"
          />
          <div className="flex flex-col gap-3 px-4 py-3">
            <ErrorNote error={error} />
            <NotOwnerHint failure={error} subject="MCP 連携の登録" />
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
      <dl className="grid grid-cols-1 gap-y-1 text-xs sm:grid-cols-[6rem_1fr]">
        <dt className="text-muted">状態</dt>
        <dd>
          {empty ? (
            <Badge>置かれていない</Badge>
          ) : (
            <Badge tone="accent">{`${String(names.length)} 件`}</Badge>
          )}
        </dd>
        {state.updatedAt !== undefined && (
          <>
            <dt className="mt-2 text-muted sm:mt-0">更新</dt>
            <dd>{formatDateTime(state.updatedAt)}</dd>
          </>
        )}
      </dl>

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
            ⚠ env / headers / args には鍵が丸ごと入っていることがある。表示するのは、周りに
            見られない場所で。
          </p>
          <div>
            <Button size="sm" onClick={() => setShown((value) => !value)}>
              {shown ? '値を隠す' : '値を表示する'}
            </Button>
          </div>
          {shown && (
            <pre
              aria-label="登録の本文（値を含む）"
              className="max-h-96 overflow-auto rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap"
            >
              {toJson(state.mcpServers)}
            </pre>
          )}
        </div>
      )}

      <p className="text-[11px] break-words text-muted">
        各 runner へ届いているかは「設定」の runner 欄（直近の押し込み）に出る。
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
      ? { label: 'headers', names: Object.keys(entry.headers ?? {}).sort() }
      : 'env' in entry
        ? { label: 'env', names: Object.keys(entry.env ?? {}).sort() }
        : { label: '', names: [] };

  return (
    <li className="flex flex-col gap-1 rounded-md border border-border px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono font-medium break-all">{name}</span>
        <Badge>{transport}</Badge>
      </div>
      <span className="font-mono break-all text-muted">{where}</span>
      {args.length > 0 && (
        <span className="text-muted">{`args: ${String(args.length)} 個（値は伏せた）`}</span>
      )}
      {keys.names.length > 0 && (
        <span className="font-mono break-all text-muted">{`${keys.label}: ${keys.names.join(', ')}`}</span>
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
  const draftClears = parsed !== null && parsed.ok && Object.keys(parsed.servers).length === 0;

  async function submit(servers: McpServers) {
    setBusy(true);
    setFailure(undefined);
    try {
      const before = Object.keys(current.mcpServers);
      const update = await setMcpServers(servers);
      setResult({ before, update });
      setConfirming(null);
      setDraft(null);
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
      <CardHeader
        title="差し替える"
        subtitle="alteroid mcp edit / set / clear / PUT /mcp-servers と同じもの。丸ごと置き換える"
      />
      <div className="flex flex-col gap-3 px-4 py-3 text-sm">
        <p className="text-xs leading-relaxed break-words text-muted">
          .mcp.json をそのまま貼れる形（{'{ "mcpServers": { … } }'}）。保存する前にデーモンが
          形を検査し、通らなければ保存も配布もしない（前のものが残る）。stdio の登録は、次の
          セッションでクローンやマネージャーが起こすコマンドになる。
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
              <span className="text-xs text-muted">登録（.mcp.json）</span>
              <Textarea
                aria-label="MCP サーバの新しい登録"
                className="min-h-64 font-mono text-xs"
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
              <p role="alert" className="text-[11px] break-words text-danger">
                {parseError}
              </p>
            )}
            {confirming !== 'save' && (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" size="sm" disabled={unchanged} onClick={askSave}>
                  {draftClears ? '空で保存する（外す）' : '保存する'}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>
                  編集を閉じる
                </Button>
                {unchanged && <span className="text-[11px] text-muted">変更はまだ無い。</span>}
              </div>
            )}
          </>
        )}

        {confirming === 'save' && parsed !== null && parsed.ok && (
          <div className="flex flex-col gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2">
            <p className="text-[11px] break-words text-warn">
              {draftClears
                ? 'MCP 連携の登録を全部外す。次のセッションから、クローン・マネージャー・作業者はこれらの連携を使えなくなる。'
                : 'この登録で丸ごと置き換え、繋がっている runner へ配る。クローンは次のセッションから、マネージャー・作業者は次に開くセッションから使う。'}
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
              MCP 連携の登録を全部外す（alteroid mcp clear と同じ）。次のセッションから、
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
          <p className="text-[11px] text-muted">前の登録がそのまま残っている。</p>
        )}
        <NotOwnerHint failure={failure} subject="MCP 連携の登録" />

        {result !== null && <UpdateReport before={result.before} update={result.update} />}
      </div>
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

  return (
    <div className="flex flex-col gap-2 text-xs">
      <p className="font-medium text-ok">
        {cleared
          ? 'MCP 連携の登録を外した。'
          : `MCP 連携の登録を差し替えた（sha256 ${update.sha256 ?? '?'}）。`}
      </p>
      {added.length > 0 && <p className="break-words">足した: {added.join(', ')}</p>}
      {removed.length > 0 && <p className="break-words">外した: {removed.join(', ')}</p>}
      <ul className="flex flex-col gap-1" aria-label="runner ごとの配布結果">
        {update.runners.length === 0 && (
          <li className="text-muted">
            いま配った runner は無い（繋がった runner へは、名乗り直したときに降ろす）。
          </li>
        )}
        {update.runners.map((runner) => (
          <li key={runner.runnerId} className="break-words">
            <span className="font-mono break-all">{runner.runnerId}</span>:{' '}
            {!runner.ok ? (
              <span className="text-danger">
                {runner.unsupported === true ? '受け取る口が無い（古い runner）' : '届かなかった'} —{' '}
                {runner.error ?? '理由不明'}
              </span>
            ) : runner.mcpServers === undefined ? (
              <span className="text-ok">{cleared ? '外した' : '届いた（指紋は返らなかった）'}</span>
            ) : update.sha256 !== undefined && runner.mcpServers.sha256 !== update.sha256 ? (
              <span className="text-danger">
                届いたが指紋が違う（runner {runner.mcpServers.sha256} / 保存 {update.sha256}）
              </span>
            ) : (
              <span className="text-ok">届いた（sha256 {runner.mcpServers.sha256}）</span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted">いつから効くか: {update.appliesFrom}</p>
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

/**
 * URL のクエリ・フラグメント・認証情報を伏せる（CLI の `maskUrl` と同じ線）。
 * 読めない URL は丸ごと伏せる —— どこに鍵があるかを判別できない。
 */
function maskUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '***';
  }
  const hidden = parsed.search !== '' || parsed.hash !== '' || parsed.username !== '';
  return hidden ? `${parsed.origin}${parsed.pathname}?***` : url;
}
