import type {
  AgentTokenView,
  TokenAvailability,
  TokenRecovery,
  TokenRotationEntry,
  TokenRotationSettings,
} from '@alteroid/logic';

// token-pool.ts の tokenAvailabilityAt を import せず書き写す: core の1関数のつもりでも sideEffects 未宣言でバンドラがパッケージ全体を tree-shake できず、1.2MB のチャンクを作った事故があるため
export function tokenAvailabilityAt(
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

export function describeAvailability(state: TokenAvailability): {
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
export function describeCooldownSource(source: AgentTokenView['cooldownSource']): string {
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

export function describeFingerprint(token: AgentTokenView): string {
  if (token.sha256 !== undefined) return token.sha256;
  // 「不明」ではなく想定外であることを名指しする: 実装上ここには来ないはずのため
  return '（識別用の値が無い。想定外の行）';
}

// unknown を「取れなかった」と扱わない: 実装が持つ正規の3値目のため
export function describeRecovery(recovery: TokenRecovery): string {
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

export function describeRotateOn(policy: TokenRotationSettings['rotateOn']): string {
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
export const ROTATE_ON_OPTIONS = Object.keys({
  free_exhausted: true,
  overage_exhausted: true,
  off: true,
} satisfies Record<TokenRotationSettings['rotateOn'], true>) as TokenRotationSettings['rotateOn'][];

// ここだけ assertNever を使わない: 送られてくる値でサーバのほうが新しい窓を先に持ち、throw すると1行の未知が一覧全部を消すため
// not_rotated は freshness も見て言い分ける: stale の回は契機に当たっており、「契機に当たらなかった」と書くと嘘になるため
// event を増やして分けない: 外向きの面（openapi.json）が動くうえ、freshness に既に在る情報のため
export function describeEvent(
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

export function describeFreshness(freshness: NonNullable<TokenRotationEntry['freshness']>): string {
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

export function describeRecoveredSource(
  source: NonNullable<TokenRotationEntry['recoveredSource']>,
): string {
  switch (source) {
    case 'account_probe':
      return 'セッションを使わずに、利用枠を直接確かめて観測した';
    case 'turn_success':
      return '実際の応答が成功したので観測できた（セッション単位の上限にも効く）';
    case 'trial':
      return '試しに使って通ったので観測できた（実際のターンの成功ではない）';
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

export function describeRotationSignal(signal: RotationSignal): string {
  return rotationLabel(ROTATION_SIGNAL_LABELS, signal);
}

export function describeRotationReason(reason: RotationReason): string {
  return rotationLabel(ROTATION_REASON_LABELS, reason);
}
