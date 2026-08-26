import { describe, expect, it } from 'vitest';

import { renderMemoryDocuments } from './memory.js';
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
  cwd: '/data/alteroid',
  runner: '別プロセスの manager-runner（http://runner:4518）',
  entrypoint: 'https://alteroid.example',
  auth: '認証は有効。ログイン手段: google',
  models: { clone: 'fable', manager: 'opus', worker: 'sonnet' },
};

describe('自己認識 — 焼き込んだ正典', () => {
  it('正典は3本、優先順位の順に並ぶ（矛盾したら上が勝つ）', () => {
    expect(canonNames()).toEqual(['north_star', 'prd', 'architecture']);
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

    // 残りの2本も、そこにしか無い一節で見る。
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
   * **自分の手が立つ場所を、委譲先の作業場所と混ぜない。**
   *
   * 道具を全部持つようになった（#32）ので、相対パスの基準が分からないことが実害に
   * なった。ここが `workspace` だけだと、クローンは「ワークスペースに居るつもり」で
   * `ls` や `Read` を撃つ（構成によっては、その場所はこの器から見えない）。
   */
  it('自分の作業ディレクトリと、マネージャーの作業場所を区別して載せる', () => {
    const section = buildSelfKnowledge({ ...FACTS, cwd: '/data/alteroid' });

    const own = section.split('\n').find((line) => line.includes('あなた自身の作業ディレクトリ'));
    expect(own).toContain('/data/alteroid');
    const manager = section
      .split('\n')
      .find((line) => line.includes('マネージャーの既定の作業ディレクトリ'));
    expect(manager).toContain('/workspace');
    // 「あなたの器から見えるとは限らない」ことまで書く（見えると確信させない）
    expect(manager).toContain('見えるとは限らない');
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
    const prompt = buildCloneSystemPrompt({ memory: renderMemoryDocuments([]), self: FACTS });

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
    // **正典の写しの版（`CANON_REVISION`）とは意図的に別の値にしてある。** 実装が
    // 写しの版で言い換えても「版が出ている」ようには見えるので、値そのものを
    // 区別できる形で置く。
    revision: {
      commit: 'd'.repeat(40),
      short: 'd'.repeat(12),
      source: 'platform',
    },
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
    injectedMemoryChars: 120,
    systemPromptChars: 4000,
  };

  /**
   * **自分が走っているコードの版。**
   *
   * これが無いと、クローンは自分について調べるときに「正典の写しの版」を
   * 「いま走っているコードの版」の答えとして使う（写しは焼き込み時点のもので、
   * 実行時に環境変数から取れる版とは食い違いうる）。
   */
  it('いま走っているコードのリビジョンを、フル sha 付きで出す', () => {
    const section = describeCloneRuntime(RUNTIME);

    expect(section).toContain('自分がいま走っているコードのリビジョン');
    expect(section).toContain('d'.repeat(40));
    expect(section).toContain('Railway が実行時に注入');
  });

  /**
   * **取れなかったときに埋めない。** ここが「不明」と言えないと、焼き込みも
   * 実行時変数も無い器で、クローンは自分の版について嘘を確信する。
   */
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

  /**
   * **「置かれているか」で言う。「既定と違うか」ではない。** RUNTIME の
   * `declaredModel` は既定と同じ `fable` なので、値の比較で言い換えた実装は
   * `modelOverridden: true` でも「既定のまま」と出て、ここで落ちる。
   */
  it('宣言されたモデル帯と、環境変数が置かれているか否かを出す', () => {
    const overridden = describeCloneRuntime({ ...RUNTIME, modelOverridden: true });
    expect(overridden).toContain('宣言されたモデル帯: fable');
    expect(overridden).toContain('人間が `ALTEROID_CLONE_MODEL` に置いた値');
    expect(overridden).not.toContain('は置かれていない');

    const notOverridden = describeCloneRuntime({ ...RUNTIME, modelOverridden: false });
    expect(notOverridden).toContain('既定。`ALTEROID_CLONE_MODEL` は置かれていない');
    expect(notOverridden).not.toContain('に置いた値');
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

  /**
   * **経緯（#324）: このテストは元々 `mcpServers: []` を「未観測」の例として
   * 置いていた。** それは `describeCloneRuntime` 側の欠陥 —— init 未観測（本当は
   * 取れていない）と、init を観測して SDK が0本と報告した（取れた値）を、
   * どちらも `[]` として同じ「まだ分からない」に畳んでいた —— をテストが
   * 仕様として固定してしまっていた形である。未観測を表す値はいまは `null` に
   * 分離したので、ここは `mcpServers: null` に直す。`mcpServers: []`（観測できた
   * 0本）が「まだ分からない」と出ないことは、この下の別のテストが固定する。
   */
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
    // 「まだ分からない」が複数箇所に出るので、件数だけ見る（未観測4件 + resume元は別文言）。
    expect(section.match(/まだ分からない/g)?.length).toBeGreaterThanOrEqual(4);
  });

  /**
   * **観測できた0本は「未観測」と区別できる文言で出る（#324 の直し方の本体）。**
   * `mcpServers: []` は「init を観測して、SDK が mcp_servers: [] を報告した」＝
   * 連携が1本も無い、という取れた値である。ここが「まだ分からない」に化けると、
   * MCP 連携が0本であるという事実が自己認識から消える —— MCP は外部サービス
   * 接続の唯一の手段（PRD）なので、0本は業務範囲の柱が空であることを直接言う
   * 値であって、取れなかったのではない。だから黙って空欄にもしない
   * （AGENTS.md 地雷「取れない軸に 0 の行を作る」の逆側 —— こちらは取れた 0 を
   * 消してしまう形である）。
   */
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

  /**
   * **MCP 連携の本数にも上限が要る（#409）。** `mcpServers` は連携の本数ぶん
   * 伸びる列挙で、`.map().join()` に上限も合図も無かった——ここはシステム
   * プロンプトへそのまま焼き込まれる行なので、伸びれば毎ターンの土台が
   * そのぶん膨らむ。**切ったら必ず合図を出す**（`excerpt.ts` の `excerptLine`
   * と同じ約束）。
   */
  it('MCP サーバが極端に多くても、抜粋の合図を出して伸び続けない', () => {
    const many = Array.from({ length: 500 }, (_, index) => ({
      name: `mcp-server-${index}`,
      status: 'connected',
    }));
    const section = describeCloneRuntime({ ...RUNTIME, mcpServers: many });
    const line = section.split('\n').find((entry) => entry.includes('MCP サーバ'));

    expect(line).toBeDefined();
    // 500本ぶんの生の列挙をそのまま出せば数千文字になる。ここでは抜粋の
    // 合図（「省略」「文字省略」）が出て、際限なく伸びていないことを見る。
    expect(line!.length).toBeLessThan(1_000);
    expect(line).toMatch(/省略/);
  });

  /**
   * **観測した許可モードと、alteroid が渡した許可モードを混ぜない。** 道具を持つ
   * ようになった（#32）以上、「使えるはずの道具が使えない」の切り分けはここから
   * 始まる。片方だけを出すと、頼んだ値が通っていないことに気づけない。
   */
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
