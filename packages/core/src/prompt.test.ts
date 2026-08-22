import { describe, expect, it } from 'vitest';

import { renderMemoryDocuments } from './memory.js';
import { buildCloneSystemPrompt, buildManagerSystemPrompt, buildWorkerPrompt } from './prompt.js';

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

/**
 * クローンのシステムプロンプトに書く「委譲の方針」を守るテスト。
 *
 * **マネージャー側と同じ理由でここに歯を当てる**（上の describe のコメント）。
 * 加えてクローン側にはもう1つの失敗の形がある — **道具を渡したのにプロンプトで
 * 取り上げる**ことである。実際に #32 の前は `tools: []` と揃えて「あなたには
 * 組み込みのツールが無い」と書いてあり、実装だけを直して本文を直さなければ、
 * 道具はあるのに使わないクローンが残る（north_star「適用範囲」が名指しで否定して
 * いる推論が、プロンプトの中で生き延びる）。
 *
 * だから**両側**を見る。「委譲が原則である」と「それは能力の制限ではない」の
 * どちらが落ちても落ちるようにしてある。
 */
describe('クローンのシステムプロンプト — 道具と委譲', () => {
  const prompt = buildCloneSystemPrompt({ memory: renderMemoryDocuments([]) });

  it('委譲が原則であることを方針として書いている', () => {
    // PRD「層ごとの能力」: 重い調査と実作業は方針として下へ委ねる。
    expect(prompt).toContain('原則としてマネージャーへ委ねる');
  });

  it('道具を取り上げていない — 自分でやってよいことが本文にある', () => {
    // north_star「適用範囲」: 人間が自分の手でできることは、クローンも自分でできる。
    // 「道具を取り上げて委譲を強制してはいけない」。
    expect(prompt).toContain('能力の制限ではない');
    expect(prompt).toContain('自分で見てよい');
  });

  it('「組み込みのツールが無い」と書いていない（#32 で反転させた説明）', () => {
    // ここが復活すると、実装が直っていてもデグレードがプロンプトで戻る。
    expect(prompt).not.toContain('組み込みのツールが無い');
    expect(prompt).not.toContain('ツールが無い');
  });

  /**
   * 道具を持つと、クローンの手は**自分を監査している器**にも届く（デーモンと
   * 同じプロセスに居るので、記憶の実体・日誌のファイル・HTTP API・入口の資格）。
   * 正典はこれを塞ぐことを禁じている（architecture.md「これは境界の破れではない」）
   * ので、**方針として**書いてあることを確かめる。書いていなければ、方針で扱うと
   * 言いながら何も言っていないことになる。
   */
  it('自分を監査している器に直接手を入れない方針が書いてある（塞ぐのではなく方針で）', () => {
    expect(prompt).toContain('専用の道具か人間を通す');
    // 「なぜ」まで書く（禁止の一覧ではなく理由で判断させる）
    expect(prompt).toContain('人間が後から追う手段');
  });

  it('自分で手を動かしたときの記録と、記憶の更新経路を方針として書いている', () => {
    // docs/architecture.md「非対称な可視性」:「どちらで見たかは日誌に残す」。
    // 記憶を直接書き換えられる立場になったので、`memory_*` を通すのも方針で表す
    // （塞ぐのではなく — 同文書「クローンが自分の手を持つことの帰結」）。
    expect(prompt).toContain('自分で手を動かしたなら');
    expect(prompt).toContain('記憶の更新は');
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
