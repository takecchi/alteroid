import { describe, expect, it } from 'vitest';

import { renderMemoryDocuments } from './memory.js';
import { buildCloneSystemPrompt } from './prompt.js';
import { heuristicChars } from './quantity.js';
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
  cwd: '/data/alteroid',
  runner: '別プロセスの manager-runner（http://runner:4518）',
  entrypoint: 'https://alteroid.example',
  auth: '認証は有効。ログイン手段: google',
  models: { clone: 'fable' },
};

describe('自己認識 — 焼き込んだ正典', () => {
  it('正典は3本、優先順位の順に並ぶ（矛盾したら上が勝つ）', () => {
    expect(canonNames()).toEqual(['north_star', 'prd', 'architecture']);
  });

  it('全文が入っている（要約に潰されていない）', () => {
    const northStar = canonDocument('north_star');
    expect(northStar?.content).toContain('2つの禁止（このプロダクトの憲法）');
    expect(northStar?.content).toContain('デグレード禁止');
    expect(northStar?.content).toContain('追加制限禁止');

    expect(canonDocument('prd')?.content).toContain('提供価値（コア3点）');
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
    expect(section).toContain('マネージャー → 作業者');
    expect(section).not.toContain('opus');
    expect(section).not.toContain('sonnet');
    expect(section).toContain('self_status');
    expect(section).toContain('manager_list');
    for (const name of canonNames()) expect(section).toContain(`\`${name}\``);
  });

  it('いま自分が走っている環境を載せる（記憶の器・作業場所・委譲先・入口）', () => {
    const section = buildSelfKnowledge(FACTS);

    expect(section).toContain('PostgreSQL（db:5432/alteroid）');
    expect(section).toContain('/workspace');
    expect(section).toContain('http://runner:4518');
    expect(section).toContain('認証は有効');
  });

  it('自分の作業ディレクトリと、マネージャーの作業場所を区別して載せる', () => {
    const section = buildSelfKnowledge({ ...FACTS, cwd: '/data/alteroid' });

    const own = section.split('\n').find((line) => line.includes('あなた自身の作業ディレクトリ'));
    expect(own).toContain('/data/alteroid');
    const manager = section
      .split('\n')
      .find((line) => line.includes('マネージャーの既定の作業ディレクトリ'));
    expect(manager).toContain('/workspace');
    expect(manager).toContain('見えるとは限らない');
  });

  it('ローカルの置き場は、そこに何が入っているかごと載る', () => {
    const section = buildSelfKnowledge(FACTS);

    expect(section).toContain('/data/alteroid（デーモンのローカル状態だけ');
  });

  it('入口は待ち受けアドレスではなく、人間が叩く先である', () => {
    const section = buildSelfKnowledge(FACTS);

    expect(section).toContain('人間からの入口: https://alteroid.example');
  });

  it('事実が渡らなければ、環境の節ごと落とす（それらしい既定値を作らない）', () => {
    const section = buildSelfKnowledge();

    expect(section).toContain(REPOSITORY_URL);
    expect(section).not.toContain('いまのあなたが走っている環境');
    expect(section).not.toContain('記憶（あなたの同一性が宿る場所）');
  });

  it('クローンのシステムプロンプトに組み込まれる', () => {
    const prompt = buildCloneSystemPrompt({ memory: renderMemoryDocuments([]), self: FACTS });

    expect(prompt).toContain('# あなた自身（alteroid）');
    expect(prompt).toContain(REPOSITORY_URL);
    expect(prompt).toContain('PostgreSQL（db:5432/alteroid）');
    expect(prompt).toContain('`self_read`');
  });

  it('モデル帯が差し替えられていれば、その値が載る（既定を書き固めない）', () => {
    const section = buildSelfKnowledge({ ...FACTS, models: { ...FACTS.models, clone: 'opus' } });

    expect(section).toContain('クローン / opus');
  });
});

describe('CloneRuntimeFacts の整形 — 観測した値と、取れていない理由だけを出す', () => {
  const RUNTIME: CloneRuntimeFacts = {
    revision: {
      commit: 'd'.repeat(40),
      short: 'd'.repeat(12),
      source: 'platform',
    },
    buildTime: { builtAt: '2026-09-18T11:45:00.000Z' },
    declaredModel: 'fable',
    modelOverridden: false,
    modelEnvKey: 'ALTEROID_CLONE_MODEL',
    sdkModel: 'claude-fable-9000-observed',
    effort: 'xhigh',
    requestedEffort: null,
    claudeCodeVersion: '2.1.0',
    apiKeySource: 'oauth',
    permissionMode: 'default',
    requestedPermissionMode: 'auto',
    mcpServers: [{ name: 'alteroid', status: 'connected' }],
    sessionId: 'sess-observed',
    resumedFrom: null,
    injectedMemoryChars: heuristicChars(120),
    systemPromptChars: heuristicChars(4000),
    lastContextUsage: null,
  };

  it('いま走っているコードのリビジョンを、フル sha 付きで出す', () => {
    const section = describeCloneRuntime(RUNTIME);

    expect(section).toContain('自分がいま走っているコードのリビジョン');
    expect(section).toContain('d'.repeat(40));
    expect(section).toContain('Railway が実行時に注入');
  });

  it('版が取れていなければ「不明」と言い、それらしい sha を作らない', () => {
    const section = describeCloneRuntime({
      ...RUNTIME,
      revision: { commit: null, short: null, source: null },
    });
    const line = section
      .split('\n')
      .find((entry) => entry.includes('走っているコードのリビジョン'));

    expect(line).toBeDefined();
    expect(line).toContain('不明');
    expect(line).not.toMatch(/[0-9a-f]{7,}/);
  });

  it('焼かれた時刻がリビジョンの行のすぐ隣に出る', () => {
    const section = describeCloneRuntime(RUNTIME);
    const lines = section.split('\n').filter((line) => line.startsWith('- '));
    const revisionIndex = lines.findIndex((line) => line.includes('走っているコードのリビジョン'));
    const buildAgeIndex = lines.findIndex((line) => line.includes('焼かれた時刻とそこからの経過'));

    expect(revisionIndex).toBeGreaterThanOrEqual(0);
    expect(buildAgeIndex).toBe(revisionIndex + 1);
    expect(lines[buildAgeIndex]).toContain('2026-09-18T11:45:00.000Z');
  });

  it('焼かれた時刻が取れていなければ「不明」と言い、それらしい時刻を作らない', () => {
    const section = describeCloneRuntime({ ...RUNTIME, buildTime: { builtAt: null } });
    const line = section
      .split('\n')
      .find((entry) => entry.includes('焼かれた時刻とそこからの経過'));

    expect(line).toBeDefined();
    expect(line).toContain('不明');
    expect(line).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('main の先端とは限らないことと、差の数え方を、リビジョンの行の隣に出す', () => {
    const section = describeCloneRuntime(RUNTIME);

    expect(section).toContain('main` の先端とは限らない');
    expect(section).toContain('まだ届いていない');
    expect(section).toContain('全部入っている、とは言えない');
    expect(section).toContain('gh api repos/takecchi/alteroid/compare/');
    expect(section).toContain('--jq .ahead_by');
    expect(section).toContain('d'.repeat(40));
  });

  it('宣言されたモデル帯と、環境変数が置かれているか否かを出す', () => {
    const overridden = describeCloneRuntime({ ...RUNTIME, modelOverridden: true });
    expect(overridden).toContain('宣言されたモデル帯: fable');
    expect(overridden).toContain('人間が `ALTEROID_CLONE_MODEL` に置いた値');
    expect(overridden).not.toContain('は置かれていない');

    const notOverridden = describeCloneRuntime({ ...RUNTIME, modelOverridden: false });
    expect(notOverridden).toContain('既定。`ALTEROID_CLONE_MODEL` は置かれていない');
    expect(notOverridden).not.toContain('に置いた値');
  });

  it('クローンの provider の行を持たない（層は常に Claude で動く。2026-10-07 の決定）', () => {
    expect(describeCloneRuntime(RUNTIME)).not.toContain('クローンの provider');
  });

  it('SDK が実際に報告したモデル id は、宣言と違う値でもそのまま出る', () => {
    const section = describeCloneRuntime(RUNTIME);
    expect(section).toContain('claude-fable-9000-observed');
  });

  it('init を観測する前は sdkModel が「まだ分からない」で、宣言帯の値では埋まらない', () => {
    const section = describeCloneRuntime({ ...RUNTIME, sdkModel: null });
    expect(section).toContain('まだ分からない');
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
      mcpServers: null,
    });
    expect(section).not.toContain('2.1.0');
    expect(section).not.toContain('oauth');
    expect(section).not.toContain('default');
    expect(section.match(/まだ分からない/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('MCP サーバは、観測できた0本と未観測を区別する（0本のとき「まだ分からない」は出ない）', () => {
    const section = describeCloneRuntime({ ...RUNTIME, mcpServers: [] });
    const line = section.split('\n').find((entry) => entry.includes('MCP サーバ'));

    expect(line).toBeDefined();
    expect(line).not.toContain('まだ分からない');
    expect(line).toContain('0本');
    expect(line).toContain('観測済み');
  });

  it('MCP サーバが1本以上あれば、これまでどおり名前と状態がそのまま出る', () => {
    const section = describeCloneRuntime({
      ...RUNTIME,
      mcpServers: [
        { name: 'alteroid', status: 'connected' },
        { name: 'stripe', status: 'pending' },
      ],
    });
    const line = section.split('\n').find((entry) => entry.includes('MCP サーバ'));

    expect(line).toBeDefined();
    expect(line).toContain('alteroid(connected)');
    expect(line).toContain('stripe(pending)');
  });

  it('MCP サーバが極端に多くても、抜粋の合図を出して伸び続けない', () => {
    const many = Array.from({ length: 500 }, (_, index) => ({
      name: `mcp-server-${index}`,
      status: 'connected',
    }));
    const section = describeCloneRuntime({ ...RUNTIME, mcpServers: many });
    const line = section.split('\n').find((entry) => entry.includes('MCP サーバ'));

    expect(line).toBeDefined();
    expect(line!.length).toBeLessThan(1_000);
    expect(line).toMatch(/省略/);
  });

  it('許可モードは「SDK が報告した実効値」と「alteroid が渡したもの」を分けて出す', () => {
    const section = describeCloneRuntime({
      ...RUNTIME,
      permissionMode: 'dontAsk',
      requestedPermissionMode: 'auto',
    });
    expect(section).toContain('許可モード（SDK が報告した実効値）: dontAsk');
    expect(section).toContain('許可モード（alteroid が渡したもの）: auto');
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
      injectedMemoryChars: heuristicChars(120),
      systemPromptChars: heuristicChars(4000),
    });
    expect(section).toContain('120');
    expect(section).toContain('4,000');
  });

  it('鍵・トークンの値は一切出さない（この型自体が持たない）', () => {
    const section = describeCloneRuntime(RUNTIME);
    expect(section).not.toMatch(/ghp_|sk-ant|Bearer /);
  });

  describe('lastContextUsage — 実際に払っていた入力と、払っていない枠', () => {
    it('⭐⭐⭐ free の軸を持つ観測でも、「実際に払っていた入力」の数値は free の分を含まない', () => {
      const section = describeCloneRuntime({
        ...RUNTIME,
        lastContextUsage: {
          durationMs: 5,
          categories: [
            { name: 'System prompt', tokens: 8_000, kind: 'used' },
            { name: 'Tools', tokens: 1_000, kind: 'used' },
            { name: 'Remaining window', tokens: 190_000, kind: 'free' },
          ],
        },
      });

      const usedLine = section.split('\n').find((line) => line.includes('実際に払っていた入力'));
      const unusedLine = section.split('\n').find((line) => line.includes('払っていない枠'));
      if (usedLine === undefined || unusedLine === undefined) {
        throw new Error('lastContextUsage の2行が出ていない');
      }

      expect(usedLine).toContain('9,000 トークン');
      expect(usedLine).not.toContain((8_000 + 1_000 + 190_000).toLocaleString('en-US'));
      expect(unusedLine).toContain('free 190,000 トークン');
    });

    it('倒れ先(1) — まだ観測していない（null）と、倒れ先(2)(3) と別の文言になり、0 を出さない', () => {
      const section = describeCloneRuntime({ ...RUNTIME, lastContextUsage: null });
      const usedLine = section.split('\n').find((line) => line.includes('実際に払っていた入力'));
      const unusedLine = section.split('\n').find((line) => line.includes('払っていない枠'));

      expect(usedLine).toContain('まだ分からない');
      expect(usedLine).not.toMatch(/0 トークン/);
      expect(unusedLine).toContain('まだ分からない');
      expect(unusedLine).not.toMatch(/0 トークン/);
    });

    it('倒れ先(2) — 観測を試みて失敗した（error 付き）ときは、理由を出し 0 を出さない', () => {
      const section = describeCloneRuntime({
        ...RUNTIME,
        lastContextUsage: { durationMs: 5, error: '失敗: タイムアウト' },
      });
      const usedLine = section.split('\n').find((line) => line.includes('実際に払っていた入力'));
      const unusedLine = section.split('\n').find((line) => line.includes('払っていない枠'));

      expect(usedLine).toContain('観測を試みて失敗した');
      expect(usedLine).toContain('失敗: タイムアウト');
      expect(usedLine).not.toMatch(/0 トークン/);
      expect(unusedLine).toContain('観測を試みて失敗した');
      expect(unusedLine).not.toMatch(/0 トークン/);
      expect(usedLine).not.toContain('まだ分からない');
    });

    it('倒れ先(3) — 観測はできたが categories が無い（SDK が内訳を返さなかった）ときは、そう言い 0 を出さない', () => {
      const section = describeCloneRuntime({
        ...RUNTIME,
        lastContextUsage: { durationMs: 5, totalTokens: 12_000 },
      });
      const usedLine = section.split('\n').find((line) => line.includes('実際に払っていた入力'));
      const unusedLine = section.split('\n').find((line) => line.includes('払っていない枠'));

      expect(usedLine).toContain('カテゴリ別の内訳を返さなかった');
      expect(usedLine).not.toMatch(/0 トークン/);
      expect(unusedLine).toContain('カテゴリ別の内訳を返さなかった');
      expect(unusedLine).not.toMatch(/0 トークン/);
      expect(usedLine).not.toContain('まだ分からない');
      expect(usedLine).not.toContain('観測を試みて失敗した');
    });

    it('unclassified（分類できない軸）が在るときは、その事実が読める（「分類できず」が出る）', () => {
      const section = describeCloneRuntime({
        ...RUNTIME,
        lastContextUsage: {
          durationMs: 5,
          categories: [
            { name: 'System prompt', tokens: 100, kind: 'used' },
            { name: 'Messages', tokens: 40 },
          ],
        },
      });
      const unusedLine = section.split('\n').find((line) => line.includes('払っていない枠'));
      expect(unusedLine).toContain('分類できず 40 トークン');
    });
  });
});
