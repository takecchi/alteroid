import { describe, expect, it } from 'vitest';

import { buildCloneSystemPrompt } from './prompt.js';
import {
  CANON_DOCUMENTS,
  REPOSITORY_URL,
  buildSelfKnowledge,
  canonDocument,
  canonNames,
  describeCloneRuntime,
  type CloneRuntimeFacts,
  type SelfFacts,
} from './self.js';

const FACTS: SelfFacts = {
  storage: 'PostgreSQL（db:5432/alteroid）',
  local: '/data/alteroid（デーモンのローカル状態だけ。記憶は上の器にあり、ここには無い）',
  workspace: '/workspace',
  runner: '別プロセスの manager-runner（http://runner:4518）',
  entrypoint: 'https://alteroid.example',
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
    expect(section).toContain('/workspace');
    expect(section).toContain('http://runner:4518');
    expect(section).toContain('認証は有効');
  });

  /**
   * pg 構成では、ローカルに残るのは state だけで**記憶ではない**。パスだけを
   * 載せると「記憶: PostgreSQL」と「人格データの根: /data/alteroid」が並び、
   * クローンは矛盾する2つの事実を同時に確信する。
   */
  it('ローカルの置き場は、そこに何が入っているかごと載る', () => {
    const section = buildSelfKnowledge(FACTS);

    expect(section).toContain('/data/alteroid（デーモンのローカル状態だけ');
  });

  /**
   * 待ち受けアドレス（`ALTEROID_BIND=0.0.0.0`）を入口として載せない。
   * 人間が叩く先は `ALTEROID_PUBLIC_URL` であり、scheme も違いうる。
   */
  it('入口は待ち受けアドレスではなく、人間が叩く先である', () => {
    const section = buildSelfKnowledge(FACTS);

    expect(section).toContain('人間からの入口: https://alteroid.example');
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

/**
 * `describeCloneRuntime`（`CloneRuntimeFacts` の整形）。
 *
 * **`SelfFacts` とは別物であることを確かめる軸が違う。** あちらは「無ければ節を
 * 落とす」（一括で無い）が、こちらは「フィールドごとに `null` があり得る」ので、
 * `null` を既定値や宣言値で埋めていないことを1フィールドずつ確かめる。
 */
describe('CloneRuntimeFacts の整形 — 観測した値と、取れていない理由だけを出す', () => {
  const RUNTIME: CloneRuntimeFacts = {
    declaredModel: 'fable',
    modelOverridden: false,
    modelEnvKey: 'ALTEROID_CLONE_MODEL',
    sdkModel: 'claude-fable-9000-observed',
    effort: 'xhigh',
    requestedEffort: null,
    claudeCodeVersion: '2.1.0',
    apiKeySource: 'oauth',
    permissionMode: 'default',
    mcpServers: [{ name: 'alteroid', status: 'connected' }],
    sessionId: 'sess-observed',
    resumedFrom: null,
    injectedMemoryChars: 120,
    systemPromptChars: 4000,
  };

  it('宣言されたモデル帯と、差し替えの有無を出す', () => {
    const overridden = describeCloneRuntime({ ...RUNTIME, modelOverridden: true });
    expect(overridden).toContain('宣言されたモデル帯: fable');
    expect(overridden).toContain('ALTEROID_CLONE_MODEL');
    expect(overridden).toContain('差し替え済み');

    const notOverridden = describeCloneRuntime({ ...RUNTIME, modelOverridden: false });
    expect(notOverridden).toContain('既定のまま');
    expect(notOverridden).not.toContain('差し替え済み');
  });

  /**
   * **宣言の値で埋めていないことを、値そのものを変えて区別する。** 宣言帯
   * （`fable`）とは違う文字列を SDK の観測値に使い、その文字列がそのまま出る
   * ことを見る。
   */
  it('SDK が実際に報告したモデル id は、宣言と違う値でもそのまま出る', () => {
    const section = describeCloneRuntime(RUNTIME);
    expect(section).toContain('claude-fable-9000-observed');
  });

  it('init を観測する前は sdkModel が「まだ分からない」で、宣言帯の値では埋まらない', () => {
    const section = describeCloneRuntime({ ...RUNTIME, sdkModel: null });
    expect(section).toContain('まだ分からない');
    // 「fable」という文字列自体は宣言帯の行にも出るので、SDK 観測の行だけを見る。
    const sdkLine = section.split('\n').find((line) => line.includes('SDK が実際に報告したモデル'));
    expect(sdkLine).toBeDefined();
    expect(sdkLine).not.toContain('fable');
  });

  it('effort が報告されていれば、その実効値が出る', () => {
    const section = describeCloneRuntime({ ...RUNTIME, effort: 'xhigh' });
    expect(section).toContain('xhigh');
  });

  it('effort が一度も報告されていなければ「まだ分からない」で、既定値では埋めない', () => {
    const section = describeCloneRuntime({ ...RUNTIME, effort: null });
    const effortLine = section.split('\n').find((line) => line.includes('effort（実効値）'));
    expect(effortLine).toContain('まだ分からない');
    expect(effortLine).not.toMatch(/low|medium|high|xhigh|max/);
  });

  it('alteroid が明示的に渡した effort が無ければ、そう言う（渡していない、で埋める）', () => {
    const section = describeCloneRuntime({ ...RUNTIME, requestedEffort: null });
    expect(section).toContain('渡していない');
  });

  it('Claude Code の版・認証の出所・許可モード・MCP サーバは、未観測なら埋めない', () => {
    const section = describeCloneRuntime({
      ...RUNTIME,
      claudeCodeVersion: null,
      apiKeySource: null,
      permissionMode: null,
      mcpServers: [],
    });
    expect(section).not.toContain('2.1.0');
    expect(section).not.toContain('oauth');
    expect(section).not.toContain('default');
    // 「まだ分からない」が複数箇所に出るので、件数だけ見る（未観測4件 + resume元は別文言）。
    expect(section.match(/まだ分からない/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('認証の出所は値ではなく名前だけを出す（鍵そのものを持つ型ではない）', () => {
    const section = describeCloneRuntime(RUNTIME);
    expect(section).toContain('認証の出所（値ではなく名前）: oauth');
  });

  it('セッション id は「本セッションで観測した値」と明記する（蒸留は別セッション）', () => {
    const section = describeCloneRuntime(RUNTIME);
    expect(section).toContain('sess-observed');
    expect(section).toContain('クローン本体のセッション');
  });

  it('resume 元が無ければ、新規に開いたと分かる言い方をする', () => {
    const section = describeCloneRuntime({ ...RUNTIME, resumedFrom: null });
    expect(section).toContain('新規に開いた');
  });

  it('記憶の文字数は、焼き込んだ時点とシステムプロンプト全体を別々に出す', () => {
    const section = describeCloneRuntime({
      ...RUNTIME,
      injectedMemoryChars: 120,
      systemPromptChars: 4000,
    });
    expect(section).toContain('120');
    expect(section).toContain('4,000');
  });

  it('鍵・トークンの値は一切出さない（この型自体が持たない）', () => {
    const section = describeCloneRuntime(RUNTIME);
    expect(section).not.toMatch(/ghp_|sk-ant|Bearer /);
  });
});
