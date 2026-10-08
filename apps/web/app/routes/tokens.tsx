import { SettingsTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { settingsDocumentTitle } from '~/lib/nav';
import { useEffect, useRef, useState } from 'react';
import { LeaveGuardScope, useReportDirty } from '~/lib/leave-guard';
import { unsentInput } from '~/lib/unsent-input';
import { useSearchParams } from 'react-router';

import {
  Page,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Empty,
  ErrorNote,
  Input,
  KeyValueList,
  Select,
  Spinner,
  WarnNote,
  cn,
} from '@alteroid/ui';
import {
  useAddToken,
  useRemoveToken,
  useRemoveUnreadableTokens,
  useSetTokenDisabled,
  useSetTokenPolicy,
  useJournal,
  useTokens,
  ApiError,
  TokenNotFoundError,
} from '@alteroid/swr';
import { formatDateTime, formatRelative, TOKEN_ID_PARAM } from '@alteroid/logic';
import type {
  AgentTokenView,
  TokenAvailability,
  TokenRecovery,
  TokenRotationEntry,
  TokenRotationSettings,
  TokensRowsUnreadable,
} from '@alteroid/logic';

// 値（value）はどこにも出さず、追加フォームで受け取った値も送信直後に state から捨てる: 出してよいのは id / label / 識別用の値 / 状態 / 時刻 / 理由の文言までのため
export default function Tokens() {
  return (
    <Page
      tabs={<SettingsTabs />}
      documentTitle={settingsDocumentTitle('/tokens')}
      title="認証トークン"
      description="登録した認証トークンの一覧・追加・削除・無効化/有効化、トークンを切り替える条件の設定、切り替えの履歴（エラー状況）"
    >
      <LeaveGuardScope>
        <div className="flex flex-col gap-4">
          <PoolAndSettings />
          <AddTokenForm />
          <RotationHistory />
        </div>
      </LeaveGuardScope>
    </Page>
  );
}

// フォームの入力は失敗時に消さない: 保存していないので、貼り直しを強いないため
function TokenWriteError({ error, className }: { error: unknown; className?: string }) {
  if (error === undefined || error === null) return null;
  return (
    <div className={className}>
      <ErrorNote error={error} />
      {error instanceof ApiError && error.code === 'journal_write_failed' && (
        <p className="mt-1 text-xs text-muted-foreground">
          何も変更していない。もう一度試すか、記録の置き場所（ディスクの空き・書き込み権限）を確かめる。
        </p>
      )}
    </div>
  );
}

// 送信後は即座に state から値を消す: ブラウザの history/フォーム復元に秘密が残らないようにするため
function AddTokenForm() {
  const addToken = useAddToken();
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  // 書きかけに値（秘密）も数える: 貼った値を失うと使い手は claude setup-token を回して取り直すことになるため
  useReportDirty('add-token', label !== '' || value !== '');

  const canSubmit = label.trim().length > 0 && value.trim().length > 0;

  async function submit() {
    if (!canSubmit) return;
    const sentLabel = label;
    const sentValue = value;
    setBusy(true);
    setFailure(undefined);
    try {
      await addToken(label.trim(), value.trim());
      // 空にしない: 応答を待つ間に打ち足した分を消さないため
      setLabel((current) => unsentInput(current, sentLabel));
      setValue((current) => unsentInput(current, sentValue));
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="追加" subtitle="使うトークンを足す" />
      <div className="flex flex-col gap-3 px-4 py-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            ラベル（人間が読む名前。秘密ではない）
          </span>
          <Input value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">値（claude setup-token の出力）</span>
          <Input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
          />
        </label>
        <TokenWriteError error={failure} />
        <div>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSubmit}
            loading={busy}
            onClick={() => void submit()}
          >
            追加
          </Button>
        </div>
      </div>
    </Card>
  );
}

function PoolAndSettings() {
  const { data, error, isLoading, isValidating, mutate } = useTokens();
  const [searchParams] = useSearchParams();
  const targetTokenId = searchParams.get(TOKEN_ID_PARAM) ?? undefined;

  // 403 を汎用の ErrorNote へ投げっぱなしにしない: 未 grant ならログイン画面へ振られるが、その手前をすり抜けた場合のため
  // 説明カードに置き換えるのは一覧がまだ読めていないときだけ: 再取得が 403 で返っても SWR は data を保っており、消すと一時的な失敗で画面を乗っ取るため
  if (data === undefined && error instanceof ApiError && error.status === 403) {
    return (
      <Card>
        <CardHeader title="トークン一覧・切り替えの設定" />
        <div className="px-4 py-3 text-sm text-muted-foreground">
          この一覧は alteroid を使う許可があるアカウントだけが見られる。
          いま繋いでいるアカウントには、この許可が無い。
        </div>
      </Card>
    );
  }

  return (
    <>
      <LoadError
        what="トークンの一覧"
        error={error}
        onRetry={() => mutate()}
        retrying={isValidating}
      />
      {isLoading ? (
        <Card>
          <Spinner />
        </Card>
      ) : data === undefined ? null : (
        <>
          <PoolCard
            tokens={data.tokens}
            targetTokenId={targetTokenId}
            rowsUnreadable={data.rowsUnreadable}
          />
          {data.settings === undefined ? (
            // 既定値では埋めない: off にしてあった回転を既定として見せることになるため
            <UnreadableSettingsCard reason={data.settingsUnreadable?.reason ?? '理由不明'} />
          ) : (
            <SettingsCard settings={data.settings} />
          )}
        </>
      )}
    </>
  );
}

// token-pool.ts の tokenAvailabilityAt を import せず書き写す: core の1関数のつもりでも sideEffects 未宣言でバンドラがパッケージ全体を tree-shake できず、1.2MB のチャンクを作った事故があるため
function tokenAvailabilityAt(
  token: Pick<AgentTokenView, 'disabledAt' | 'invalidatedAt' | 'cooldownUntil'>,
  // 既定引数に Date.now() を持つ: コンポーネント本体で直接 Date.now() を呼ぶと react-hooks/purity に落ちるため
  at: number = Date.now(),
): TokenAvailability {
  if (token.disabledAt !== undefined) return 'disabled';
  if (token.invalidatedAt !== undefined) return 'invalidated';
  if (token.cooldownUntil !== undefined && token.cooldownUntil > at) return 'cooling';
  return 'ready';
}

// 送られてくる値は投げずに「未知である」とそのまま出す: サーバのほうが新しい窓が必ず在り、投げると1行の未知が一覧を丸ごと消すため
// 黙って既知のどれかへ寄せない: 寄せると読む側は嘘の状態を見るため
// ここに数を書かない: 数のほうが先に腐り、数え上げの持ち主は schema.ts の z.enum のため
function describeUnknown(value: never, label: string): string {
  return `未知の${label}（${String(value)}）。この画面より新しいサーバが送った値である`;
}

// 送られてくる値には使わない: サーバのほうが新しい窓で throw するため（この画面が自分で作る値にだけ使う）
function assertNever(value: never, label: string): never {
  throw new Error(`未知の${label}: ${JSON.stringify(value)}`);
}

function describeAvailability(state: TokenAvailability): {
  label: string;
  tone: 'ok' | 'warn' | 'neutral' | 'danger';
} {
  switch (state) {
    case 'ready':
      return { label: '使用可能', tone: 'ok' };
    case 'cooling':
      return { label: '休止中', tone: 'warn' };
    case 'disabled':
      return {
        label: '無効化済み（人間が外した。自動では戻らない。「戻す」で人間が戻す）',
        tone: 'neutral',
      };
    case 'invalidated':
      return { label: '失効（通らないと確定。人間が外すまで戻らない）', tone: 'danger' };
    default:
      return assertNever(state, 'トークンの状態');
  }
}

// 3値を2値へ潰さない: 枠と課金枠の食い違いが画面から消えるため
// 無い回は「記録が無い」と出す: 古い行か欄を返さない版のデーモンのどちらかで、どちらも権威ある値とは言えないため
function describeCooldownSource(source: AgentTokenView['cooldownSource']): string {
  switch (source) {
    case undefined:
      return '記録が無い（この期限が確かな値かどうかは言えない）';
    case 'quota_reset':
      return '利用枠の復活時刻（確かな値）';
    case 'overage_reset':
      return '従量課金枠の復活時刻（確かな値。利用枠そのものではない）';
    case 'notice_text':
      return '上限の文言に書かれていた時刻（推測。ただし既定よりは良い）';
    case 'default':
      return '設定の既定（ただの推測である）';
    default:
      return describeUnknown(source, '休止の期限の出所');
  }
}

function describeFingerprint(token: AgentTokenView): string {
  if (token.sha256 !== undefined) return token.sha256;
  // 「不明」ではなく想定外であることを名指しする: 実装上ここには来ないはずのため
  return '（識別用の値が無い。想定外の行）';
}

// unknown を「取れなかった」と扱わない: 実装が持つ正規の3値目のため
function describeRecovery(recovery: TokenRecovery): string {
  switch (recovery) {
    case 'time':
      return '分類: 時間で戻る見込み（リセットを待てば良い）';
    case 'action':
      return '分類: 人の対応が要る見込み（入金・管理者の設定・座席種別の変更など）';
    case 'unknown':
      return '分類: どちらとも言えない（時間で戻るとも、人の対応が要るとも言えない。捨てる判断の根拠にしないこと）';
    default:
      // 投げない: 送られてくる値で、サーバのほうが新しい窓を先に持つため
      return describeUnknown(recovery, '回復の見込み');
  }
}

function formatEpochMs(ms: number): string {
  return formatDateTime(new Date(ms).toISOString());
}

function formatEpochMsRelative(ms: number): string {
  return formatRelative(new Date(ms).toISOString());
}

function PoolCard({
  tokens,
  targetTokenId,
  rowsUnreadable,
}: {
  tokens: readonly AgentTokenView[];
  targetTokenId?: string;
  rowsUnreadable?: TokensRowsUnreadable;
}) {
  const sorted = [...tokens].sort((a, b) => a.order - b.order);
  // 「既に無い」は行ではなく一覧側に持つ: hook は断る前に一覧を取り直すので、行の state に置くと断りの文言も一緒に消えるため
  const [gone, setGone] = useState<TokenNotFoundError | undefined>(undefined);
  // プールに居ない id で飛んできたとき黙って画面の頭に着地しない: 「リンクが壊れている」のか「その行が本当に無い」のか区別が付かないため
  const targetMissing = targetTokenId !== undefined && !sorted.some((t) => t.id === targetTokenId);

  return (
    <Card>
      <CardHeader
        title="トークン一覧"
        subtitle="登録済みのトークン。値そのものは出ない"
        action={<Badge>{sorted.length}</Badge>}
      />
      {targetMissing && (
        <WarnNote className="m-4">
          <code className="font-mono break-all">{targetTokenId}</code>{' '}
          はいまの一覧に無い（外したか、別の実行環境のもの）。
        </WarnNote>
      )}
      {gone !== undefined && <TokenWriteError error={gone} className="m-4" />}
      {rowsUnreadable !== undefined && <UnreadableRowsNote unreadable={rowsUnreadable} />}
      {sorted.length === 0 ? (
        rowsUnreadable !== undefined ? (
          // 読めない行が在るとき「まだ1件も無い」「正常」と言わない: 読めた行が無いとしか言えないため
          <Empty>
            読めた認証トークンの行は無い。登録されていない、とは言えない（読めない行が在る）。
          </Empty>
        ) : (
          // 正常な既定構成でもありうると添える: 「まだ取れていない」との混同を避けるため
          <Empty>
            登録された認証トークンがまだ1件も無い。（実行環境の環境変数1本だけの既定構成でも、これは正常）
          </Empty>
        )
      ) : (
        <ul>
          {sorted.map((token) => (
            <TokenRow
              key={token.id}
              token={token}
              highlighted={token.id === targetTokenId}
              onGone={setGone}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

// 一覧を書き換える操作は読めない行を捨てずに持ち越す: PUT /tokens は全文置換だが読めない行は残し、消すのは id を指す消すボタンだけのため
function UnreadableRowsNote({ unreadable }: { unreadable: TokensRowsUnreadable }) {
  const removeUnreadable = useRemoveUnreadableTokens();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(undefined);

  async function remove(id: string) {
    setBusyId(id);
    setFailure(undefined);
    try {
      await removeUnreadable([id]);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <WarnNote block className="m-4">
      <p>
        読めないトークンの行が {unreadable.count} 件ある（消えたのではなく、読めない形で
        入っている）。この一覧には載っていない。
      </p>
      <ul className="mt-1 list-disc pl-5">
        {unreadable.rows.map((row, index) => (
          <li key={`${row.id ?? ''}:${index}`}>
            {row.id === undefined && row.label === undefined ? (
              '（id もラベルも取れない）'
            ) : (
              <>
                {row.id !== undefined && <code className="font-mono break-all">{row.id}</code>}
                {row.id !== undefined && row.label !== undefined && ' / '}
                {row.label !== undefined && <span>{row.label}</span>}
              </>
            )}
            {' — '}
            {row.reason}
            {row.id !== undefined && (
              <>
                {' '}
                <Button
                  variant="danger"
                  size="sm"
                  aria-label={`${row.id} の行を消す`}
                  loading={busyId === row.id}
                  onClick={() => setConfirmingId(row.id as string)}
                >
                  この行を消す
                </Button>
                {/* 押した瞬間には実行せず確認を挟む: 消した行は戻せないため */}
                <ConfirmDialog
                  open={confirmingId === row.id}
                  onOpenChange={(open) => {
                    if (!open) setConfirmingId(null);
                  }}
                  title={`読めないトークンの行「${row.id}」を消しますか`}
                  description="この行は消え、元に戻せません。中身はこの画面では読めないので、消したあとに同じものを入れ直すには元の値が要ります。"
                  confirmLabel="消す"
                  destructive
                  onConfirm={() => void remove(row.id as string)}
                />
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-1">
        一覧を書き換える操作（追加・削除・無効化/戻す）は、この行を捨てずに持ち越す。
        消すには、行ごとの「この行を消す」を使う。番号が取れない行は、ここでは消せない。
      </p>
      <TokenWriteError error={failure} />
    </WarnNote>
  );
}

function TokenRow({
  token,
  highlighted = false,
  onGone,
}: {
  token: AgentTokenView;
  onGone: (error: TokenNotFoundError | undefined) => void;
  highlighted?: boolean;
}) {
  const availability = tokenAvailabilityAt(token);
  const state = describeAvailability(availability);
  const rejected = token.lastRejectedAt !== undefined || token.lastRejectedReason !== undefined;
  const setDisabled = useSetTokenDisabled();
  const removeToken = useRemoveToken();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [busy, setBusy] = useState<'disable' | 'enable' | 'remove' | null>(null);
  const [failure, setFailure] = useState<unknown>(undefined);
  const rowRef = useRef<HTMLLIElement>(null);

  // スクロールは mount 時の1回で足りる: PoolCard は useTokens のデータが届いてから TokenRow を描画するので、effect が走る時点で行は既に DOM に在るため
  useEffect(() => {
    if (highlighted) {
      rowRef.current?.scrollIntoView({ block: 'center' });
    }
  }, [highlighted]);

  async function toggleDisabled(next: boolean) {
    setBusy(next ? 'disable' : 'enable');
    setFailure(undefined);
    onGone(undefined);
    try {
      await setDisabled(token.id, next);
    } catch (caught) {
      if (caught instanceof TokenNotFoundError) onGone(caught);
      else setFailure(caught);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('remove');
    setFailure(undefined);
    onGone(undefined);
    try {
      await removeToken(token.id);
    } catch (caught) {
      if (caught instanceof TokenNotFoundError) onGone(caught);
      else setFailure(caught);
    } finally {
      setBusy(null);
    }
  }

  return (
    <li
      ref={rowRef}
      id={`token-${token.id}`}
      className={cn(
        'border-b border-border px-4 py-3 last:border-b-0',
        // 背景はチップより薄い /5 にする: 行全体が長時間目に入り続けるので、濃いと読みにくいため
        highlighted && 'border-primary bg-primary/5',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium break-all">{token.label}</span>
        <Badge tone={state.tone}>{state.label}</Badge>
        <span className="text-xs text-muted-foreground">order {token.order}</span>
      </div>

      <KeyValueList
        className="mt-2"
        labelWidth="9rem"
        items={[
          { label: '識別用の値', value: describeFingerprint(token), mono: true },
          {
            label: '作成',
            value:
              token.createdAt === undefined
                ? '不明（先行バージョンで作られた行のため記録が無い。「いま作られた」とは埋めない）'
                : formatDateTime(token.createdAt),
          },
          {
            label: '最終更新',
            value:
              token.updatedAt === undefined
                ? '不明（この行が実際に変わったことは無い）'
                : formatDateTime(token.updatedAt),
          },
          ...(token.disabledAt !== undefined
            ? [
                {
                  label: '無効化',
                  value: `${formatDateTime(token.disabledAt)}（人間が明示的に外した。自動では戻らない。「戻す」で人間が戻す）`,
                },
              ]
            : []),
          ...(token.invalidatedAt !== undefined
            ? [
                { label: '失効', value: formatDateTime(token.invalidatedAt) },
                {
                  label: '失効の理由（原文）',
                  value: (
                    <span className="font-mono text-[11px] break-words whitespace-pre-wrap">
                      {token.invalidatedReason ?? '（理由の記録が無い）'}
                    </span>
                  ),
                },
              ]
            : []),
          ...(token.cooldownUntil !== undefined
            ? [
                // 休止は絶対時刻を主に出す: 相対表現だけでは、休止が5時間なのに理由の原文は「weekly limit resets 5pm」と言っていた桁の食い違いに気づけないため
                {
                  label: '休止の期限',
                  value: `${formatEpochMs(token.cooldownUntil)}（${formatEpochMsRelative(token.cooldownUntil)}）`,
                },
                // 出所を必ず出す: 絶対時刻だけでは権威ある値か推測かが書けず、推測のときだけ出す形にすると何も書いていないことが「推測ではない」と「まだ対応していない」の両方を意味するため
                { label: '期限の出所', value: describeCooldownSource(token.cooldownSource) },
              ]
            : []),
          {
            label: '断られた記録',
            value: !rejected ? (
              '断られた記録が無い'
            ) : (
              <div className="flex flex-col gap-1">
                {token.lastRejectedAt !== undefined && (
                  <span>最後に断られた時刻: {formatDateTime(token.lastRejectedAt)}</span>
                )}
                {token.lastRejectedReason !== undefined && (
                  // Markdown は解釈しない: 原文をそのまま出すため
                  <span className="font-mono text-[11px] break-words whitespace-pre-wrap">
                    {token.lastRejectedReason}
                  </span>
                )}
                {token.recovery !== undefined && (
                  <span className="text-muted-foreground">{describeRecovery(token.recovery)}</span>
                )}
              </div>
            ),
          },
        ]}
      />

      <TokenWriteError error={failure} className="mt-2" />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {token.disabledAt === undefined ? (
          <Button
            size="sm"
            aria-label={`${token.label} を無効化する`}
            loading={busy === 'disable'}
            disabled={busy !== null}
            onClick={() => void toggleDisabled(true)}
          >
            無効化する
          </Button>
        ) : (
          <Button
            size="sm"
            aria-label={`${token.label} を戻す`}
            loading={busy === 'enable'}
            disabled={busy !== null}
            onClick={() => void toggleDisabled(false)}
          >
            戻す
          </Button>
        )}
        <Button
          variant="danger"
          size="sm"
          aria-label={`${token.label} を削除`}
          loading={busy === 'remove'}
          disabled={busy !== null}
          onClick={() => setConfirmingRemove(true)}
        >
          削除
        </Button>
        {/* 押した瞬間には実行せず確認を挟む: 消したトークンは戻せないため */}
        <ConfirmDialog
          open={confirmingRemove}
          onOpenChange={setConfirmingRemove}
          title={`トークン「${token.label}」を削除しますか`}
          description="このトークンはプールから外れ、元に戻せません。値はこの画面には出ていないので、入れ直すには claude setup-token の出力がもう一度要ります。"
          confirmLabel="削除する"
          destructive
          onConfirm={() => void remove()}
        />
      </div>
    </li>
  );
}

function describeRotateOn(policy: TokenRotationSettings['rotateOn']): string {
  switch (policy) {
    case 'free_exhausted':
      return '無料枠が尽きたら切り替える（既定）';
    case 'overage_exhausted':
      return '課金枠まで使い切ってから切り替える';
    case 'off':
      return '切り替えない（記録だけする）';
    default:
      // 投げない: 送られてくる値で、サーバのほうが新しい窓を先に持つため
      return describeUnknown(policy, '切り替える条件');
  }
}

// satisfies Record<…, true> で縛る: 配列リテラルに型注釈を付けた形では、値が増えた日に欠けたまま黙って通り、書き込み側は「選べない値が在る」ことを何も言わないため
const ROTATE_ON_OPTIONS = Object.keys({
  free_exhausted: true,
  overage_exhausted: true,
  off: true,
} satisfies Record<TokenRotationSettings['rotateOn'], true>) as TokenRotationSettings['rotateOn'][];

function SettingsCard({ settings }: { settings: TokenRotationSettings }) {
  const setPolicy = useSetTokenPolicy();

  // undefined は「まだ触っていない」: 触っていない間はサーバの値をそのまま映し、SSE 経由の無効化が再取得を回しても書きかけが消えないため
  const [rotateOnDraft, setRotateOnDraft] = useState<TokenRotationSettings['rotateOn'] | undefined>(
    undefined,
  );
  const [cooldownMsDraft, setCooldownMsDraft] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  const rotateOn = rotateOnDraft ?? settings.rotateOn;
  const cooldownMsText = cooldownMsDraft ?? String(settings.cooldownMs);
  const dirty = rotateOn !== settings.rotateOn || cooldownMsText !== String(settings.cooldownMs);
  useReportDirty('token-policy', dirty);

  async function save() {
    setBusy(true);
    setFailure(undefined);
    try {
      // 「正の整数」等の判定を先回りして弾かない: 変な値でもそのまま送り、断られたらサーバの文言をそのまま見せるため
      await setPolicy({ rotateOn, cooldownMs: Number(cooldownMsText) });
      setRotateOnDraft(undefined);
      setCooldownMsDraft(undefined);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="切り替えの設定" subtitle="トークンを切り替える条件と、休止の既定" />
      <KeyValueList
        className="px-4 py-3"
        labelWidth="9rem"
        items={[
          { label: '切り替える条件', value: describeRotateOn(settings.rotateOn) },
          {
            label: '休止の既定',
            value: (
              <>
                {(settings.cooldownMs / (60 * 60 * 1000)).toLocaleString('ja-JP', {
                  maximumFractionDigits: 2,
                })}
                時間。
                <br />
                <span className="text-xs text-muted-foreground">
                  利用枠の復活時刻が分からなかったときだけ使う目安。分かっているときは、行ごとの
                  「休止の期限」が優先される。
                </span>
              </>
            ),
          },
          ...(settings.updatedAt !== undefined
            ? [{ label: '最終変更', value: formatDateTime(settings.updatedAt) }]
            : []),
        ]}
      />

      <div className="flex flex-col gap-3 border-t border-border px-4 py-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">切り替える条件を変える</span>
          <Select
            value={rotateOn}
            onChange={(event) =>
              setRotateOnDraft(event.target.value as TokenRotationSettings['rotateOn'])
            }
          >
            {ROTATE_ON_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {describeRotateOn(option)}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">休止の既定を変える（ミリ秒）</span>
          <Input
            type="number"
            value={cooldownMsText}
            onChange={(event) => setCooldownMsDraft(event.target.value)}
          />
        </label>

        <TokenWriteError error={failure} />

        <div>
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            disabled={!dirty}
            onClick={() => void save()}
          >
            {dirty ? '保存' : '変更なし'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

// reason はそのまま出す: 空欄と壊れた値を混同すると、人間は「設定したことが無い」と誤読するため
// 既定値では埋めず未選択から始める: 読めない現在値の代わりに既定を選ばせると、off にしてあった回転を気づかないまま既定へ戻すことになるため
// 両方揃うまで保存できない: PUT /tokens/policy は現在値が読めないとき両方を送ったときだけ上書きが通り、片方だけだと 500 になるため
// ROTATE_ON_OPTIONS / describeRotateOn は SettingsCard と共有する: 選択肢が増減したとき、ここだけ追随し損ねないため
function UnreadableSettingsCard({ reason }: { reason: string }) {
  const setPolicy = useSetTokenPolicy();

  const [rotateOnDraft, setRotateOnDraft] = useState<TokenRotationSettings['rotateOn'] | undefined>(
    undefined,
  );
  const [cooldownMsText, setCooldownMsText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  useReportDirty('token-policy', rotateOnDraft !== undefined || cooldownMsText !== '');
  const canSubmit = rotateOnDraft !== undefined && cooldownMsText.trim().length > 0;

  async function save() {
    if (!canSubmit) return;
    setBusy(true);
    setFailure(undefined);
    try {
      // 先回りして弾かない: サーバの 400 をそのまま見せるため
      await setPolicy({ rotateOn: rotateOnDraft, cooldownMs: Number(cooldownMsText) });
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="切り替えの設定" subtitle="トークンを切り替える条件と、休止の既定" />
      <div className="px-4 py-3 text-sm text-muted-foreground">
        切り替えの設定は読めない（消えたのではなく、読めない形で入っている）: {reason}
      </div>
      <div className="flex flex-col gap-3 border-t border-border px-4 py-3 text-sm">
        <p className="text-xs text-muted-foreground">
          直すには、切り替える条件と休止の既定の両方を選び直して保存する（片方だけでは保存できない
          —— 読めない現在値は、両方揃った入力でしか上書きできない）。
        </p>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">切り替える条件を選ぶ</span>
          <Select
            value={rotateOnDraft ?? ''}
            onChange={(event) =>
              setRotateOnDraft(
                event.target.value === ''
                  ? undefined
                  : (event.target.value as TokenRotationSettings['rotateOn']),
              )
            }
          >
            <option value="" disabled>
              選択してください
            </option>
            {ROTATE_ON_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {describeRotateOn(option)}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">休止の既定を選ぶ（ミリ秒）</span>
          <Input
            type="number"
            value={cooldownMsText}
            onChange={(event) => setCooldownMsText(event.target.value)}
          />
        </label>

        <TokenWriteError error={failure} />

        <div>
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            disabled={!canSubmit}
            onClick={() => void save()}
          >
            保存
          </Button>
        </div>
      </div>
    </Card>
  );
}

// 打ち切ったら必ずそう書く: 黙って切り捨てないため
const JOURNAL_LIMIT = 50;

// ここだけ assertNever を使わない: 送られてくる値でサーバのほうが新しい窓を先に持ち、throw すると1行の未知が一覧全部を消すため
// not_rotated は freshness も見て言い分ける: stale の回は契機に当たっており、「契機に当たらなかった」と書くと嘘になるため
// event を増やして分けない: 外向きの面（openapi.json）が動くうえ、freshness に既に在る情報のため
function describeEvent(
  event: TokenRotationEntry['event'],
  freshness?: TokenRotationEntry['freshness'],
): {
  label: string;
  tone: 'ok' | 'warn' | 'neutral' | 'danger';
} {
  switch (event) {
    case 'rotated':
      return {
        label:
          '切り替えた（次のトークンを渡した。動いている最中のセッションにはまだ反映されていない）',
        tone: 'warn',
      };
    case 'exhausted':
      return { label: '候補が無い（全層が止まる）', tone: 'danger' };
    case 'sweep_stopped':
      return {
        label: '候補を試し切る前に打ち切った（まだ試していない候補が残っている）',
        tone: 'warn',
      };
    case 'not_rotated':
      return freshness === 'stale'
        ? {
            label: '切り替えなかった（すでに切り替えた後の通知。条件には当たっている）',
            tone: 'neutral',
          }
        : { label: '切り替えなかった（条件に当たらなかった。正常）', tone: 'neutral' };
    case 'parked':
      // rotated と同じ warn にしない: 撒けてはいるがいま通る鍵は1本も無く、exhausted と同じ重さの danger のため
      return {
        label: 'いま使える鍵が無い（いちばん早く戻る鍵を渡して待っている）',
        tone: 'danger',
      };
    case 'recovered':
      return { label: '止まっていた使用中のトークンが、また通ることを確認できた', tone: 'ok' };
    case 'reopened':
      // recovered と label を同じ文にしない: あちらは観測、こちらは時計で、同じ文だと読む側は observed だと思うため
      return {
        label: '使用中のトークンの休止が明けた（時刻が過ぎただけ。通ることまでは確認していない）',
        tone: 'ok',
      };
    case 'restored':
      return { label: '起動時に使用中のトークンを渡し直した', tone: 'neutral' };
    case 'restore_failed':
      return { label: '起動時の渡し直しに失敗', tone: 'danger' };
    default:
      return { label: describeUnknown(event, '切り替えの出来事'), tone: 'neutral' };
  }
}

function describeFreshness(freshness: NonNullable<TokenRotationEntry['freshness']>): string {
  switch (freshness) {
    case 'current':
      return '現在の観測';
    case 'stale':
      return '古い観測';
    case 'unknown':
      return '不明（どのトークンの観測か分からない箇所からの記録。「古い観測」とは別の意味）';
    default:
      // 投げない: 送られてくる値で、サーバのほうが新しい窓を先に持つため
      return describeUnknown(freshness, '観測の新しさ');
  }
}

function describeRecoveredSource(
  source: NonNullable<TokenRotationEntry['recoveredSource']>,
): string {
  switch (source) {
    case 'account_probe':
      return 'セッションを使わずに、利用枠を直接確かめて観測した';
    case 'turn_success':
      return '実際の応答が成功したので観測できた（セッション単位の上限にも効く）';
    default:
      return describeUnknown(source, '回復の観測元');
  }
}

type RotationSignal = NonNullable<TokenRotationEntry['signal']>;
type RotationReason = NonNullable<TokenRotationEntry['reason']>;

// Record にする: schema の enum に値が増えると型検査が落ち、足し忘れに気づけるため
// 表に無い値は素の値のまま出す: 送られてくる値はこの画面より新しいことがあるため
const ROTATION_SIGNAL_LABELS: Record<RotationSignal, string> = {
  reached: '利用枠に達して、仕事が止まった',
  quota_rejected: '利用枠が尽きた（従量課金枠は見ていない）',
  overage_closed: '利用枠が尽き、従量課金枠も閉じている',
  entered_overage: '従量課金枠から使い始めた（まだ動く）',
  org_policy: '組織の方針で止められている（利用枠の話ではない）',
  warning: '利用枠が近づいている',
  none: '切り替える材料が無かった',
  stranded: '使っているトークンは通らないのに、通る候補が在る',
  settings_unreadable: '切り替えの設定が読めなかった',
};

const ROTATION_REASON_LABELS: Record<RotationReason, string> = {
  pool_changed: 'トークンの一覧が変わった',
  settings_changed: '切り替えの設定が変わった',
  tick: '定期の見張り',
  runner_connected: '実行環境が繋がった',
  account_probe: '利用枠を直接確かめた結果が届いた',
  startup: '起動した直後',
  turn_succeeded: '使っているトークンで応答が成功した',
  trial_succeeded: '試しに使った候補が通った',
};

function rotationLabel(labels: Record<string, string>, value: string): string {
  return Object.hasOwn(labels, value) ? labels[value]! : `${value}（この画面にまだ言い方が無い値）`;
}

function describeRotationSignal(signal: RotationSignal): string {
  return rotationLabel(ROTATION_SIGNAL_LABELS, signal);
}

function describeRotationReason(reason: RotationReason): string {
  return rotationLabel(ROTATION_REASON_LABELS, reason);
}

function RotationHistory() {
  const { data, error, isLoading, isValidating, mutate } = useJournal(JOURNAL_LIMIT, [
    'token_rotation',
  ]);
  // type で狭める: GET /journal の型はサーバ側の絞り込みを反映せず、全種別の合併型のままのため
  const entries = (data?.entries ?? []).filter(
    (entry): entry is TokenRotationEntry => entry.type === 'token_rotation',
  );
  // 取れなかったのを0件と描かない: 失敗は LoadError が言うため
  const listUnavailable = data === undefined && error !== undefined;

  return (
    <Card>
      <CardHeader
        title="切り替えの履歴（エラー状況）"
        subtitle="トークンの切り替えの記録を新しい順に表示する。出来事は省かずに全部出す"
        action={data === undefined ? undefined : <Badge>{entries.length}</Badge>}
      />
      <LoadError
        what="切り替えの履歴"
        error={error}
        onRetry={() => mutate()}
        retrying={isValidating}
        className="m-4"
      />
      {isLoading ? (
        <Spinner />
      ) : listUnavailable ? null : entries.length === 0 ? (
        <Empty>切り替えの記録がまだ1件も無い。</Empty>
      ) : (
        <ul>
          {entries.map((entry) => (
            <RotationRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
      {/* TruncationNote は使えない: GET /journal は総件数を返さず、あちらは正確な total が要るため */}
      {entries.length === JOURNAL_LIMIT && (
        <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          直近 {JOURNAL_LIMIT} 件のみ表示している。これより古い記録は、日誌の画面で
          トークンの切り替えの記録に絞り込んで確認する。
        </p>
      )}
    </Card>
  );
}

function RotationRow({ entry }: { entry: TokenRotationEntry }) {
  const event = describeEvent(entry.event, entry.freshness);

  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={event.tone}>{event.label}</Badge>
        <span className="text-xs text-muted-foreground">{formatDateTime(entry.at)}</span>
        {entry.signal !== undefined && (
          <span className="text-xs text-muted-foreground">
            きっかけ: {describeRotationSignal(entry.signal)}
          </span>
        )}
        {entry.freshness !== undefined && (
          <span className="text-xs text-muted-foreground">
            {describeFreshness(entry.freshness)}
          </span>
        )}
        {/* signal と畳まない: 畳むと「休止が明けたので見直した」と「記録の上で現役が通らない」が同じ顔になるため */}
        {entry.reason !== undefined && (
          <span className="text-xs text-muted-foreground">
            見直したきっかけ: {describeRotationReason(entry.reason)}
          </span>
        )}
        {/* recovered の行にだけ付ける: 無い回は「観測していない」であって「account_probe だった」ではないため */}
        {entry.recoveredSource !== undefined && (
          <span className="text-xs text-muted-foreground">
            {describeRecoveredSource(entry.recoveredSource)}
          </span>
        )}
      </div>

      <p className="mt-1 text-sm break-words whitespace-pre-wrap">{entry.text}</p>

      <KeyValueList
        className="mt-2"
        labelWidth="8rem"
        items={[
          ...(entry.label !== undefined ? [{ label: 'ラベル', value: entry.label }] : []),
          ...(entry.tokenId !== undefined
            ? [{ label: '移った先・渡した先', value: entry.tokenId, mono: true }]
            : []),
          ...(entry.fromTokenId !== undefined
            ? [{ label: '降りた側', value: entry.fromTokenId, mono: true }]
            : []),
          ...(entry.generation !== undefined ? [{ label: '世代', value: entry.generation }] : []),
          ...(entry.earliestAt !== undefined
            ? [
                // 見出しはどちらでも読める言い方にする: parked の回はこれが「撒いた鍵が通るようになる時刻」で、exhausted の同じ欄と意味が同じため
                { label: '最速の復帰見込み', value: formatDateTime(entry.earliestAt) },
              ]
            : []),
        ]}
      />

      {entry.noticeText !== undefined && (
        // 当たった文言は言い換えずそのまま出す: text の中にも出るが、整形が変わっても原文はこちらに残すため
        <p className="mt-2 font-mono text-[11px] break-words whitespace-pre-wrap text-muted-foreground">
          {entry.noticeText}
        </p>
      )}
    </li>
  );
}
