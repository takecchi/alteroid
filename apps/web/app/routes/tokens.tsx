import { SettingsTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { UnreadableRowsNote } from '~/components/unreadable-rows-note';
import { formatEpochMs, formatEpochMsRelative } from '~/lib/format-epoch-ms';
import { settingsDocumentTitle } from '~/lib/nav';
import { useEffect, useRef, useState } from 'react';
import { LeaveGuardScope, useReportDirty } from '~/lib/leave-guard';
import { unsentInput } from '~/lib/unsent-input';
import {
  checkCooldownDraft,
  cooldownDraftOf,
  describeCooldown,
  EMPTY_COOLDOWN_DRAFT,
  isEmptyCooldownDraft,
  type CooldownCheck,
  type CooldownDraft,
} from '~/lib/cooldown-input';
import { useAction } from '~/lib/use-action';
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
  useTokens,
  ApiError,
  TokenNotFoundError,
  TokenPoolChangedError,
} from '@alteroid/swr';
import { formatDateTime, TOKEN_ID_PARAM } from '@alteroid/logic';
import type {
  AgentTokenView,
  TokenRotationSettings,
  TokensActive,
  TokensRowsUnreadable,
} from '@alteroid/logic';

import {
  describeAvailability,
  describeCooldownSource,
  describeFingerprint,
  describeRecovery,
  describeRotateOn,
  ROTATE_ON_OPTIONS,
  tokenAvailabilityAt,
} from './tokens-describe';
import { RotationHistory } from './tokens-rotation-history';

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
function TokenWriteError({
  error,
  className,
  onRetry,
}: {
  error: unknown;
  className?: string;
  onRetry?: () => void;
}) {
  if (error === undefined || error === null) return null;
  // 取り直してから送るまでの間に、ほかでプールが変わった: 何も変えておらず、一覧は読み直してある（#4591）
  if (error instanceof TokenPoolChangedError) {
    return (
      <div
        role="alert"
        className={cn('rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs', className)}
      >
        <p className="font-medium text-warn">
          読んだ後に、トークンの一覧がほかで変わった。何も変えていない。
        </p>
        <p className="mt-1 text-muted-foreground">
          一覧は読み直した。いまの一覧を確かめてから、このまま置き直すか、やめる。
        </p>
        {onRetry !== undefined && (
          <Button size="sm" className="mt-2" onClick={onRetry}>
            このまま置き直す
          </Button>
        )}
      </div>
    );
  }
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
  const { busy, failure, run } = useAction();
  // 書きかけに値（秘密）も数える: 貼った値を失うと使い手は claude setup-token を回して取り直すことになるため
  useReportDirty('add-token', label !== '' || value !== '');

  const canSubmit = label.trim().length > 0 && value.trim().length > 0;

  async function submit() {
    if (!canSubmit) return;
    const sentLabel = label;
    const sentValue = value;
    await run(async () => {
      await addToken(label.trim(), value.trim());
      // 空にしない: 応答を待つ間に打ち足した分を消さないため
      setLabel((current) => unsentInput(current, sentLabel));
      setValue((current) => unsentInput(current, sentValue));
    });
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
        <TokenWriteError error={failure} onRetry={() => void submit()} />
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
            active={data.active}
            activeNever={data.activeNever === true}
            activeUnreadable={data.activeUnreadable}
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

function PoolCard({
  tokens,
  targetTokenId,
  rowsUnreadable,
  active,
  activeNever,
  activeUnreadable,
}: {
  tokens: readonly AgentTokenView[];
  targetTokenId?: string;
  rowsUnreadable?: TokensRowsUnreadable;
  active?: TokensActive;
  activeNever: boolean;
  activeUnreadable?: { reason: string };
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
      <ActiveNote active={active} never={activeNever} unreadable={activeUnreadable} />
      {rowsUnreadable !== undefined && <UnreadableTokenRows unreadable={rowsUnreadable} />}
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
              isActive={active?.tokenId === token.id}
              onGone={setGone}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

// 現役の指名の3状態を別々に言う: 「まだ一度も無い」と「読めない」を空欄や 0 で潰さないため。どの欄も無いのは現役を返さない古いデーモンで、何も言わない（「無い」と偽らない）
function ActiveNote({
  active,
  never,
  unreadable,
}: {
  active?: TokensActive;
  never: boolean;
  unreadable?: { reason: string };
}) {
  if (active !== undefined) {
    return (
      <p className="mx-4 mt-3 text-sm" data-testid="active-note">
        現役の指名: <code className="font-mono break-all">{active.tokenId}</code>（世代{' '}
        {active.generation}、{formatDateTime(active.rotatedAt)}）
      </p>
    );
  }
  if (unreadable !== undefined) {
    return (
      <div data-testid="active-note">
        <WarnNote className="m-4">
          現役の指名は読めない（{unreadable.reason}）。一覧のどれが現役かは言えない。
        </WarnNote>
      </div>
    );
  }
  if (never) {
    return (
      <p className="mx-4 mt-3 text-sm text-muted-foreground" data-testid="active-note">
        現役の指名: まだ一度も無い（器の環境変数のまま走っている）
      </p>
    );
  }
  return null;
}

// 一覧を書き換える操作は読めない行を捨てずに持ち越す: PUT /tokens は全文置換だが読めない行は残し、消すのは id を指す消すボタンだけのため
function UnreadableTokenRows({ unreadable }: { unreadable: TokensRowsUnreadable }) {
  const removeUnreadable = useRemoveUnreadableTokens();
  return (
    <UnreadableRowsNote
      noun="トークン"
      unreadable={unreadable}
      removeUnreadable={removeUnreadable}
      description="この行は消え、元に戻せません。中身はこの画面では読めないので、消したあとに同じものを入れ直すには元の値が要ります。"
      footer={
        <p className="mt-1">
          一覧を書き換える操作（追加・削除・無効化/戻す）は、この行を捨てずに持ち越す。
          消すには、行ごとの「この行を消す」を使う。番号が取れない行は、ここでは消せない。
        </p>
      }
      renderFailure={(failure) => <TokenWriteError error={failure} />}
    />
  );
}

function TokenRow({
  token,
  highlighted = false,
  isActive = false,
  onGone,
}: {
  token: AgentTokenView;
  onGone: (error: TokenNotFoundError | undefined) => void;
  highlighted?: boolean;
  isActive?: boolean;
}) {
  const availability = tokenAvailabilityAt(token);
  const state = describeAvailability(availability);
  const rejected = token.lastRejectedAt !== undefined || token.lastRejectedReason !== undefined;
  const setDisabled = useSetTokenDisabled();
  const removeToken = useRemoveToken();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [busy, setBusy] = useState<'disable' | 'enable' | 'remove' | null>(null);
  const [failure, setFailure] = useState<unknown>(undefined);
  // 409（ほかで変わった）のときだけ、同じ操作を「このまま置き直す」で撃ち直せるよう持つ
  const [retry, setRetry] = useState<(() => void) | undefined>(undefined);
  const rowRef = useRef<HTMLLIElement>(null);

  // スクロールは mount 時の1回で足りる: PoolCard は useTokens のデータが届いてから TokenRow を描画するので、effect が走る時点で行は既に DOM に在るため
  useEffect(() => {
    if (highlighted) {
      rowRef.current?.scrollIntoView({ block: 'center' });
    }
  }, [highlighted]);

  function fail(caught: unknown, again: () => void): void {
    if (caught instanceof TokenNotFoundError) onGone(caught);
    else setFailure(caught);
    setRetry(caught instanceof TokenPoolChangedError ? () => again : undefined);
  }

  async function toggleDisabled(next: boolean) {
    setBusy(next ? 'disable' : 'enable');
    setFailure(undefined);
    setRetry(undefined);
    onGone(undefined);
    try {
      await setDisabled(token.id, next);
    } catch (caught) {
      fail(caught, () => void toggleDisabled(next));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('remove');
    setFailure(undefined);
    setRetry(undefined);
    onGone(undefined);
    try {
      await removeToken(token.id);
    } catch (caught) {
      fail(caught, () => void remove());
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
        {/* 状態の印とは別に出す: 「使用可能」は現役の意味ではないため */}
        {isActive && <Badge tone="ok">現役</Badge>}
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

      <TokenWriteError error={failure} className="mt-2" onRetry={retry} />
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

// 休止の既定は時と分の2つの欄で入れる（送る中身はミリ秒のまま）。欄が空なら 0 として数える
function CooldownFields({
  legend,
  labelPrefix,
  fields,
  onChange,
}: {
  legend: string;
  labelPrefix: string;
  fields: CooldownDraft;
  onChange: (next: CooldownDraft) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-xs text-muted-foreground">{legend}</legend>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={0}
          step={1}
          className="w-24"
          aria-label={`${labelPrefix}（時間）`}
          value={fields.hours}
          onChange={(event) => onChange({ ...fields, hours: event.target.value })}
        />
        <span>時間</span>
        <Input
          type="number"
          min={0}
          step={1}
          className="w-24"
          aria-label={`${labelPrefix}（分）`}
          value={fields.minutes}
          onChange={(event) => onChange({ ...fields, minutes: event.target.value })}
        />
        <span>分</span>
      </div>
    </fieldset>
  );
}

function SettingsCard({ settings }: { settings: TokenRotationSettings }) {
  const setPolicy = useSetTokenPolicy();

  // undefined は「まだ触っていない」: 触っていない間はサーバの値をそのまま映し、SSE 経由の無効化が再取得を回しても書きかけが消えないため
  const [rotateOnDraft, setRotateOnDraft] = useState<TokenRotationSettings['rotateOn'] | undefined>(
    undefined,
  );
  const [cooldownDraft, setCooldownDraft] = useState<CooldownDraft | undefined>(undefined);
  const { busy, failure, setFailure, run } = useAction();

  const rotateOn = rotateOnDraft ?? settings.rotateOn;
  const cooldownFields = cooldownDraft ?? cooldownDraftOf(settings.cooldownMs);
  // 触っていない欄は保存済みの値のまま（分に満たない端数も含めて）送る。触った欄だけ、時・分から作り直す
  const cooldownCheck: CooldownCheck | undefined =
    cooldownDraft === undefined ? undefined : checkCooldownDraft(cooldownDraft);
  const cooldownChanged =
    cooldownCheck !== undefined && !(cooldownCheck.ok && cooldownCheck.ms === settings.cooldownMs);
  const dirty = rotateOn !== settings.rotateOn || cooldownChanged;
  useReportDirty('token-policy', dirty);

  async function save() {
    // 送る前に形を見る: 形が合わないものは送らず、画面の語で直し方を言う。形に合うのにサーバが断ったときの文は、そのまま出る
    if (cooldownCheck !== undefined && !cooldownCheck.ok) {
      setFailure(cooldownCheck.message);
      return;
    }
    const cooldownMs = cooldownCheck === undefined ? settings.cooldownMs : cooldownCheck.ms;
    await run(async () => {
      await setPolicy({ rotateOn, cooldownMs });
      setRotateOnDraft(undefined);
      setCooldownDraft(undefined);
    });
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
                {describeCooldown(settings.cooldownMs)}。
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
        <CooldownFields
          legend="休止の既定を変える"
          labelPrefix="休止の既定を変える"
          fields={cooldownFields}
          onChange={setCooldownDraft}
        />

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
  const [cooldownFields, setCooldownFields] = useState<CooldownDraft>(EMPTY_COOLDOWN_DRAFT);
  const { busy, failure, setFailure, run } = useAction();

  useReportDirty(
    'token-policy',
    rotateOnDraft !== undefined || !isEmptyCooldownDraft(cooldownFields),
  );
  const canSubmit = rotateOnDraft !== undefined && !isEmptyCooldownDraft(cooldownFields);

  async function save() {
    if (!canSubmit) return;
    // 送る前に形を見る（SettingsCard と同じ）
    const check = checkCooldownDraft(cooldownFields);
    if (!check.ok) {
      setFailure(check.message);
      return;
    }
    await run(async () => {
      await setPolicy({ rotateOn: rotateOnDraft, cooldownMs: check.ms });
    });
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
        <CooldownFields
          legend="休止の既定を選ぶ"
          labelPrefix="休止の既定を選ぶ"
          fields={cooldownFields}
          onChange={setCooldownFields}
        />

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
