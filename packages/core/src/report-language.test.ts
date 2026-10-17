import { describe, expect, it } from 'vitest';

import {
  REPORT_LANGUAGE_ENV,
  REPORT_LANGUAGE_NOTICE_INTERVAL_MS,
  ReportLanguageNotices,
  describeReportLanguage,
  describeReportLanguageNotice,
  findEnglishSentences,
  resolveEffectiveReportLanguage,
  resolveReportLanguage,
} from './report-language.js';

// 2026-10-16 #4965: 担当の報告に「Types pass.」「Binding check: revert …」のような英語の途中の文が何度も混ざった

describe('findEnglishSentences: 英語の文を拾う', () => {
  it.each([
    ['Types pass.', 'Types pass'],
    ['Now running the full test suite.', 'Now running the full test suite'],
    [
      'Binding check: revert the order temporarily and confirm the new test fails.',
      'revert the order temporarily and confirm the new test fails',
    ],
  ])('%j', (text, expected) => {
    expect(findEnglishSentences(text)).toContain(expected);
  });

  it('日本語の行の後ろに続く英語の行を拾い、日本語の行は拾わない', () => {
    const found = findEnglishSentences(
      '型は通った。\nNow running the full test suite.\n次へ進む。',
    );
    expect(found).toEqual(['Now running the full test suite']);
  });

  it('箇条書きの印の付いた英語の行も拾う', () => {
    expect(findEnglishSentences('- Then I will fix the order.')).toEqual([
      'Then I will fix the order',
    ]);
  });
});

describe('findEnglishSentences: 引っかけない', () => {
  it.each([
    // 英語のファイル名だけの行
    'packages/core/src/runner.ts',
    'README.md',
    'runner-pids-pressure.ts',
    // 型の名前・識別子だけの行
    'RunnerSession',
    'DigestSessionDelta#foldParagraphs',
    'ALTEROID_REPORT_LANGUAGE',
    // 短い札
    'OK',
    'CI: success',
    'LGTM',
    'Test Files  659 passed (659)',
    // コマンドの行
    'git push origin main',
    'pnpm exec vitest run',
    '$ git checkout -b feat/x and then run the tests',
    // 行頭が時刻のログ
    '2026-10-16T01:02:03Z run the job and check the result',
    '[12:34:56] the worker is running',
    // URL
    'https://github.com/takecchi/alteroid/pull/4964',
    // 日本語の文の中の英単語
    '`git push` した',
    'CI が green になった',
    'PR #4964 を merge した',
    'Types pass を確かめた。',
    'run the test を回した',
    // 引用の行
    '> This is a quote from the docs.',
    // インラインのコードの中の英語
    '`revert the order and run the test`',
    // エラーや道具の出力の引用（開発マネージャーの下調べで、地の文として引っかかっていた形。2026-10-16）
    'TypeError: stores.jobs.getJob is not a function',
    "AssertionError: expected 'failed' to be 'running'",
    "Error: ENOTEMPTY: directory not empty, rmdir '/tmp/x'",
    "fatal: no upstream configured for branch 'main'",
    'Test timed out in 5000ms.',
    'ELIFECYCLE Test failed. See above for more details.',
    'npm ERR! code ELIFECYCLE and the build failed',
  ])('%j', (text) => {
    expect(findEnglishSentences(text)).toEqual([]);
  });

  it('コードの塊の中の英語', () => {
    const text = [
      '直した。',
      '```ts',
      '// Run the check and fix the order.',
      'it("is a test for the runner", () => {});',
      '```',
      '以上。',
    ].join('\n');
    expect(findEnglishSentences(text)).toEqual([]);
  });

  it('閉じていないコードの塊の中の英語', () => {
    expect(findEnglishSentences('途中で切れた。\n```\nThis is the rest of it')).toEqual([]);
  });
});

describe('ALTEROID_REPORT_LANGUAGE の読み方', () => {
  it('既定は off。ja と off だけを受け、綴り違いは投げる', () => {
    expect(resolveReportLanguage({})).toBe('off');
    expect(resolveReportLanguage({ [REPORT_LANGUAGE_ENV]: ' ' })).toBe('off');
    expect(resolveReportLanguage({ [REPORT_LANGUAGE_ENV]: ' ja ' })).toBe('ja');
    expect(() => resolveReportLanguage({ [REPORT_LANGUAGE_ENV]: 'on' })).toThrow(
      'ALTEROID_REPORT_LANGUAGE の値が不正: on',
    );
  });

  it('プロファイルの値が runner の env より優先される', () => {
    const ja = { [REPORT_LANGUAGE_ENV]: 'ja' };
    const off = { [REPORT_LANGUAGE_ENV]: 'off' };
    expect(resolveEffectiveReportLanguage(ja, {})).toBe('ja');
    expect(resolveEffectiveReportLanguage(ja, off)).toBe('off');
    expect(resolveEffectiveReportLanguage({}, ja)).toBe('ja');
  });

  it('起動行は値と読んだ先を言い、不正な値でも投げない', () => {
    expect(describeReportLanguage({}, {})).toContain('報告の言語の知らせ: off（');
    expect(describeReportLanguage({}, { [REPORT_LANGUAGE_ENV]: 'ja' })).toContain(
      '実行環境プロファイルの値',
    );
    expect(describeReportLanguage({ [REPORT_LANGUAGE_ENV]: 'x' }, {})).toContain('不正な値');
  });
});

describe('ReportLanguageNotices', () => {
  it('知らせの文は例を80字までに切り、止める指示ではないと言う', () => {
    const text = describeReportLanguageNotice('x'.repeat(100));
    expect(text).toContain(`例: "${'x'.repeat(80)}…"`);
    expect(text).toContain('これは知らせで、止める指示ではない。');
  });

  it('担い手ごとに10分に1回まで。間隔の内に見つけた分は、間隔が明けても添えない', () => {
    const notices = new ReportLanguageNotices();
    expect(notices.observe('manager', ['Types pass'], 0)).toBe(true);
    expect(notices.next('manager', 1)).toContain('Types pass');
    expect(notices.next('manager', 2)).toBeNull();

    expect(notices.observe('manager', ['Now running'], 10)).toBe(false);
    expect(notices.next('manager', REPORT_LANGUAGE_NOTICE_INTERVAL_MS + 10)).toBeNull();

    expect(notices.observe('manager', ['Later one'], REPORT_LANGUAGE_NOTICE_INTERVAL_MS + 20)).toBe(
      true,
    );
    expect(notices.next('manager', REPORT_LANGUAGE_NOTICE_INTERVAL_MS + 30)).toContain('Later one');

    expect(notices.observe('agent-1', ['Other actor'], 40)).toBe(true);
    expect(notices.next('agent-1', 50)).toContain('Other actor');
  });

  it('見つからなければ何も積まない', () => {
    const notices = new ReportLanguageNotices();
    expect(notices.observe('manager', [], 0)).toBe(false);
    expect(notices.next('manager', 1)).toBeNull();
  });
});
