import { describe, expect, it } from 'vitest';

import { NOTIFY_REPORT_EXCERPT } from './excerpt.js';
import { notifyExcerptLines, resumeFallbackBody, unresumableNotice } from './manager-notices.js';

const MORE = (id: string) =>
  `続きを読むなら manager_report managerId=${id}（直近の報告の全文） / ` +
  `manager_report managerId=${id} part=request（依頼文）。`;

describe('notifyExcerptLines', () => {
  it('報告が無ければ先頭は空行で、続きの案内だけが残る', () => {
    expect(notifyExcerptLines({ id: 'm1' })).toEqual(['', MORE('m1')]);
  });
  it('報告が在れば抜粋を添える', () => {
    expect(notifyExcerptLines({ id: 'm1', lastReport: '完了' })).toEqual([
      '直近の報告（抜粋）: 完了',
      MORE('m1'),
    ]);
  });
  it('長い報告は抜粋の上限で切る', () => {
    const [head] = notifyExcerptLines({
      id: 'm1',
      lastReport: 'あ'.repeat(NOTIFY_REPORT_EXCERPT * 2),
    });
    expect(head?.startsWith('直近の報告（抜粋）: ')).toBe(true);
    expect(head?.length).toBeLessThan(NOTIFY_REPORT_EXCERPT + 40);
  });
});

describe('unresumableNotice', () => {
  const job = { id: 'm1', cwd: '/w', lastReport: undefined };
  it('runner の原因: 日誌と本文に理由・作業ディレクトリを載せる', () => {
    const { journal, notice } = unresumableNotice(job, 'boom', 'runner');
    expect(journal).toBe(
      '（戻せなかった）runner の器が作り直されたが、前のセッションから戻せなかった。 理由: boom',
    );
    const lines = notice.split('\n');
    expect(lines.slice(0, 4)).toEqual([
      'runner の器が作り直されたが、この委譲を前のセッションから戻せなかった。',
      '理由: boom',
      '作業ディレクトリ: /w',
      MORE('m1'),
    ]);
    expect(lines).toHaveLength(5);
    expect(lines[4]).toContain('自動では再試行しない');
  });
  it('session の原因: 材料が無いことを言い、cwd が無ければ (不明)', () => {
    const { journal, notice } = unresumableNotice({ id: 'm2' }, 'x', 'session');
    expect(journal).toContain('（SDK に会話が残っていない）');
    expect(notice).toContain('生ログも預かっていないので、続きの材料が無い。');
    expect(notice).toContain('作業ディレクトリ: (不明)');
  });
});

describe('resumeFallbackBody', () => {
  it('セッション・理由・抜粋・注意を並べ、空行は落とす', () => {
    const body = resumeFallbackBody({ id: 'm1', lastReport: 'r' }, 's1', '理由X');
    expect(body.split('\n')).toEqual([
      '前のセッション（s1）へは戻れなかったので、預かってあった生ログから新しいセッションを起こして続けさせた。',
      '理由: 理由X',
      '直近の報告（抜粋）: r',
      MORE('m1'),
      'マネージャーが持っているのは記録から読み取れる範囲だけである。' +
        '前のセッションで口頭で足した細かい指示は効いていないと考えて、' +
        '必要なら `manager_send` で言い直すこと。',
    ]);
  });
  it('報告が無ければ抜粋行は出ない', () => {
    expect(resumeFallbackBody({ id: 'm1' }, 's', 'r').split('\n')).toHaveLength(4);
  });
});
