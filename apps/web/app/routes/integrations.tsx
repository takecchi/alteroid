import { daemonOrigin, ORIGIN_PLACEHOLDER } from '~/lib/integration-example';
import { LeaveGuardScope, useReportDirty, type LeaveNotice } from '~/lib/leave-guard';
import { SettingsTabs } from '~/components/group-tabs';
import { UnreadableRowsNote } from '~/components/unreadable-rows-note';
import { LoadError } from '~/components/load-error';
import { settingsDocumentTitle } from '~/lib/nav';
import { useNowMs } from '~/lib/use-now';
import { unsentInput } from '~/lib/unsent-input';
import { useState } from 'react';
import { Link } from 'react-router';

import {
  Page,
  Badge,
  Button,
  Card,
  CardHeader,
  CodeBlock,
  Empty,
  ErrorNote,
  FieldHint,
  Input,
  KeyValueList,
  Spinner,
} from '@alteroid/ui';
import {
  useApiContext,
  useIntegrationKeys,
  useIssueIntegrationKey,
  useRemoveUnreadableIntegrationKeys,
  useRevokeIntegrationKey,
} from '@alteroid/swr';
import { formatDateTime } from '@alteroid/logic';
import type {
  IntegrationKeyInput,
  IntegrationKeyIssued,
  IntegrationKeyView,
} from '@alteroid/logic';

// 値を localStorage・SWR のキャッシュ・URL に入れない: 値は1回だけ見せ、デーモンも sha256 しか持たず、消えたら取り出せないため
// 特定のサービスの名前・分岐を持たない: source は人間が決める文字列のため

const SOURCE_PATTERN = /^[a-z0-9._-]{1,64}$/;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_RATE_PER_MINUTE = 60;
const MAX_INT = 2_147_483_647;
const NAME_MAX_LENGTH = 200;

type KeyStatus = 'active' | 'revoked' | 'expired';

function statusOf(key: IntegrationKeyView, now: number): KeyStatus {
  if (key.revokedAt !== null) return 'revoked';
  if (key.expiresAt === null) return 'active';
  return Date.parse(key.expiresAt) > now ? 'active' : 'expired';
}

const STATUS_VIEW: Record<KeyStatus, { label: string; tone: 'ok' | 'neutral' | 'warn' }> = {
  active: { label: '有効', tone: 'ok' },
  revoked: { label: '失効', tone: 'neutral' },
  expired: { label: '期限切れ', tone: 'warn' },
};

const ISSUED_VALUE_NOTICE: LeaveNotice = {
  title: '写していない鍵の値があります',
  description:
    'このまま離れると、発行した鍵の値は消えて二度と見られません。取り直せないので、鍵を失効して発行し直すことになります。',
  confirmLabel: '値を消して離れる',
};

export default function Integrations() {
  const { data, error, isLoading, isValidating, mutate } = useIntegrationKeys();
  const removeUnreadable = useRemoveUnreadableIntegrationKeys();
  // 発行のたびに前の値を消さない: まだ控えていないかもしれないため
  const [issued, setIssued] = useState<IntegrationKeyIssued[]>([]);
  const now = useNowMs(30_000);

  return (
    <Page
      tabs={<SettingsTabs />}
      documentTitle={settingsDocumentTitle('/integrations')}
      title="連携"
      description="外のサービスが alteroid へ外部イベントを送るための鍵。鍵ごとに送れる source を1つに固定し、期限と上限を付けられる"
    >
      <LeaveGuardScope>
        <div className="flex flex-col gap-4">
          <p className="text-xs leading-relaxed break-words text-muted-foreground">
            alteroid から相手の MCP サーバを呼びたいときは、鍵ではなく{' '}
            <Link to="/mcp-servers" className="underline underline-offset-2">
              MCP サーバの登録
            </Link>
            へ。skill や plugin を入れるなら{' '}
            <Link to="/plugins" className="underline underline-offset-2">
              プラグイン
            </Link>
            へ。
          </p>

          <IssueForm onIssued={(result) => setIssued((current) => [result, ...current])} />

          {issued.map((result) => (
            <IssuedValue
              key={result.key.id}
              issued={result}
              onClose={() =>
                setIssued((current) => current.filter((row) => row.key.id !== result.key.id))
              }
            />
          ))}

          <Card>
            <CardHeader
              title="発行した鍵"
              subtitle="失効・期限切れを含む。値は残っていない（指紋は見分けるためだけの先頭12桁）"
              action={data === undefined ? undefined : <Badge>{data.keys.length}</Badge>}
            />
            <div className="flex flex-col gap-3 px-4 py-3">
              <LoadError
                what="連携の鍵の一覧"
                error={error}
                onRetry={() => mutate()}
                retrying={isValidating}
              />
            </div>
            {data?.rowsUnreadable !== undefined && (
              <UnreadableRowsNote
                noun="連携の鍵"
                unreadable={data.rowsUnreadable}
                removeUnreadable={removeUnreadable}
                hand="integration-keys.json"
              />
            )}
            {isLoading ? (
              <Spinner />
            ) : data === undefined ? null : data.keys.length === 0 ? (
              data.rowsUnreadable !== undefined ? (
                <Empty>読めた連携の鍵は無い（連携の鍵がまだ無い、とは言えない）。</Empty>
              ) : (
                <Empty>連携の鍵はまだ無い。</Empty>
              )
            ) : (
              <ul>
                {data.keys.map((key) => (
                  <KeyRow key={key.id} view={key} now={now} />
                ))}
              </ul>
            )}
          </Card>
        </div>
      </LeaveGuardScope>
    </Page>
  );
}

function IssueForm({ onIssued }: { onIssued: (issued: IntegrationKeyIssued) => void }) {
  const issueKey = useIssueIntegrationKey();
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [expires, setExpires] = useState('');
  const [maxBodyBytes, setMaxBodyBytes] = useState('');
  const [ratePerMinute, setRatePerMinute] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [problems, setProblems] = useState<string[]>([]);
  useReportDirty(
    'issue-form',
    [name, source, expires, maxBodyBytes, ratePerMinute].some((field) => field !== ''),
  );

  const nameTooLong = name.trim().length > NAME_MAX_LENGTH;

  async function submit() {
    if (nameTooLong) return;
    const checked = buildInput({ name, source, expires, maxBodyBytes, ratePerMinute });
    if (!checked.ok) {
      setProblems(checked.problems);
      setFailure(undefined);
      return;
    }
    setProblems([]);
    setFailure(undefined);
    setBusy(true);
    const sent = { name, source, expires, maxBodyBytes, ratePerMinute };
    try {
      const result = await issueKey(checked.input);
      onIssued(result);
      // 応答を待つ間に打ち足した分は消さない（#3891）。打ち足しの形があるのは文字列の name・source
      // だけ。期限・数値は、足した結果が別の値になるので、変えていなければ空に、変えていればそのまま残す。
      setName((current) => unsentInput(current, sent.name));
      setSource((current) => unsentInput(current, sent.source));
      setExpires((current) => (current === sent.expires ? '' : current));
      setMaxBodyBytes((current) => (current === sent.maxBodyBytes ? '' : current));
      setRatePerMinute((current) => (current === sent.ratePerMinute ? '' : current));
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="鍵を発行する"
        subtitle="発行した鍵で送れるのは、ここで決めた source のイベントだけ"
      />
      <form
        className="flex flex-col gap-3 px-4 py-3 text-sm"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">名前（見分けるための呼び名）</span>
          <Input
            value={name}
            aria-invalid={nameTooLong || undefined}
            aria-describedby={nameTooLong ? 'integration-name-too-long' : undefined}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {nameTooLong && (
          <p
            id="integration-name-too-long"
            role="alert"
            className="-mt-2 text-[11px] break-words text-destructive"
          >
            名前は 1〜{String(NAME_MAX_LENGTH)} 文字で指定してください（いま{' '}
            {String(name.trim().length)} 文字）
          </p>
        )}
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">source</span>
            <Input
              value={source}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              aria-describedby="integration-source-hint"
              onChange={(event) => setSource(event.target.value)}
            />
          </label>
          <FieldHint id="integration-source-hint">
            英小文字・数字・. _ - の 1〜64 文字（^[a-z0-9._-]{'{1,64}'}$）。この鍵は、この source
            のイベントだけを送れる。後から変えられない
          </FieldHint>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">期限（任意。空なら無期限）</span>
          <Input
            type="datetime-local"
            value={expires}
            onChange={(event) => setExpires(event.target.value)}
          />
        </label>
        <details className="rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            上限を変える（任意）
          </summary>
          <div className="mt-2 flex flex-col gap-3">
            <p className="text-[11px] text-muted-foreground">
              空なら既定（本文 1 MiB = {String(DEFAULT_MAX_BODY_BYTES)} バイト・
              {String(DEFAULT_RATE_PER_MINUTE)} 回/分）。この上限は連携の鍵にだけ掛かる。
            </p>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">本文の上限（バイト）</span>
              <Input
                inputMode="numeric"
                value={maxBodyBytes}
                placeholder={String(DEFAULT_MAX_BODY_BYTES)}
                onChange={(event) => setMaxBodyBytes(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">1分あたりの回数</span>
              <Input
                inputMode="numeric"
                value={ratePerMinute}
                placeholder={String(DEFAULT_RATE_PER_MINUTE)}
                onChange={(event) => setRatePerMinute(event.target.value)}
              />
            </label>
          </div>
        </details>

        {problems.length > 0 && (
          <ul role="alert" className="list-disc pl-5 text-[11px] break-words text-destructive">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        <ErrorNote error={failure} />
        {failure !== undefined && (
          <p className="text-[11px] text-muted-foreground">
            鍵は発行していない。入力はそのまま残してあるので、直して、もう一度押せる。
          </p>
        )}

        <div>
          <Button type="submit" variant="primary" size="sm" loading={busy}>
            発行する
          </Button>
        </div>
      </form>
    </Card>
  );
}

function buildInput(fields: {
  name: string;
  source: string;
  expires: string;
  maxBodyBytes: string;
  ratePerMinute: string;
}): { ok: true; input: IntegrationKeyInput } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const name = fields.name.trim();
  if (name.length === 0) problems.push('名前を入れてください');
  if (!SOURCE_PATTERN.test(fields.source)) {
    problems.push('source は英小文字・数字・. _ - の 1〜64 文字で入れてください');
  }
  const input: IntegrationKeyInput = { name, source: fields.source };
  if (fields.expires.trim() !== '') {
    const at = new Date(fields.expires);
    if (Number.isNaN(at.getTime())) problems.push('期限を読めませんでした');
    else if (at.getTime() <= Date.now()) problems.push('期限が過去です');
    else input.expiresAt = at.toISOString();
  }
  const limit = (text: string, label: string): number | undefined => {
    if (text.trim() === '') return undefined;
    const value = Number(text.trim());
    if (!/^\d+$/.test(text.trim()) || value <= 0 || value > MAX_INT) {
      problems.push(`${label}は 1 以上 ${String(MAX_INT)} 以下の整数で入れてください`);
      return undefined;
    }
    return value;
  };
  const body = limit(fields.maxBodyBytes, '本文の上限');
  if (body !== undefined) input.maxBodyBytes = body;
  const rate = limit(fields.ratePerMinute, '1分あたりの回数');
  if (rate !== undefined) input.ratePerMinute = rate;
  return problems.length > 0 ? { ok: false, problems } : { ok: true, input };
}

// 送り方の例に値を書かない: 値が画面に2回出てしまうため
function IssuedValue({ issued, onClose }: { issued: IntegrationKeyIssued; onClose: () => void }) {
  const { baseUrl } = useApiContext();
  const { key, value } = issued;
  useReportDirty(`issued-value:${key.id}`, true, ISSUED_VALUE_NOTICE);
  const origin = daemonOrigin(baseUrl);
  const example =
    `curl -X POST ${origin ?? ORIGIN_PLACEHOLDER}/events/${key.source} \\\n` +
    `  -H "Authorization: Bearer <上の値>" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"message":"hello"}'`;
  return (
    <Card>
      <CardHeader
        title={`発行した: ${key.name}`}
        subtitle={`source ${key.source}`}
        action={
          <Button variant="ghost" size="sm" onClick={onClose}>
            値を消して閉じる
          </Button>
        }
      />
      <div className="flex flex-col gap-3 px-4 py-3 text-sm">
        <p role="alert" className="text-[11px] break-words text-warn">
          この値は二度と表示されない（alteroid は sha256
          しか保存していない）。いま写して、渡す先の秘密の置き場へ入れる。画面を離れたり閉じたりすると消える。
        </p>
        <CodeBlock label="連携の鍵の値">{value}</CodeBlock>
        {origin !== null && <CodeBlock label="デーモンの origin">{origin}</CodeBlock>}
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            外のサービスに貼るのはデーモンの origin だけ。/events は送る側が付ける。
            送り方の例（本文の JSON がそのまま payload になる）
          </span>
          <CodeBlock label="curl">{example}</CodeBlock>
        </div>
      </div>
    </Card>
  );
}

function KeyRow({ view, now }: { view: IntegrationKeyView; now: number }) {
  const revokeKey = useRevokeIntegrationKey();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const status = statusOf(view, now);
  const shown = STATUS_VIEW[status];

  async function revoke() {
    setBusy(true);
    setFailure(undefined);
    try {
      await revokeKey(view.id);
      setConfirming(false);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium break-all">{view.name}</span>
        <Badge tone={shown.tone}>{shown.label}</Badge>
      </div>
      <KeyValueList
        className="mt-2"
        labelWidth="9rem"
        items={[
          { label: 'source', value: view.source, mono: true },
          {
            label: '作成',
            value: `${formatDateTime(view.createdAt)}（${view.createdBy}）`,
          },
          {
            label: '最終使用',
            value:
              view.lastUsedAt === null ? '（まだ使われていない）' : formatDateTime(view.lastUsedAt),
          },
          {
            label: '期限',
            value: view.expiresAt === null ? '（無期限）' : formatDateTime(view.expiresAt),
          },
          ...(view.revokedAt === null
            ? []
            : [{ label: '失効', value: formatDateTime(view.revokedAt) }]),
          { label: '指紋', value: view.fingerprint, mono: true },
          {
            label: '上限',
            value: `本文 ${String(view.limits.maxBodyBytes)} バイト・${String(view.limits.ratePerMinute)} 回/分`,
          },
        ]}
      />
      {view.revokedAt === null && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {!confirming ? (
              <Button
                variant="danger"
                size="sm"
                aria-label={`${view.name} を失効する`}
                onClick={() => setConfirming(true)}
              >
                失効する
              </Button>
            ) : (
              <>
                <span className="text-[11px] text-warn">
                  失効するとすぐ効き、この鍵で送っている外のサービスは 401
                  になる。元には戻せない（必要なら新しく発行する）。
                </span>
                <Button
                  variant="danger"
                  size="sm"
                  loading={busy}
                  aria-label={`${view.name} を本当に失効する`}
                  onClick={() => void revoke()}
                >
                  本当に失効する
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  やめる
                </Button>
              </>
            )}
          </div>
          <ErrorNote error={failure} />
        </div>
      )}
    </li>
  );
}
