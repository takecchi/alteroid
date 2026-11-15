import { readFileSync } from 'node:fs';

import {
  createManagerPool,
  createMemoryStores,
  createRunnerRegistry,
  fakeCloneHost,
  parsePromptJson,
} from '@alteroid/core';
import type { ClonePromptSnapshot, CloneHost } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { selfPromptResponseSchema } from './openapi.js';
import { sessionOf, snapshotOf, usageOf } from './self-prompt.test-support.js';

// `diagnostics analyze --prompt` が読む `prompt.json`（`GET /self/prompt` の応答）の、core の写し
// （`packages/core/src/diagnostics-prompt-input.ts`）と、正（`selfPromptResponseSchema`）を突き合わせる。
// core は daemon を import できないので、写しは自動では追従しない。ここが、正が変わったときに写しを直させる唯一の歯である。
//
// 突き合わせの形: 本物の応答（`GET /self/prompt` を実際に叩いた値）の各欄を壊した応答（欄を消す・null にする・型を変える）を作り、
// 「正が受け入れる応答は、写しも読める」を確かめる。写しが正より厳しい（正が nullable／optional の欄を写しが必須にしている・
// 正に無い欄を写しが必須にしている）と、この不変条件が落ちる。写しの定義の中身を辿らず、`parsePromptJson` だけを使う。
const FIX_THE_COPY =
  '`selfPromptResponseSchema` が変わった。core の `diagnostics-prompt-input.ts` の写しを直すこと';

const GITHUB = `ghp_${'a1B2'.repeat(9)}`;
const ENV_VALUE = 'dummy-env-secret-value-0123456789';

// `diagnostics pull` の試験（apps/cli）の偽サーバが返す固定の JSON。cli は daemon を import できないので、置き場は cli 側のファイル
const CLI_FIXTURE = new URL('../../cli/src/diagnostics-pull-prompt.fixture.json', import.meta.url);

function cloneHost(snapshot: ClonePromptSnapshot): CloneHost {
  const stores = createMemoryStores();
  return fakeCloneHost({
    promptSnapshot: () => snapshot,
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
  });
}

async function realResponse(
  snapshot: ClonePromptSnapshot,
  path = '/self/prompt',
): Promise<unknown> {
  const app = createApp({
    clone: cloneHost(snapshot),
    stores: createMemoryStores(),
    token: 'test-token',
    shutdown: () => {},
    env: { ALTEROID_TEST_SECRET: ENV_VALUE },
  });
  const response = await app.request(path, { headers: { authorization: 'Bearer test-token' } });
  expect(response.status).toBe(200);
  return (await response.json()) as unknown;
}

const richUsage = () =>
  usageOf({
    autoCompactThreshold: 160_000,
    isAutoCompactEnabled: false,
    categories: {
      available: true,
      value: {
        rows: [
          { name: 'System prompt', tokens: 300, kind: 'used' },
          { name: 'Free space', tokens: 1000, kind: 'free' },
          { name: 'Autocompact buffer', tokens: 50, kind: 'buffer' },
          { name: 'Deferred tools', tokens: 30, kind: 'deferred' },
        ],
        omitted: 2,
      },
    },
    systemPromptSections: {
      available: true,
      value: {
        rows: [
          { name: 'Core', tokens: 250 },
          { name: null, tokens: 5 },
        ],
        omitted: 0,
      },
    },
    mcpTools: {
      available: true,
      value: {
        rows: [
          { name: 'journal_read', serverName: 'alteroid', tokens: 20, isLoaded: true },
          { name: null, serverName: null, tokens: 3, isLoaded: null },
        ],
        omitted: 1,
      },
    },
    memoryFiles: {
      available: true,
      value: { rows: [{ path: null, type: null, tokens: 5 }], omitted: 0 },
    },
    mcpInstructions: {
      available: true,
      value: { rows: [{ serverName: 'alteroid', tokens: 7 }], omitted: 0 },
    },
    messageBreakdown: {
      available: true,
      value: {
        toolCallTokens: 1,
        toolResultTokens: 2,
        attachmentTokens: 3,
        assistantMessageTokens: 4,
        userMessageTokens: 5,
        toolCallsByType: { rows: [{ name: 'Bash', callTokens: 1, resultTokens: 2 }], omitted: 0 },
      },
    },
  });

const unavailableUsage = () =>
  usageOf({
    categories: { available: false, reason: '取れなかった' },
    mcpTools: { available: false, reason: '取れなかった' },
    systemPromptSections: { available: false, reason: '取れなかった' },
    memoryFiles: { available: false, reason: '取れなかった' },
    systemTools: { available: false, reason: '取れなかった' },
    deferredBuiltinTools: { available: false, reason: '取れなかった' },
  });

const richSession = () =>
  sessionOf({
    resumedFrom: 'sess-0',
    sessionId: null,
    memoryInPrompt: {
      documents: [
        {
          slug: 'a',
          type: 'premise',
          description: '要旨',
          chars: 10,
          index: { kind: 'baked', form: 'indexed-card', chars: 4 },
        },
        {
          slug: 'b',
          type: 'fact',
          description: null,
          chars: 5,
          index: { kind: 'omitted', reason: '上限' },
        },
        {
          slug: 'c',
          type: 'note',
          description: null,
          chars: 5,
          index: { kind: 'unavailable', reason: '控えに無かった' },
        },
      ],
      omitted: 3,
    },
    externalMcpServersLive: {
      at: '2026-11-15T00:00:03.000Z',
      failed: ['remote'],
      retained: ['github'],
    },
    plugins: [],
    tools: [],
    externalMcpServers: [],
  });

const dirtySession = () =>
  sessionOf({
    systemPrompt: { text: `鍵 ${GITHUB} と環境の値 ${ENV_VALUE}`, chars: 60 },
    externalMcpServers: [{ name: `srv-${GITHUB}`, type: 'sse' }],
  });

const failure = { ok: false, at: '2026-11-15T00:00:09.000Z', error: '時間切れ' } as const;

interface Variant {
  name: string;
  body: unknown;
}

async function variants(): Promise<Variant[]> {
  const make = async (name: string, snapshot: ClonePromptSnapshot, path?: string) => ({
    name,
    body: await realResponse(snapshot, path),
  });
  return [
    await make('(a) full=1（全文）', snapshotOf()),
    await make('(b) full=0', snapshotOf(), '/self/prompt?full=0'),
    await make('(b) full=0・リッチ', snapshotOf(richSession(), richUsage()), '/self/prompt?full=0'),
    await make('(c) session が null（セッション未取得）', snapshotOf(null, null)),
    await make('(d) session が失敗の回', snapshotOf(failure, null)),
    await make('(d) session が失敗・文脈占有は成功', snapshotOf(failure, richUsage())),
    await make('(e) 記憶の文書が omitted: true を含む', snapshotOf(richSession(), null)),
    await make('(f) contextUsage が失敗の回', snapshotOf(sessionOf(), failure)),
    await make(
      '(f) contextUsage が成功（全部の軸が入った回）',
      snapshotOf(richSession(), richUsage()),
    ),
    await make(
      '(f) contextUsage が成功（軸が取れない回）',
      snapshotOf(sessionOf(), unavailableUsage()),
    ),
    await make('(f) contextUsage が未観測（null）', snapshotOf(sessionOf(), null)),
    await make('(g) secretScan に当たりがある回', snapshotOf(dirtySession(), richUsage())),
    {
      name: 'apps/cli の試験の固定の JSON（diagnostics-pull-prompt.fixture.json）',
      body: JSON.parse(readFileSync(CLI_FIXTURE, 'utf8')) as unknown,
    },
  ];
}

const copyReads = (body: unknown): boolean =>
  parsePromptJson(JSON.stringify(body)).state === 'read';
const canonAccepts = (body: unknown): boolean => selfPromptResponseSchema.safeParse(body).success;

type Path = (string | number)[];
type Mutation = 'delete' | 'null' | 'wrong';
const MUTATIONS: Mutation[] = ['delete', 'null', 'wrong'];

function nodePaths(value: unknown, path: Path = []): Path[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => [[...path, index], ...nodePaths(item, [...path, index])]);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => [
      [...path, key],
      ...nodePaths(item, [...path, key]),
    ]);
  }
  return [];
}

function valueAt(root: unknown, path: Path): unknown {
  let current = root;
  for (const key of path) current = (current as Record<string | number, unknown>)[key];
  return current;
}

// 型を変える: 値が入れ物（オブジェクト・配列）なら文字列に、そうでなければオブジェクトにする（どの葉の型とも合わない）
function wrongTypeOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? 'wrong' : { wrong: true };
}

function mutated(body: unknown, path: Path, mutation: Mutation): unknown | undefined {
  const copy = structuredClone(body);
  const parent = valueAt(copy, path.slice(0, -1)) as Record<string | number, unknown> | unknown[];
  const key = path[path.length - 1] as string | number;
  const original = valueAt(copy, path);
  if (mutation === 'delete') {
    if (Array.isArray(parent)) return undefined;
    delete (parent as Record<string | number, unknown>)[key];
  } else {
    (parent as Record<string | number, unknown>)[key] =
      mutation === 'null' ? null : wrongTypeOf(original);
  }
  return copy;
}

const pathLabel = (path: Path): string => path.join('.');

/**
 * 「正が受け入れる応答を、写しが読めない」場合の一覧（変異: 欄を1つだけ消す・null にする・型を変える）。
 * 変異していない応答そのものも含めて調べる（経路は `(変異なし)`）。
 */
function stricterThanCanon(
  all: Variant[],
  canon: (body: unknown) => boolean,
  copy: (body: unknown) => boolean,
): string[] {
  const found: string[] = [];
  for (const { name, body } of all) {
    if (canon(body) && !copy(body)) {
      // 変異する前から読めないなら、欄ごとの変異の結果は全部これに埋もれるので数えない
      found.push(`${name} / (変異なし)`);
      continue;
    }
    for (const path of nodePaths(body)) {
      for (const mutation of MUTATIONS) {
        const changed = mutated(body, path, mutation);
        if (changed === undefined) continue;
        if (canon(changed) && !copy(changed)) {
          found.push(`${name} / ${pathLabel(path)} を ${mutation}`);
        }
      }
    }
  }
  return found;
}

describe('core の prompt.json の写しと selfPromptResponseSchema の突き合わせ', () => {
  it('試験が使う応答は、どれも正（selfPromptResponseSchema）に合う本物の形である（応答の作り方そのものの確認）', async () => {
    for (const { name, body } of await variants()) {
      const result = selfPromptResponseSchema.safeParse(body);
      expect(
        result.success,
        `${name}: 応答が selfPromptResponseSchema に合わない。${FIX_THE_COPY}（応答の作り方・cli の固定の JSON も合わせて直す）`,
      ).toBe(true);
      // 欄の過不足が無い（zod は未知の欄を捨てるので、parse の結果と応答が同じなら正が持たない欄は無い）
      if (result.success) expect(result.data, name).toEqual(body);
    }
  });

  it('本物の応答（full=1・full=0・session null/失敗・omitted・contextUsage 失敗/成功・秘密の当たり）を、写しで読める', async () => {
    for (const { name, body } of await variants()) {
      const input = parsePromptJson(JSON.stringify(body));
      const reason = input.state === 'read' ? '' : input.reason;
      expect(input.state, `${name}: ${FIX_THE_COPY}。写しの読めない理由: ${reason}`).toBe('read');
    }
  });

  it('秘密の当たりがある回の応答を、写しは secretScan の規則名と件数のまま読む', async () => {
    const body = (await realResponse(snapshotOf(dirtySession(), richUsage()))) as {
      secretScan: { scanned: true; hits: { rule: string; count: number }[] };
    };
    expect(body.secretScan.hits.length).toBeGreaterThan(0);
    const input = parsePromptJson(JSON.stringify(body));
    expect(input.state).toBe('read');
    if (input.state === 'read') expect(input.body.secretScan).toEqual(body.secretScan);
  });

  it('正が受け入れる応答（欄が消えた・null・型違いの変異を含む）を、写しが読めなくなる欄が無い', async () => {
    const found = stricterThanCanon(await variants(), canonAccepts, copyReads);
    // 件数が多いと出力が溢れるので、先頭だけを出す
    expect(
      found.slice(0, 10),
      `${FIX_THE_COPY}（写しが必須にしている欄を、正は nullable／optional にしている、または正に無い欄を写しが読んでいる。全 ${String(found.length)} 件の先頭 10 件）`,
    ).toEqual([]);
  });

  it('突き合わせは空振りしない: 写しが読んでいる欄（変異で読めなくなる欄）が十分にあり、主要な欄を含む', async () => {
    const [full, , , , , , , , rich] = await variants();
    const read = new Set<string>();
    for (const { body } of [full, rich] as Variant[]) {
      for (const path of nodePaths(body)) {
        for (const mutation of MUTATIONS) {
          const changed = mutated(body, path, mutation);
          if (changed !== undefined && !copyReads(changed)) read.add(pathLabel(path));
        }
      }
    }
    expect(read.size).toBeGreaterThanOrEqual(40);
    for (const expected of [
      'secretScan.scanned',
      'systemPrompt.chars',
      'memoryInPrompt.documents.0.indexChars',
      'tools.0.descriptionChars',
      'contextUsage.mcpTools.value.rows.0.tokens',
      'builtinTools.systemTools.value.rows.0.name',
    ]) {
      expect(read.has(expected), expected).toBe(true);
    }
  });

  it('歯: 写しが正より厳しければ突き合わせが落ちる（nullable の欄を必須にした写し・optional の欄を必須にした写し）', async () => {
    const all = await variants();
    // 正は session.sessionId を nullable にしている。写しがそれを必須の文字列にした場合
    const requiresSessionId = (body: unknown): boolean =>
      copyReads(body) &&
      typeof (body as { session?: { sessionId?: unknown } | null }).session?.sessionId === 'string';
    expect(stricterThanCanon(all, canonAccepts, requiresSessionId).length).toBeGreaterThan(0);
    // 正は systemPrompt.text を optional にしている（full=0 で省く）。写しがそれを必須にした場合
    const requiresText = (body: unknown): boolean =>
      copyReads(body) &&
      typeof (body as { systemPrompt?: { text?: unknown } | null }).systemPrompt?.text === 'string';
    expect(stricterThanCanon(all, canonAccepts, requiresText).length).toBeGreaterThan(0);
    // 正に無い欄を必須にした写し
    const requiresGhost = (body: unknown): boolean =>
      copyReads(body) && (body as { ghost?: unknown }).ghost !== undefined;
    expect(stricterThanCanon(all, canonAccepts, requiresGhost).length).toBeGreaterThan(0);
  });

  it('歯: 正の欄の名前を変えた応答（secretScan.scanned → scannedX）は、正も写しも受け入れない', async () => {
    const body = (await realResponse(snapshotOf())) as { secretScan: Record<string, unknown> };
    const { scanned, ...rest } = body.secretScan;
    const renamed = { ...body, secretScan: { ...rest, scannedX: scanned } };

    expect(canonAccepts(renamed)).toBe(false);
    const input = parsePromptJson(JSON.stringify(renamed));
    expect(input.state).toBe('unreadable');
    if (input.state === 'unreadable') expect(input.reason).toContain('secretScan.scanned');
  });

  it('歯: 正の欄の名前を変えると、変えた欄ごとに写しの parse が落ちる（読んでいる欄の改名を見逃さない）', async () => {
    const body = (await realResponse(snapshotOf(richSession(), richUsage()))) as Record<
      string,
      unknown
    >;
    for (const key of [
      'full',
      'systemPrompt',
      'memoryInPrompt',
      'tools',
      'builtinTools',
      'contextUsage',
      'notice',
      'secretScan',
    ]) {
      const renamed: Record<string, unknown> = { ...body, [`${key}X`]: body[key] };
      delete renamed[key];
      expect(parsePromptJson(JSON.stringify(renamed)).state, key).toBe('unreadable');
    }
  });
});
