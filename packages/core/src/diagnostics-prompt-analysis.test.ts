import { describe, expect, it } from 'vitest';

import {
  analyzePrompt,
  PROMPT_NO_REMOVAL_NOTE,
  splitSystemPromptSections,
  type PromptAnalysis,
  type PromptCharsCandidate,
  type PromptTokensCandidate,
} from './diagnostics-prompt-analysis.js';
import { renderPromptAnalysis } from './diagnostics-prompt-format.js';
import { parsePromptJson, type PromptInput } from './diagnostics-prompt-input.js';
import { exactTokens, heuristicChars, type ExactTokens, type HeuristicChars } from './quantity.js';
import { createSecretRedactor } from './secret-redaction.js';

// ダミーの鍵（どこの鍵でもない。繰り返しで作る）
const DUMMY_KEY = `ghp_${'a1B2'.repeat(9)}`;

// ---- 固定のフィクスチャ（GET /self/prompt の応答の形。値はダミー）----

const INTRO = '導入の文\n';
const SECTION_STANCE = '# あなたの立ち位置\n立ち位置の本文\n\n';
const SECTION_TOOLS = '# 道具\n```\n# 囲みの中の行は見出しではない\n```\n道具の本文\n\n';
const MEMORY_HEAD = '# 現在の記憶\n\n**これは索引である。**\n\n';
const INDEX_FRAGMENTS = ['a'.repeat(100), 'b'.repeat(40), 'c'.repeat(10)];
const TEXT = `${INTRO}${SECTION_STANCE}${SECTION_TOOLS}${MEMORY_HEAD}${INDEX_FRAGMENTS.join('\n')}\n`;
const MEMORY_SECTION_CHARS = MEMORY_HEAD.length + 100 + 1 + 40 + 1 + 10 + 1;

const documents = [
  // 並びはわざと大きい順にしない
  {
    slug: 'beta',
    type: 'premise',
    description: '要旨ベータ',
    chars: 800,
    indexChars: 40,
    indexForm: 'premise-card',
    omitted: false,
    indexNote: null,
  },
  {
    slug: 'alpha',
    type: 'premise',
    description: '要旨アルファ要旨アルファ',
    chars: 5000,
    indexChars: 100,
    indexForm: 'premise-card',
    omitted: false,
    indexNote: null,
  },
  {
    slug: 'gamma',
    type: 'fact',
    description: null,
    chars: 20,
    indexChars: 10,
    indexForm: 'toc-line',
    omitted: false,
    indexNote: null,
  },
  {
    slug: 'delta',
    type: 'note',
    description: null,
    chars: 9000,
    indexChars: null,
    indexForm: null,
    omitted: true,
    indexNote: '索引の予算を超えたので省いた',
  },
  {
    slug: 'eps',
    type: 'note',
    description: null,
    chars: 30,
    indexChars: null,
    indexForm: null,
    omitted: false,
    indexNote: '索引の中での長さを測れなかった',
  },
];

const tools = [
  { name: 'ask_human', source: 'clone', descriptionChars: 200, inputSchemaChars: 100 },
  { name: 'memory_read', source: 'clone', descriptionChars: 400, inputSchemaChars: 300 },
  { name: 'journal_write', source: 'clone', descriptionChars: 150, inputSchemaChars: 50 },
];

const axis = <T>(rows: T[], omitted = 0) => ({ available: true, value: { rows, omitted } });

const usageOk = {
  ok: true,
  at: '2026-11-13T09:30:00.000Z',
  totalTokens: 20000,
  rawMaxTokens: 200000,
  percentage: 10,
  autoCompactThreshold: 167000,
  isAutoCompactEnabled: true,
  categories: axis([
    { name: 'System prompt', tokens: 5000, kind: 'used' },
    { name: 'MCP tools', tokens: 3000, kind: 'used' },
    { name: 'Free space', tokens: 150000, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' },
    { name: 'Deferred tools', tokens: 700, kind: 'deferred' },
    { name: 'Mystery', tokens: 5, kind: 'future-kind' },
  ]),
  mcpTools: axis([
    { name: 'mcp__alteroid__memory_read', serverName: 'alteroid', tokens: 900, isLoaded: true },
    { name: 'mcp__alteroid__ask_human', serverName: 'alteroid', tokens: 300, isLoaded: true },
    { name: 'mcp__alteroid__ghost', serverName: 'alteroid', tokens: 77, isLoaded: true },
    { name: 'mcp__github__issue_create', serverName: 'github', tokens: 400, isLoaded: true },
    { name: 'mcp__github__pr_list', serverName: 'github', tokens: 100, isLoaded: null },
    { name: 'mcp__slack__post', serverName: 'slack', tokens: 250, isLoaded: false },
  ]),
  systemPromptSections: axis([
    { name: 'Intro', tokens: 300 },
    { name: 'Memory', tokens: 1200 },
  ]),
  memoryFiles: axis([{ path: '/work/CLAUDE.md', type: 'Project', tokens: 600 }]),
  systemTools: axis([
    { name: 'Read', tokens: 400 },
    { name: 'Bash', tokens: 1100 },
  ]),
  deferredBuiltinTools: axis([
    { name: 'WebFetch', tokens: 80, isLoaded: false },
    { name: 'NotebookEdit', tokens: 60, isLoaded: true },
  ]),
};

function bodyOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    full: true,
    session: {
      ok: true,
      builtAt: '2026-11-13T09:00:00.000Z',
      resumedFrom: null,
      sessionId: 'sess-0001',
      model: 'opus',
    },
    systemPrompt: { text: TEXT, chars: TEXT.length },
    memoryInPrompt: { documents, omittedDocuments: 3 },
    tools,
    builtinTools: {
      available: false,
      reason: 'SDK 組み込みの道具の定義（説明・入力スキーマ）は SDK が返さない',
      systemTools: usageOk.systemTools,
      deferredBuiltinTools: usageOk.deferredBuiltinTools,
    },
    externalMcpServers: [
      { name: 'github', type: 'http' },
      { name: 'slack', type: 'stdio' },
      { name: 'quiet', type: 'sse' },
    ],
    externalMcpServersLive: {
      at: '2026-11-13T09:10:00.000Z',
      failed: ['quiet'],
      retained: ['github', 'slack'],
    },
    plugins: [],
    contextUsage: usageOk,
    notice: ['記憶の文書のうち 1 件は、焼いた索引から省かれた', '秘密走査: 走査した（当たり0件）'],
    secretScan: { scanned: true, hits: [] },
    unknownFutureField: 'ok',
    ...over,
  };
}

function inputOf(over: Record<string, unknown> = {}): PromptInput {
  return parsePromptJson(JSON.stringify(bodyOf(over)));
}

const redactor = () => createSecretRedactor({ env: {} });

function run(
  over: Record<string, unknown> | PromptInput = {},
  extra: { topN?: number; pulledAt?: string | null } = {},
): PromptAnalysis {
  const r = redactor();
  const isInput = 'state' in over;
  return analyzePrompt({
    input: isInput ? (over as PromptInput) : inputOf(over),
    pulledAt: extra.pulledAt === undefined ? '2026-11-13T10:00:00.000Z' : extra.pulledAt,
    topN: extra.topN ?? 10,
    redact: (text) => r.redact(text),
  });
}

function readOf(over: Record<string, unknown> = {}, extra: Parameters<typeof run>[1] = {}) {
  const a = run(over, extra);
  if (a.state !== 'read') throw new Error(`読めるはずが ${a.state}: ${a.reason}`);
  return a;
}

const render = (a: PromptAnalysis, top = 10): string => renderPromptAnalysis(a, top);

describe('prompt.json の入力の検査', () => {
  it('未知の欄は許し、必須の欄が無い・型が違うときは落とさず「読めない」にする（値は理由に出さない）', () => {
    expect(inputOf().state).toBe('read');
    const missing = parsePromptJson(JSON.stringify({ ...bodyOf(), notice: undefined }));
    expect(missing.state).toBe('unreadable');
    const wrong = parsePromptJson(
      JSON.stringify({ ...bodyOf(), full: `dummy-value-${DUMMY_KEY}` }),
    );
    expect(wrong.state).toBe('unreadable');
    if (wrong.state === 'unreadable') {
      expect(wrong.reason).toContain('full');
      expect(wrong.reason).not.toContain(DUMMY_KEY);
    }
    const broken = parsePromptJson('{not json');
    expect(broken).toEqual({ state: 'unreadable', reason: 'JSON として読めない' });
    expect(parsePromptJson('[]').state).toBe('unreadable');
  });

  it('入力が無い・読めないときは、節を「入力が無い／読めない」と明記して出す（0 を置かない）', () => {
    const none = render(run({ state: 'none', reason: '--prompt も --dir も渡されていない' }));
    expect(none).toContain('入力が無い: --prompt も --dir も渡されていない');
    expect(none).toContain('取れない（0 ではない）');
    const unreadable = render(run({ state: 'unreadable', reason: 'JSON として読めない' }));
    expect(unreadable).toContain('読めない: JSON として読めない');
  });
});

describe('システムプロンプトの節ごとの大きさ', () => {
  it('splitSystemPromptSections: 行頭の「# 」で割り、導入を別にし、囲みの中の行を見出しにせず、合計が本文に一致する', () => {
    const sections = splitSystemPromptSections(TEXT);
    expect(sections.map((s) => s.heading)).toEqual([
      null,
      'あなたの立ち位置',
      '道具',
      '現在の記憶',
    ]);
    expect(sections.reduce((a, s) => a + s.chars, 0)).toBe(TEXT.length);
    expect(sections[0]?.chars).toBe(INTRO.length);
    expect(sections[2]?.chars).toBe(SECTION_TOOLS.length);
    // 「## 」は節を割らない
    expect(splitSystemPromptSections('# A\n## B\nx').map((s) => s.heading)).toEqual(['A']);
    expect(splitSystemPromptSections('')).toEqual([]);
  });

  it('full=1: 節ごとの文字数と全体に占める割合を出す', () => {
    const a = readOf();
    if (a.systemPrompt.state !== 'read' || a.systemPrompt.sections.state !== 'read') {
      throw new Error('節が読めるはず');
    }
    const rows = a.systemPrompt.sections.rows;
    expect(rows.map((r) => [r.heading, r.chars])).toEqual([
      [null, INTRO.length],
      ['あなたの立ち位置', SECTION_STANCE.length],
      ['道具', SECTION_TOOLS.length],
      ['現在の記憶', MEMORY_SECTION_CHARS],
    ]);
    expect(rows[1]?.share).toBeCloseTo(SECTION_STANCE.length / TEXT.length, 10);
    expect(a.systemPrompt.sections.textCharsDiffersFromChars).toBe(false);
    const text = render(a);
    expect(text).toContain('導入（最初の見出しより前）');
    expect(text).toContain('# あなたの立ち位置');
  });

  it('索引の突き合わせ: 索引の合計が節のどれだけかを出し、差を「その他」として丸めずに出す', () => {
    const a = readOf();
    if (a.systemPrompt.state !== 'read' || a.systemPrompt.memoryIndex.state !== 'read') {
      throw new Error('突き合わせが読めるはず');
    }
    const m = a.systemPrompt.memoryIndex;
    expect(m.indexCharsSum).toBe(150);
    expect(m.sectionChars).toBe(MEMORY_SECTION_CHARS);
    expect(m.difference).toBe(MEMORY_SECTION_CHARS - 150);
    expect(m.indexShareOfSection).toBeCloseTo(150 / MEMORY_SECTION_CHARS, 10);
    // indexChars が null の 2 文書は合計に入っていない
    expect(m.documentsWithoutIndexChars).toBe(2);
    expect(m.note).toContain(`その他 ${String(MEMORY_SECTION_CHARS - 150)} 字`);
    expect(render(a)).toContain('索引の長さが取れなかった（indexChars が null の）文書 2 件');
  });

  it('索引の突き合わせ: 合わない（索引の合計が節より大きい）ときは黙って丸めず、負の差と「合わない」を出す', () => {
    const big = documents.map((d) => (d.slug === 'alpha' ? { ...d, indexChars: 5000 } : d));
    const a = readOf({ memoryInPrompt: { documents: big, omittedDocuments: 0 } });
    if (a.systemPrompt.state !== 'read' || a.systemPrompt.memoryIndex.state !== 'read') {
      throw new Error('突き合わせが読めるはず');
    }
    const m = a.systemPrompt.memoryIndex;
    expect(m.difference).toBe(MEMORY_SECTION_CHARS - 5050);
    expect(m.difference).toBeLessThan(0);
    expect(m.note).toContain('合わない');
    expect(render(a)).toContain(
      `差 -${String(5050 - MEMORY_SECTION_CHARS).replace(/\B(?=(\d{3})+$)/g, ',')}字`,
    );
    // 合わないときは、記憶の節を文書ごとに分けず（二重に数えず）、節をそのまま候補に置く
    if (a.candidates.chars.state !== 'read') throw new Error('文字数の候補が読めるはず');
    const kinds = a.candidates.chars.rows.map((r) => r.kind);
    expect(kinds).not.toContain('memory-index');
    expect(a.candidates.chars.rows.some((r) => r.label.includes('索引と合わない'))).toBe(false);
  });

  it('「# 現在の記憶」の見出しが本文に無いときは、突き合わせを「取れない」と理由つきで言う', () => {
    const text = '# だけ\n本文\n';
    const a = readOf({ systemPrompt: { text, chars: text.length } });
    if (a.systemPrompt.state !== 'read') throw new Error('読めるはず');
    expect(a.systemPrompt.memoryIndex).toMatchObject({ state: 'unavailable' });
    expect(render(a)).toContain('本文に「# 現在の記憶」の見出しが無い');
  });

  it('full=0: 全体の chars だけを出し、節ごとは「取れない」と理由を書く（0 を置かない）', () => {
    const a = readOf({ full: false, systemPrompt: { chars: TEXT.length } });
    if (a.systemPrompt.state !== 'read') throw new Error('読めるはず');
    expect(a.systemPrompt.chars).toBe(TEXT.length);
    expect(a.systemPrompt.sections).toEqual({
      state: 'unavailable',
      reason: '本文が省かれている（full=0）。`pull` は既定で全文を取る',
    });
    expect(a.systemPrompt.memoryIndex.state).toBe('unavailable');
    const text = render(a);
    expect(text).toContain(`全体: ${TEXT.length}字`);
    expect(text).toContain(
      '節ごと: 取れない（本文が省かれている（full=0）。`pull` は既定で全文を取る）',
    );
    expect(text).toContain('full: 0（本文・道具の説明・入力スキーマが省かれている');
    expect(a.coverage.bodyOmitted).toBe(true);
    // 節ごとの行（「# 道具:」など）は出ない
    expect(text).not.toMatch(/^ {4}# /m);
  });

  it('contextUsage.systemPromptSections は SDK 実測のトークンとして別に並べる（大きい順。文字数と換算しない）', () => {
    const a = readOf();
    if (a.systemPrompt.state !== 'read' || a.systemPrompt.sdkSections.state !== 'read') {
      throw new Error('SDK の節が読めるはず');
    }
    expect(a.systemPrompt.sdkSections.rows.map((r) => [r.name, r.tokens])).toEqual([
      ['Memory', 1200],
      ['Intro', 300],
    ]);
    expect(a.systemPrompt.sdkSections.total).toBe(1500);
    expect(render(a)).toContain('Memory: 1,200トークン');
  });
});

describe('記憶の索引の文書ごとの大きさ', () => {
  it('indexChars の大きい順に、区分・索引全体に占める割合・本文に対する比・要旨の文字数を出す', () => {
    const a = readOf();
    if (a.memory.state !== 'read') throw new Error('読めるはず');
    expect(a.memory.rows.map((r) => r.slug)).toEqual(['alpha', 'beta', 'gamma']);
    const [alpha, beta, gamma] = a.memory.rows;
    expect(alpha).toMatchObject({ type: 'premise', indexChars: 100, chars: 5000 });
    expect(alpha?.shareOfIndex).toBeCloseTo(100 / 150, 10);
    expect(alpha?.indexOverBody).toBeCloseTo(100 / 5000, 10);
    expect(alpha?.descriptionChars).toBe('要旨アルファ要旨アルファ'.length);
    expect(beta?.shareOfIndex).toBeCloseTo(40 / 150, 10);
    expect(gamma?.descriptionChars).toBeNull();
    expect(a.memory.indexCharsSum).toBe(150);
    expect(a.memory.omittedDocuments).toBe(3);
    const text = render(a);
    expect(text.indexOf('alpha（premise）')).toBeLessThan(text.indexOf('beta（premise）'));
    expect(text).toContain('載せる件数の上限で切り捨てた文書 3 件（一覧に無い）');
  });

  it('omitted の文書と索引の長さが取れなかった文書は別枠に、indexNote つきで出す（indexChars を 0 にしない）', () => {
    const a = readOf();
    if (a.memory.state !== 'read') throw new Error('読めるはず');
    expect(a.memory.unindexed).toEqual([
      expect.objectContaining({
        slug: 'delta',
        omitted: true,
        indexNote: '索引の予算を超えたので省いた',
        chars: 9000,
      }),
      expect.objectContaining({
        slug: 'eps',
        omitted: false,
        indexNote: '索引の中での長さを測れなかった',
      }),
    ]);
    expect(a.memory.rows.map((r) => r.slug)).not.toContain('delta');
    const text = render(a);
    expect(text).toContain('delta（note）: 索引から省かれた');
    expect(text).toContain('indexNote: 索引の予算を超えたので省いた');
    expect(text).toContain('eps（note）: 索引の中での長さが取れなかった');
  });

  it('contextUsage.memoryFiles（CLAUDE.md 等）は別の表で、トークンとして出す', () => {
    const a = readOf();
    if (a.memory.state !== 'read' || a.memory.memoryFiles.state !== 'read') {
      throw new Error('読めるはず');
    }
    expect(a.memory.memoryFiles.rows).toEqual([
      { path: '/work/CLAUDE.md', type: 'Project', tokens: 600 },
    ]);
    expect(render(a)).toContain('/work/CLAUDE.md（Project）: 600トークン');
  });

  it('memoryInPrompt が null（セッション未取得）のときは「取れない」と理由を書く', () => {
    const a = readOf({ memoryInPrompt: null });
    expect(a.memory).toMatchObject({ state: 'unavailable' });
    expect(render(a)).toContain('記憶の索引: 取れない（memoryInPrompt が null');
  });
});

describe('道具・外部 MCP・SDK 組み込み', () => {
  it('道具の定義は説明 + スキーマの文字数の大きい順。SDK 実測トークンは名前が対応した道具だけに並べる', () => {
    const a = readOf();
    if (a.tools.state !== 'read') throw new Error('読めるはず');
    expect(a.tools.rows.map((r) => [r.name, r.totalChars])).toEqual([
      ['memory_read', 700],
      ['ask_human', 300],
      ['journal_write', 200],
    ]);
    expect(a.tools.totalChars).toBe(1200);
    expect(a.tools.rows[0]?.shareOfTotal).toBeCloseTo(700 / 1200, 10);
    expect(a.tools.rows.map((r) => r.tokens)).toEqual([900, 300, null]);
    if (a.tools.tokens.state !== 'read') throw new Error('トークンが読めるはず');
    expect(a.tools.tokens.matched).toBe(2);
    expect(a.tools.tokens.unmatchedTools).toEqual(['journal_write']);
    // クローン自身のサーバの行のうち、どの道具とも対応しないもの
    expect(a.tools.tokens.unmatchedCloneServerRows).toEqual({ count: 1, tokens: 77 });
    const text = render(a);
    expect(text).toContain('トークン 取れない（contextUsage.mcpTools に名前の対応する行が無い）');
    expect(text).toContain('3 本 / 合計 1,200字');
    expect(text).toContain('モデルに見える定義（$schema を外した後）');
  });

  it('外部 MCP: クローン自身の道具（サーバ alteroid）を混ぜず、サーバごとに畳み、道具ごとの上位を出す', () => {
    const a = readOf({}, { topN: 2 });
    if (a.externalMcp.state !== 'read' || a.externalMcp.tokens.state !== 'read') {
      throw new Error('読めるはず');
    }
    const ext = a.externalMcp.tokens;
    expect(ext.total).toBe(750);
    expect(ext.byServer.map((s) => [s.name, s.tools, s.tokens, s.type])).toEqual([
      ['github', 2, 500, 'http'],
      ['slack', 1, 250, 'stdio'],
    ]);
    expect(ext.registeredWithoutRows).toEqual(['quiet']);
    expect(ext.topTools.map((t) => t.name)).toEqual([
      'mcp__github__issue_create',
      'mcp__slack__post',
    ]);
    expect(a.externalMcp.live).toEqual({
      state: 'read',
      at: '2026-11-13T09:10:00.000Z',
      failed: ['quiet'],
      retained: ['github', 'slack'],
    });
    const text = render(a, 2);
    expect(text).toContain('github（http）、slack（stdio）、quiet（sse）');
    expect(text).toContain('失敗 quiet / 残った github、slack');
    expect(text).toContain('登録はあるが mcpTools に行が無い（取れない。0 ではない）: quiet');
    expect(text).not.toContain('alteroid（');
  });

  it('SDK 組み込みの道具: 名前・トークン・isLoaded を出し、reason をそのまま出す', () => {
    const a = readOf();
    if (a.builtin.state !== 'read') throw new Error('読めるはず');
    expect(a.builtin.systemTools).toMatchObject({ state: 'read', total: 1500 });
    expect(a.builtin.deferredBuiltinTools).toMatchObject({ state: 'read', total: 140 });
    const text = render(a);
    expect(text).toContain(
      'builtinTools.reason: SDK 組み込みの道具の定義（説明・入力スキーマ）は SDK が返さない',
    );
    expect(text).toContain('Bash: 1,100トークン');
    expect(text.indexOf('Bash: 1,100トークン')).toBeLessThan(text.indexOf('Read: 400トークン'));
    expect(text).toContain('WebFetch: 80トークン / isLoaded false');
  });

  it('文脈占有のカテゴリ: kind で分け、used だけを「毎ターン払っている量」にし、free・buffer・deferred・未知を混ぜない', () => {
    const a = readOf();
    if (a.occupancy.state !== 'read') throw new Error('読めるはず');
    expect(a.occupancy.used.tokens).toBe(8000);
    expect(a.occupancy.used.rows.map((r) => r.name)).toEqual(['System prompt', 'MCP tools']);
    expect(a.occupancy.free.tokens).toBe(150000);
    expect(a.occupancy.buffer.tokens).toBe(33000);
    expect(a.occupancy.deferred.tokens).toBe(700);
    expect(a.occupancy.unclassified).toEqual({ tokens: 5, count: 1 });
    const text = render(a);
    expect(text).toContain('★ 毎ターン払っている量（kind=used）: 8,000トークン');
    expect(text).toContain('kind が無い・未知の行: 5トークン（1 行。used に入れていない）');
  });
});

describe('削減候補（定義を短くできる余地の大きい順）', () => {
  it('文字数どうし・トークンどうしを別々に大きい順に並べ、単位を混ぜない', () => {
    const a = readOf({}, { topN: 100 });
    if (a.candidates.chars.state !== 'read' || a.candidates.tokens.state !== 'read') {
      throw new Error('候補が読めるはず');
    }
    const chars: PromptCharsCandidate[] = a.candidates.chars.rows;
    const tokens: PromptTokensCandidate[] = a.candidates.tokens.rows;
    for (let i = 1; i < chars.length; i++) {
      expect(chars[i - 1]?.size ?? 0).toBeGreaterThanOrEqual(chars[i]?.size ?? 0);
    }
    for (let i = 1; i < tokens.length; i++) {
      expect(tokens[i - 1]?.size ?? 0).toBeGreaterThanOrEqual(tokens[i]?.size ?? 0);
    }
    // 文字数の側にはトークンの出所の行が、トークンの側には文字数の出所の行が入らない
    expect(new Set(chars.map((r) => r.basis))).toEqual(new Set(['text-counted', 'server-chars']));
    expect(new Set(tokens.map((r) => r.basis))).toEqual(new Set(['sdk-tokens']));
    expect(chars.map((r) => r.kind)).not.toContain('external-mcp');
    expect(tokens.map((r) => r.kind)).not.toContain('memory-index');
    // 文字数の側: 導入・節・記憶の索引（文書ごと）・索引以外・道具の定義
    expect(chars.map((r) => r.kind)).toEqual(
      expect.arrayContaining([
        'system-section',
        'memory-index',
        'memory-index-other',
        'clone-tool',
      ]),
    );
    // 記憶の節は文書ごとに分けて数える（節そのものの行は無く、合計はシステムプロンプト + 道具の定義の文字数に一致する）
    const total = chars.reduce((sum, r) => sum + r.size, 0);
    expect(total).toBe(TEXT.length + 1200);
    expect(a.candidates.chars.baseline).toBe(TEXT.length + 1200);
    expect(chars[0]?.share).toBeCloseTo((chars[0]?.size ?? 0) / (TEXT.length + 1200), 10);
    // トークンの側: SDK の節・指示ファイル・クローンの道具・外部 MCP のサーバ・組み込み（ロード済みの遅延道具だけ）
    expect(tokens.map((r) => r.kind)).toEqual(
      expect.arrayContaining([
        'sdk-section',
        'memory-file',
        'clone-tool',
        'external-mcp',
        'builtin-system-tool',
        'builtin-deferred-tool',
      ]),
    );
    expect(tokens.map((r) => r.label).join('\n')).not.toContain('WebFetch');
    expect(a.candidates.tokens.excludedNotLoaded).toBe(1);
    expect(tokens[0]).toMatchObject({ size: 1200, share: 1200 / 8000 });
    expect(a.candidates.tokens.baseline).toBe(8000);
  });

  it('各行に、誰がどこで変えられるかを添える（変えられないものは「変えられない」と書く）', () => {
    const a = readOf();
    if (a.candidates.chars.state !== 'read' || a.candidates.tokens.state !== 'read') {
      throw new Error('候補が読めるはず');
    }
    const whereOf = (rows: Array<{ kind: string; where: string }>, kind: string): string =>
      rows.find((r) => r.kind === kind)?.where ?? '';
    expect(whereOf(a.candidates.chars.rows, 'system-section')).toContain('prompt.ts');
    expect(whereOf(a.candidates.chars.rows, 'system-section')).toContain('self.ts');
    expect(whereOf(a.candidates.chars.rows, 'memory-index')).toContain(
      '人間が書き換える記憶の文書',
    );
    expect(whereOf(a.candidates.chars.rows, 'clone-tool')).toContain('clone-tools-*.ts');
    expect(whereOf(a.candidates.tokens.rows, 'external-mcp')).toContain('PUT /mcp-servers');
    expect(whereOf(a.candidates.tokens.rows, 'builtin-system-tool')).toContain('変えられない');
  });

  it('--top 件に絞り、全件数を言う。本文が省かれたときは「全体 − 索引」と文書ごとの索引を並べる', () => {
    const a = readOf({}, { topN: 3 });
    if (a.candidates.chars.state !== 'read' || a.candidates.tokens.state !== 'read') {
      throw new Error('候補が読めるはず');
    }
    expect(a.candidates.chars.rows).toHaveLength(3);
    expect(a.candidates.chars.total).toBeGreaterThan(3);
    expect(a.candidates.tokens.rows).toHaveLength(3);

    const omitted = readOf({ full: false, systemPrompt: { chars: TEXT.length } }, { topN: 100 });
    if (omitted.candidates.chars.state !== 'read') throw new Error('候補が読めるはず');
    const rows = omitted.candidates.chars.rows;
    expect(rows.find((r) => r.label.includes('記憶の索引以外'))?.size).toBe(TEXT.length - 150);
    expect(rows.filter((r) => r.kind === 'memory-index').map((r) => r.size)).toEqual([100, 40, 10]);
    // 節ごとの行は作らない
    expect(rows.filter((r) => r.kind === 'system-section')).toHaveLength(1);
    expect(rows.reduce((sum, r) => sum + r.size, 0)).toBe(TEXT.length + 1200);
  });

  it('能力の削除・クローンの tools を絞る提案の文言を出力に入れない。「定義の簡潔化の候補」の1行は出す', () => {
    const text = render(readOf());
    expect(text).toContain(PROMPT_NO_REMOVAL_NOTE);
    expect(PROMPT_NO_REMOVAL_NOTE).toBe('能力を減らす候補ではなく、定義の簡潔化の候補');
    // 上の1行（否定の形で言う文）を除いた出力に、減らす・外す・絞る・削除・無効化・取り除く・使わない の勧めが出ない
    const rest = text.split(PROMPT_NO_REMOVAL_NOTE).join('');
    for (const word of [
      '削除',
      '外す',
      '取り外',
      '絞',
      '無効',
      '取り除',
      '減らす',
      '使わない',
      '不要',
    ]) {
      expect(rest, `「${word}」が出力に出た`).not.toContain(word);
    }
  });

  it('contextUsage が無いときは、トークンの候補を「取れない」と言い、文字数の候補だけを並べる（換算しない）', () => {
    const a = readOf({
      contextUsage: null,
      builtinTools: {
        available: false,
        reason: 'r',
        systemTools: null,
        deferredBuiltinTools: null,
      },
    });
    expect(a.candidates.tokens).toMatchObject({ state: 'unavailable' });
    expect(a.candidates.chars).toMatchObject({ state: 'read' });
    const text = render(a);
    expect(text).toContain('トークンの候補: 取れない');
    expect(text).toContain('contextUsage: 未取得');
  });
});

describe('coverage', () => {
  it('session の状態・builtAt・model・resumedFrom・sessionId・経過・notice の全件・秘密走査を出す', () => {
    const a = readOf({
      session: {
        ok: true,
        builtAt: '2026-11-13T09:00:00.000Z',
        resumedFrom: 'sess-0000',
        sessionId: 'sess-0001',
        model: 'opus',
      },
      secretScan: { scanned: true, hits: [{ rule: 'github-token', count: 2 }] },
    });
    expect(a.coverage.session).toEqual({
      state: 'ok',
      builtAt: '2026-11-13T09:00:00.000Z',
      model: 'opus',
      resumedFrom: 'sess-0000',
      sessionId: 'sess-0001',
    });
    expect(a.coverage.ageAtPullMs).toBe(3_600_000);
    expect(a.coverage.notices).toHaveLength(2);
    expect(a.coverage.secretScan).toEqual([{ rule: 'github-token', count: 2 }]);
    const text = render(a);
    expect(text).toContain('session: 成功 / builtAt 2026-11-13T09:00:00.000Z / model opus');
    expect(text).toContain('resumedFrom sess-0000 / sessionId sess-0001');
    expect(text).toContain('プロンプトが焼かれてからの経過: 60 分');
    expect(text).toContain('全 2 件');
    expect(text).toContain('- 記憶の文書のうち 1 件は、焼いた索引から省かれた');
    expect(text).toContain('github-token 2 件');
    expect(text).toContain('SDK が測った時刻 2026-11-13T09:30:00.000Z');
  });

  it('pulledAt が無いときは経過を「取れない」と理由つきで言う。builtAt が後なら、そう言う', () => {
    const a = readOf({}, { pulledAt: null });
    expect(a.coverage.ageAtPullMs).toBeNull();
    expect(render(a)).toContain('取れない（manifest.json の pulledAt が無い）');
    const later = readOf({}, { pulledAt: '2026-11-13T08:00:00.000Z' });
    expect(later.coverage.ageAtPullMs).toBe(-3_600_000);
    expect(render(later)).toContain('builtAt が pulledAt より後');
  });

  it('session が null（未取得）: 節ごとに「取れない」と理由を言い、道具・記憶・システムプロンプトに 0 を置かない', () => {
    const a = readOf({
      session: null,
      systemPrompt: null,
      memoryInPrompt: null,
      tools: null,
      builtinTools: null,
      externalMcpServers: null,
      externalMcpServersLive: null,
      contextUsage: null,
      notice: ['まだセッションが組まれていない'],
    });
    expect(a.coverage.session.state).toBe('none');
    for (const section of [a.systemPrompt, a.memory, a.tools, a.externalMcp, a.builtin]) {
      expect(section.state).toBe('unavailable');
    }
    expect(a.occupancy.state).toBe('unavailable');
    expect(a.candidates.chars.state).toBe('unavailable');
    expect(a.candidates.tokens.state).toBe('unavailable');
    const text = render(a);
    expect(text).toContain('session: 未取得（まだセッションが組まれていない');
    expect(text).toContain('- まだセッションが組まれていない');
    expect(text).not.toMatch(/\b0字/);
    expect(text).not.toMatch(/ 0トークン/);
  });

  it('session が失敗の回: 失敗の時刻と理由を出し、節は取れないと言う', () => {
    const a = readOf({
      session: {
        ok: false,
        at: '2026-11-13T08:00:00.000Z',
        error: 'スナップショットを組めなかった',
      },
      systemPrompt: null,
      memoryInPrompt: null,
      tools: null,
      builtinTools: null,
      externalMcpServers: null,
    });
    expect(a.coverage.session).toEqual({
      state: 'failed',
      at: '2026-11-13T08:00:00.000Z',
      error: 'スナップショットを組めなかった',
    });
    expect(a.coverage.ageAtPullMs).toBeNull();
    expect(render(a)).toContain(
      'session: 失敗の回（2026-11-13T08:00:00.000Z。理由: スナップショットを組めなかった）',
    );
  });

  it('contextUsage が失敗の回: トークンの節を「取れない」と言い、文字数の節は出す（混ぜない）', () => {
    const a = readOf({
      contextUsage: { ok: false, at: '2026-11-13T09:40:00.000Z', error: '10秒以内に返らなかった' },
      builtinTools: {
        available: false,
        reason: 'r',
        systemTools: null,
        deferredBuiltinTools: null,
      },
    });
    expect(a.coverage.contextUsage).toEqual({
      state: 'failed',
      at: '2026-11-13T09:40:00.000Z',
      error: '10秒以内に返らなかった',
    });
    expect(a.occupancy.state).toBe('unavailable');
    if (a.tools.state !== 'read') throw new Error('読めるはず');
    expect(a.tools.tokens.state).toBe('unavailable');
    expect(a.tools.rows.every((r) => r.tokens === null)).toBe(true);
    expect(a.systemPrompt).toMatchObject({ state: 'read', sdkSections: { state: 'unavailable' } });
    if (a.builtin.state !== 'read') throw new Error('読めるはず');
    expect(a.builtin.systemTools.state).toBe('unavailable');
    const text = render(a);
    expect(text).toContain(
      'contextUsage: 失敗の回（2026-11-13T09:40:00.000Z。理由: 10秒以内に返らなかった）',
    );
    expect(text).toContain('SDK 実測のトークンは出せない');
    // 文字数の節は出ている
    expect(text).toContain('# あなたの立ち位置');
  });

  it('SDK が返さなかった軸（available:false）は、その軸だけ理由つきで「取れない」にする', () => {
    const a = readOf({
      contextUsage: {
        ...usageOk,
        mcpTools: { available: false, reason: 'この版の SDK は mcpTools を返さない' },
      },
    });
    if (a.tools.state !== 'read' || a.externalMcp.state !== 'read') throw new Error('読めるはず');
    expect(a.tools.tokens).toEqual({
      state: 'unavailable',
      reason: 'SDK が返さなかった（この版の SDK は mcpTools を返さない）',
    });
    expect(a.externalMcp.tokens.state).toBe('unavailable');
    expect(a.coverage.contextUsage).toMatchObject({
      state: 'ok',
      axes: expect.arrayContaining([
        expect.objectContaining({ axis: 'mcpTools', available: false }),
      ]),
    });
  });
});

describe('表示の安全', () => {
  it('見出し・slug・道具名・サーバ名・理由・notice の鍵を、表示の直前に伏せる。制御文字は除く', () => {
    const text = `# 見出し${DUMMY_KEY}\n本文\n# 現在の記憶\n\nx\n`;
    const a = readOf({
      systemPrompt: { text, chars: text.length },
      memoryInPrompt: {
        documents: [{ ...documents[0], slug: `slug-${DUMMY_KEY}`, indexNote: `理由 ${DUMMY_KEY}` }],
        omittedDocuments: 0,
      },
      tools: [{ name: `tool-${DUMMY_KEY}`, descriptionChars: 1, inputSchemaChars: 1 }],
      externalMcpServers: [{ name: `srv-${DUMMY_KEY}\u0007`, type: 'http' }],
      notice: [`注記 ${DUMMY_KEY}`],
      session: {
        ok: true,
        builtAt: '2026-11-13T09:00:00.000Z',
        resumedFrom: null,
        sessionId: `sess-${DUMMY_KEY}`,
        model: 'opus',
      },
    });
    const output = render(a);
    const json = JSON.stringify(a);
    for (const shown of [output, json]) {
      expect(shown).not.toContain(DUMMY_KEY);
      expect(shown).toContain('[redacted:');
    }
    // eslint-disable-next-line no-control-regex
    expect(output).not.toMatch(/\u0007/);
  });

  it('伏せ字で当たった規則と件数は、渡した伏せ字の走査器に残る（呼び出し側が標準エラーへ出す）', () => {
    const r = redactor();
    const text = `# 見出し${DUMMY_KEY}\n`;
    analyzePrompt({
      input: inputOf({ systemPrompt: { text, chars: text.length } }),
      pulledAt: null,
      topN: 5,
      redact: (value) => r.redact(value),
    });
    expect(r.hits().length).toBeGreaterThan(0);
    expect(JSON.stringify(r.hits())).not.toContain(DUMMY_KEY);
  });
});

describe('単位の型', () => {
  it('文字数（HeuristicChars）をトークン（ExactTokens）として読み替える代入は、型で通らない', () => {
    const chars: HeuristicChars = heuristicChars(10);
    const tokens: ExactTokens = exactTokens(10);
    // @ts-expect-error 文字数はトークンではない
    const wrongTokens: ExactTokens = chars;
    // @ts-expect-error トークンは文字数ではない
    const wrongChars: HeuristicChars = tokens;
    // 実行時は同じ number。型だけが区別している（この行は型の歯の確認で、値の比較ではない）
    expect([wrongTokens, wrongChars]).toEqual([10, 10]);
    // 分析の結果の型も区別している
    const a = readOf();
    if (a.tools.state !== 'read') throw new Error('読めるはず');
    const row = a.tools.rows[0];
    // @ts-expect-error 道具の文字数をトークンの欄へ入れられない
    const mixed: ExactTokens | null = row?.totalChars ?? null;
    expect(mixed).toBe(700);
  });
});
