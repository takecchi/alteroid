import { Page } from '~/components/page';
import { Badge, Card, CardHeader, Empty, ErrorNote, Spinner } from '~/components/ui';
import { useJournal, useTokens } from '~/hooks/queries';
import { ApiError } from '~/lib/api';
import { formatDateTime, formatRelative } from '~/lib/format';
import type {
  AgentTokenView,
  TokenAvailability,
  TokenRecovery,
  TokenRotationEntry,
  TokenRotationSettings,
} from '~/lib/types';

/**
 * `/tokens` — 認証トークンのプール一覧・回転の設定・回転の履歴（エラー状況）。
 *
 * **読み取り専用。** 登録・無効化は CLI（`alteroid token add` / `disable` /
 * `enable` / `policy`）と `PUT /tokens` の仕事であって、この画面の仕事ではない
 * （Issue #464「Web UI にプールの画面が1つも無い」を埋める分）。経路は
 * `GET /tokens` と `GET /journal?type=token_rotation` の2本だけで、どちらも
 * 既に在るものを読むだけ——ここで新しい API 経路は足していない。
 *
 * **値（`value`）はどこにも出さない。** サーバ側の型（`AgentTokenView`）が
 * そもそも `value` を持たないので、この画面が「消し忘れて出す」形は作れない。
 * 出してよいのは id / label / 指紋（`sha256`、salt 無し sha256 の先頭12hex）/
 * 状態 / 時刻 / 断られた・失効した理由の文言までである
 * （`.claude/skills/token-pool/SKILL.md`）。
 */
export default function Tokens() {
  return (
    <Page
      title="認証トークン"
      description="プールの一覧・回転の設定・回転の履歴（エラー状況）。読み取り専用 — 登録や無効化は alteroid token コマンド、または PUT /tokens で行う"
    >
      <div className="flex flex-col gap-4">
        <PoolAndSettings />
        <RotationHistory />
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// プール一覧・回転の設定（GET /tokens）
// ---------------------------------------------------------------------------

function PoolAndSettings() {
  const { data, error, isLoading } = useTokens();

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
        <div className="px-4 py-3 text-sm text-muted">
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
          <PoolCard tokens={data.tokens} />
          <SettingsCard settings={data.settings} />
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
 * 1.2MB のチャンクを作った事故がある（`apps/web/app/lib/format.ts` の
 * `assertNeverCreatedAt` の doc）。だから実体の関数は呼ばず、4行のロジックを
 * ここに複製する。**判定順（`disabled` > `invalidated` > `cooling` > `ready`）
 * を崩さないこと。**
 */
function tokenAvailabilityAt(
  token: Pick<AgentTokenView, 'disabledAt' | 'invalidatedAt' | 'cooldownUntil'>,
  // **既定引数として `Date.now()` を持つ**（呼び出し側の render 本体で直接
  // 呼ばない）。`~/lib/format.ts` の `formatRelative(iso, now = Date.now())`
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
 * （`parked`）と8値目（`recovered`）が足された。**固定に見える数え上げでも増える。**
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
      return '記録が無い（この期限が権威ある値かどうかは言えない）';
    case 'quota_reset':
      return '枠の resetsAt（権威ある値）';
    case 'overage_reset':
      return '課金枠の overageResetsAt（権威ある値。枠そのものではない）';
    case 'notice_text':
      return '上限の文言に書かれていた時刻（推測。ただし既定よりは良い）';
    case 'default':
      return '設定の既定（ただの推測である）';
    default:
      return describeUnknown(source, '冷却の期限の出所');
  }
}

/**
 * 指紋の欄。**「不明」で埋めない** —— `source: 'env'` の行はそもそも指紋を
 * 持たない（値を持たないので）。「取れなかった」ではなく「そもそも無い」と
 * 名指しする。
 */
function describeFingerprint(token: AgentTokenView): string {
  if (token.source === 'env') return '（環境変数由来のため指紋は無い）';
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
      return '分類: どちらとも言えない（time でも action でもない。捨てる判断の根拠にしないこと）';
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

function PoolCard({ tokens }: { tokens: readonly AgentTokenView[] }) {
  const sorted = [...tokens].sort((a, b) => a.order - b.order);

  return (
    <Card>
      <CardHeader
        title="プール一覧"
        subtitle="alteroid token list / GET /tokens と同じもの。値は出ない"
        action={<Badge>{sorted.length}</Badge>}
      />
      {sorted.length === 0 ? (
        // **プールが空の構成は正常でありうる**（`.claude/skills/token-pool/SKILL.md`
        // 「何は変わらないか」）。「まだ取れていない」との混同を避けるため、
        // 正常な既定構成でもありうると添える。
        <Empty>
          登録された認証トークンがまだ1件も無い。（器の環境変数1本だけの既定構成でも、これは正常）
        </Empty>
      ) : (
        <ul>
          {sorted.map((token) => (
            <TokenRow key={token.id} token={token} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function TokenRow({ token }: { token: AgentTokenView }) {
  const availability = tokenAvailabilityAt(token);
  const state = describeAvailability(availability);
  const rejected = token.lastRejectedAt !== undefined || token.lastRejectedReason !== undefined;

  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium break-all">{token.label}</span>
        <Badge tone={state.tone}>{state.label}</Badge>
        <span className="text-xs text-muted">order {token.order}</span>
      </div>

      <dl className="mt-2 grid grid-cols-1 gap-y-1 text-xs sm:grid-cols-[9rem_1fr]">
        <dt className="text-muted">指紋</dt>
        <dd className="font-mono break-all">{describeFingerprint(token)}</dd>

        <dt className="mt-2 text-muted sm:mt-0">作成</dt>
        <dd>
          {token.createdAt === undefined
            ? '不明（先行バージョンで作られた行のため記録が無い。「いま作られた」とは埋めない）'
            : formatDateTime(token.createdAt)}
        </dd>

        <dt className="mt-2 text-muted sm:mt-0">最終更新</dt>
        <dd>
          {token.updatedAt === undefined
            ? '不明（この行が実際に変わったことは無い）'
            : formatDateTime(token.updatedAt)}
        </dd>

        {token.disabledAt !== undefined && (
          <>
            <dt className="mt-2 text-muted sm:mt-0">無効化</dt>
            <dd>{formatDateTime(token.disabledAt)}（人間が明示的に外した。戻らない）</dd>
          </>
        )}

        {token.invalidatedAt !== undefined && (
          <>
            <dt className="mt-2 text-muted sm:mt-0">失効</dt>
            <dd>{formatDateTime(token.invalidatedAt)}</dd>
            <dt className="mt-2 text-muted sm:mt-0">失効の理由（原文）</dt>
            <dd className="font-mono text-[11px] break-words whitespace-pre-wrap">
              {token.invalidatedReason ?? '（理由の記録が無い）'}
            </dd>
          </>
        )}

        {token.cooldownUntil !== undefined && (
          <>
            {/*
              **冷却は絶対時刻を必ず出す。** 実測で「冷却が5時間なのに断られた
              理由の原文は『weekly limit resets 5pm』と言っていた」という桁の
              食い違いが観測されている——相対表現（「あと◯時間」）だけでは
              この食い違いに気づけない。絶対時刻を主に、相対は括弧で添えるだけ
              にする。
            */}
            <dt className="mt-2 text-muted sm:mt-0">冷却の期限</dt>
            <dd>
              {formatEpochMs(token.cooldownUntil)}（{formatEpochMsRelative(token.cooldownUntil)}）
            </dd>
            {/*
              **出所を必ず出す（#683）。** 絶対時刻を出しても、**それが権威ある
              値なのか5時間足しただけの推測なのかは書けていなかった** ——
              #678 の調査は「文言が 22:10 と言っているのに 01:42 と出ている」を
              人間が目で見つけたところから始まった。行が出所を持てば、その1行で
              終わる。

              **「推測のときだけ出す」形にしないこと。** 権威ある値のときも
              出さないと、**何も書いていないことが「推測ではない」と「まだ
              対応していない」の両方を意味する**（`AGENTS.md` の地雷
              「取れない軸に 0 の行を作る」の裏返し）。
            */}
            <dt className="mt-2 text-muted sm:mt-0">期限の出所</dt>
            <dd>{describeCooldownSource(token.cooldownSource)}</dd>
          </>
        )}

        <dt className="mt-2 text-muted sm:mt-0">断られた記録</dt>
        <dd>
          {!rejected ? (
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
                <span className="text-muted">{describeRecovery(token.recovery)}</span>
              )}
            </div>
          )}
        </dd>
      </dl>
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

function SettingsCard({ settings }: { settings: TokenRotationSettings }) {
  return (
    <Card>
      <CardHeader
        title="回転の設定"
        subtitle="alteroid token policy / PUT /tokens/policy と同じもの。ここは読み取りだけ"
      />
      <dl className="grid grid-cols-1 gap-y-1 px-4 py-3 text-sm sm:grid-cols-[9rem_1fr]">
        <dt className="text-muted">回す契機</dt>
        <dd>{describeRotateOn(settings.rotateOn)}</dd>

        <dt className="mt-2 text-muted sm:mt-0">冷却の既定</dt>
        <dd>
          {(settings.cooldownMs / (60 * 60 * 1000)).toLocaleString('ja-JP', {
            maximumFractionDigits: 2,
          })}
          時間（{settings.cooldownMs.toLocaleString('en-US')} ミリ秒）。
          <br />
          <span className="text-xs text-muted">
            `resetsAt` が取れなかったときだけ使うフォールバック。権威ある期限は行ごとの
            「冷却の期限」のほう。
          </span>
        </dd>

        {settings.updatedAt !== undefined && (
          <>
            <dt className="mt-2 text-muted sm:mt-0">最終変更</dt>
            <dd>{formatDateTime(settings.updatedAt)}</dd>
          </>
        )}
      </dl>
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
      // **止まっていた鍵が開いた。** 良い知らせなので `ok` である（他にここへ
      // 来る `event` は無い）。
      return { label: '止まっていた現役が、また通ることを観測できた', tone: 'ok' };
    case 'restored':
      return { label: '起動時に現役を撒き直した', tone: 'neutral' };
    case 'restore_failed':
      return { label: '起動時の撒き直しに失敗', tone: 'danger' };
    default:
      // **落とさない**（`describeUnknown` の doc）。網羅性は引数の `never` が守る。
      return { label: describeUnknown(event, '回転の event'), tone: 'neutral' };
  }
}

function describeFreshness(freshness: NonNullable<TokenRotationEntry['freshness']>): string {
  switch (freshness) {
    case 'current':
      return '現在の観測';
    case 'stale':
      return '古い観測';
    case 'unknown':
      return '不明（身元を運べない検知点由来。stale とは別の意味）';
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
      return 'セッションを使わない枠の probe が観測した';
    case 'turn_success':
      return 'ターンが実際に成功したので観測できた（session limit にも効く）';
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

  return (
    <Card>
      <CardHeader
        title="回転の履歴（エラー状況）"
        subtitle="日誌の token_rotation を新しい順で表示。event は潰さない"
        action={<Badge>{entries.length}</Badge>}
      />
      <ErrorNote error={error} className="m-4" />
      {isLoading ? (
        <Spinner />
      ) : entries.length === 0 ? (
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
        <p className="border-t border-border px-4 py-2 text-[11px] text-muted">
          直近 {JOURNAL_LIMIT} 件のみ表示している。これより古い記録は日誌の画面（種別:
          token_rotation で絞り込み）で確認する。
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
        <span className="text-xs text-muted">{formatDateTime(entry.at)}</span>
        {entry.signal !== undefined && (
          <span className="text-xs text-muted">契機: {entry.signal}</span>
        )}
        {entry.freshness !== undefined && (
          <span className="text-xs text-muted">{describeFreshness(entry.freshness)}</span>
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
          <span className="text-xs text-muted">見直しの契機: {entry.reason}</span>
        )}
        {/*
          **`recovered` の行にだけ付く**（#681 (1)）。無い回は「観測していない」
          であって「`account_probe` だった」ではない（`schema.ts` の
          `recoveredSource` の doc。#683 の `cooldownSource` と同じ規律）。
        */}
        {entry.recoveredSource !== undefined && (
          <span className="text-xs text-muted">
            {describeRecoveredSource(entry.recoveredSource)}
          </span>
        )}
      </div>

      {/* 人間が読む1行（整形済み）。原文ではないので Markdown 扱いにはしないが、装飾もしない。 */}
      <p className="mt-1 text-sm break-words whitespace-pre-wrap">{entry.text}</p>

      <dl className="mt-2 grid grid-cols-1 gap-y-1 text-xs sm:grid-cols-[8rem_1fr]">
        {entry.label !== undefined && (
          <>
            <dt className="text-muted">ラベル</dt>
            <dd>{entry.label}</dd>
          </>
        )}
        {entry.tokenId !== undefined && (
          <>
            <dt className="mt-2 text-muted sm:mt-0">移った先/撒いた先 id</dt>
            <dd className="font-mono break-all">{entry.tokenId}</dd>
          </>
        )}
        {entry.fromTokenId !== undefined && (
          <>
            <dt className="mt-2 text-muted sm:mt-0">降りた側 id</dt>
            <dd className="font-mono break-all">{entry.fromTokenId}</dd>
          </>
        )}
        {entry.generation !== undefined && (
          <>
            <dt className="mt-2 text-muted sm:mt-0">世代</dt>
            <dd>{entry.generation}</dd>
          </>
        )}
        {entry.earliestAt !== undefined && (
          <>
            {/*
              **`parked` の回はこれが「撒いた鍵が通るようになる時刻」である**
              （`tokenRotationEntry` の doc: `exhausted` の同じ欄と意味は同じ ——
              `parked` はまさにその候補を撒いた回だからである）。⟹ 見出しは
              どちらでも読める言い方にしてある。
            */}
            <dt className="mt-2 text-muted sm:mt-0">最速の復帰見込み</dt>
            <dd>{formatDateTime(entry.earliestAt)}</dd>
          </>
        )}
      </dl>

      {entry.noticeText !== undefined && (
        // **当たった文言は言い換えずそのまま。** `text` の中にも出るが、整形が
        // 変わっても原文はこちらに残る（受け入れ基準8）。
        <p className="mt-2 font-mono text-[11px] break-words whitespace-pre-wrap text-muted">
          {entry.noticeText}
        </p>
      )}
    </li>
  );
}
