// 外部由来の文字列（説明・パス・SKILL.md の冒頭）は素のテキストでだけ描く: HTML や Markdown として解釈すると、取り元が画面を書き換えられるため
import { SettingsTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { settingsDocumentTitle } from '~/lib/nav';
import { useState } from 'react';
import { useSearchParams } from 'react-router';

import {
  Page,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  ErrorNote,
  Input,
  Select,
  Spinner,
} from '@alteroid/ui';
import {
  ApiError,
  useInstallPlugin,
  usePlugins,
  usePreviewPlugin,
  useRemovePlugin,
} from '@alteroid/swr';
import {
  emptyPluginSourceForm,
  formatDateTime,
  hasRunnerPushFailure,
  parsePluginPrefill,
  parsePluginSource,
} from '@alteroid/logic';
import type {
  PluginInstallResult,
  PluginPreview,
  PluginPreviewSummary,
  PluginRemoveResult,
  PluginRow,
  PluginScope,
  PluginSourceForm,
} from '@alteroid/logic';

const MAX_LISTED_FILES = 40;
const SCOPES: readonly PluginScope[] = ['all', 'app', 'runner'];

type Source = PluginRow['source'];
type Runners = PluginInstallResult['runners'];

export default function PluginsPage() {
  const { data, error, isLoading, isValidating, mutate } = usePlugins();
  const [query] = useSearchParams();

  return (
    <Page
      tabs={<SettingsTabs />}
      documentTitle={settingsDocumentTitle('/plugins')}
      title="プラグイン"
      description="skill・agent・command をまとめて配る plugin を入れる・外す。入れる前に中身を確かめられる"
    >
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="入れてあるプラグイン" subtitle="いま入っている plugin" />
          <div className="flex flex-col gap-3 px-4 py-3">
            <LoadError
              what="プラグインの一覧"
              error={error}
              onRetry={() => mutate()}
              retrying={isValidating}
            />
            {isLoading ? <Spinner /> : data !== undefined && <PluginList plugins={data.plugins} />}
          </div>
        </Card>
        {/* クエリが変わったら作り直す: 欄は初期値だけをクエリから取るため */}
        <AddPlugin
          key={query.toString()}
          installed={data?.plugins ?? []}
          initial={parsePluginPrefill(query) ?? emptyPluginSourceForm()}
        />
      </div>
    </Page>
  );
}

function sourceWhere(source: Source): string {
  const base = source.kind === 'marketplace' ? `marketplace ${source.plugin ?? '?'} ` : '';
  const path = source.path === undefined ? '' : ` (path: ${source.path})`;
  return `${base}${source.url}${path}`;
}

function sourceText(source: Source): string {
  return `${sourceWhere(source)} @ ${source.sha.slice(0, 12)}`;
}

function PluginList({ plugins }: { plugins: readonly PluginRow[] }) {
  const removePlugin = useRemovePlugin();
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [removed, setRemoved] = useState<PluginRemoveResult | null>(null);

  async function remove(name: string) {
    setBusy(true);
    setFailure(undefined);
    setRemoved(null);
    try {
      setRemoved(await removePlugin(name));
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
      setTarget(null);
    }
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      {plugins.length === 0 ? (
        <Badge>入っていない</Badge>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="入れてあるプラグインの一覧">
          {plugins.map((plugin) => (
            <li
              key={plugin.name}
              className="flex flex-col gap-1 rounded-md border border-border px-3 py-2 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <span className="font-mono font-medium break-all">{plugin.name}</span>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  aria-label={`プラグイン ${plugin.name} を外す`}
                  onClick={() => setTarget(plugin.name)}
                >
                  外す
                </Button>
              </div>
              {plugin.description !== undefined && (
                // 外の文字列。素のテキストの子として描く（HTML・Markdown として解釈しない）。
                <p className="break-words">{plugin.description}</p>
              )}
              <span className="font-mono break-all text-muted-foreground">
                {`取り元: ${sourceText(plugin.source)}`}
              </span>
              <span className="text-muted-foreground">{`撒く先: ${plugin.scope}`}</span>
              <span className="text-muted-foreground">
                {`hooks: ${plugin.enableHooks ? '有効' : '無効'} / .mcp.json: ${plugin.enableMcp ? '有効' : '無効'}`}
              </span>
              <span className="text-muted-foreground">
                {`入れた人: ${plugin.installedBy}（${formatDateTime(plugin.installedAt)}）`}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] break-words text-muted-foreground">
        外しても、走っているセッションには次に開くまで残る。
      </p>
      <ErrorNote error={failure} />
      {removed !== null && (
        <div className="flex flex-col gap-1 text-xs">
          <p className="font-medium text-ok">{`プラグイン「${removed.name}」を外した。`}</p>
          <RunnerResults runners={removed.runners} appliesFrom={removed.appliesFrom} />
        </div>
      )}
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        title={`プラグイン「${target ?? ''}」を外しますか`}
        description="外しても、走っているセッションでは次に開くまで残ります。"
        confirmLabel="本当に外す"
        destructive
        onConfirm={() => {
          if (target !== null) void remove(target);
        }}
      />
    </div>
  );
}

function RunnerResults({ runners, appliesFrom }: { runners: Runners; appliesFrom: string }) {
  return (
    <div className="flex flex-col gap-1 text-xs">
      <ul className="flex flex-col gap-1" aria-label="実行環境ごとの反映結果">
        {runners.length === 0 && (
          <li className="text-muted-foreground">
            いま渡した実行環境は無い（繋がった実行環境へは、つなぎ直したときに渡す）。
          </li>
        )}
        {runners.map((runner) => (
          <li key={runner.runnerId} className="break-words">
            {runner.ok
              ? `${runner.runnerId}: 届いた`
              : `${runner.runnerId}: ${runner.unsupported === true ? '受け取る機能が無い（古い実行環境）' : '届かなかった'} — ${runner.error ?? '理由不明'}`}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">{`いつから効くか: ${appliesFrom}`}</p>
    </div>
  );
}

function AddPlugin({
  installed,
  initial,
}: {
  installed: readonly PluginRow[];
  initial: PluginSourceForm;
}) {
  const previewPlugin = usePreviewPlugin();
  const installPlugin = useInstallPlugin();
  const [form, setForm] = useState<PluginSourceForm>(initial);
  const [inputError, setInputError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [scope, setScope] = useState<PluginScope>('all');
  const [enableHooks, setEnableHooks] = useState(false);
  const [enableMcp, setEnableMcp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [expired, setExpired] = useState(false);
  const [result, setResult] = useState<PluginInstallResult | null>(null);

  function edit(patch: Partial<PluginSourceForm>) {
    setForm((current) => ({ ...current, ...patch }));
    // 取り元を変えたら預かりを捨てる: 見せた中身と違うものを確定させないため
    setPreview(null);
    setInputError(null);
    setFailure(undefined);
    setExpired(false);
  }

  async function runPreview() {
    const parsed = parsePluginSource(form);
    setResult(null);
    setFailure(undefined);
    setExpired(false);
    if (!parsed.ok) {
      setInputError(parsed.error);
      setPreview(null);
      return;
    }
    setInputError(null);
    setBusy(true);
    try {
      setPreview(await previewPlugin(parsed.request));
    } catch (caught) {
      setPreview(null);
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  async function runInstall(current: PluginPreview) {
    setBusy(true);
    setFailure(undefined);
    setExpired(false);
    try {
      setResult(
        await installPlugin({ previewId: current.previewId, scope, enableHooks, enableMcp }),
      );
      setPreview(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 404) {
        setExpired(true);
        setPreview(null);
      } else {
        setFailure(caught);
      }
    } finally {
      setBusy(false);
    }
  }

  const existing =
    preview === null ? undefined : installed.find((p) => p.name === preview.summary.name);

  return (
    <Card>
      <CardHeader
        title="プラグインを入れる"
        subtitle="取り元を選び、プレビューで中身を確かめてから入れる"
      />
      <div className="flex flex-col gap-3 px-4 py-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">取り元の種類</span>
          <Select
            aria-label="取り元の種類"
            value={form.kind}
            onChange={(event) =>
              edit({ kind: event.target.value === 'url' ? 'url' : 'marketplace' })
            }
          >
            <option value="marketplace">公式 marketplace の plugin 名</option>
            <option value="url">https の URL</option>
          </Select>
        </label>

        {form.kind === 'marketplace' ? (
          <Input
            aria-label="plugin 名"
            placeholder="plugin 名"
            autoComplete="off"
            spellCheck={false}
            value={form.plugin}
            onChange={(event) => edit({ plugin: event.target.value })}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <Input
              aria-label="リポジトリの URL"
              placeholder="https://github.com/owner/repo"
              autoComplete="off"
              spellCheck={false}
              value={form.url}
              onChange={(event) => edit({ url: event.target.value })}
            />
            <Input
              aria-label="path"
              placeholder="path（リポジトリの中の plugin のディレクトリ。任意）"
              autoComplete="off"
              spellCheck={false}
              value={form.path}
              onChange={(event) => edit({ path: event.target.value })}
            />
            <Input
              aria-label="ref"
              placeholder="ref（ブランチ・タグ。任意）"
              autoComplete="off"
              spellCheck={false}
              value={form.ref}
              onChange={(event) => edit({ ref: event.target.value })}
            />
            <Input
              aria-label="sha"
              placeholder="sha（小文字40桁の commit SHA。任意）"
              autoComplete="off"
              spellCheck={false}
              value={form.sha}
              onChange={(event) => edit({ sha: event.target.value })}
            />
          </div>
        )}

        {inputError !== null && (
          <p
            role="alert"
            aria-label="入力の誤り"
            className="text-[11px] break-words text-destructive"
          >
            {inputError}
          </p>
        )}
        <div>
          <Button
            size="sm"
            variant="primary"
            loading={busy && preview === null}
            disabled={busy}
            onClick={() => void runPreview()}
          >
            プレビュー
          </Button>
        </div>

        {expired && (
          <ErrorNote error="預かりの期限が切れた。プレビューからやり直すこと（まだ入れていない）。" />
        )}
        {failure !== undefined && <ErrorNote error={failure} />}

        {preview !== null && (
          <>
            <PreviewView preview={preview} />
            <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
              {existing !== undefined && (
                <p className="text-xs break-all text-warn">
                  {`置き換え: ${existing.source.sha} → ${preview.summary.sha}`}
                </p>
              )}
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">撒く先</span>
                <Select
                  aria-label="撒く先"
                  value={scope}
                  onChange={(event) => setScope(toScope(event.target.value))}
                >
                  <option value="all">all（クローンと実行環境の両方）</option>
                  <option value="app">app（クローンだけ）</option>
                  <option value="runner">runner（実行環境だけ）</option>
                </Select>
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={enableHooks}
                  onChange={(event) => setEnableHooks(event.target.checked)}
                />
                hooks を有効にする（有効にしても展開されない）
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={enableMcp}
                  onChange={(event) => setEnableMcp(event.target.checked)}
                />
                .mcp.json を有効にする
              </label>
              <div>
                <Button
                  variant="danger"
                  size="sm"
                  loading={busy}
                  onClick={() => void runInstall(preview)}
                >
                  入れる
                </Button>
              </div>
            </div>
          </>
        )}

        {result !== null && <InstallReport result={result} />}
      </div>
    </Card>
  );
}

function toScope(value: string): PluginScope {
  return SCOPES.find((scope) => scope === value) ?? 'all';
}

function InstallReport({ result }: { result: PluginInstallResult }) {
  const p = result.plugin;
  const partial = hasRunnerPushFailure(result);
  return (
    <div className="flex flex-col gap-2 text-xs">
      <p className="font-medium text-ok">
        {`プラグイン「${p.name}」を入れた（撒く先 ${p.scope}、SHA ${p.source.sha}）。`}
      </p>
      {partial && (
        <p
          role="alert"
          aria-label="一部の実行環境へ反映できていない"
          className="font-medium text-warn"
        >
          一部の実行環境へ反映できていない（保存は済んでいる。失敗した実行環境へは、次につながったときに降ろし直す）。
        </p>
      )}
      <RunnerResults runners={result.runners} appliesFrom={result.appliesFrom} />
    </div>
  );
}

function PresenceLine({
  label,
  presence,
  note,
}: {
  label: string;
  presence: { present: boolean; paths: string[] };
  note: string;
}) {
  if (!presence.present) return null;
  return <p className="break-words">{`${label}: ${presence.paths.join(', ')}  ${note}`}</p>;
}

function PreviewView({ preview }: { preview: PluginPreview }) {
  const s: PluginPreviewSummary = preview.summary;
  const drops = s.extractorDrops.filter((drop) => drop.reason !== 'invalid-path');
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2 text-xs">
      <p className="font-mono font-medium break-all">{s.name}</p>
      {s.description !== undefined && (
        <p className="break-words text-muted-foreground">{s.description}</p>
      )}
      <p className="break-all">{`取り元: ${sourceWhere(s.source)}`}</p>
      <p className="font-mono break-all">{s.sha}</p>
      <p className="text-muted-foreground">
        この commit で固定する（自動更新しない）。預かりは {formatDateTime(preview.expiresAt)}{' '}
        まで。
      </p>
      {s.source.version !== undefined && <p>{`版: ${s.source.version}`}</p>}
      <p>{`ファイル: ${String(s.fileCount)} 個 / ${String(s.totalBytes)} バイト`}</p>
      <p>
        {`skills ${String(s.counts.skills)} / agents ${String(s.counts.agents)} / commands ${String(s.counts.commands)}`}
      </p>

      {s.hooks.present && (
        <div
          role="alert"
          aria-label="hooks を含む"
          className="flex flex-col gap-1 rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2 font-medium text-destructive"
        >
          <p>警告: hooks を含む（plugin が実行の途中に割り込むコードを持ち込める）。</p>
          <p className="font-mono break-all">{s.hooks.paths.join(', ')}</p>
          <p>
            既定は無効。hooks を有効にしても展開されない（監査との関係を確かめるまで出さない）。
          </p>
        </div>
      )}
      <PresenceLine
        label=".mcp.json / mcpServers"
        presence={s.mcp}
        note="（「.mcp.json を有効にする」を選んだときだけ展開）"
      />
      <PresenceLine label="modules" presence={s.modules} note="（展開されない）" />
      <PresenceLine label="lspServers" presence={s.lspServers} note="（展開されない）" />
      {s.shellExecution.present && (
        <p className="break-words text-warn">
          {`警告: skills / commands の本文に、シェルを実行する記法（!\` や \`\`\`!）がある。呼び出されたとき、その場でコマンドが走りうる。該当: ${s.shellExecution.paths.join(', ')}`}
        </p>
      )}
      {s.executables.extracted.length > 0 && (
        <p className="break-words">
          {`実行ファイル（展開される）: ${s.executables.extracted.join(', ')}`}
        </p>
      )}
      {s.executables.notExtracted.length > 0 && (
        <p className="break-words">
          {`実行ファイル（展開されない）: ${s.executables.notExtracted.join(', ')}`}
        </p>
      )}
      {s.skipped.length > 0 && (
        <p className="break-words">
          {`取らなかったもの: ${s.skipped.map((item) => `${item.path}（${item.reason}）`).join(', ')}`}
        </p>
      )}
      {drops.length > 0 && (
        <div>
          <p>展開されないもの（有効にしても落とす）:</p>
          <ul className="font-mono break-all">
            {drops.slice(0, MAX_LISTED_FILES).map((drop) => (
              <li key={drop.path}>{`${drop.path}  (${drop.reason})`}</li>
            ))}
          </ul>
          {drops.length > MAX_LISTED_FILES && (
            <p>{`…ほか ${String(drops.length - MAX_LISTED_FILES)} 件`}</p>
          )}
        </div>
      )}
      {s.skillExcerpts.length > 0 && (
        <div className="flex flex-col gap-1">
          <p>SKILL.md の冒頭:</p>
          {s.skillExcerpts.map((excerpt) => (
            <div key={excerpt.path}>
              <p className="font-mono break-all">{excerpt.path}</p>
              <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted px-3 py-2 font-mono break-all whitespace-pre-wrap">
                {excerpt.truncated ? `${excerpt.excerpt}\n…` : excerpt.excerpt}
              </pre>
            </div>
          ))}
        </div>
      )}
      <div>
        <p>ファイル一覧:</p>
        <ul className="font-mono break-all" aria-label="ファイル一覧">
          {s.files.slice(0, MAX_LISTED_FILES).map((file) => (
            <li key={file.path}>
              {`${file.path}  ${String(file.size)}B${file.executable ? '  (実行ビット)' : ''}`}
            </li>
          ))}
        </ul>
        {s.files.length > MAX_LISTED_FILES && (
          <p>{`…ほか ${String(s.files.length - MAX_LISTED_FILES)} 個`}</p>
        )}
      </div>
    </div>
  );
}
