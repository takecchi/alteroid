import { describe, expect, it } from 'vitest';
import {
  renderRestoredNotice,
  RESUMED_WITHOUT_LOG_CLAUSE,
  type RestoredListItem,
} from './restored-notice.js';

function item(overrides: Partial<RestoredListItem>): RestoredListItem {
  return {
    managerId: 'mgr-a',
    runnerId: 'runner-1',
    how: 'resumed',
    cwd: '/work/mgr-a',
    excerpt: undefined,
    workspaceLine: '',
    first: false,
    status: 'running',
    ...overrides,
  };
}

function lineOf(text: string, id: string): string {
  return text.split('\n').find((line) => line.startsWith(`- ${id}:`)) ?? '';
}

// 2026-10-11 の反映の後、resume を受理しただけの委譲を「再開させた・running（セッションは生きている）」と知らせ、
// その後 12 本のほぼ全部が「SDK に会話が残っていない」で lost になった（#4501）。
describe('取り戻した知らせの一覧は、resume の受理を「戻れた」と言わない（#4501）', () => {
  it('resumed で running の行は「再開を指示した・未確認」と言い、「セッションは生きている」と言わない', () => {
    const text = renderRestoredNotice('runner の器が作り直された', [item({})]);
    const line = lineOf(text, 'mgr-a');
    expect(line).toContain(
      '前のセッションからの再開を指示した（resume は受理された。会話が戻ったかは未確認）',
    );
    expect(line).toContain('状態 running（resume を受理しただけ。会話が戻ったかは未確認）');
    expect(text).not.toContain('セッションは生きている');
    expect(text).not.toContain('再開させた');
    expect(text).toContain(
      '戻れなければ、この後に担当ごとの知らせが別に届き、状態は lost になる。',
    );
    // 失敗の知らせを見分ける語を、受理の知らせに混ぜない。
    expect(text).not.toContain('戻せなかった');
  });

  it('resumed でも配る時点で lost なら、lost と言う', () => {
    const text = renderRestoredNotice('runner の器が作り直された', [item({ status: 'lost' })]);
    expect(lineOf(text, 'mgr-a')).toContain('状態 lost（セッションは失われた）');
  });

  it('attached で running の行は、これまでどおり「セッションは生きている」と言う（陽性対照）', () => {
    const text = renderRestoredNotice('runner の器が作り直された', [
      item({ managerId: 'mgr-b', how: 'attached' }),
    ]);
    const line = lineOf(text, 'mgr-b');
    expect(line).toContain('走り続けている（attached）');
    expect(line).toContain('状態 running（セッションは生きている）');
    expect(text).not.toContain('再開を指示した委譲:');
  });

  it('生ログ無しで出した resume は、その行に「戻れない見込みが高い」を添える。配る時点で lost なら添えない', () => {
    const text = renderRestoredNotice('runner の器が作り直された', [
      item({ managerId: 'mgr-a', withoutLog: true }),
      item({ managerId: 'mgr-b', withoutLog: true, status: 'lost' }),
      item({ managerId: 'mgr-c' }),
    ]);
    expect(text.split(`  ⚠ ${RESUMED_WITHOUT_LOG_CLAUSE}`).length - 1).toBe(1);
    const block = text.slice(text.indexOf('- mgr-a:'), text.indexOf('- mgr-b:'));
    expect(block).toContain(RESUMED_WITHOUT_LOG_CLAUSE);
    expect(RESUMED_WITHOUT_LOG_CLAUSE).not.toContain('戻せなかった');
  });
});
