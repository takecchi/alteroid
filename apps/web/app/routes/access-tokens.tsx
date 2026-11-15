import { daemonOrigin, mcpServerJson } from '~/lib/integration-example';
import { LeaveGuardScope, useReportDirty, type LeaveNotice } from '~/lib/leave-guard';
import { SettingsTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { settingsDocumentTitle } from '~/lib/nav';
import { useAction } from '~/lib/use-action';
import { useFocusAfter } from '~/lib/use-focus-after';
import { useNowMs } from '~/lib/use-now';
import { unsentInput } from '~/lib/unsent-input';
import { useRef, useState } from 'react';
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
  ApiError,
  useAccessTokens,
  useApiContext,
  useIssueAccessToken,
  useRevokeAccessToken,
} from '@alteroid/swr';
import { formatDateTime } from '@alteroid/logic';
import type {
  AccessTokenInput,
  AccessTokenIssued,
  AccessTokenKind,
  AccessTokenView,
} from '@alteroid/logic';

// 値を localStorage・SWR のキャッシュ・URL に入れない: 値は1回だけ見せ、デーモンも sha256 しか持たず、消えたら取り出せないため
// 種類を read / full の2つに固定する: 選べる許可の一覧（scopes）にすると、確認が要る行為の一覧と同じ形になるため（デーモンも2つしか受けない）

const NAME_MAX_LENGTH = 200;
// 登録名は連携の鍵の `alteroid-report` と別にする: 同じクライアントに両方を並べて入れられるように
const MCP_SERVER_NAME = 'alteroid';

const KIND_VIEW: Record<AccessTokenKind, { label: string; description: string }> = {
  read: {
    label: 'read（読むだけ）',
    description:
      '読むだけ。記憶・日誌・利用・/self/prompt の読み取りと /mcp（読み取りの道具と報告）。書き込み・鍵や資格の読み出しは通らない。',
  },
  full: {
    label: 'full（ログインと同じ強さ）',
    description:
      'ログインのトークンと同じ強さ。ただし発行したトークンからは、新しいアクセストークンを発行・一覧・失効できない。',
  },
};

const KINDS: readonly AccessTokenKind[] = ['read', 'full'];

type ExpiryMode = '30d' | 'date' | 'never';

type TokenStatus = 'active' | 'revoked' | 'expired';

function statusOf(token: AccessTokenView, now: number): TokenStatus {
  if (token.revokedAt !== null) return 'revoked';
  if (token.expiresAt === null) return 'active';
  return Date.parse(token.expiresAt) > now ? 'active' : 'expired';
}

const STATUS_VIEW: Record<TokenStatus, { label: string; tone: 'ok' | 'neutral' | 'warn' }> = {
  active: { label: '有効', tone: 'ok' },
  revoked: { label: '失効', tone: 'neutral' },
  expired: { label: '期限切れ', tone: 'warn' },
};

const ISSUED_VALUE_NOTICE: LeaveNotice = {
  title: '写していないトークンの値があります',
  description:
    'このまま離れると、発行したトークンの値は消えて二度と見られません。取り直せないので、トークンを失効して発行し直すことになります。',
  confirmLabel: '値を消して離れる',
};

function isRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

function needsAccount(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400;
}

// 403 を一般の失敗と同じ文面にしない: 直しようがない失敗で、再試行しても通らないため
function RefusalNote() {
  return (
    <p role="alert" className="text-[11px] break-words text-warn">
      この資格ではアクセストークンを管理できない。管理できるのは、alteroid
      にログインした人か、実行環境の持ち主だけ。発行したアクセストークン（read・full
      のどちらでも）からは、発行・一覧・失効を呼べない。
    </p>
  );
}

function OperatorNote() {
  return (
    <p role="alert" className="text-[11px] break-words text-warn">
      ログインなしの構成（実行環境の持ち主の資格）では、どのアカウントのトークンかを決められないので、この画面からは扱えない。アカウントを指定して管理するには、ログインしてこの画面を開くか、HTTP
      API の accountId を指定する。
    </p>
  );
}

export default function AccessTokens() {
  const { data, error, isLoading, isValidating, mutate } = useAccessTokens();
  // 発行のたびに前の値を消さない: まだ控えていないかもしれないため
  const [issued, setIssued] = useState<AccessTokenIssued[]>([]);
  const now = useNowMs(30_000);
  const refused = isRefusal(error);
  const operator = needsAccount(error);

  return (
    <Page
      tabs={<SettingsTabs />}
      documentTitle={settingsDocumentTitle('/access-tokens')}
      title="アクセストークン"
      description="別の環境のクローンなどへ渡す、alteroid の HTTP API と MCP（/mcp）を使うためのトークンを発行する。種類は read と full の2つだけ"
    >
      <LeaveGuardScope>
        <div className="flex flex-col gap-4">
          <p className="text-xs leading-relaxed break-words text-muted-foreground">
            Claude 本体の認証トークン（サブスクリプションの枠）は{' '}
            <Link to="/tokens" className="underline underline-offset-2">
              認証トークン
            </Link>
            、外のサービスが外部イベントを送る鍵は{' '}
            <Link to="/integrations" className="underline underline-offset-2">
              連携
            </Link>
            、ログインできるアカウントの許可は{' '}
            <Link to="/access" className="underline underline-offset-2">
              アクセス許可
            </Link>
            へ。ここで扱うのは、alteroid そのものを呼ぶためのトークン。
          </p>

          {refused && <RefusalNote />}
          {operator && <OperatorNote />}
          {!refused && !operator && (
            <IssueForm onIssued={(result) => setIssued((current) => [result, ...current])} />
          )}

          {issued.map((result) => (
            <IssuedValue
              key={result.token.id}
              issued={result}
              onClose={() =>
                setIssued((current) => current.filter((row) => row.token.id !== result.token.id))
              }
            />
          ))}

          {!refused && !operator && (
            <Card>
              <CardHeader
                title="発行したトークン"
                subtitle="失効・期限切れ・ログインで発行したものを含む。値は残っていない（指紋は見分けるためだけの先頭12桁）"
                action={data === undefined ? undefined : <Badge>{data.tokens.length}</Badge>}
              />
              <div className="flex flex-col gap-3 px-4 py-3">
                <LoadError
                  what="アクセストークンの一覧"
                  error={error}
                  onRetry={() => mutate()}
                  retrying={isValidating}
                />
              </div>
              {isLoading ? (
                <Spinner />
              ) : data === undefined ? null : data.tokens.length === 0 ? (
                <Empty>アクセストークンはまだ無い。</Empty>
              ) : (
                <ul>
                  {data.tokens.map((token) => (
                    <TokenRow key={token.id} view={token} now={now} />
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
      </LeaveGuardScope>
    </Page>
  );
}

function IssueForm({ onIssued }: { onIssued: (issued: AccessTokenIssued) => void }) {
  const issueToken = useIssueAccessToken();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AccessTokenKind>('read');
  const [expiryMode, setExpiryMode] = useState<ExpiryMode>('30d');
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  // 発行中の2回目を止める印: ボタンの disabled は Ctrl/Cmd+Enter（`requestSubmit`）を止めず、state は次の描画まで古いため。
  // 止めないと、値の違う生きたトークンが2本発行され、片方を控え損ねやすい
  const issuingRef = useRef(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [problems, setProblems] = useState<string[]>([]);
  useReportDirty(
    'issue-form',
    name !== '' || kind !== 'read' || expiryMode !== '30d' || expires !== '',
  );

  const nameTooLong = name.trim().length > NAME_MAX_LENGTH;

  async function submit() {
    if (issuingRef.current || nameTooLong) return;
    const checked = buildInput({ name, kind, expiryMode, expires });
    if (!checked.ok) {
      setProblems(checked.problems);
      setFailure(undefined);
      return;
    }
    setProblems([]);
    setFailure(undefined);
    issuingRef.current = true;
    setBusy(true);
    const sent = { name, kind, expiryMode, expires };
    try {
      const result = await issueToken(checked.input);
      onIssued(result);
      // 応答を待つ間に打ち足した分は消さない。打ち足しの形があるのは文字列の name だけ。
      // 種類・期限は、変えていなければ既定に戻し、変えていればそのまま残す。
      setName((current) => unsentInput(current, sent.name));
      setKind((current) => (current === sent.kind ? 'read' : current));
      setExpiryMode((current) => (current === sent.expiryMode ? '30d' : current));
      setExpires((current) => (current === sent.expires ? '' : current));
    } catch (caught) {
      setFailure(caught);
    } finally {
      issuingRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="トークンを発行する" subtitle="発行した値は、この画面で1度だけ見られる" />
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
            aria-describedby={nameTooLong ? 'access-token-name-too-long' : undefined}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {nameTooLong && (
          <p
            id="access-token-name-too-long"
            role="alert"
            className="-mt-2 text-[11px] break-words text-destructive"
          >
            名前は 1〜{String(NAME_MAX_LENGTH)} 文字で指定してください（いま{' '}
            {String(name.trim().length)} 文字）
          </p>
        )}

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs text-muted-foreground">種類</legend>
          {KINDS.map((candidate) => (
            <label key={candidate} className="flex items-start gap-2">
              <input
                type="radio"
                name="access-token-kind"
                value={candidate}
                checked={kind === candidate}
                className="mt-1"
                onChange={() => setKind(candidate)}
              />
              <span className="flex flex-col gap-0.5">
                <span>{KIND_VIEW[candidate].label}</span>
                <span className="text-[11px] break-words text-muted-foreground">
                  {KIND_VIEW[candidate].description}
                </span>
              </span>
            </label>
          ))}
          {kind === 'full' && (
            <p role="alert" className="text-[11px] break-words text-warn">
              full は強い資格。このトークンを持つ相手は、書き込みを含め、ログインした人と同じことを
              alteroid
              にできる（新しいアクセストークンの発行だけはできない）。渡す相手と置き場所を絞り、読むだけで足りるなら
              read にする。
            </p>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs text-muted-foreground">期限</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="access-token-expiry"
              value="30d"
              checked={expiryMode === '30d'}
              onChange={() => setExpiryMode('30d')}
            />
            <span>30 日（既定）</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="access-token-expiry"
              value="date"
              checked={expiryMode === 'date'}
              onChange={() => setExpiryMode('date')}
            />
            <span>日時を指定する</span>
          </label>
          {expiryMode === 'date' && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">期限の日時</span>
              <Input
                type="datetime-local"
                value={expires}
                onChange={(event) => setExpires(event.target.value)}
              />
            </label>
          )}
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="access-token-expiry"
              value="never"
              checked={expiryMode === 'never'}
              onChange={() => setExpiryMode('never')}
            />
            <span>無期限（明示して選んだときだけ）</span>
          </label>
          {expiryMode === 'never' && (
            <FieldHint id="access-token-never-hint">
              無期限のトークンは、失効するまで使われ続ける。必要がなくなったら失効する。
            </FieldHint>
          )}
        </fieldset>

        {problems.length > 0 && (
          <ul role="alert" className="list-disc pl-5 text-[11px] break-words text-destructive">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        {isRefusal(failure) ? <RefusalNote /> : <ErrorNote error={failure} />}
        {failure !== undefined && (
          <p className="text-[11px] text-muted-foreground">
            トークンは発行していない。入力はそのまま残してあるので、直して、もう一度押せる。
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
  kind: AccessTokenKind;
  expiryMode: ExpiryMode;
  expires: string;
}): { ok: true; input: AccessTokenInput } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const name = fields.name.trim();
  if (name.length === 0) problems.push('名前を入れてください');
  const input: AccessTokenInput = { name, kind: fields.kind };
  if (fields.expiryMode === 'never') {
    input.expiresAt = null;
  } else if (fields.expiryMode === 'date') {
    if (fields.expires.trim() === '') {
      problems.push('期限の日時を入れてください');
    } else {
      const at = new Date(fields.expires);
      if (Number.isNaN(at.getTime())) problems.push('期限を読めませんでした');
      else if (at.getTime() <= Date.now()) problems.push('期限が過去です');
      else input.expiresAt = at.toISOString();
    }
  }
  // 30 日は送らない: 省略がデーモンの既定（30 日後）で、値を画面とデーモンの2か所に持たないため
  return problems.length > 0 ? { ok: false, problems } : { ok: true, input };
}

// この JSON だけが値を埋める: 貼れる形にするのが目的で、値は発行の応答にしか無く、発行直後の画面（保存も再表示もしない）でだけ組み立てる
function IssuedValue({ issued, onClose }: { issued: AccessTokenIssued; onClose: () => void }) {
  const { baseUrl } = useApiContext();
  const { token, value } = issued;
  useReportDirty(`issued-value:${token.id}`, true, ISSUED_VALUE_NOTICE);
  const origin = daemonOrigin(baseUrl);
  return (
    <Card>
      <CardHeader
        title={`発行した: ${token.name}`}
        subtitle={`種類 ${token.kind}`}
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
        {token.kind === 'full' && (
          <p className="text-[11px] break-words text-warn">
            full のトークン。持っている相手は、ログインした人と同じことができる。
          </p>
        )}
        <CodeBlock label="アクセストークンの値">{value}</CodeBlock>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            MCP サーバとして登録するときの JSON（登録名は {MCP_SERVER_NAME}
            。連携の鍵の報告用の登録 alteroid-report
            とは別の名前なので、同じクライアントに並べて入れられる）
          </span>
          <CodeBlock label="MCP サーバの JSON">
            {mcpServerJson(origin, value, MCP_SERVER_NAME)}
          </CodeBlock>
          <p className="text-[11px] break-words text-warn">
            この JSON を別の alteroid の「設定 — MCP
            サーバ」に貼ると、トークンがその環境のレジストリに平文で入り、そこのクローン・マネージャー・作業者から見える。
          </p>
          <p className="text-[11px] break-words text-muted-foreground">
            alteroid は alteroid 自身の MCP サーバの名前として予約されているので、「設定 — MCP
            サーバ」へ貼るときは登録名（先頭のキー）を別の名前に変える。
          </p>
        </div>
      </div>
    </Card>
  );
}

function originLabel(token: AccessTokenView): string {
  return token.origin === 'login'
    ? 'ログイン（alteroid login）'
    : `発行（${token.issuedBy ?? '不明'}）`;
}

function TokenRow({ view, now }: { view: AccessTokenView; now: number }) {
  const revokeToken = useRevokeAccessToken();
  const [confirming, setConfirming] = useState(false);
  const { busy, failure, run } = useAction();
  const status = statusOf(view, now);
  const shown = STATUS_VIEW[status];

  // 確認の欄は「失効する」のボタンを差し替えて出すので、閉じるとき押していたボタンごと消えて焦点が body に落ちる。閉じたあとの戻し先をここで持つ。
  // ボタンに ref を渡さず行から引く: 共通の Button は ref を受けない型のため
  const rowRef = useRef<HTMLLIElement>(null);
  const focusTriggerAfter = useFocusAfter(rowRef, confirming);
  // 失効が通ると「失効する」のボタンが行から無くなるので、行そのものへ戻す
  const focusRowAfter = useFocusAfter(rowRef, view.revokedAt !== null);

  function revoke() {
    return run(async () => {
      // 呼ぶ前に立てる: revokeToken が一覧を取り直して revokedAt が変わる描き直しは、await が返るより先に来ることがある
      await focusRowAfter('', () => revokeToken(view.id));
      setConfirming(false);
    });
  }

  return (
    <li
      ref={rowRef}
      tabIndex={-1}
      className="border-b border-border px-4 py-3 outline-none last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium break-all">{view.name}</span>
        <Badge tone={view.kind === 'full' ? 'warn' : 'neutral'}>{view.kind}</Badge>
        <Badge tone={shown.tone}>{shown.label}</Badge>
      </div>
      <KeyValueList
        className="mt-2"
        labelWidth="9rem"
        items={[
          { label: '種類', value: view.kind, mono: true },
          { label: '発行元', value: originLabel(view) },
          { label: '作成', value: formatDateTime(view.createdAt) },
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
                data-revoke-trigger
                onClick={() => setConfirming(true)}
              >
                失効する
              </Button>
            ) : (
              <>
                <span className="text-[11px] text-warn">
                  失効するとすぐ効き、このトークンで呼んでいる相手は 401
                  になる。元には戻せない（必要なら新しく発行する）。
                  {view.origin === 'login' &&
                    'ログインで発行したトークンなので、その端末は再ログインが必要になる。'}
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
                  onClick={() => {
                    void focusTriggerAfter('[data-revoke-trigger]');
                    setConfirming(false);
                  }}
                >
                  やめる
                </Button>
              </>
            )}
          </div>
          {isRefusal(failure) ? <RefusalNote /> : <ErrorNote error={failure} />}
        </div>
      )}
    </li>
  );
}
