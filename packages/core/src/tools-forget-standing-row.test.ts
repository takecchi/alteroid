import { describe, expect, it } from 'vitest';

import { DigestSessionDelta } from './digest-session-delta.js';

const KIND = 'weekly-review';
describe('DigestSessionDelta: 自発の tick（renderDigest）で畳んだ行も、控えを会話の上の版に揃える', () => {
  const row = (request: string) =>
    `- ${KIND}（毎日 09:00）${request}\n  前回動いた時刻: （まだ一度も動いていない）`;
  const digestOf = (request: string) =>
    [
      '期間: x',
      '',
      '## 継続中の依頼（時刻が来れば届く。前回からの続きがあるか見ること）',
      row(request),
    ].join('\n');
  const at = new Date('2026-10-28T00:00:00.000Z');

  it('⭐ 控えが B を指しているとき、自発の tick が「前回から変わらない」A の行を畳んだら、控えの B を捨てる', () => {
    const delta = new DigestSessionDelta();
    // 自発の tick が A を全文で出す（控えは A）
    delta.renderDigest(digestOf('A'), at);
    delta.commit();
    // 定期の tick が B を全文で出す（控えは B に置き換わる）
    delta.foldStandingRows(digestOf('B'));
    delta.commit();
    // 自発の tick は前回（A）から変わらないので畳む。会話でいちばん新しい全文は定期の B
    delta.renderDigest(digestOf('A'), at);
    delta.commit();
    // 人間が B に戻した → 控えが B のままだと畳んでしまう
    const folded = delta.foldStandingRows(digestOf('B'));
    expect(folded).toContain(`- ${KIND}（`);
  });

  it('控えが同じ版を指しているなら、自発の tick が畳んでも控えは残る（畳みは続く）', () => {
    const delta = new DigestSessionDelta();
    delta.renderDigest(digestOf('A'), at);
    delta.commit();
    delta.renderDigest(digestOf('A'), at);
    delta.commit();
    const folded = delta.foldStandingRows(digestOf('A'));
    expect(folded).not.toContain(`- ${KIND}（`);
    expect(folded).toContain('1 件は、この会話で最後に全文で出した版と');
  });

  it('forgetStandingRow は、押し込む前（staged）の控えも捨てる', () => {
    const delta = new DigestSessionDelta();
    delta.foldStandingRows(digestOf('A'));
    delta.forgetStandingRow(KIND);
    delta.commit();
    expect(delta.foldStandingRows(digestOf('A'))).toContain(`- ${KIND}（`);
  });
});
