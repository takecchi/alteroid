import { describe, expect, it } from 'vitest';

import { buildCloneSystemPrompt } from './prompt.js';
import {
  CANON_DOCUMENTS,
  REPOSITORY_URL,
  buildSelfKnowledge,
  canonDocument,
  canonNames,
  type SelfFacts,
} from './self.js';

const FACTS: SelfFacts = {
  storage: 'PostgreSQL（db:5432/alteroid）',
  home: '/home/node/.alteroid',
  workspace: '/workspace',
  runner: '別プロセスの manager-runner（http://runner:4518）',
  listen: 'http://127.0.0.1:4517',
  auth: '認証は有効。ログイン手段: google',
  models: { clone: 'fable', manager: 'opus', worker: 'sonnet' },
};

describe('自己認識 — 焼き込んだ正典', () => {
  it('正典は4本、優先順位の順に並ぶ（矛盾したら上が勝つ）', () => {
    expect(canonNames()).toEqual(['north_star', 'prd', 'architecture', 'roadmap']);
  });

  /**
   * **要約ではなく全文であること。** 要約を焼き込むと docs と二重管理になり、
   * ずれた瞬間クローンは自分について間違ったことを確信する。だから「正典に
   * しか無い一節」がそのまま入っているかで見る。
   */
  it('全文が入っている（要約に潰されていない）', () => {
    const northStar = canonDocument('north_star');
    expect(northStar?.content).toContain('2つの禁止（このプロダクトの憲法）');
    expect(northStar?.content).toContain('デグレード禁止');
    expect(northStar?.content).toContain('追加制限禁止');

    // 「いま何ができて何ができないか」の出所。未着手の節が残っていること。
    expect(canonDocument('roadmap')?.content).toContain('M5');
    expect(canonDocument('architecture')?.content).toContain('プロセスモデル');
  });

  it('どの正典も出所の位置を持つ（クローンがリポジトリで探し直せる）', () => {
    for (const doc of CANON_DOCUMENTS) {
      expect(doc.path).toMatch(/^docs\/.+\.md$/);
      expect(doc.title.length).toBeGreaterThan(0);
      expect(doc.summary.length).toBeGreaterThan(0);
    }
  });

  it('名前は大文字小文字と空白を吸収する。無い名前は undefined', () => {
    expect(canonDocument('  PRD ')?.name).toBe('prd');
    expect(canonDocument('agents')).toBeUndefined();
  });
});

describe('自己認識 — システムプロンプトに載る節', () => {
  it('実装の在り処と層の対応を必ず載せる', () => {
    const section = buildSelfKnowledge(FACTS);

    expect(section).toContain(REPOSITORY_URL);
    expect(section).toContain('fable');
    expect(section).toContain('opus');
    expect(section).toContain('sonnet');
    // 正典の目次（何を self_read で読めるか）
    for (const name of canonNames()) expect(section).toContain(`\`${name}\``);
  });

  it('いま自分が走っている環境を載せる（記憶の器・作業場所・委譲先・入口）', () => {
    const section = buildSelfKnowledge(FACTS);

    expect(section).toContain('PostgreSQL（db:5432/alteroid）');
    expect(section).toContain('/home/node/.alteroid');
    expect(section).toContain('/workspace');
    expect(section).toContain('http://runner:4518');
    expect(section).toContain('http://127.0.0.1:4517');
    expect(section).toContain('認証は有効');
  });

  /**
   * **無い事実を埋めない。** 埋めた瞬間、クローンは自分の環境について嘘を
   * 確信する（デーモンの外で組み立てる場合や、テストで facts を渡さない場合）。
   */
  it('事実が渡らなければ、環境の節ごと落とす（それらしい既定値を作らない）', () => {
    const section = buildSelfKnowledge();

    expect(section).toContain(REPOSITORY_URL);
    expect(section).not.toContain('いまのあなたが走っている環境');
    expect(section).not.toContain('記憶（あなたの同一性が宿る場所）');
  });

  it('クローンのシステムプロンプトに組み込まれる', () => {
    const prompt = buildCloneSystemPrompt({ memory: '', self: FACTS });

    expect(prompt).toContain('# あなた自身（alteroid）');
    expect(prompt).toContain(REPOSITORY_URL);
    expect(prompt).toContain('PostgreSQL（db:5432/alteroid）');
    // 自分を調べる手段が道具一覧にも出ていること（片方だけだと使い方が分からない）
    expect(prompt).toContain('`self_read`');
  });

  it('モデル帯が差し替えられていれば、その値が載る（既定を書き固めない）', () => {
    const section = buildSelfKnowledge({ ...FACTS, models: { ...FACTS.models, clone: 'opus' } });

    expect(section).toContain('クローン / opus');
  });
});
