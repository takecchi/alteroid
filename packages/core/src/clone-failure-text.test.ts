import { describe, expect, it } from 'vitest';

import {
  describeFailureJournalLine,
  describeHeldEscalationJournal,
  describeHumanFailureLine,
  describeRefusalHaltedJournal,
  describeRefusalStreakJournal,
  describeThinnedHumanFailure,
  describeUnproductiveUsageBlockFoldJournal,
  refusalOfFailure,
} from './clone-failure-text.js';
import {
  categoryFromRefusalText,
  describeRefusalFailureMark,
  looksLikeSafeguardsRefusal,
  REFUSAL_AUTO_REOPEN_ENV,
} from './clone-refusal.js';
import {
  classifyContextWindowFailure,
  describeContextWindowFailure,
} from './context-window-failure.js';
import type { ContextWindowFailure } from './context-window-failure.js';

// 純関数へ移した本文を、移す前の `clone.ts` の式（逐語。`this.#...` を引数へ置き換えただけ）と 1 文字ずつ比べる。
// 「移し替えで 1 文字も変えていない」ことの歯であって、文面の正しさの保証ではない。
// 下の `old*` は、切り出し前の `Clone#reportFailure`・`#noteRefusal`・`#noteHeldEscalation`・`#noteUnproductiveUsageBlockFold` の式の写しである（接頭辞は呼び元に残るので含めない）。

// --- 旧式の写し（切り出し前の clone.ts の定数・式） ---

const OLD_CONTEXT_WINDOW_ALSO_NOTICE =
  '⚠️ ただし、このターンは文脈窓（プロンプトの長さ）にも当たっている。' +
  '⟹ 枠が開いても、長さが同じままなら同じところで落ちる。' +
  '待つだけでは返せない可能性がある（詳しい理由は日誌に残してある）。';

const OLD_CONTEXT_WINDOW_FOLD_NOTICE =
  'この会話はここで一区切りにして、次の発言から新しく開き直す。' +
  '⚠️ それまでのやりとりは消えていない（記録は残っている）が、' +
  '私はその続きを覚えていない状態で始まるので、必要なら読み直す。';

const OLD_CONTEXT_WINDOW_FOLD_HELD_NOTICE =
  '⚠️ このセッションは既に会話を引き継がずに開いたもので、まだ1度も答えを返せていない。' +
  '⟹ もう一度開き直しても同じ材料で同じところへ落ちるので、開き直していない。' +
  '⟹ プロンプトそのものが収まっていない可能性がある。';

const OLD_UNPRODUCTIVE_USAGE_BLOCK_FOLD_NOTICE =
  'この会話はここで一区切りにして、次の発言から新しく開き直す。' +
  '⚠️ 理由は文脈窓ではなく、枠（利用上限）に当たったまま1度も答えを返せずに' +
  '再試行を繰り返しているため——同じセッションへ積み続けると、枠が開いたときには' +
  '文脈が伸びきっている。それまでのやりとりは消えていない（記録は残っている）が、' +
  '私はその続きを覚えていない状態で始まるので、必要なら読み直す。';

function oldHumanText(
  usageBlocked: boolean,
  contextWindowFailure: ContextWindowFailure | undefined,
  foldingForContextWindow: 'no' | 'folding' | 'held',
  foldingForUnproductiveUsage: 'no' | 'folding',
): string {
  // `this.#usageBlocked === null` は `!usageBlocked`
  return (
    (!usageBlocked
      ? 'この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。'
      : 'いま利用上限に当たっているので、この発言にはまだ返せない。' +
        '発言は捨てずに保持していて、枠が開いたら試し直して返信する。' +
        (contextWindowFailure === undefined ? '' : OLD_CONTEXT_WINDOW_ALSO_NOTICE)) +
    (foldingForContextWindow === 'folding'
      ? OLD_CONTEXT_WINDOW_FOLD_NOTICE
      : foldingForContextWindow === 'held'
        ? OLD_CONTEXT_WINDOW_FOLD_HELD_NOTICE
        : foldingForUnproductiveUsage === 'folding'
          ? OLD_UNPRODUCTIVE_USAGE_BLOCK_FOLD_NOTICE
          : '')
  );
}

function oldRefused(
  runningRefusal: { category: string | null } | undefined,
  rawMessage: string,
): { category: string | null } | undefined {
  return runningRefusal !== undefined
    ? { category: runningRefusal.category ?? categoryFromRefusalText(rawMessage) }
    : looksLikeSafeguardsRefusal(rawMessage)
      ? { category: categoryFromRefusalText(rawMessage) }
      : undefined;
}

function oldFailureJournalText(
  conversationId: string | null,
  message: string,
  contextWindowFailure: ContextWindowFailure | undefined,
  refused: { category: string | null } | undefined,
): string {
  const failureText =
    conversationId === null
      ? `内部ターンが失敗した: ${message}`
      : `人間との対話ターンが失敗した: ${message}`;
  return `${
    contextWindowFailure === undefined
      ? failureText
      : `${failureText}${describeContextWindowFailure(contextWindowFailure)}`
  }${refused === undefined ? '' : describeRefusalFailureMark(refused.category)}`;
}

function oldThinnedText(folded: number, humanText: string): string {
  return (
    `人間へ返す1行は畳んだ（最後に返した1行から数えて ${folded} 件目）。同じ1行を` +
    `既に返してあり、そのあと人間からの新しい発言は届いていない: ${humanText}`
  );
}

function oldHeldEscalationText(streak: number): string {
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

function oldRefusalHaltedText(label: string, sessionId: string | null): string {
  return (
    '自動で開き直したセッションが、1度も答えを返さないまま安全分類器に弾かれた' +
    `（category: ${label}、session id: ${sessionId ?? '不明'}）。⟹ 自動の開き直しはもうしない` +
    '（記憶の焼き込みや届き続ける合図そのものが弾かれている可能性。ターンは回り続ける。' +
    '解けるのは、このセッションが1度答えたとき、または人間が手動で開き直したとき）。'
  );
}

function oldRefusalStreakText(
  streak: number,
  label: string,
  sessionId: string | null,
  setting: { enabled: boolean; unrecognized?: string },
): string {
  return (
    `別の入力で ${String(streak)} 回続けて安全分類器に弾かれた` +
    `（category: ${label}、session id: ${sessionId ?? '不明'}）。⟹ セッションごと弾かれていると見る。` +
    (setting.enabled
      ? '自動の開き直しが有効なので、開き直す。'
      : '自動の開き直しは外してあるので、開き直さない（人間へ知らせる）。') +
    (setting.unrecognized === undefined
      ? ''
      : ` ⚠ ${REFUSAL_AUTO_REOPEN_ENV} の値「${setting.unrecognized}」は読めないので有効として扱った。`)
  );
}

function oldUnproductiveFoldText(accumulatedChars: number, threshold: number): string {
  return (
    '枠に当たったまま1度も答えを返せないうちに、積んだ入力が ' +
    `${String(accumulatedChars)} 文字（閾値 ` +
    `${String(threshold)}）に達した。同じ` +
    'セッションへ積み続けると枠が開いた頃には文脈が伸びきっているので、' +
    'ここでセッションを畳んで作り直す（Issue #1240）。'
  );
}

// --- 比べる ---

const CONTEXT_WINDOW = classifyContextWindowFailure('Prompt is too long');

describe('旧式との 1 文字比べ', () => {
  it('前提: 文脈窓の失敗として分類される入力を使っている（比べる枝が「無し」に偏らない）', () => {
    expect(CONTEXT_WINDOW).toBeDefined();
  });

  it('人間へ返す失敗の 1 行: 枠 × 文脈窓 × 畳み（文脈窓）× 畳み（枠）の全 24 通り', () => {
    let compared = 0;
    for (const usageBlocked of [false, true]) {
      for (const contextWindowFailure of [undefined, CONTEXT_WINDOW]) {
        for (const foldingForContextWindow of ['no', 'folding', 'held'] as const) {
          for (const foldingForUnproductiveUsage of ['no', 'folding'] as const) {
            expect(
              describeHumanFailureLine({
                usageBlocked,
                contextWindowFailed: contextWindowFailure !== undefined,
                foldingForContextWindow,
                foldingForUnproductiveUsage,
              }),
            ).toBe(
              oldHumanText(
                usageBlocked,
                contextWindowFailure,
                foldingForContextWindow,
                foldingForUnproductiveUsage,
              ),
            );
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(24);
  });

  it('拒否の判定: 構造の合図（無し・category あり・category null）× 失敗文（4 通り）', () => {
    const raws = [
      '',
      'something broke',
      'safeguards flagged this session',
      'SAFEGUARDS FLAGGED this session. Details: [bio]',
      'something broke. Details: [cyber]',
    ];
    for (const structuralRefusal of [undefined, { category: 'cyber' }, { category: null }]) {
      for (const rawMessage of raws) {
        expect(refusalOfFailure({ structuralRefusal, rawMessage })).toEqual(
          oldRefused(structuralRefusal, rawMessage),
        );
      }
    }
  });

  it('失敗の日誌行: 会話の有無 × 文脈窓の有無 × 拒否（無し・不明・cyber）', () => {
    for (const conversationId of [null, 'conv-1']) {
      for (const contextWindowFailure of [undefined, CONTEXT_WINDOW]) {
        for (const refused of [undefined, { category: null }, { category: 'cyber' }]) {
          expect(
            describeFailureJournalLine({
              internal: conversationId === null,
              message: '結果なしで終了: x（result_subtype） / boom',
              contextWindowFailure,
              refused,
            }),
          ).toBe(
            oldFailureJournalText(
              conversationId,
              '結果なしで終了: x（result_subtype） / boom',
              contextWindowFailure,
              refused,
            ),
          );
        }
      }
    }
  });

  it('畳んだ回の日誌: 何件目か 3 通り', () => {
    for (const folded of [1, 2, 10]) {
      expect(describeThinnedHumanFailure(folded, '本文（本文）')).toBe(
        oldThinnedText(folded, '本文（本文）'),
      );
    }
  });

  it('畳み直しの日誌: 連続 1・2・3 回目（2 回目から注意が付く）', () => {
    for (const streak of [1, 2, 3]) {
      expect(describeHeldEscalationJournal(streak)).toBe(oldHeldEscalationText(streak));
    }
  });

  it('拒否の日誌（止めた）: label × session id（無し）', () => {
    for (const label of ['cyber', '不明']) {
      for (const sessionId of ['sess-1', null]) {
        expect(describeRefusalHaltedJournal({ label, sessionId })).toBe(
          oldRefusalHaltedText(label, sessionId),
        );
      }
    }
  });

  it('拒否の日誌（続けて弾かれた）: streak × label × session id × 設定の 4 形', () => {
    const settings = [
      { enabled: true },
      { enabled: false },
      { enabled: true, unrecognized: 'maybe' },
      { enabled: false, unrecognized: 'x' },
    ];
    for (const streak of [2, 3]) {
      for (const label of ['cyber', '不明']) {
        for (const sessionId of ['sess-1', null]) {
          for (const setting of settings) {
            expect(describeRefusalStreakJournal({ streak, label, sessionId, setting })).toBe(
              oldRefusalStreakText(streak, label, sessionId, setting),
            );
          }
        }
      }
    }
  });

  it('枠に当たり続けた畳みの日誌: 積んだ文字数と閾値', () => {
    for (const accumulatedChars of [200_000, 275_340]) {
      expect(
        describeUnproductiveUsageBlockFoldJournal({
          accumulatedChars,
          thresholdChars: 200_000,
        }),
      ).toBe(oldUnproductiveFoldText(accumulatedChars, 200_000));
    }
  });
});
