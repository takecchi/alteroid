import { describe, expect, it } from 'vitest';

import {
  classifyContextWindowFailure,
  describeContextWindowFailure,
} from './context-window-failure.js';

describe('文脈窓（コンテキストウィンドウ）超過の文言を分類する', () => {
  // 根拠: `context-window-failure.ts` の doc に実測コマンドと出力が逐語である
  // （Claude Code CLI バイナリ自身が使っている判定文言）。

  it('プロンプト自体が長すぎる回を拾う（実測: CLI の `c()` が使う文言）', () => {
    const real = 'prompt is too long: 220000 tokens > 200000 maximum';
    const failure = classifyContextWindowFailure(real);
    expect(failure).toEqual({ kind: 'prompt_too_long', text: real });
  });

  it('別リージョン系の言い回しも同じ種別で拾う（実測: CLI の `c()` のもう一方の分岐）', () => {
    const real = 'input is too long for requested model';
    expect(classifyContextWindowFailure(real)?.kind).toBe('prompt_too_long');
  });

  it('入力 + max_tokens の合計超過を拾う（実測: CLI の `h()` が使う文言）', () => {
    const real = 'input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000';
    const failure = classifyContextWindowFailure(real);
    expect(failure).toEqual({ kind: 'max_tokens_context_overflow', text: real });
  });

  it('生成の途中で文脈窓に当たった回を拾う（実測: `stop_reason` が `model_context_window_exceeded` のときの assistant content）', () => {
    const real = 'Error: The model has reached its context window limit.';
    const failure = classifyContextWindowFailure(real);
    expect(failure).toEqual({ kind: 'model_context_window_exceeded', text: real });
  });

  it('大文字小文字を区別しない（CLI 自身が `toLowerCase()` してから比較している）', () => {
    expect(classifyContextWindowFailure('PROMPT IS TOO LONG: 1 > 0')?.kind).toBe('prompt_too_long');
  });

  describe('紛らわしいが別の失敗は拾わない（対照）', () => {
    it('利用上限（枠）', () => {
      expect(
        classifyContextWindowFailure("You've hit your individual spend limit"),
      ).toBeUndefined();
    });

    it('ネットワーク断', () => {
      expect(
        classifyContextWindowFailure(
          "fatal: unable to access '...': getaddrinfo() thread failed to start",
        ),
      ).toBeUndefined();
    });

    it('認証失敗', () => {
      expect(
        classifyContextWindowFailure('authentication_failed: invalid api key'),
      ).toBeUndefined();
    });

    it('出力トークンの上限超過（文脈窓とは別の失敗）', () => {
      // SDKAssistantMessageError の `max_output_tokens` はここでは拾わない
      // ——実際の出力上限超過の文言はここでの既知パターンに一致しない。
      expect(
        classifyContextWindowFailure(
          'exceeded the 8192 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.',
        ),
      ).toBeUndefined();
    });

    it('「文脈窓」という語だけを含む地の文（CLIのゆるい判定 `g()` はここでは採らない）', () => {
      // CLI 自身は `"context window"` の部分一致だけの判定（`g()`）も持つが、
      // 誤検知が広いのでこちらでは採用していない（doc 参照）。
      expect(
        classifyContextWindowFailure('人間との雑談で「文脈窓」や context window の話題が出ただけ'),
      ).toBeUndefined();
    });

    it('空文字・空白', () => {
      expect(classifyContextWindowFailure('')).toBeUndefined();
      expect(classifyContextWindowFailure('   ')).toBeUndefined();
    });
  });

  it('文言はそのまま持つ（言い換えない）', () => {
    const real = 'prompt is too long: 999999 tokens > 200000 maximum';
    const failure = classifyContextWindowFailure(real)!;
    expect(failure.text).toBe(real);
  });
});

describe('describeContextWindowFailure', () => {
  it('ASCII の検索語（journal_read の q= で引ける語）を含む', () => {
    const text = describeContextWindowFailure({
      kind: 'prompt_too_long',
      text: 'prompt is too long: 1 > 0',
    });
    expect(text).toContain('context_window_failure');
    expect(text).toContain('prompt_too_long');
  });

  it('弱さ（型合わせであって契約ではない）を1文で書く', () => {
    const text = describeContextWindowFailure({
      kind: 'max_tokens_context_overflow',
      text: 'input length and `max_tokens` exceed context limit: 1 + 1 > 1',
    });
    expect(text).toContain('契約ではない');
    // 「該当しなかった失敗が文脈窓ではない」と読めてしまわないよう、
    // 目印の不在が否定を意味しないことも書く。
    expect(text).toContain('とも限らない');
  });
});
