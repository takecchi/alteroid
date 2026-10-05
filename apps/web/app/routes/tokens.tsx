import { SettingsTabs } from '~/components/group-tabs';
import { settingsDocumentTitle } from '~/lib/nav';
import { AlertTriangle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import {
  Page,
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  Input,
  KeyValueList,
  Select,
  Spinner,
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

/**
 * `/tokens` — 認証トークンのプール一覧・回転の設定・回転の履歴（エラー状況）。
 *
 * **追加・削除・無効化/有効化はこの画面からも行える**（2026-09-14。Issue #464
 * が埋めた「読み取り専用」の形をここで解いた——人間の決定により、CLI
 * （`alteroid token add` / `remove` / `disable` / `enable`）と同じ資格・同じ
 * `PUT /tokens`（全置換）をこの画面からも呼べるようにしてある）。**回す契機・
 * 冷却の設定（`policy`）も、2026-09-20 からこの画面から変えられる**
 * （Issue #1123。CLI（`alteroid token policy`）と同じ資格・同じ
 * `PUT /tokens/policy` をこの画面からも呼ぶ——`mutations.ts` の
 * `useSetTokenPolicy`）。
 *
 * **値（`value`）はどこにも出さない。** サーバ側の型（`AgentTokenView`）が
 * そもそも `value` を持たないので、この画面が「消し忘れて出す」形は作れない。
 * 追加フォームで受け取った値は送信直後に捨てる（コンポーネントの state に
 * 残さない）。出してよいのは id / label / 指紋（`sha256`、salt 無し sha256
 * の先頭12hex）/ 状態 / 時刻 / 断られた・失効した理由の文言までである
 * （`.claude/skills/token-pool/SKILL.md`）。
 */
export default function Tokens() {
  return (
    <Page
      tabs={<SettingsTabs />}
      documentTitle={settingsDocumentTitle('/tokens')}
      title="認証トークン"
      description="プールの一覧・追加・削除・無効化/有効化・回転の設定・回転の履歴（エラー状況）"
    >
      <div className="flex flex-col gap-4">
        <PoolAndSettings />
        <AddTokenForm />
        <RotationHistory />
      </div>
    </Page>
  );
}

/**
 * トークンを1本足す。**値はテキストエリアへ貼り付ける**（`alteroid token add`
 * と違いブラウザにファイル入力を持たせない——貼り付けのほうが手数が少ない）。
 *
 * **送信後は即座に state から値を消す。** ブラウザの history/フォーム復元に
 * 秘密が残らないようにする。
 */
function AddTokenForm() {
  const addToken = useAddToken();
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  const canSubmit = label.trim().length > 0 && value.trim().length > 0;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await addToken(label.trim(), value.trim());
      setLabel('');
      setValue('');
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
        <ErrorNote error={failure} />
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

// ---------------------------------------------------------------------------
// プール一覧・回転の設定（GET /tokens）
// ---------------------------------------------------------------------------

function PoolAndSettings() {
  const { data, error, isLoading } = useTokens();
  // 使用量の画面（`usage.tsx`「認証トークン別」）から飛んできたときの、
  // 行き先の id（issue #2109。`packages/logic/src/tokens-links.ts` の `tokensHref`）。
  const [searchParams] = useSearchParams();
  const targetTokenId = searchParams.get(TOKEN_ID_PARAM) ?? undefined;

  // **403 は「alteroid を使う許可が無い」であって、ただの失敗ではない。**
  //
  // 2026-09-06 の同格化で `/tokens` から `requireOperator` が外れたので、ここへ
  // 来る 403 は `authenticate` の「許可が無い」だけになった（実行環境の持ち主か
  // どうかは、もうこの画面の資格に関係しない）。
  //
  // **そして普通はここまで来ない** —— 未 grant なら `use-auth` が `ungranted` を
  // 返し、`shell` がログイン画面へ振る。残してあるのは、その手前をすり抜けた
  // 場合に汎用の `ErrorNote` へ投げっぱなしにしないためである。
  if (error instanceof ApiError && error.status === 403) {
    return (
      <Card>
        <CardHeader title="プール一覧・回転の設定" />
        <div className="px-4 py-3 text-sm text-muted-foreground">
          この一覧は alteroid を使う許可があるアカウントだけが見られる（
          <code className="font-mono">alteroid token list</code>{' '}
          と同じ資格）。いま繋いでいるアカウントには、この許可が無い。
        </div>
      </Card>
    );
  }

  return (
    <>
      <ErrorNote error={error} />
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
            // **issue #2096（#2095 の表示側）。** 回す契機・冷却の設定が壊れて
            // いて読めないとき、デーモンは `settings` を省いて
            // `settingsUnreadable.reason` を返す——既定値では埋めない
            // （`off` にしてあった回転を既定として見せることになる）。
            // ここでは理由をそのまま出し、両方を選ばせて直す導線
            // （`UnreadableSettingsCard`）を出す。
            <UnreadableSettingsCard reason={data.settingsUnreadable?.reason ?? '理由不明'} />
          ) : (
            <SettingsCard settings={data.settings} />
          )}
        </>
      )}
    </>
  );
}

/**
 * その行の「使えるか」を判定する。**`packages/core/src/token-pool.ts` の
 * `tokenAvailabilityAt` と同じロジックをここへ書き写している。**
 *
 * `apps/web/**` は `@alteroid/core` からの**値**の import を eslint で禁止して
 * いる（`import type` は可）——過去に core の1関数だけを import したつもりが、
 * `sideEffects` 未宣言のためバンドラがパッケージ全体を tree-shake できず
 * 1.2MB のチャンクを作った事故がある（`packages/logic/src/format.ts` の
 * `assertNeverCreatedAt` の doc）。だから実体の関数は呼ばず、4行のロジックを
 * ここに複製する。**判定順（`disabled` > `invalidated` > `cooling` > `ready`）
 * を崩さないこと。**
 */
function tokenAvailabilityAt(
  token: Pick<AgentTokenView, 'disabledAt' | 'invalidatedAt' | 'cooldownUntil'>,
  // **既定引数として `Date.now()` を持つ**（呼び出し側の render 本体で直接
  // 呼ばない）。`packages/logic/src/format.ts` の `formatRelative(iso, now = Date.now())`
  // と同じ形——コンポーネント本体で直接 `Date.now()` を呼ぶと
  // `react-hooks/purity`（不純な関数呼び出し）に落ちる。
  at: number = Date.now(),
): TokenAvailability {
  if (token.disabledAt !== undefined) return 'disabled';
  if (token.invalidatedAt !== undefined) return 'invalidated';
  if (token.cooldownUntil !== undefined && token.cooldownUntil > at) return 'cooling';
  return 'ready';
}

/**
 * **網羅していない値が実行時に届いたときに、投げずに1行へ落とす。**
 *
 * `assertNever` との使い分けは「**その値を誰が作るか**」である:
 *
 * - **この画面が自分で作る値** → `assertNever`。増えたらこのファイルが一緒に
 *   変わるので、実行時に未知が届く経路が無い（{@link tokenAvailabilityAt} が
 *   その形）。**投げてよい**
 * - **デーモンが作って送ってくる値** → こちら。`apps/web` は Vercel、デーモンは
 *   Railway で**別に配られる**ので、**サーバのほうが新しい窓が必ず在る。**
 *   そこで投げると、**1行の未知が一覧を丸ごと消す**（`AGENTS.md` の禁止1と同じ形）
 *
 * **網羅性はコンパイル時に守る**（引数が `never` なので、値が増えれば型検査が落ちる）。
 * **そして未知の値は「未知である」とそのまま出す** —— 黙って既知のどれかへ寄せない。
 * 寄せると、読む側は**嘘の状態**を見る。
 *
 * **⚠️ これは実際に起きた形である。** `token_rotation` の `event` は「5値」として
 * 書かれていたが、2026-08-26 に6値目（`sweep_stopped`）が、2026-09-07 に7値目
 * （`parked`）と8値目（`recovered`）が、2026-09-11 に9値目（`reopened`。#833）が
 * 足された。**固定に見える数え上げでも増える。**
 * ⟹ **ここに数を書かないこと**（数のほうが先に腐る。数え上げの持ち主は
 * `packages/core/src/schema.ts` の `z.enum` である）。
 */
function describeUnknown(value: never, label: string): string {
  return `未知の${label}（${String(value)}）。この画面より新しいデーモンが送った値である`;
}

/**
 * **この画面が自分で作る値**の網羅性を実行時にも守る。
 *
 * **送られてくる値へ使わないこと**（{@link describeUnknown} の使い分け）。
 */
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
      return { label: '冷却中', tone: 'warn' };
    case 'disabled':
      return { label: '無効化済み（人間が外した。戻らない）', tone: 'neutral' };
    case 'invalidated':
      return { label: '失効（通らないと確定。人間が外すまで戻らない）', tone: 'danger' };
    default:
      return assertNever(state, 'トークンの状態');
  }
}

/**
 * 冷却の期限の出所（#683）。
 *
 * **3値を2値へ潰さない**（枠と課金枠の食い違いが画面から消える）。
 *
 * **無い回は「記録が無い」と出す。** 無いのは
 * (a) #683 より前に冷却が書かれた行 (b) この欄を返さない版のデーモンに
 * 繋がっている、のどちらかで、**どちらも「権威ある値である」ではない。**
 *
 * **未知の語は `describeUnknown` へ落とす。** `apps/web` は Vercel、デーモンは
 * Railway で別に配られるので、**サーバのほうが新しい窓が必ず在る**（あちらの doc）。
 */
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
      return describeUnknown(source, '冷却の期限の出所');
  }
}

/**
 * 指紋の欄。**「不明」で埋めない。**
 *
 * **⚠️ かつては `source: 'env'` の行（器の環境変数を指す、値を持たない行）が
 * あり、その行だけ指紋も無かった。** その概念自体を廃止した（トークンプールは
 * 100% DB 駆動——登録された行は必ず値を持つ）ので、いまは常に指紋が付く。
 */
function describeFingerprint(token: AgentTokenView): string {
  if (token.sha256 !== undefined) return token.sha256;
  // 実装上ここには来ないはず（`stored` は値を持つので必ず指紋が付く）——
  // それでも「不明」ではなく、想定外であることを名指しする。
  return '（指紋が無い。想定外の行）';
}

/**
 * 回復の見込み。**`unknown` は実装が持つ正規の3値目であって、「取れなかった」
 * ではない。** `time` / `action` と同じ扱いの値として、そのまま出す。
 */
function describeRecovery(recovery: TokenRecovery): string {
  switch (recovery) {
    case 'time':
      return '分類: 時間で戻る見込み（リセットを待てば良い）';
    case 'action':
      return '分類: 人の対応が要る見込み（入金・管理者の設定・座席種別の変更など）';
    case 'unknown':
      return '分類: どちらとも言えない（時間で戻るとも、人の対応が要るとも言えない。捨てる判断の根拠にしないこと）';
    default:
      // **送られてくる値である**（`agentTokenViewSchema` の `recovery` は
      // デーモンが `limitRecoveryOf` で導いて載せる）。⟹ 投げない。
      return describeUnknown(recovery, '回復の見込み');
  }
}

/** epoch ミリ秒 → 絶対時刻。`formatDateTime` は ISO 文字列しか受けないので変換する。 */
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
  /**
   * 使用量の画面から飛んできたときの、行き先の id（issue #2109）。
   * `undefined` なら「飛んできていない」——通常の一覧表示と何も変わらない。
   */
  targetTokenId?: string;
  /**
   * 読めなかった行（`GET /tokens` の `rowsUnreadable`。issue #2346。`settingsUnreadable` の
   * 行版）。1件でも在るときだけ載る——`undefined` なら「読めない行は無い」。
   */
  rowsUnreadable?: TokensRowsUnreadable;
}) {
  const sorted = [...tokens].sort((a, b) => a.order - b.order);
  // **プールから外れた id で飛んできたときの倒れ先。** 使用量には残っている
  // が、いまの `GET /tokens` には居ない id（外した・別の器のプールを見ている、
  // など——どちらとも断定しない）で飛んできたとき、黙って画面の頭に着地する
  // と「リンクが壊れている」のか「その行が本当に無い」のか区別が付かない。
  const targetMissing = targetTokenId !== undefined && !sorted.some((t) => t.id === targetTokenId);

  return (
    <Card>
      <CardHeader
        title="プール一覧"
        subtitle="登録済みのトークン。値そのものは出ない"
        action={<Badge>{sorted.length}</Badge>}
      />
      {targetMissing && (
        // **`commitments.tsx` の `UnreadableNote` と同じ形にする**（issue
        // #2109）——「無い」でも「壊れている」でもない、どちらとも言えない
        // 状態を断る役割が同じである。
        <div
          role="status"
          className="m-4 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">
            <code className="font-mono break-all">{targetTokenId}</code>{' '}
            はいまのプールに無い（外したか、別の器のもの）。
          </span>
        </div>
      )}
      {rowsUnreadable !== undefined && <UnreadableRowsNote unreadable={rowsUnreadable} />}
      {sorted.length === 0 ? (
        rowsUnreadable !== undefined ? (
          // **「まだ1件も無い」「正常」と言えるのは、読めない行が0件のときだけ**
          // （issue #2346）。読めない行が在れば、読めた行が無いとしか言えない。
          <Empty>
            読めた認証トークンの行は無い。登録されていない、とは言えない（読めない行が在る）。
          </Empty>
        ) : (
          // **プールが空の構成は正常でありうる**（`.claude/skills/token-pool/SKILL.md`
          // 「何は変わらないか」）。「まだ取れていない」との混同を避けるため、
          // 正常な既定構成でもありうると添える。
          <Empty>
            登録された認証トークンがまだ1件も無い。（器の環境変数1本だけの既定構成でも、これは正常）
          </Empty>
        )
      ) : (
        <ul>
          {sorted.map((token) => (
            <TokenRow key={token.id} token={token} highlighted={token.id === targetTokenId} />
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * 読めないトークンの行の断り（issue #2346。`commitments.tsx` の `UnreadableNote` と同じ形）。
 *
 * **「消えたのではなく、読めない形で入っている」と言う**（`UnreadableSettingsCard` と同じ
 * 向き）。識別は id とラベルだけで、トークンの値は出ない（デーモンが返さない）。
 * **プールを書き換える操作（追加・削除・無効化/戻す）はこの行を捨てずに持ち越す**
 * （issue #2354 の決定。`PUT /tokens` は全文置換だが読めない行は残す。
 * `FsTokenPoolStore.replace` の doc）。消すのは、id を指す消すボタン
 * （`POST /tokens/unreadable/remove`）だけである。id が取れない行にはボタンが無い
 * （指す名前が無い）。
 */
function UnreadableRowsNote({ unreadable }: { unreadable: TokensRowsUnreadable }) {
  const removeUnreadable = useRemoveUnreadableTokens();
  const [busyId, setBusyId] = useState<string | null>(null);
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
    <div
      role="status"
      className="m-4 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 break-words">
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
                    loading={busyId === row.id}
                    onClick={() => void remove(row.id as string)}
                  >
                    この行を消す
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-1">
          プールを書き換える操作（追加・削除・無効化/戻す）は、この行を捨てずに持ち越す。
          消すには、行ごとの「この行を消す」を使う。番号が取れない行は、ここでは消せない。
        </p>
        <ErrorNote error={failure} />
      </div>
    </div>
  );
}

function TokenRow({
  token,
  highlighted = false,
}: {
  token: AgentTokenView;
  /** 使用量の画面から、この行を指して飛んできたか（issue #2109）。 */
  highlighted?: boolean;
}) {
  const availability = tokenAvailabilityAt(token);
  const state = describeAvailability(availability);
  const rejected = token.lastRejectedAt !== undefined || token.lastRejectedReason !== undefined;
  const setDisabled = useSetTokenDisabled();
  const removeToken = useRemoveToken();
  const [busy, setBusy] = useState<'disable' | 'enable' | 'remove' | null>(null);
  const [failure, setFailure] = useState<unknown>(undefined);
  const rowRef = useRef<HTMLLIElement>(null);

  // **スクロールは mount 時の1回で足りる。** `PoolCard`（親）は `useTokens`
  // のデータが届いてから初めて `TokenRow` を描画するので、この effect が
  // 走る時点で行は既に DOM に在る——react-router の `<ScrollRestoration>`
  // が hash に対して行う `getElementById` → `scrollIntoView` が非同期データと
  // 競合する問題（`packages/logic/src/tokens-links.ts` の doc）を、ここでは踏まない。
  useEffect(() => {
    if (highlighted) {
      rowRef.current?.scrollIntoView({ block: 'center' });
    }
  }, [highlighted]);

  async function toggleDisabled(next: boolean) {
    setBusy(next ? 'disable' : 'enable');
    setFailure(undefined);
    try {
      await setDisabled(token.id, next);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('remove');
    setFailure(undefined);
    try {
      await removeToken(token.id);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(null);
    }
  }

  return (
    <li
      ref={rowRef}
      // **安定した目印（issue #2109）。** hash ナビゲーションの入力としては
      // 使わない（`packages/logic/src/tokens-links.ts` の doc）が、行を指す DOM の id 自体は
      // 残す——テストや将来の直接リンクから見つけやすくするため。
      id={`token-${token.id}`}
      className={cn(
        'border-b border-border px-4 py-3 last:border-b-0',
        // **控えめな強調。** 選択チップ（`journal.tsx` / `managers.tsx`）と
        // 同じ `border-primary` + `bg-primary/15` の語彙を使うが、背景は薄めた
        // `/5` にする——行全体が長時間目に入り続けるので、チップより濃いと
        // 読みにくい。
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
          { label: '指紋', value: describeFingerprint(token), mono: true },
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
                  value: `${formatDateTime(token.disabledAt)}（人間が明示的に外した。戻らない）`,
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
                // **冷却は絶対時刻を必ず出す。** 実測で「冷却が5時間なのに断られた
                // 理由の原文は『weekly limit resets 5pm』と言っていた」という桁の
                // 食い違いが観測されている——相対表現（「あと◯時間」）だけでは
                // この食い違いに気づけない。絶対時刻を主に、相対は括弧で添えるだけ
                // にする。
                {
                  label: '冷却の期限',
                  value: `${formatEpochMs(token.cooldownUntil)}（${formatEpochMsRelative(token.cooldownUntil)}）`,
                },
                // **出所を必ず出す（#683）。** 絶対時刻を出しても、**それが権威ある
                // 値なのか5時間足しただけの推測なのかは書けていなかった** ——
                // #678 の調査は「文言が 22:10 と言っているのに 01:42 と出ている」を
                // 人間が目で見つけたところから始まった。行が出所を持てば、その1行で
                // 終わる。
                //
                // **「推測のときだけ出す」形にしないこと。** 権威ある値のときも
                // 出さないと、**何も書いていないことが「推測ではない」と「まだ
                // 対応していない」の両方を意味する**（`AGENTS.md` の地雷
                // 「取れない軸に 0 の行を作る」の裏返し）。
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
                  // **原文をそのまま出す。Markdown は解釈しない。**
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

      <ErrorNote error={failure} className="mt-2" />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {token.disabledAt === undefined ? (
          <Button
            size="sm"
            loading={busy === 'disable'}
            disabled={busy !== null}
            onClick={() => void toggleDisabled(true)}
          >
            無効化する
          </Button>
        ) : (
          <Button
            size="sm"
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
          loading={busy === 'remove'}
          disabled={busy !== null}
          onClick={() => void remove()}
        >
          削除
        </Button>
      </div>
    </li>
  );
}

function describeRotateOn(policy: TokenRotationSettings['rotateOn']): string {
  switch (policy) {
    case 'free_exhausted':
      return '無料枠が尽きたら回す（既定）';
    case 'overage_exhausted':
      return '課金枠まで閉じてから回す';
    case 'off':
      return '回さない（記録だけする）';
    default:
      // **送られてくる値である**（`GET /tokens` の `settings.rotateOn`）。⟹ 投げない。
      return describeUnknown(policy, '回す契機');
  }
}

/**
 * `<select>` に出す回す契機の数え上げ（`tokenRotationPolicySchema`（core）と同じ3値）。
 *
 * **`satisfies Record<…, true>` で縛ってあるのは、網羅をコンパイル時に守るためである**
 * （`packages/core/src/schema.ts` の `journalEntryTypeNames` と同じ形）。**配列リテラルに
 * 型注釈を付けた形では守れない** —— 値が増えた日に、欠けたまま黙って通る。読み取り側
 * （`describeRotateOn`）は `describeUnknown` で安全に倒れるが、**書き込み側は「選べない値が
 * 在る」ことを何も言わない** —— 人間には画面が完全に見えてしまう。
 */
const ROTATE_ON_OPTIONS = Object.keys({
  free_exhausted: true,
  overage_exhausted: true,
  off: true,
} satisfies Record<TokenRotationSettings['rotateOn'], true>) as TokenRotationSettings['rotateOn'][];

function SettingsCard({ settings }: { settings: TokenRotationSettings }) {
  const setPolicy = useSetTokenPolicy();

  /**
   * `undefined` は「まだ人間がこの欄に触っていない」——`memory-detail.tsx` の
   * `draft` と同じ作法。触っていない間はサーバの値をそのまま映すので、SSE 経由の
   * 無効化が再取得を回しても書きかけが消えない。触った瞬間から下書きが勝つ。
   */
  const [rotateOnDraft, setRotateOnDraft] = useState<TokenRotationSettings['rotateOn'] | undefined>(
    undefined,
  );
  const [cooldownMsDraft, setCooldownMsDraft] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  const rotateOn = rotateOnDraft ?? settings.rotateOn;
  const cooldownMsText = cooldownMsDraft ?? String(settings.cooldownMs);
  const dirty = rotateOn !== settings.rotateOn || cooldownMsText !== String(settings.cooldownMs);

  async function save() {
    setBusy(true);
    setFailure(undefined);
    try {
      // **「正の整数」等の判定をここで先回りして弾かない**（Issue #1123 受け入れ
      // 基準3）。`Number(cooldownMsText)` が変な値（負数・NaN 等）でもそのまま
      // 送り、断られたらサーバの文言をそのまま `ErrorNote` で見せる。
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
      <CardHeader title="回転の設定" subtitle="トークンを切り替える条件と、冷却の既定" />
      <KeyValueList
        className="px-4 py-3"
        labelWidth="9rem"
        items={[
          { label: '回す契機', value: describeRotateOn(settings.rotateOn) },
          {
            label: '冷却の既定',
            value: (
              <>
                {(settings.cooldownMs / (60 * 60 * 1000)).toLocaleString('ja-JP', {
                  maximumFractionDigits: 2,
                })}
                時間。
                <br />
                <span className="text-xs text-muted-foreground">
                  利用枠の復活時刻が分からなかったときだけ使う目安。分かっているときは、行ごとの
                  「冷却の期限」が優先される。
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
          <span className="text-xs text-muted-foreground">回す契機を変える</span>
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
          <span className="text-xs text-muted-foreground">冷却の既定を変える（ミリ秒）</span>
          <Input
            type="number"
            value={cooldownMsText}
            onChange={(event) => setCooldownMsDraft(event.target.value)}
          />
        </label>

        <ErrorNote error={failure} />

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

/**
 * 回す契機・冷却の設定が壊れていて読めないときの直し方（issue #2096。#2095 の
 * 表示側）。
 *
 * **`reason` はそのまま出す。** 「消えたのではなく、読めない形で入っている」と
 * 伝える —— 空欄と壊れた値を混同すると、人間は「設定したことが無い」と誤読する。
 *
 * **既定値では埋めない。** 読めない現在値の代わりに `free_exhausted` 等の既定を
 * 選ばせておくと、実際は `off` にしてあった回転を人間が気づかないまま既定へ
 * 戻すことになる（`AGENTS.md` の地雷「取れない軸に 0 の行を作る」と同じ形）。
 * だから2つの入力欄はどちらも**未選択から始める**——選ぶまで保存は押せない。
 *
 * **両方揃うまで保存できない。** `PUT /tokens/policy` は、現在値が読めないときは
 * `rotateOn` と `cooldownMs` の両方を送ったときだけ上書きが通る（片方だけだと
 * 読めない現在値を埋められず 500 になる。issue #2053 / PR #2075、
 * `packages/core/src/token-pool-service.ts` の `setSettings` の doc）。
 *
 * **保存に成功したら、この下書きを持ち続けない。** `useSetTokenPolicy` が
 * `GET /tokens` を取り直す（`mutations.ts`）ので、応答が読める形へ戻れば
 * `PoolAndSettings` は自動でこのカードではなく通常の {@link SettingsCard} を
 * 出す——このコンポーネントの寿命はそこで終わる。
 *
 * **`ROTATE_ON_OPTIONS` / `describeRotateOn` は {@link SettingsCard} と共有する
 * （書き写さない）。** 選択肢の一覧が増減したとき、ここだけ追随し損ねる形を
 * 作らないため。
 */
function UnreadableSettingsCard({ reason }: { reason: string }) {
  const setPolicy = useSetTokenPolicy();

  /** 未選択は `undefined`（`SettingsCard` の下書きと違い、埋める元の現在値が無い）。 */
  const [rotateOnDraft, setRotateOnDraft] = useState<TokenRotationSettings['rotateOn'] | undefined>(
    undefined,
  );
  /** 未入力は空文字。**既定値を入れない**——空のまま保存を押せないだけにする。 */
  const [cooldownMsText, setCooldownMsText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  const canSubmit = rotateOnDraft !== undefined && cooldownMsText.trim().length > 0;

  async function save() {
    if (!canSubmit) return;
    setBusy(true);
    setFailure(undefined);
    try {
      // **`Number(cooldownMsText)` を先回りして弾かない**（`SettingsCard.save`
      // と同じ判断。Issue #1123 受け入れ基準3）。サーバの 400 をそのまま見せる。
      await setPolicy({ rotateOn: rotateOnDraft, cooldownMs: Number(cooldownMsText) });
      // 成功後は `GET /tokens` が読める形を返すはずなので、下書きは特に戻さない
      // ——このコンポーネント自体が `SettingsCard` に置き換わって消える。
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="回転の設定" subtitle="トークンを切り替える条件と、冷却の既定" />
      <div className="px-4 py-3 text-sm text-muted-foreground">
        回転の設定は読めない（消えたのではなく、読めない形で入っている）: {reason}
      </div>
      <div className="flex flex-col gap-3 border-t border-border px-4 py-3 text-sm">
        <p className="text-xs text-muted-foreground">
          直すには、回す契機と冷却の既定の両方を選び直して保存する（片方だけでは保存できない ——
          読めない現在値は、両方揃った入力でしか上書きできない）。
        </p>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">回す契機を選ぶ</span>
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
          <span className="text-xs text-muted-foreground">冷却の既定を選ぶ（ミリ秒）</span>
          <Input
            type="number"
            value={cooldownMsText}
            onChange={(event) => setCooldownMsText(event.target.value)}
          />
        </label>

        <ErrorNote error={failure} />

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

// ---------------------------------------------------------------------------
// 回転の履歴（エラー状況） — GET /journal?type=token_rotation
// ---------------------------------------------------------------------------

/** 表示上限。**打ち切ったら必ずそう書く**（黙って切り捨てない）。 */
const JOURNAL_LIMIT = 50;

/**
 * 回転の `event` を人間の1行にする。
 *
 * **ここだけ `assertNever` を使わない。理由は「版のずれ」である。**
 *
 * この画面が読むのは**デーモンが書いた行**で、デーモンとこの画面は別に配られる
 * （`vercel.json` / `railway/`）。⟹ **サーバのほうが新しい窓が必ず在る**
 * —— そのとき、まだ知らない `event` が届く。`assertNever` は `throw` するので、
 * **画面が丸ごと落ちる**（1行の未知が一覧全部を消す。`AGENTS.md` の禁止1と同じ形）。
 *
 * ⟹ **網羅性はコンパイル時に守り、実行時は落とさない。** 未知の値は「未知である」と
 * そのまま出す —— **黙って既知のどれかへ寄せない**（寄せると、読む側は嘘の状態を
 * 見る。上の `sweep_stopped` を `exhausted` へ潰すのと同じ誤り）。
 *
 * **兄弟のうち送られてくる値を読む3つ（`describeRecovery` / `describeRotateOn` /
 * `describeFreshness`）も同じ形にしてある。** `describeAvailability` だけは
 * `assertNever` のままで、**それが正しい** —— あの値は送られてこない
 * （{@link tokenAvailabilityAt} がこのファイルの中で作る）。
 *
 * ## ⚠️ `not_rotated` だけは `event` からは決まらない（`freshness` も見る）
 *
 * `not_rotated` は**2つの別の事実**に付く:
 *
 * | 実際に起きたこと | `signal` | `freshness` |
 * | --- | --- | --- |
 * | 契機に当たらなかった（`off` / `org_policy` / まだ課金枠が生きている） | その印 | `current` など |
 * | **もう回した後の通知だったので捨てた** | **`reached` などの本物の印** | **`stale`** |
 *
 * **後者に「契機に当たらなかった」と書くと嘘になる** —— 契機には当たっている
 * （`signal: reached`）。捨てた理由は世代が合わないことで、まったく別物である。
 *
 * **これは実際に人間を誤らせた**（2026-09-07）。`You've hit your session limit` の
 * 行に「契機に当たらなかった。正常」と出ていたので、**その1行が嘘なのではないか**
 * と読まれた。本文（`text`）は正しく「もう回した後の通知（世代が合わない）」と
 * 書いており、**badge だけが別のことを言っていた。**
 *
 * ⟹ `freshness` を受けて言い分ける。**`event` を増やして分ける道は採らない** ——
 * あれは外向きの面（`openapi.json`）が動くうえ、`freshness` に既に在る情報である。
 */
function describeEvent(
  event: TokenRotationEntry['event'],
  freshness?: TokenRotationEntry['freshness'],
): {
  label: string;
  tone: 'ok' | 'warn' | 'neutral' | 'danger';
} {
  switch (event) {
    case 'rotated':
      return { label: '回した（撒いた。走行中のセッションには未反映）', tone: 'warn' };
    case 'exhausted':
      return { label: '候補が無い（全層が止まる）', tone: 'danger' };
    case 'sweep_stopped':
      return {
        label: '候補を試し切る前に打ち切った（まだ試していない候補が残っている）',
        tone: 'warn',
      };
    case 'not_rotated':
      // **`event` だけでは決まらない**（{@link describeEvent} の doc の表）。
      // `stale` の回は**契機に当たっている** —— 捨てた理由は世代が合わないこと
      // なので、「契機に当たらなかった」と書くと嘘になる。
      return freshness === 'stale'
        ? {
            label: '回さなかった（もう回した後の通知。契機には当たっている）',
            tone: 'neutral',
          }
        : { label: '回さなかった（契機に当たらなかった。正常）', tone: 'neutral' };
    case 'parked':
      // **`rotated` と同じ `warn` にしない。** 撒けてはいるが、**いま通る鍵は
      // 1本も無い**（`earliestAt` まで全層が止まる）。そこは `exhausted` と同じ
      // 重さなので `danger` である —— 違うのは「開いた瞬間にそのまま通る」ことで、
      // それは `label` の側で言う。
      return {
        label: 'いま通る鍵が無い（いちばん早く戻る鍵を撒いて待っている）',
        tone: 'danger',
      };
    case 'recovered':
      // **止まっていた鍵が開いた。** 良い知らせなので `ok` である。
      return { label: '止まっていた現役が、また通ることを観測できた', tone: 'ok' };
    case 'reopened':
      // **`recovered` と同じ `ok` だが、label は別である**（#833）。あちらは
      // **観測**、こちらは**時計**（記録した期限を過ぎただけで、通ることは誰も
      // 確かめていない）。**同じ文にすると、読む側は observed だと思う。**
      return {
        label: '現役の冷却が明けた（時計。通ることは観測していない）',
        tone: 'ok',
      };
    case 'restored':
      return { label: '起動時に現役を撒き直した', tone: 'neutral' };
    case 'restore_failed':
      return { label: '起動時の撒き直しに失敗', tone: 'danger' };
    default:
      // **落とさない**（`describeUnknown` の doc）。網羅性は引数の `never` が守る。
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
      // **送られてくる値である**（日誌の行の `freshness`）。⟹ 投げない。
      return describeUnknown(freshness, '観測の新しさ');
  }
}

/**
 * `event: 'recovered'` の行が持つ、**どちらの生産者が観測したか**（#681 (1)）。
 *
 * **送られてくる値である**（`describeFreshness` と同じ判定基準）。⟹ 投げない
 * ——サーバのほうが新しい窓を先に持つ。
 */
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

function RotationHistory() {
  const { data, error, isLoading } = useJournal(JOURNAL_LIMIT, ['token_rotation']);
  // **`GET /journal` の型はサーバ側の絞り込みを反映しない**（応答の形は全種別の
  // 合併型のまま）ので、`type` で狭めて使う。実際の絞り込みはサーバ側の
  // `?type=token_rotation` が行っている——ここでの filter は型を狭めるためで
  // あって、二重に絞り込んでいるのではない。
  const entries = (data?.entries ?? []).filter(
    (entry): entry is TokenRotationEntry => entry.type === 'token_rotation',
  );
  /**
   * **取れなかったのを0件と描かない**（issue #2324）。履歴をまだ一度も読めていないまま
   * 失敗したとき、失敗は下の `ErrorNote` が言う。再検証の失敗で `data` が残っている
   * ときは当たらず、履歴をそのまま出す。
   */
  const listUnavailable = data === undefined && error !== undefined;

  return (
    <Card>
      <CardHeader
        title="回転の履歴（エラー状況）"
        subtitle="トークンの切り替えの記録を新しい順に表示する。出来事は省かずに全部出す"
        action={listUnavailable ? undefined : <Badge>{entries.length}</Badge>}
      />
      <ErrorNote error={error} className="m-4" />
      {isLoading ? (
        <Spinner />
      ) : listUnavailable ? null : entries.length === 0 ? (
        <Empty>回転の記録がまだ1件も無い。</Empty>
      ) : (
        <ul>
          {entries.map((entry) => (
            <RotationRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
      {/*
        **`GET /journal` は総件数を返さないので `TruncationNote` は使えない**
        （あちらは正確な `total` が要る）。取れた件数が要求した上限と一致する
        ときだけ、「これより古い記録があるかもしれない」と明示する——黙って
        切り捨てない。
      */}
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
  // **`freshness` も渡す。** `not_rotated` は `event` だけでは言い分けられない
  // （{@link describeEvent} の doc）。
  const event = describeEvent(entry.event, entry.freshness);

  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={event.tone}>{event.label}</Badge>
        <span className="text-xs text-muted-foreground">{formatDateTime(entry.at)}</span>
        {entry.signal !== undefined && (
          <span className="text-xs text-muted-foreground">契機: {entry.signal}</span>
        )}
        {entry.freshness !== undefined && (
          <span className="text-xs text-muted-foreground">
            {describeFreshness(entry.freshness)}
          </span>
        )}
        {/*
          **`signal` とは別の欄である**（`schema.ts` の `reason` の doc）。
          `signal` は「何を見て決めたか」、こちらは「なぜこの瞬間に見たか」——
          畳むと「冷却が明けたので見直した」と「記録の上で現役が通らない」が
          同じ顔になる。

          **素の値をそのまま出す。** `signal` の隣が既にそうなっており、
          **訳語を1つ置くと、増えた値だけが訳されないまま並ぶ**（この enum は
          実際に増えている。{@link describeUnknown} の doc）。
        */}
        {entry.reason !== undefined && (
          <span className="text-xs text-muted-foreground">見直しの契機: {entry.reason}</span>
        )}
        {/*
          **`recovered` の行にだけ付く**（#681 (1)）。無い回は「観測していない」
          であって「`account_probe` だった」ではない（`schema.ts` の
          `recoveredSource` の doc。#683 の `cooldownSource` と同じ規律）。
        */}
        {entry.recoveredSource !== undefined && (
          <span className="text-xs text-muted-foreground">
            {describeRecoveredSource(entry.recoveredSource)}
          </span>
        )}
      </div>

      {/* 人間が読む1行（整形済み）。原文ではないので Markdown 扱いにはしないが、装飾もしない。 */}
      <p className="mt-1 text-sm break-words whitespace-pre-wrap">{entry.text}</p>

      <KeyValueList
        className="mt-2"
        labelWidth="8rem"
        items={[
          ...(entry.label !== undefined ? [{ label: 'ラベル', value: entry.label }] : []),
          ...(entry.tokenId !== undefined
            ? [{ label: '移った先・配った先', value: entry.tokenId, mono: true }]
            : []),
          ...(entry.fromTokenId !== undefined
            ? [{ label: '降りた側', value: entry.fromTokenId, mono: true }]
            : []),
          ...(entry.generation !== undefined ? [{ label: '世代', value: entry.generation }] : []),
          ...(entry.earliestAt !== undefined
            ? [
                // **`parked` の回はこれが「撒いた鍵が通るようになる時刻」である**
                // （`tokenRotationEntry` の doc: `exhausted` の同じ欄と意味は同じ ——
                // `parked` はまさにその候補を撒いた回だからである）。⟹ 見出しは
                // どちらでも読める言い方にしてある。
                { label: '最速の復帰見込み', value: formatDateTime(entry.earliestAt) },
              ]
            : []),
        ]}
      />

      {entry.noticeText !== undefined && (
        // **当たった文言は言い換えずそのまま。** `text` の中にも出るが、整形が
        // 変わっても原文はこちらに残る（受け入れ基準8）。
        <p className="mt-2 font-mono text-[11px] break-words whitespace-pre-wrap text-muted-foreground">
          {entry.noticeText}
        </p>
      )}
    </li>
  );
}
