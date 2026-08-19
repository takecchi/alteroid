import { describe, expect, it } from 'vitest';

import { buildManagerSystemPrompt, buildWorkerPrompt } from './prompt.js';

/**
 * マネージャーのシステムプロンプトに書く「委譲の指針」を守るテスト。
 *
 * **なぜ文字列の中身をテストするのか。** ここは `docs/architecture.md`
 * 「プロセスモデル」が「作業者層の本体は `agents` 定義1個と**マネージャーの
 * システムプロンプトに書く委譲の指針**のみ」と名指ししている場所で、方針を
 * 削っても型は通り、`agents` 定義も残るので**どのテストも落ちない**。実際に
 * 本番で6日間 $386 を使い、58本のマネージャーのうち35本が作業者を一度も
 * 起こしていなかった（支出の73%が Opus 側）。そのとき本文にあったのは
 * 「使える」「任せてよい」という許可の文体だけだった。
 *
 * だから**方針が書かれていること自体**に歯を当てる。文言そのものではなく、
 * PRD が両側から挟んでいる3つの性質を見る。
 */
describe('マネージャーのシステムプロンプト — 委譲の指針', () => {
  const prompt = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });

  it('「原則として作業者へ委ねる」を方針として書いている（許可の文体で終わらせない）', () => {
    // PRD「層ごとの能力」: 重い実作業を Opus の値段でやるのは無駄なので、
    // 原則として作業者へ委ねる。
    expect(prompt).toContain('原則として作業者へ出す');
  });

  it('能力の制限として書いていない — 自分でやってよいことが本文にある', () => {
    // north_star 禁止2。方針で表すのであって、能力を削るのではない。
    // ここが消えると「委譲を強制した」＝能力の削除になる。
    expect(prompt).toContain('能力の制限ではない');
    expect(prompt).toContain('自分で実装できる');
  });

  it('「全部を下へ投げろ」になっていない — 作業者が立たないのも正しい動作だと書いてある', () => {
    // PRD「層ごとの能力」: 全部を下へ投げることは要件ではない。簡単な調査依頼が
    // マネージャーで完結し、作業者が1体も立たないのは正しい動作である。
    // 片側だけ強めると、簡単な調査までサブエージェント越しになって遅くなる。
    expect(prompt).toContain('全部を下へ投げることも求めていない');
    expect(prompt).toContain('1体も立たないのは正しい動作');
  });

  it('作業者の名前と このセッションの識別子 が差し込まれる', () => {
    const other = buildManagerSystemPrompt({ managerId: 'mgr-abc', workerName: 'w2' });
    expect(other).toContain('mgr-abc');
    expect(other).toContain('`w2` サブエージェント');
    // 取り違えていないこと（両方が同じ穴に入っていないか）
    expect(other).not.toContain('mgr-test');
    expect(other).not.toContain('`worker` サブエージェント');
  });

  it('委譲の対象を実装だけに狭めていない（AGENTS.md 地雷8）', () => {
    for (const kind of ['調査', 'レビュー']) {
      expect(prompt).toContain(kind);
    }
    expect(prompt).toContain('実装に限らず');
  });

  it('ユーザーがクローンであることは残っている（この改修で落としていない）', () => {
    expect(prompt).toContain('価値観をコピーしたクローン');
  });
});

describe('作業者のシステムプロンプト', () => {
  it('仕事の型を実装専用に狭めていない（AGENTS.md 地雷8）', () => {
    const prompt = buildWorkerPrompt();
    expect(prompt).toContain('実装に限らない');
  });

  it('握り潰さずに上へ返す経路があることを書いている', () => {
    expect(buildWorkerPrompt()).toContain('握り潰さず');
  });
});
