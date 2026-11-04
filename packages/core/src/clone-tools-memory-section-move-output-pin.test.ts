import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { scanMemorySections } from './memory.js';
import { heuristicChars } from './quantity.js';
import type { CloneRuntimeFacts } from './self.js';
import { memoryVersion } from './store.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `memory_section_move` の出力（全文と字数）と、呼んだあとの状態（記憶の本文・日誌へ足された行）を、
// 場面ごとにコミットした固定値（clone-tools-memory-section-move-output-pin.json）と丸ごと比べる。
// `clone-tools-memory.ts` の `tool('memory_section_move', …)`（約 293 行・入れ子 7 段の式）を部分ごとの小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・記憶の本文）を固定して毎回同じにする。
// この道具は読むだけではなく記憶を書き換えるので、出力だけでなく「呼んだあとの状態」も固定する:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか）
//   - memory: 場面で触れた記憶（動かした元と先）を、呼んだあとにストアから読んだ形のまま（版 version・frontmatter・updatedAt を含む）
//   - journal: 呼んだあとに日誌へ足された行（種類・本文・id・at をそのまま）
//   - wrote: 記憶か日誌のどれかが呼ぶ前から変わったか。断った・何もしなかった場面は false で、記憶が呼ぶ前と同じであることも別に確かめる
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_MEMORY_SECTION_MOVE_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-memory-section-move-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-memory-section-move-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、記憶・日誌のどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。
// 記憶は場面の頭に基準時刻で入れ、呼びごとに基準時刻から 1 分ずつ進めて呼ぶ（updatedAt・日誌の at が呼び順に増える）。
// 日誌の id はインメモリの採番（id-1, id-2, …）で、場面ごとにストアを作り直すので毎回同じ。節id は本文から決まる（入力の側で固定）。
// 同じ状態へ続けて呼ぶ場面は `名前#1`・`名前#2` と呼びごとに固定する。

type Args = Record<string, unknown>;

/** 呼びが起こした書き込み（記憶か日誌）が「無い」と「有る」。無いと言った呼びは、呼ぶ前と状態が同じであることを確かめる */
type Writes = 'none' | 'some';

interface SeedDoc {
  slug: string;
  content: string;
  /** 真なら人間が触った印（保護状態 human）を付ける */
  human?: boolean;
}

/** 場面の中で呼びごとに差し替える口（器の振る舞いと「誰の走行か」） */
interface Hooks {
  cause: 'clone' | 'distill';
  /** この slug への persona.write だけ投げる（出どころの書き込みが落ちる場面） */
  failWriteSlug: string | null;
  /** この slug を最初に読んだ直後に、別の内容を書き込む（読んでから切り取るまでの間に変わる場面） */
  raceOnRead: { slug: string; content: string } | null;
}

interface Step {
  args: Args;
  writes: Writes;
  /** 呼ぶ直前に器の口を設定する */
  before?: (hooks: Hooks) => void;
  /** 呼ぶ前に外から（人間・別のターンが）記憶を書き換える。呼ぶ前の状態に含める */
  externalEdit?: { slug: string; content: string };
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed: SeedDoc[];
  steps: Step[];
  /** journal.append の何回目（場面の通し・1 から）を投げさせるか */
  journalFailsAt?: number[];
  /** 渡すと runtime（セッション構築時点に焼いた記憶の文字数）を持った器にする */
  injectedMemoryChars?: number;
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const HUMAN_ISO = '2026-10-28T00:00:00.000Z';
const PIN_URL = new URL('./clone-tools-memory-section-move-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_MEMORY_SECTION_MOVE_PIN === '1';

/** 呼びの n 番目（0 始まり）の時刻。基準の 1 分後から 1 分ずつ進む */
function callTime(index: number): string {
  return new Date(Date.parse(BASE_ISO) + (index + 1) * 60_000).toISOString();
}

// ---- 記憶の本文（入力。節id はここから決まる） ----

const SRC = [
  '---',
  'description: 私について',
  'type: premise',
  '---',
  '# 私について',
  '芯である。',
  '',
  '## 事例',
  '事例の本文である。',
  '',
  '### だから',
  '子の節である。',
  '',
  '## 次',
  '残る節である。',
  '',
].join('\n');

const MULTI = [
  '---',
  'description: 複数節',
  'type: premise',
  '---',
  '# 表紙',
  '芯である。',
  '',
  '## 節A',
  '節Aの本文である。',
  '',
  '## 節B',
  '節Bの本文である。',
  '',
  '## 節C',
  '節Cの本文である。',
  '',
].join('\n');

const DUP = '# A\n本文\n\n# A\n本文\n\n# B\n終わり\n';

const BROKEN = '---\ndescription: 閉じが無い\n# 見出し\n本文\n';

const ODD = [
  '---',
  'type:  premise',
  'description:   私について',
  '---',
  '# A',
  '本文',
  '',
  '# B',
  '本文',
  '',
].join('\n');

const FENCED = [
  '# ログ',
  '',
  '## 例',
  '```sh',
  '## これは見出しではない',
  'echo hi',
  '```',
  '本文E',
  '',
  '## 次',
  '本文F',
  '',
].join('\n');

const SOLE = '# 唯一\n本文\n';

const JUMPY = [
  '---',
  'description: 階層が飛んでいる文書',
  'type: premise',
  '---',
  '# 表紙',
  '芯である。',
  '',
  '## 親の話題',
  '親の本文である。',
  '',
  '#### 無関係な規則（### を挟んでいない）',
  '無関係な本文である。',
  '',
  '## 次',
  '残る節である。',
  '',
].join('\n');

const JUMPY_MANY = [
  '---',
  'description: 階層が何度も飛んでいる文書',
  'type: premise',
  '---',
  '# 表紙',
  '芯である。',
  '',
  '## 親の話題',
  '親の本文である。',
  '',
  ...Array.from({ length: 16 }, (_, index) => {
    const pad = String(index).padStart(2, '0');
    return `#### 飛んだ子${pad}（### を挟んでいない）\n子の本文${pad}である。\n`;
  }),
  '## 次',
  '残る節である。',
  '',
].join('\n');

function sectionsOf(count: number, headingTail: string, body: string): string {
  return Array.from({ length: count }, (_, index) => {
    const pad = String(index).padStart(3, '0');
    return `# 節${pad}: ${headingTail}\n\n本文${pad}: ${body}\n`;
  }).join('\n');
}

/** 一覧の予算（2,000字）を越える節数（fact。目次は焼かれない） */
const LIST_MANY = `---\ndescription: 節の多い文書\ntype: fact\n---\n${sectionsOf(30, 'み'.repeat(60), 'あ'.repeat(40))}`;

/** 焼き込みの目次の予算（6,000字）に張り付く節数（premise） */
const BIG_TOC = `---\ndescription: 目次が予算に張り付いた文書\ntype: premise\n---\n${sectionsOf(100, 'み'.repeat(60), 'あ'.repeat(30))}`;

const FACT_APPENDIX = '---\ntype: fact\ndescription: 付録\n---\n# 付録\n既存の本文\n';
const PREMISE_APPENDIX = '---\ntype: premise\ndescription: 付録\n---\n# 付録\n既存の本文\n';
const PLAIN_APPENDIX = '# 付録\n既存の本文\n';

/** 文書の中の見出しの節の本文（節の範囲そのまま）。移し先に「既に在る」節を作るために使う */
function sectionText(content: string, heading: string): string {
  const found = scanMemorySections(content).sections.find((section) => section.heading === heading);
  if (found === undefined) throw new Error(`見出し ${heading} の節が無い`);
  return content.slice(found.start, found.end);
}

/** 節id（本文から決まる。同じ見出しが複数あるときは nth 番目） */
function idOf(content: string, heading: string, nth = 0): string {
  const hits = scanMemorySections(content).sections.filter(
    (section) => section.heading === heading,
  );
  const found = hits[nth];
  if (found === undefined) throw new Error(`見出し ${heading} の節が無い（${String(nth)} 番目）`);
  return found.id;
}

/** 節id のうち、見出しの部分は同じで中身の部分だけ違う id（「古い」と判定される） */
function staleOf(id: string): string {
  return `${id.split('-')[0] ?? ''}-00000000`;
}

const ABSENT = 'deadbeef-cafebabe';

const SRC_EVENT = idOf(SRC, '## 事例');
const SRC_CHILD = idOf(SRC, '### だから');
const SRC_NEXT = idOf(SRC, '## 次');
const MULTI_A = idOf(MULTI, '## 節A');
const MULTI_B = idOf(MULTI, '## 節B');
const MULTI_C = idOf(MULTI, '## 節C');
const DUP_FIRST = idOf(DUP, '# A', 0);
const DUP_B = idOf(DUP, '# B');

function move(fromSlug: string, sections: string[], toSlug: string, summary = '移した'): Args {
  return { fromSlug, sections, toSlug, summary };
}

const SCENARIOS: Scenario[] = [
  // ---- 引数の検査 ----
  {
    name: 'arg-errors',
    covers:
      'from／to の slug が不正（英大文字・空白・空）・sections が空配列・from と to が同じ・検査の優先順（from の slug → to の slug → sections → 同じ文書）。どれも何も変わらない',
    seed: [{ slug: 'about-me', content: SRC }],
    steps: [
      { args: move('Bad Slug', [SRC_EVENT], 'about-me-appendix'), writes: 'none' },
      { args: move('about-me', [SRC_EVENT], 'Bad/Slug'), writes: 'none' },
      { args: move('', [SRC_EVENT], 'about-me-appendix'), writes: 'none' },
      { args: move('about-me', [], 'about-me-appendix'), writes: 'none' },
      { args: move('about-me', [], 'about-me'), writes: 'none' },
      { args: move('about-me', [SRC_EVENT], 'about-me'), writes: 'none' },
      { args: move('BAD', [], 'WORSE'), writes: 'none' },
      { args: move('about-me', [], 'WORSE'), writes: 'none' },
    ],
  },
  // ---- 出どころ ----
  {
    name: 'source-missing',
    covers:
      '出どころの文書が無い（slug の打ち間違い）。移し先は作らない。同じ文書でないことの検査は先に通る',
    seed: [{ slug: 'about-me', content: SRC }],
    steps: [
      { args: move('nope', [ABSENT], 'somewhere'), writes: 'none' },
      { args: move('about-me-typo', [SRC_EVENT], 'about-me'), writes: 'none' },
    ],
  },
  {
    name: 'source-malformed',
    covers:
      '出どころの frontmatter が壊れている（malformed）。clone でも distill でも断る・移し先は作らない。節id の検査より先に断る',
    seed: [{ slug: 'broken', content: BROKEN }],
    steps: [
      { args: move('broken', [ABSENT], 'elsewhere'), writes: 'none' },
      {
        args: move('broken', [ABSENT], 'elsewhere'),
        writes: 'none',
        before: (hooks) => {
          hooks.cause = 'distill';
        },
      },
    ],
  },
  // ---- 節id の解決 ----
  {
    name: 'lookup-failures',
    covers:
      '節id が解決できない: 1件だけ（無い／古い／曖昧）は基本の文言のまま追加の行が出ない・2件以上（1件目の文言＋残りの内訳＋全件が見つかったときしか動かさない）・見つかった節と混ぜても1節も動かさない',
    seed: [
      { slug: 'dup', content: DUP },
      { slug: 'about-me', content: SRC },
    ],
    steps: [
      { args: move('dup', [ABSENT], 'dup-appendix'), writes: 'none' },
      { args: move('dup', [staleOf(DUP_B)], 'dup-appendix'), writes: 'none' },
      { args: move('dup', [DUP_FIRST], 'dup-appendix'), writes: 'none' },
      { args: move('dup', [DUP_B, staleOf(DUP_B)], 'dup-appendix'), writes: 'none' },
      { args: move('dup', [ABSENT, staleOf(DUP_B)], 'dup-appendix'), writes: 'none' },
      {
        args: move('dup', [ABSENT, staleOf(DUP_B), DUP_FIRST, 'baadf00d-01234567'], 'dup-appendix'),
        writes: 'none',
      },
      { args: move('dup', [DUP_FIRST, ABSENT, DUP_B], 'dup-appendix'), writes: 'none' },
      { args: move('about-me', [SRC_EVENT, ABSENT], 'about-me-appendix'), writes: 'none' },
    ],
  },
  {
    name: 'lookup-stale-after-edit',
    covers:
      '対象の節が外から書き換えられた後の同じ節id は古い扱いで断る（1文字も変わらない）。別の節の書き換えでは通る',
    seed: [{ slug: 'about-me', content: SRC }],
    steps: [
      {
        args: move('about-me', [SRC_EVENT], 'about-me-appendix'),
        writes: 'none',
        externalEdit: {
          slug: 'about-me',
          content: SRC.replace('事例の本文である', '事例の本文を直した'),
        },
      },
      {
        args: move('about-me', [SRC_EVENT], 'about-me-appendix'),
        writes: 'some',
        externalEdit: { slug: 'about-me', content: SRC.replace('残る節である', '残る節を直した') },
      },
    ],
  },
  // ---- 範囲の重なり ----
  {
    name: 'overlap',
    covers:
      '指定した節どうしの範囲が重なる: 親子を一緒に指す（どちらの順でも）・同じ節id を2回渡す。隣り合う兄弟は重ならない（断らない）',
    seed: [{ slug: 'about-me', content: SRC }],
    steps: [
      { args: move('about-me', [SRC_EVENT, SRC_CHILD], 'about-me-appendix'), writes: 'none' },
      { args: move('about-me', [SRC_CHILD, SRC_EVENT], 'about-me-appendix'), writes: 'none' },
      { args: move('about-me', [SRC_EVENT, SRC_EVENT], 'about-me-appendix'), writes: 'none' },
      { args: move('about-me', [SRC_EVENT, SRC_NEXT], 'about-me-appendix'), writes: 'some' },
    ],
  },
  // ---- 移せたとき ----
  {
    name: 'move-new-destination',
    covers:
      '移し先が無いので作る（入れ子の子ごと動く・新規作成の床の注記・runtime 無しで現在値）。続けて同じ呼びは節が無いので断る・兄弟の残りを既存の移し先へ足す',
    seed: [{ slug: 'about-me', content: SRC }],
    steps: [
      {
        args: move('about-me', [SRC_EVENT], 'about-me-appendix', '事例を付録へ移した'),
        writes: 'some',
      },
      {
        args: move('about-me', [SRC_EVENT], 'about-me-appendix', '事例を付録へ移した'),
        writes: 'none',
      },
      {
        args: move('about-me', [SRC_NEXT], 'about-me-appendix', '次を付録へ移した'),
        writes: 'some',
      },
    ],
  },
  {
    name: 'move-multi',
    covers:
      '複数節を1回で移す（渡した順ではなく文書に現れる順で移し先の末尾に並ぶ）・日誌は move_in／move_out の2件のまま・続けて残りの節を既存の移し先へ',
    seed: [{ slug: 'multi', content: MULTI }],
    steps: [
      {
        args: move('multi', [MULTI_C, MULTI_A], 'multi-appendix', '節A・Cを付録へ'),
        writes: 'some',
      },
      { args: move('multi', [MULTI_B], 'multi-appendix', '節Bも付録へ'), writes: 'some' },
    ],
  },
  {
    name: 'move-all-sections',
    covers:
      '出どころの全節を移す（表紙だけが残る）・出どころが見出し1節だけで移すと空になる文書（frontmatter 無し）',
    seed: [
      { slug: 'multi', content: MULTI },
      { slug: 'sole', content: SOLE },
    ],
    steps: [
      {
        args: move('multi', [MULTI_A, MULTI_B, MULTI_C], 'multi-appendix', '全部移した'),
        writes: 'some',
      },
      {
        args: move('sole', [idOf(SOLE, '# 唯一')], 'sole-appendix', '唯一の節を移した'),
        writes: 'some',
      },
    ],
  },
  {
    name: 'dest-kinds',
    covers:
      '移し先が既に在る文書: fact（床が減る・順位の言い方）・premise・frontmatter 無し。出どころが premise／fact／frontmatter 無し',
    seed: [
      { slug: 'src-premise', content: SRC },
      { slug: 'dest-fact', content: FACT_APPENDIX },
      { slug: 'src-multi', content: MULTI },
      { slug: 'dest-premise', content: PREMISE_APPENDIX },
      { slug: 'src-fenced', content: FENCED },
      { slug: 'dest-plain', content: PLAIN_APPENDIX },
      { slug: 'src-fact', content: LIST_MANY },
      { slug: 'dest-fact2', content: FACT_APPENDIX },
    ],
    steps: [
      { args: move('src-premise', [SRC_EVENT], 'dest-fact'), writes: 'some' },
      { args: move('src-multi', [MULTI_B], 'dest-premise'), writes: 'some' },
      { args: move('src-fenced', [idOf(FENCED, '## 例')], 'dest-plain'), writes: 'some' },
      {
        args: move('src-fact', [idOf(LIST_MANY, '# 節000: ' + 'み'.repeat(60))], 'dest-fact2'),
        writes: 'some',
      },
    ],
  },
  {
    name: 'byte-exact',
    covers:
      '出どころの frontmatter がバイト同一（キーの順序・空白も含む）・コードフェンスの中の見出しを境界にしない',
    seed: [
      { slug: 'odd', content: ODD },
      { slug: 'log', content: FENCED },
    ],
    steps: [
      { args: move('odd', [idOf(ODD, '# A')], 'odd-appendix'), writes: 'some' },
      { args: move('log', [idOf(FENCED, '## 例')], 'log-appendix'), writes: 'some' },
    ],
  },
  // ---- 警告・省略 ----
  {
    name: 'hierarchy-jump',
    covers:
      '移した節の子孫に階層飛び（## → ####）が在ると警告が付く（断らない）・件数が多いと一覧が予算で省略される',
    seed: [
      { slug: 'jumpy', content: JUMPY },
      { slug: 'jumpy-many', content: JUMPY_MANY },
    ],
    steps: [
      { args: move('jumpy', [idOf(JUMPY, '## 親の話題')], 'jumpy-appendix'), writes: 'some' },
      {
        args: move('jumpy-many', [idOf(JUMPY_MANY, '## 親の話題')], 'jumpy-many-appendix'),
        writes: 'some',
      },
    ],
  },
  {
    name: 'listing-budget',
    covers:
      '移した節の一覧が予算（2,000字）を越える: 一覧の省略（ほか N 節・移動は済んでいる）。少数なら省略なし',
    seed: [{ slug: 'many', content: LIST_MANY }],
    steps: [
      {
        args: move(
          'many',
          scanMemorySections(LIST_MANY).sections.map((section) => section.id),
          'many-appendix',
          '全部移した',
        ),
        writes: 'some',
      },
    ],
  },
  {
    name: 'listing-few',
    covers: '節が多い文書から2節だけ移す（一覧は省略されない）',
    seed: [{ slug: 'many', content: LIST_MANY }],
    steps: [
      {
        args: move(
          'many',
          scanMemorySections(LIST_MANY)
            .sections.slice(0, 2)
            .map((section) => section.id),
          'many-appendix',
          '2節だけ移した',
        ),
        writes: 'some',
      },
    ],
  },
  {
    name: 'outline-saturation',
    covers:
      '焼き込みの目次の予算（6,000字）に張り付いた premise: 張り付いたまま揺れる回・張り付きが外れる回・移し先が予算を越える回の床の注記',
    seed: [{ slug: 'big-toc', content: BIG_TOC }],
    steps: [
      {
        args: move(
          'big-toc',
          scanMemorySections(BIG_TOC)
            .sections.slice(0, 20)
            .map((section) => section.id),
          'big-toc-appendix',
          '20節を付録へ',
        ),
        writes: 'some',
      },
      {
        args: move(
          'big-toc',
          scanMemorySections(BIG_TOC)
            .sections.slice(20, 90)
            .map((section) => section.id),
          'big-toc-appendix',
          '70節を付録へ',
        ),
        writes: 'some',
      },
    ],
  },
  // ---- runtime ----
  {
    name: 'runtime-grows',
    covers:
      'runtime（セッション構築時点の記憶の文字数）が在る器: 構築時点が移した後の総量より小さい（増える見込み・割合）。続けて2回目も同じ構築時点との差で出る',
    seed: [{ slug: 'about-me', content: SRC }],
    injectedMemoryChars: 100,
    steps: [
      { args: move('about-me', [SRC_EVENT], 'about-me-appendix'), writes: 'some' },
      { args: move('about-me', [SRC_NEXT], 'about-me-appendix'), writes: 'some' },
    ],
  },
  {
    name: 'runtime-zero',
    covers: 'runtime の構築時点が0文字（割合は出せない旨）',
    seed: [{ slug: 'about-me', content: SRC }],
    injectedMemoryChars: 0,
    steps: [{ args: move('about-me', [SRC_EVENT], 'about-me-appendix'), writes: 'some' }],
  },
  {
    name: 'runtime-shrinks',
    covers: 'runtime の構築時点が大きい（減る見込み）',
    seed: [{ slug: 'about-me', content: SRC }],
    injectedMemoryChars: 1_000_000,
    steps: [{ args: move('about-me', [SRC_EVENT], 'about-me-appendix'), writes: 'some' }],
  },
  // ---- 誰の走行か・保護 ----
  {
    name: 'guard-distill',
    covers:
      '統合の走行（distill）からも通る: clone-only／人間が触った印つきの出どころ（保護状態 human）・移し先が人間の印つき。日誌の cause は distill',
    seed: [
      { slug: 'human-doc', content: SRC, human: true },
      { slug: 'clone-doc', content: MULTI },
      { slug: 'human-dest', content: PLAIN_APPENDIX, human: true },
    ],
    steps: [
      {
        args: move('human-doc', [SRC_EVENT], 'human-doc-appendix'),
        writes: 'some',
        before: (hooks) => {
          hooks.cause = 'distill';
        },
      },
      {
        args: move('clone-doc', [MULTI_A], 'human-dest'),
        writes: 'some',
        before: (hooks) => {
          hooks.cause = 'distill';
        },
      },
      {
        args: move('human-doc', [SRC_NEXT], 'human-doc-appendix'),
        writes: 'some',
        before: (hooks) => {
          hooks.cause = 'clone';
        },
      },
    ],
  },
  // ---- 移し先に同じ節が既に在る（冪等） ----
  {
    name: 'dest-already-has',
    covers:
      '移し先に同じ節id が既に在る: 一部だけ（既に在る節は追記しない・応答に名乗る・移し先の日誌の要約に注記）・全部（追記しない・切り取りだけ。日誌は move_out の1件で要約に注記）',
    seed: [
      { slug: 'multi', content: MULTI },
      { slug: 'dest-some', content: `${PLAIN_APPENDIX}\n${sectionText(MULTI, '## 節A')}` },
      { slug: 'multi2', content: MULTI },
      {
        slug: 'dest-all',
        content: `${PLAIN_APPENDIX}\n${sectionText(MULTI, '## 節B')}${sectionText(MULTI, '## 節C')}`,
      },
    ],
    steps: [
      { args: move('multi', [MULTI_A, MULTI_B], 'dest-some', '節A・Bを移す'), writes: 'some' },
      { args: move('multi2', [MULTI_B, MULTI_C], 'dest-all', '節B・Cを移す'), writes: 'some' },
    ],
  },
  // ---- 出どころの書き込みが失敗する ----
  {
    name: 'from-write-fails',
    covers:
      '移し先へ足した後に出どころの書き込みが落ちる（半完了。重複しているが失われていない・日誌は move_in だけ）→ 直して同じ呼びをやり直す（既に在るので追記しない・切り取りだけ）→ もう一度やると節が無い',
    seed: [{ slug: 'multi', content: MULTI }],
    steps: [
      {
        args: move('multi', [MULTI_A, MULTI_B], 'multi-appendix', '節A・Bをまとめる'),
        writes: 'some',
        before: (hooks) => {
          hooks.failWriteSlug = 'multi';
        },
      },
      {
        args: move('multi', [MULTI_A, MULTI_B], 'multi-appendix', '節A・Bをまとめる'),
        writes: 'some',
        before: (hooks) => {
          hooks.failWriteSlug = null;
        },
      },
      {
        args: move('multi', [MULTI_A, MULTI_B], 'multi-appendix', '節A・Bをまとめる'),
        writes: 'none',
      },
    ],
  },
  {
    name: 'from-write-fails-dedup',
    covers:
      '出どころの書き込みが落ち、移し先には一部が既に在った（今回追記した分は両方に在る・既に在った分は増えていない旨）',
    seed: [
      { slug: 'multi', content: MULTI },
      { slug: 'dest-some', content: `${PLAIN_APPENDIX}\n${sectionText(MULTI, '## 節A')}` },
    ],
    steps: [
      {
        args: move('multi', [MULTI_A, MULTI_B], 'dest-some', '節A・Bを移す'),
        writes: 'some',
        before: (hooks) => {
          hooks.failWriteSlug = 'multi';
        },
      },
    ],
  },
  {
    name: 'from-write-fails-nothing-appended',
    covers:
      '移し先に全部既に在って何も追記せず、出どころの書き込みも落ちる（何も追記していない・重複は増えていない。何も書き込みは起きない）',
    seed: [
      { slug: 'multi', content: MULTI },
      {
        slug: 'dest-all',
        content: `${PLAIN_APPENDIX}\n${sectionText(MULTI, '## 節B')}${sectionText(MULTI, '## 節C')}`,
      },
    ],
    steps: [
      {
        args: move('multi', [MULTI_B, MULTI_C], 'dest-all', '節B・Cを移す'),
        writes: 'none',
        before: (hooks) => {
          hooks.failWriteSlug = 'multi';
        },
      },
    ],
  },
  // ---- 版の食い違い（読んでから切り取るまでの間に変わる） ----
  {
    name: 'version-conflict',
    covers:
      '出どころを読んだ後・切り取る前に誰かが書き換えた（版の食い違い）: 移し先へは追記済みで重複が残る旨・日誌は move_in だけ・出どころは書き換えた人の内容のまま。全部既に在る移し先なら何も追記せず「何も追記していない」の文言',
    seed: [
      { slug: 'about-me', content: SRC },
      {
        slug: 'dest-all',
        content: `${PLAIN_APPENDIX}\n${sectionText(SRC, '## 次')}`,
      },
      { slug: 'src2', content: SRC },
    ],
    steps: [
      {
        args: move('about-me', [SRC_EVENT], 'about-me-appendix'),
        writes: 'some',
        before: (hooks) => {
          hooks.raceOnRead = {
            slug: 'about-me',
            content: SRC.replace('残る節である', '人間が直した節である'),
          };
        },
      },
      {
        // 状態が変わるのは割り込んだ側の書き込みだけ（道具は何も書かない: 日誌は空・移し先は呼ぶ前のまま。下の目印で確かめる）
        args: move('src2', [SRC_NEXT], 'dest-all', '次を移す'),
        writes: 'some',
        before: (hooks) => {
          hooks.raceOnRead = {
            slug: 'src2',
            content: SRC.replace('事例の本文である', '人間が直した事例である'),
          };
        },
      },
    ],
  },
  // ---- 日誌が書けない ----
  {
    name: 'journal-fails-move-in',
    covers:
      '移し先への追記の日誌（move_in）が書けない: 半完了（出どころはまだ切っていない・日誌は空・やり直し禁止の応答）→ 日誌が戻ってから同じ呼びをやり直す',
    seed: [{ slug: 'multi', content: MULTI }],
    journalFailsAt: [1],
    steps: [
      {
        args: move('multi', [MULTI_A, MULTI_B], 'multi-appendix', '節A・Bをまとめる'),
        writes: 'some',
      },
      {
        args: move('multi', [MULTI_A, MULTI_B], 'multi-appendix', '節A・Bをまとめる'),
        writes: 'some',
      },
    ],
  },
  {
    name: 'journal-fails-move-out',
    covers:
      '出どころの切り取りの日誌（move_out）が書けない: 完了済み・日誌は move_in の1件だけ・やり直し禁止の応答',
    seed: [{ slug: 'multi', content: MULTI }],
    journalFailsAt: [2],
    steps: [
      {
        args: move('multi', [MULTI_A, MULTI_B], 'multi-appendix', '節A・Bをまとめる'),
        writes: 'some',
      },
    ],
  },
];

function stepKey(scenario: Scenario, index: number): string {
  return scenario.steps.length === 1 ? scenario.name : `${scenario.name}#${String(index + 1)}`;
}

const ALL_KEYS: string[] = SCENARIOS.flatMap((scenario) =>
  scenario.steps.map((_, index) => stepKey(scenario, index)),
);

// ---- 記録の形 ----

interface PinnedOutput {
  length: number;
  text: string;
  isError: boolean;
  /** 道具が例外を投げて返ったか（その場合 text は例外の message） */
  thrown: boolean;
}

/** ストアから読める形のまま（`persona.read` の中身）に、版（memoryVersion）を足したもの */
type PinnedDoc = Record<string, unknown> & { content: string; version: string };

interface PinnedStep {
  output: PinnedOutput;
  wrote: boolean;
  /** 場面で触れた記憶（呼んだあと）。無ければ null */
  memory: Record<string, PinnedDoc | null>;
  /** 呼んだあとに日誌へ足された行 */
  journal: Record<string, unknown>[];
}

interface PinFile {
  /** 場面ごとの出力の字数の一覧（`output.length`）。どの場面が何字を出しているかを1か所で読む */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedStep>;
}

const RUNTIME_BASE: CloneRuntimeFacts = {
  revision: { commit: null, short: null, source: null },
  buildTime: { builtAt: null },
  declaredModel: 'fable',
  modelOverridden: false,
  modelEnvKey: 'ALTEROID_CLONE_MODEL',
  sdkModel: null,
  effort: null,
  requestedEffort: null,
  claudeCodeVersion: null,
  apiKeySource: null,
  permissionMode: null,
  requestedPermissionMode: 'auto',
  mcpServers: [],
  sessionId: null,
  resumedFrom: null,
  injectedMemoryChars: heuristicChars(0),
  systemPromptChars: heuristicChars(0),
  lastContextUsage: null,
};

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function readDoc(stores: Stores, slug: string): Promise<PinnedDoc | null> {
  const doc = await stores.persona.read(slug);
  if (doc === null) return null;
  return plain({ ...doc, version: memoryVersion(doc.content) }) as PinnedDoc;
}

/** 場面の呼びの引数に出てくる、記憶として読める slug（不正な slug は読まない） */
function watchedSlugs(scenario: Scenario): string[] {
  const slugs = new Set<string>(scenario.seed.map((doc) => doc.slug));
  for (const step of scenario.steps) {
    for (const key of ['fromSlug', 'toSlug']) {
      const value = step.args[key];
      if (typeof value === 'string' && /^[a-z0-9._-]+$/.test(value)) slugs.add(value);
    }
  }
  return [...slugs].sort();
}

async function snapshot(
  stores: Stores,
  slugs: readonly string[],
): Promise<{ memory: Record<string, PinnedDoc | null>; all: unknown; journal: unknown[] }> {
  const memory: Record<string, PinnedDoc | null> = {};
  for (const slug of slugs) memory[slug] = await readDoc(stores, slug);
  return {
    memory,
    all: plain(await stores.persona.documents()),
    journal: plain(await stores.journal.list({ order: 'asc' })) as unknown[],
  };
}

function withHooks(base: Stores, hooks: Hooks, failJournalAt: readonly number[]): Stores {
  let journalCalls = 0;
  // 呼びごとに仕込む割り込みを、その呼びの中で1度だけ起こす（仕込みごとに別の目印）
  let raced: Hooks['raceOnRead'] = null;
  const persona: Stores['persona'] = {
    ...base.persona,
    read: async (slug) => {
      const doc = await base.persona.read(slug);
      const race = hooks.raceOnRead;
      if (race !== null && raced !== race && slug === race.slug) {
        raced = race;
        await base.persona.write(race.slug, race.content);
      }
      return doc;
    },
    write: async (slug, content, options) => {
      if (hooks.failWriteSlug === slug) throw new Error('ストアが落ちた');
      return base.persona.write(slug, content, options);
    },
  };
  return {
    ...base,
    persona,
    journal: {
      ...base.journal,
      append: (entry) => {
        journalCalls += 1;
        if (failJournalAt.includes(journalCalls)) return Promise.reject(new Error('日誌が落ちた'));
        return base.journal.append(entry);
      },
    },
  };
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(BASE_ISO));
  for (const doc of scenario.seed) {
    await base.persona.write(doc.slug, doc.content);
    if (doc.human === true) await base.persona.markHumanTouched(doc.slug, HUMAN_ISO);
  }
  const hooks: Hooks = { cause: 'clone', failWriteSlug: null, raceOnRead: null };
  const stores = withHooks(base, hooks, scenario.journalFailsAt ?? []);
  const injected = scenario.injectedMemoryChars;
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => hooks.cause,
    conversationId: () => undefined,
    ...(injected === undefined
      ? {}
      : {
          runtime: () => ({ ...RUNTIME_BASE, injectedMemoryChars: heuristicChars(injected) }),
        }),
  });
  const found = tools.find((entry) => entry.name === 'memory_section_move');
  if (!found) throw new Error('memory_section_move が無い');

  const slugs = watchedSlugs(scenario);
  const results: PinnedStep[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    if (step.externalEdit !== undefined) {
      vi.setSystemTime(new Date(callTime(index)));
      await base.persona.write(step.externalEdit.slug, step.externalEdit.content);
    }
    const before = await snapshot(base, slugs);
    hooks.raceOnRead = null;
    step.before?.(hooks);
    vi.setSystemTime(new Date(callTime(index)));
    let output: PinnedOutput;
    try {
      const result = await found.handler(step.args as never, {});
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      output = { length: text.length, text, isError: result.isError === true, thrown: false };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      output = { length: text.length, text, isError: true, thrown: true };
    }
    // 次の呼びへ口を持ち越さない（この呼びの仕込みだけが効く）
    hooks.raceOnRead = null;
    const after = await snapshot(base, slugs);
    const wrote =
      JSON.stringify(before.all) !== JSON.stringify(after.all) ||
      before.journal.length !== after.journal.length;
    results.push({
      output,
      wrote,
      memory: after.memory,
      journal: after.journal.slice(before.journal.length) as Record<string, unknown>[],
    });
    if (step.writes === 'none') {
      // 書き込みが起きなかった呼びは、記憶が呼ぶ前と同じ（ここで確かめる。json にも「呼んだあと」が残る）
      expect(
        after.all,
        `場面 ${stepKey(scenario, index)} は書き込みが起きないはずだが、記憶が呼ぶ前から変わった`,
      ).toEqual(before.all);
      expect(
        after.journal.length,
        `場面 ${stepKey(scenario, index)} は書き込みが起きないはずだが、日誌に行が足された`,
      ).toBe(before.journal.length);
    }
  }
  return results;
}

async function runAll(): Promise<Record<string, PinnedStep>> {
  const out: Record<string, PinnedStep> = {};
  for (const scenario of SCENARIOS) {
    const results = await runScenario(scenario);
    for (const [index, result] of results.entries()) out[stepKey(scenario, index)] = result;
  }
  return out;
}

describe('memory_section_move の出力と呼んだあとの状態の固定（場面ごとの出力の全文・記憶の本文・日誌の行）', () => {
  let actual: Record<string, PinnedStep> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(BASE_ISO));
    actual = await runAll();
    if (UPDATE) {
      const file: PinFile = {
        lengths: Object.fromEntries(ALL_KEYS.map((key) => [key, actual[key]?.output.length ?? -1])),
        scenarios: actual,
      };
      writeFileSync(PIN_URL, `${JSON.stringify(file, null, 2)}\n`);
    }
    pinned = JSON.parse(readFileSync(PIN_URL, 'utf8')) as PinFile;
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('空振りでない（場面が在り、固定値と実際の場面の名前の並びが同じ）', () => {
    expect(
      Object.keys(pinned.scenarios).length,
      '固定値が空である。この歯は何も測っていない',
    ).toBeGreaterThan(0);
    expect(Object.keys(actual)).toEqual(ALL_KEYS);
    expect(Object.keys(pinned.scenarios)).toEqual(ALL_KEYS);
    for (const key of ALL_KEYS) {
      expect(actual[key]?.output.text.length, `${key} が空の出力である`).toBeGreaterThan(0);
    }
  });

  it('場面ごとの出力の字数の一覧が固定値と同じ（どの場面の字数が動いたかを1か所で読む）', () => {
    const lengths = Object.fromEntries(
      ALL_KEYS.map((key) => [key, actual[key]?.output.length ?? -1]),
    );
    expect(lengths).toEqual(pinned.lengths);
  });

  it('固定値の字数が、固定値の全文の長さと合っている（json を手で書き換えていない）', () => {
    for (const [key, entry] of Object.entries(pinned.scenarios)) {
      expect(entry.output.text.length, `${key}: json の length と text.length が食い違う`).toBe(
        entry.output.length,
      );
      expect(pinned.lengths[key], `${key}: lengths の一覧と食い違う`).toBe(entry.output.length);
    }
  });

  it('書き込みが起きなかったと宣言した場面は、実際にも書き込みが起きていない（その逆も）', () => {
    for (const scenario of SCENARIOS) {
      for (const [index, step] of scenario.steps.entries()) {
        const key = stepKey(scenario, index);
        expect(actual[key]?.wrote, `${key}: 書き込みの有無が宣言と違う`).toBe(
          step.writes === 'some',
        );
      }
    }
  });

  describe.each(SCENARIOS)('場面 $name', (scenario) => {
    for (const [index] of scenario.steps.entries()) {
      const key = stepKey(scenario, index);

      it(`${key} の出力が固定値と同じ（${scenario.covers}）`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(got, `${key} が実際の出力に無い`).toBeDefined();
        // 先に字数を比べて、どの場面が何字から何字へ動いたかを文言に出す
        expect(
          got?.output.text.length,
          `場面 ${key} の出力の字数が変わった: 固定値 ${String(want?.output.length)} 字 → いま ${String(got?.output.text.length)} 字`,
        ).toBe(want?.output.length);
        expect(
          got?.output.text,
          `場面 ${key} の出力が固定値からずれた（字数は ${String(got?.output.text.length)} 字で同じ）`,
        ).toBe(want?.output.text);
        expect(
          { isError: got?.output.isError, thrown: got?.output.thrown },
          `場面 ${key} の出力の isError／例外で返ったか、が変わった`,
        ).toEqual({ isError: want?.output.isError, thrown: want?.output.thrown });
      });

      it(`${key} の呼んだあとの記憶が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          Object.keys(got?.memory ?? {}),
          `場面 ${key} の記憶: 見ている slug の並びが変わった`,
        ).toEqual(Object.keys(want?.memory ?? {}));
        for (const [slug, wantDoc] of Object.entries(want?.memory ?? {})) {
          const gotDoc = got?.memory[slug] ?? null;
          expect(gotDoc === null, `場面 ${key} の記憶 ${slug}: 文書が有る／無いが変わった`).toBe(
            wantDoc === null,
          );
          if (wantDoc === null || gotDoc === null) continue;
          expect(
            gotDoc.content.length,
            `場面 ${key} の記憶 ${slug} の本文の字数が変わった: 固定値 ${String(wantDoc.content.length)} 字 → いま ${String(gotDoc.content.length)} 字`,
          ).toBe(wantDoc.content.length);
          expect(
            gotDoc.content,
            `場面 ${key} の記憶 ${slug} の本文が固定値からずれた（字数は ${String(gotDoc.content.length)} 字で同じ）`,
          ).toBe(wantDoc.content);
          expect(
            gotDoc,
            `場面 ${key} の記憶 ${slug} の本文以外（版・frontmatter・updatedAt など）が固定値からずれた`,
          ).toEqual(wantDoc);
        }
      });

      it(`${key} の呼んだあとに日誌へ足された行が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.journal.length,
          `場面 ${key} の日誌: 足された行の数が変わった: 固定値 ${String(want?.journal.length)} 行 → いま ${String(got?.journal.length)} 行`,
        ).toBe(want?.journal.length);
        expect(
          got?.journal,
          `場面 ${key} の日誌: 足された行（種類・本文・id・at）が固定値からずれた`,
        ).toEqual(want?.journal);
        expect(got?.wrote, `場面 ${key} の書き込みの有無が変わった`).toBe(want?.wrote);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・記憶・日誌になる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.output.text ?? '';
    const journal = (key: string): Record<string, unknown>[] => actual[key]?.journal ?? [];
    const doc = (key: string, slug: string): string => actual[key]?.memory[slug]?.content ?? '';
    expect(text('arg-errors#1')).toContain('記憶のスラッグが不正: Bad Slug');
    expect(text('arg-errors#2')).toContain('記憶のスラッグが不正: Bad/Slug');
    expect(text('arg-errors#4')).toContain('sections');
    expect(text('arg-errors#5')).toContain('sections');
    expect(text('arg-errors#6')).toContain('同じ文書');
    expect(text('arg-errors#7')).toContain('不正: BAD');
    expect(text('arg-errors#8')).toContain('不正: WORSE');
    expect(text('source-missing#1')).toContain('は存在しない');
    expect(text('source-malformed#1')).toContain('malformed');
    expect(text('source-malformed#2')).toContain('malformed');
    expect(text('lookup-failures#1')).toContain('打ち間違い');
    expect(text('lookup-failures#2')).toContain('書き換えている');
    expect(text('lookup-failures#3')).toContain('選ばずに断る');
    expect(text('lookup-failures#4')).not.toContain('ほかにも解決できなかった');
    expect(text('lookup-failures#4')).toContain('この口は全件が見つかったときしか動かさない');
    expect(text('lookup-failures#6')).toContain(
      'ほかにも解決できなかった節id が 3 件ある（無い 1 件・古い 1 件・曖昧 1 件）。',
    );
    expect(text('lookup-failures#7')).toContain(
      'ほかにも解決できなかった節id が 1 件ある（無い 1 件・古い 0 件・曖昧 0 件）。',
    );
    expect(text('lookup-stale-after-edit#1')).toContain('書き換えている');
    expect(text('lookup-stale-after-edit#2')).toContain('を about-me-appendix の末尾へ移した');
    expect(text('overlap#1')).toContain('重なっている');
    expect(text('overlap#3')).toContain('重なっている');
    expect(text('overlap#4')).toContain('を about-me-appendix の末尾へ移した');
    expect(text('move-new-destination#1')).toContain('新規作成: about-me-appendix');
    expect(text('move-new-destination#2')).toContain('節は無い');
    expect(journal('move-new-destination#1').map((row) => row.action)).toEqual([
      'move_in',
      'move_out',
    ]);
    expect(text('move-new-destination#1')).toContain('現在値である');
    expect(text('move-multi#1')).toContain('2 節');
    expect(doc('move-multi#1', 'multi-appendix').indexOf('## 節A')).toBeLessThan(
      doc('move-multi#1', 'multi-appendix').indexOf('## 節C'),
    );
    expect(text('dest-kinds#1')).toContain('毎ターンの床');
    expect(text('hierarchy-jump#1')).toContain('階層');
    expect(text('hierarchy-jump#2')).toContain('件は一覧から省略');
    expect(text('listing-budget')).toContain('節は一覧から省略');
    expect(text('listing-few')).not.toContain('節は一覧から省略');
    expect(text('outline-saturation#1')).toContain('張り付いている');
    expect(text('outline-saturation#2')).toMatch(/予算.*(切られなくなった|越えた)/);
    expect(text('runtime-grows#1')).toContain('増える見込み');
    expect(text('runtime-zero')).toContain('割合は出せない');
    expect(text('runtime-shrinks')).toContain('減る見込み');
    expect(journal('guard-distill#1').map((row) => row.cause)).toEqual(['distill', 'distill']);
    expect(journal('guard-distill#3').map((row) => row.cause)).toEqual(['clone', 'clone']);
    expect(text('dest-already-has#1')).toContain('既に在ったため、追記していない');
    expect(journal('dest-already-has#1')[0]?.summary).toContain('既に在ったため追記しなかった');
    expect(journal('dest-already-has#2').map((row) => row.action)).toEqual(['move_out']);
    expect(journal('dest-already-has#2')[0]?.summary).toContain('切り取りのみ行った');
    expect(text('from-write-fails#1')).toContain('重複しているが、失われてはいない');
    expect(journal('from-write-fails#1').map((row) => row.action)).toEqual(['move_in']);
    expect(text('from-write-fails#2')).toContain('既に在ったため、追記していない');
    expect(text('from-write-fails#3')).toContain('節は無い');
    expect(text('from-write-fails-dedup')).toContain('今回は追記していない（重複は増えていない）');
    expect(text('from-write-fails-nothing-appended')).toContain('今回は何も追記していない');
    expect(text('version-conflict#1')).toContain('その間に変わった');
    expect(text('version-conflict#1')).toContain('重複しているが、失われてはいない');
    expect(journal('version-conflict#2')).toEqual([]);
    expect(doc('version-conflict#2', 'dest-all')).toBe(
      `${PLAIN_APPENDIX}\n${sectionText(SRC, '## 次')}`,
    );
    expect(doc('version-conflict#2', 'src2')).toContain('人間が直した事例である');
    expect(text('version-conflict#2')).toContain('今回は何も追記していない');
    expect(text('version-conflict#2')).toContain('その間に変わった');
    expect(text('journal-fails-move-in#1').split('\n')[0]).toBe(
      '⚠⚠ 一部完了・未記録・やり直し禁止',
    );
    expect(text('journal-fails-move-out').split('\n')[0]).toBe('⚠⚠ 完了済み・未記録・やり直し禁止');
    expect(journal('journal-fails-move-out').map((row) => row.action)).toEqual(['move_in']);
  });
});
