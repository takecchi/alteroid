import {
  categoryFromRefusalText,
  describeRefusalFailureMark,
  looksLikeSafeguardsRefusal,
  REFUSAL_AUTO_REOPEN_ENV,
} from './clone-refusal.js';
import type { RefusalAutoReopenSetting } from './clone-refusal.js';
import { describeContextWindowFailure } from './context-window-failure.js';
import type { ContextWindowFailure } from './context-window-failure.js';

/**
 * `Clone` の、失敗の報告（`#reportFailure`）と、その周りの日誌（`#noteRefusal`・`#noteHeldEscalation`・
 * `#noteUnproductiveUsageBlockFold`）の**文面と判定**。状態を読まず書かない純関数だけを置く（同期。`await` を持たない）。
 *
 * - `Clone` に残すもの: `await`・状態の読み書き・`#emit`・`#journal` / `#journalSelf` の呼び。値は呼び元が**元の評価位置で**読んで引数で渡す
 * - `EXCHANGE_KIND_*_PREFIX` の字面は呼び元（`Clone`）が `#journal` / `#journalSelf` の呼びの `text:` に直接書く:
 *   `exchange-kind-coverage.test.ts` がソースを走査して定数名を文字として探すため。ここが返すのは接頭辞の**後ろ**の本文だけ
 * - 文言は一字も変えない（`clone-failure-text-pin.test.ts` が `createClone` 越しに、`clone-failure-text.test.ts` が旧式との 1 文字比べで縛る）
 */

// `context_window_failure` の目印と生の文言を含めない: 日誌側の道具で、人間へ返す1行に持ち込まないため（`clone-turn-failure-trace.test.ts` が測る）
// 「どうすべきか」を書かない: 材料だけ渡して判断は人間とクローンに残すため
const CONTEXT_WINDOW_ALSO_NOTICE =
  '⚠️ ただし、このターンは文脈窓（プロンプトの長さ）にも当たっている。' +
  '⟹ 枠が開いても、長さが同じままなら同じところで落ちる。' +
  '待つだけでは返せない可能性がある（詳しい理由は日誌に残してある）。';

// 「会話が失われた」と書かない: 記録はストアに在って消えておらず、失われるのはクローンの文脈の連続性だけのため
const CONTEXT_WINDOW_FOLD_NOTICE =
  'この会話はここで一区切りにして、次の発言から新しく開き直す。' +
  '⚠️ それまでのやりとりは消えていない（記録は残っている）が、' +
  '私はその続きを覚えていない状態で始まるので、必要なら読み直す。';

// 抑止を名乗る: 畳まずに落ち続ける状態は外から「なぜか動かない」にしか見えず、名乗らないと「壊れている」と読まれるため
// 「どうすべきか」を書かない: 材料だけ渡して判断は人間とクローンに残すため
const CONTEXT_WINDOW_FOLD_HELD_NOTICE =
  '⚠️ このセッションは既に会話を引き継がずに開いたもので、まだ1度も答えを返せていない。' +
  '⟹ もう一度開き直しても同じ材料で同じところへ落ちるので、開き直していない。' +
  '⟹ プロンプトそのものが収まっていない可能性がある。';

// `CONTEXT_WINDOW_FOLD_NOTICE` と共通にしない: 長さで落ちたのではないのに「文脈窓」の話だと読ませないため
const UNPRODUCTIVE_USAGE_BLOCK_FOLD_NOTICE =
  'この会話はここで一区切りにして、次の発言から新しく開き直す。' +
  '⚠️ 理由は文脈窓ではなく、枠（利用上限）に当たったまま1度も答えを返せずに' +
  '再試行を繰り返しているため——同じセッションへ積み続けると、枠が開いたときには' +
  '文脈が伸びきっている。それまでのやりとりは消えていない（記録は残っている）が、' +
  '私はその続きを覚えていない状態で始まるので、必要なら読み直す。';

/**
 * **安全分類器（safeguards）による拒否か**。(a) このターンに構造の合図（`refusal` イベント）が
 * 届いていた（`structuralRefusal`。`running?.refusal` をそのまま渡す）、または (b) 失敗文に `safeguards flagged` が含まれる
 * （弱い補助の判定。`looksLikeSafeguardsRefusal`）。**失敗で終わったターンの失敗文だけを見る**——答えが返ったターンの本文は見ない。
 */
export function refusalOfFailure(input: {
  readonly structuralRefusal: { readonly category: string | null } | undefined;
  readonly rawMessage: string;
}): { category: string | null } | undefined {
  const { structuralRefusal, rawMessage } = input;
  return structuralRefusal !== undefined
    ? { category: structuralRefusal.category ?? categoryFromRefusalText(rawMessage) }
    : looksLikeSafeguardsRefusal(rawMessage)
      ? { category: categoryFromRefusalText(rawMessage) }
      : undefined;
}

/**
 * 失敗の日誌行（`[障害] ` の後ろ）。先頭（`内部ターンが失敗した:` / `人間との対話ターンが失敗した:`）は変えない:
 * `clone-turn-failure-trace.test.ts` の `text.startsWith(...)` を壊すため。目印は末尾に足す。
 */
export function describeFailureJournalLine(input: {
  /** 会話に紐づかない失敗（`conversationId === null`）。 */
  readonly internal: boolean;
  readonly message: string;
  readonly contextWindowFailure: ContextWindowFailure | undefined;
  readonly refused: { readonly category: string | null } | undefined;
}): string {
  const { internal, message, contextWindowFailure, refused } = input;
  const failureText = internal
    ? `内部ターンが失敗した: ${message}`
    : `人間との対話ターンが失敗した: ${message}`;
  return `${
    contextWindowFailure === undefined
      ? failureText
      : `${failureText}${describeContextWindowFailure(contextWindowFailure)}`
  }${refused === undefined ? '' : describeRefusalFailureMark(refused.category)}`;
}

/**
 * 人間へ返す失敗の 1 行。
 *
 * 文言の分岐は `usageBlocked`（`#usageBlocked !== null`）を見てこの1か所に置く: 呼び出し側ごとに書き分けると、経路が増えたとき「枠なのに枠と言わない」失敗が静かに混ざるため。
 * 枠と長さは同時に真になりうる: 保持は正しい（やめると閉じた枠を叩き続ける）ので、保持だけを言うと長さでも落ちる回に守れない約束になり、どちらへも倒さず両方言う。
 * ここへ ASCII の目印（`context_window_failure`）と生の文言を持ち込まない: 日誌側の道具で、`clone-turn-failure-trace.test.ts` が「人間へ返す1行」でその線を測るため。
 * 畳むかどうかは枠の有無と独立なので、3軸目として1文足すだけにする: 4マスをそれぞれ書き分けると同じ内容を4回持つため。
 */
export function describeHumanFailureLine(input: {
  /** `this.#usageBlocked !== null`（呼び元が、元の評価位置で読んで渡す）。 */
  readonly usageBlocked: boolean;
  /** 失敗が文脈窓の失敗として分類された（`contextWindowFailure !== undefined`）。 */
  readonly contextWindowFailed: boolean;
  readonly foldingForContextWindow: 'no' | 'folding' | 'held';
  readonly foldingForUnproductiveUsage: 'no' | 'folding';
}): string {
  const {
    usageBlocked,
    contextWindowFailed,
    foldingForContextWindow,
    foldingForUnproductiveUsage,
  } = input;
  return (
    (!usageBlocked
      ? 'この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。'
      : 'いま利用上限に当たっているので、この発言にはまだ返せない。' +
        '発言は捨てずに保持していて、枠が開いたら試し直して返信する。' +
        (contextWindowFailed ? CONTEXT_WINDOW_ALSO_NOTICE : '')) +
    (foldingForContextWindow === 'folding'
      ? CONTEXT_WINDOW_FOLD_NOTICE
      : foldingForContextWindow === 'held'
        ? CONTEXT_WINDOW_FOLD_HELD_NOTICE
        : foldingForUnproductiveUsage === 'folding'
          ? UNPRODUCTIVE_USAGE_BLOCK_FOLD_NOTICE
          : '')
  );
}

/**
 * 畳んだ回の日誌（`[間引き] ` の後ろ）。1件ずつ残す: 「畳んだ」だけでは何件ぶんが人間へ返らなかったかを後から数えられないため。
 */
export function describeThinnedHumanFailure(folded: number, humanText: string): string {
  return (
    `人間へ返す1行は畳んだ（最後に返した1行から数えて ${folded} 件目）。同じ1行を` +
    `既に返してあり、そのあと人間からの新しい発言は届いていない: ${humanText}`
  );
}

/** `#noteHeldEscalation` の日誌（`[判断] ` の後ろ）。 */
export function describeHeldEscalationJournal(streak: number): string {
  return (
    '会話を引き継がずに開いたこのセッションは、1度も答えを返せないまま、' +
    '1回目の長さの失敗では開き直さずに持ちこたえた（held）が、別の入力でもう一度同じ長さで落ちた。' +
    '⟹ 拒まれた入力がセッションに残って送り直されている可能性があるので、ここで畳んで新しい' +
    `セッションで開き直す（issue #955。答えを返せないままの畳み直しは連続 ${String(streak)} 回目）。` +
    (streak >= 2
      ? ' ⚠ 開き直した新しいセッションも、1度も答えないまま同じ形で落ちている。' +
        'システムプロンプトや記憶の焼き込みそのものが文脈窓に収まっていない可能性がある' +
        '（held と畳み直しの交互）。'
      : '')
  );
}

/** `#noteRefusal` の「自動で開き直したセッションが弾かれた」日誌（`[判断] ` の後ろ）。 */
export function describeRefusalHaltedJournal(input: {
  readonly label: string;
  readonly sessionId: string | null;
}): string {
  const { label, sessionId } = input;
  return (
    '自動で開き直したセッションが、1度も答えを返さないまま安全分類器に弾かれた' +
    `（category: ${label}、session id: ${sessionId ?? '不明'}）。⟹ 自動の開き直しはもうしない` +
    '（記憶の焼き込みや届き続ける合図そのものが弾かれている可能性。ターンは回り続ける。' +
    '解けるのは、このセッションが1度答えたとき、または人間が手動で開き直したとき）。'
  );
}

/** `#noteRefusal` の「別の入力で続けて弾かれた」日誌（`[判断] ` の後ろ）。 */
export function describeRefusalStreakJournal(input: {
  readonly streak: number;
  readonly label: string;
  readonly sessionId: string | null;
  readonly setting: RefusalAutoReopenSetting;
}): string {
  const { streak, label, sessionId, setting } = input;
  return (
    `別の入力で ${String(streak)} 回続けて安全分類器に弾かれた` +
    `（category: ${label}、session id: ${sessionId ?? '不明'}）。⟹ セッションごと弾かれていると見る。` +
    (setting.enabled
      ? '自動の開き直しが有効なので、開き直す。'
      : '自動の開き直しは外してあるので、開き直さない（人間へ知らせる）。') +
    (setting.unrecognized === undefined
      ? ''
      : ` ⚠ ${REFUSAL_AUTO_REOPEN_ENV} の値「${setting.unrecognized}」は読めないので有効にした。`)
  );
}

/** `#noteUnproductiveUsageBlockFold` の日誌（`[判断] ` の後ろ）。 */
export function describeUnproductiveUsageBlockFoldJournal(input: {
  readonly accumulatedChars: number;
  readonly thresholdChars: number;
}): string {
  const { accumulatedChars, thresholdChars } = input;
  return (
    '枠に当たったまま1度も答えを返せないうちに、積んだ入力が ' +
    `${String(accumulatedChars)} 文字（閾値 ` +
    `${String(thresholdChars)}）に達した。同じ` +
    'セッションへ積み続けると枠が開いた頃には文脈が伸びきっているので、' +
    'ここでセッションを畳んで作り直す（Issue #1240）。'
  );
}
