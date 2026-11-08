import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { DISTILL_GAP_NOTICE_HEAD } from './distill-gap.js';
import { EXCHANGE_KIND_GAUGE_PREFIX } from './exchange-kind.js';
import { fakeSdk, setup, waitFor, waitForDone, wireEvents } from './clone-test-harness.js';
import type { FakeCall, Setup } from './clone-test-harness.js';
import { createClone } from './clone.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { HumanActionKind, InboxEvent, JournalEntryInput } from './schema.js';
import type { Stores } from './store.js';
import { captureStderr, createMemoryStores, humanMessage } from './testing.js';

// `Clone` の「ターン入力の組み立ての殻」（読み出し・控えの更新・日誌 1 行。`#distillGapNotice`・`#contextWindowFoldNotice`・
// `#withFreshMemory`・`#memoryEditAttribution`・`#withHumanActions`・`#humanActionSection`、呼び元は `#runTurn` の 1 式）を、
// `createClone` 経由で固定する。モデルへ渡る入力と日誌を観測する。
// 切り出し（`clone-turn-input.ts`）の前に置いた。全文の期待は仕様を先に書いたものではなく、今の作りの出力を `vitest run <path> -u` で
// 生成して目で読んで確かめた値である。「今の出力から変えない」ための歯であって、文面の正しさの保証ではない。
// 文面の逐語（人間の操作の節・記憶の載せ直し・帰属・文脈窓の畳みの断り）は `clone-turn-input-text-pin.test.ts` が持つ。
// ここが足すのは、既存の試験が縛っていない枝: 読み始めの時刻への戻し（`#buildSessionSpec`）・控えの更新の位置・読み出しが投げた回の握り方・
// 差分が空でも印は下ろすこと・蒸留のターンは呼んでも遷移させないこと。
// 時刻は `Date` だけを止めて動かす（タイマーは本物のまま。実時間の待ちは足さない）。

const HEAD = '人間が自分の手で直したことがある';
const VIA = { kind: 'operator', auth: 'operator-token' } as const;
const SEPARATOR = '\n\n---\n\n';
const REFRESH_HEAD = '[system] この会話の文脈が要約に潰された。';
const UPDATE_HEAD = '[system] 記憶が更新された';
const HUMAN_ATTRIBUTION = '人間が書き換えた記憶: notes';
const UNTRACED_ATTRIBUTION = '日誌に書き手が残っていない変更: notes';

function at(clock: string): void {
  vi.setSystemTime(new Date(`2026-11-01T${clock}.000Z`));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at('09:00:00');
});

afterEach(() => {
  vi.useRealTimers();
});

const doc = (title: string, body: string): string => `## ${title}\n${body}\n`;

function humanDecision(kind: HumanActionKind, target: string): JournalEntryInput {
  return {
    type: 'decision',
    decision: `${target} を人間が操作した`,
    grounds: 'API',
    humanAction: { kind, target, via: VIA },
  };
}

function memoryUpdate(slug: string): JournalEntryInput {
  return {
    type: 'memory_update',
    slug,
    cause: 'human',
    action: 'write',
    summary: `${slug} を書いた`,
  };
}

/** n 回目のターンを投げ、n 回目の done を待つ。n 本目の入力を返す。 */
async function turn(s: Setup, text: string, n: number): Promise<string> {
  s.clone.post(humanMessage(text));
  await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length >= n);
  return s.calls[0]?.inputs[n - 1] ?? '';
}

async function firePreCompact(s: Setup): Promise<void> {
  const main = s.calls[0] as FakeCall;
  const dir = await makeTempDir('alteroid-turn-input-shell-pin-');
  const transcriptPath = join(dir, 'transcript.jsonl');
  await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
  const preCompact = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
  if (preCompact === undefined) throw new Error('PreCompact フックが登録されていない');
  await preCompact(
    { session_id: 'sess-fake', transcript_path: transcriptPath } as never,
    undefined,
    { signal: new AbortController().signal } as never,
  );
}

async function gaugeTexts(stores: Stores): Promise<string[]> {
  const rows = await stores.journal.list({ types: ['exchange'] });
  return rows.flatMap((row) =>
    row.type === 'exchange' && row.text.startsWith(EXCHANGE_KIND_GAUGE_PREFIX) ? [row.text] : [],
  );
}

describe('読み始めの時刻への戻し（#buildSessionSpec が控えを session を組んだ時刻へ戻す）', () => {
  it('記憶: セッションを組む前（器を作った後）の人間の行は、組んだ後の変更の書き手にしない', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('notes', doc('notes見出し', '旧い本文。'));
    const s = setup(undefined, stores);

    at('09:01:00');
    await stores.journal.append(memoryUpdate('notes'));
    at('09:02:00');
    await turn(s, '1回目', 1);

    at('09:02:30');
    await stores.persona.write('notes', doc('notes見出し', '新しい本文。'));
    at('09:03:00');
    const input = await turn(s, '2回目', 2);

    expect(input).toContain(UNTRACED_ATTRIBUTION);
    expect(input).not.toContain(HUMAN_ATTRIBUTION);
    await s.clone.stop();
  });

  it('人間の操作: セッションを組む前（器を作った後）の行は、最初のターンに載せない。組んだ後の行は載る', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores);

    at('09:01:00');
    await stores.journal.append(humanDecision('practice_write', 'before-build'));
    at('09:02:00');
    const first = await turn(s, '1回目', 1);

    at('09:02:30');
    await stores.journal.append(humanDecision('practice_write', 'after-build'));
    at('09:03:00');
    const second = await turn(s, '2回目', 2);

    expect(first).not.toContain(HEAD);
    expect(first).not.toContain('before-build');
    expect(second).toContain('やり方を書き直した: after-build');
    expect(second).not.toContain('before-build');
    await s.clone.stop();
  });
});

describe('記憶の控えの時刻（#memoryCarriedAt）の進め方', () => {
  it('差分を載せた回の読み始めの時刻へ進む: 載せた回より前の人間の行は、次の変更の書き手にしない', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('notes', doc('notes見出し', 'v1'));
    const s = setup(undefined, stores);
    await turn(s, '1回目', 1);

    at('09:01:00');
    await stores.persona.write('notes', doc('notes見出し', 'v2'));
    await stores.journal.append(memoryUpdate('notes'));
    at('09:02:00');
    const second = await turn(s, '2回目', 2);

    at('09:03:00');
    await stores.persona.write('notes', doc('notes見出し', 'v3'));
    at('09:04:00');
    const third = await turn(s, '3回目', 3);

    expect(second).toContain(HUMAN_ATTRIBUTION);
    expect(third).toContain(UNTRACED_ATTRIBUTION);
    expect(third).not.toContain(HUMAN_ATTRIBUTION);
    await s.clone.stop();
  });

  it('読み始めの時刻を控える（載せた後・読み終えた後にしない）: 読んでいる間に積まれた人間の行は、次の窓に残る', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('notes', doc('notes見出し', 'v1'));
    const original = stores.persona.documents.bind(stores.persona);
    let raceOnNextRead = false;
    const racing: Stores = {
      ...stores,
      persona: {
        ...stores.persona,
        documents: async () => {
          const documents = await original();
          if (raceOnNextRead) {
            raceOnNextRead = false;
            // 読み終えた後に、人間が直して日誌に残す（この回の入力には載らない）
            at('09:02:10');
            await stores.persona.write('notes', doc('notes見出し', 'v3'));
            await stores.journal.append(memoryUpdate('notes'));
            at('09:02:30');
          }
          return documents;
        },
      },
    };
    const s = setup(undefined, racing);
    await turn(s, '1回目', 1);

    at('09:01:00');
    await stores.persona.write('notes', doc('notes見出し', 'v2'));
    at('09:02:00');
    raceOnNextRead = true;
    const second = await turn(s, '2回目', 2);
    at('09:03:00');
    const third = await turn(s, '3回目', 3);

    expect(second).toContain(UPDATE_HEAD);
    expect(third).toContain(UPDATE_HEAD);
    expect(third).toContain(HUMAN_ATTRIBUTION);
    await s.clone.stop();
  });
});

describe('記憶の読み出しが投げた回と、差分が空でも下ろす印', () => {
  it('投げた回は記憶の節を出さず、控えも要約後の印も触らない: 次の回に差分と索引の載せ直しが両方載る', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('notes', doc('notes見出し', 'v1'));
    const original = stores.persona.documents.bind(stores.persona);
    let failing = false;
    const flaky: Stores = {
      ...stores,
      persona: {
        ...stores.persona,
        documents: () => (failing ? Promise.reject(new Error('記憶が読めない')) : original()),
      },
    };
    const s = setup(undefined, flaky);
    await turn(s, '1回目', 1);

    await firePreCompact(s);
    await stores.persona.write('notes', doc('notes見出し', 'v2'));
    failing = true;
    const second = await turn(s, '2回目', 2);
    failing = false;
    const third = await turn(s, '3回目', 3);
    const fourth = await turn(s, '4回目', 4);

    expect(second).not.toContain('<!-- memory:');
    expect(second).not.toContain(REFRESH_HEAD);
    expect(second).not.toContain(UPDATE_HEAD);
    expect(second).toContain('2回目');
    expect(third).toContain(REFRESH_HEAD);
    expect(third).toContain('<!-- memory: notes.md');
    expect(fourth).not.toContain('<!-- memory:');
    expect(fourth).not.toContain(REFRESH_HEAD);
    await s.clone.stop();
  });

  it('記憶が空で差分も無いまま要約された回も、印は下ろす: 次の回に「記憶は空になった」を繰り返さない（日誌には 0 件の行が 1 本残る）', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores);
    await turn(s, '1回目', 1);

    await firePreCompact(s);
    const second = await turn(s, '2回目', 2);
    const third = await turn(s, '3回目', 3);
    await stores.persona.write('late', doc('遅れた更新', '本文'));
    const fourth = await turn(s, '4回目', 4);

    expect(second).toContain('（記憶は空になった）');
    expect(await gaugeTexts(stores)).toMatchInlineSnapshot(`
      [
        "[計器] 記憶の索引を載せ直した（要約後。違った文書 0 件: ）。載せ直した文字数 0。全文書数 0",
      ]
    `);
    expect(third).not.toContain('（記憶は空になった）');
    expect(third).not.toContain(REFRESH_HEAD);
    expect(fourth).toContain(UPDATE_HEAD);
    expect(fourth).not.toContain(REFRESH_HEAD);
    await s.clone.stop();
  });

  it('要約後の印は 1 度で下ろす: 索引を載せ直して日誌に 1 行残し、次の回には載せず、その後の更新に相乗りしない', async () => {
    const stores = createMemoryStores();
    await stores.persona.write(
      'values',
      '---\ntype: premise\ndescription: 価値観の要旨\n---\n## 価値観\nV1\n',
    );
    await stores.persona.write(
      'habits',
      '---\ntype: premise\ndescription: 習慣の要旨\n---\n## 習慣\nH1\n',
    );
    const s = setup(undefined, stores);
    await turn(s, '1回目', 1);

    await firePreCompact(s);
    const second = await turn(s, '2回目', 2);
    const third = await turn(s, '3回目', 3);
    await stores.persona.write(
      'values',
      '---\ntype: premise\ndescription: 価値観の要旨\n---\n## 価値観\nV2\n',
    );
    const fourth = await turn(s, '4回目', 4);

    expect(second.slice(0, second.indexOf(SEPARATOR))).toMatchInlineSnapshot(`
      "[system] この会話の文脈が要約に潰された。**それまでに載せた記憶の差分も、その要約の中へ畳まれている**（残っているとは限らない）。だから**いまの索引を丸ごと載せ直す** —— 下に在るのが現在の記憶の全体（要旨と節の目次）であり、システムプロンプト側の「現在の記憶」より新しい。食い違ったら下を採ること。**節の本文はどこにも載っていない——要るなら \`memory_section_read\` で開くこと。**

      <!-- memory: habits.md（premise・本文は載っていない。全 50 文字 / 1 節） -->
      要旨: 習慣の要旨
      節（memory_section_read に節id を渡せば本文が開く。文字数（子込み）は memory_outline で見られる）:
        [4a10b490-2c919779] ## 習慣

      <!-- memory: values.md（premise・本文は載っていない。全 52 文字 / 1 節） -->
      要旨: 価値観の要旨
      節（memory_section_read に節id を渡せば本文が開く。文字数（子込み）は memory_outline で見られる）:
        [075432cc-3b7ae645] ## 価値観"
    `);
    expect(await gaugeTexts(stores)).toMatchInlineSnapshot(`
      [
        "[計器] 記憶の索引を載せ直した（要約後。違った文書 2 件: habits（焼いた時点に無かった） / values（焼いた時点に無かった））。載せ直した文字数 338。全文書数 2",
      ]
    `);
    expect(third).not.toContain('<!-- memory:');
    expect(third).not.toContain(REFRESH_HEAD);
    expect(fourth).toContain(UPDATE_HEAD);
    expect(fourth).not.toContain(REFRESH_HEAD);
    expect(await gaugeTexts(stores)).toHaveLength(1);
    await s.clone.stop();
  });

  it('索引の載せ直しの日誌の行は、秘密の値を伏せる（env の値と同じ slug は伏せ字になる）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('leakyslug-0123456789', doc('漏れる見出し', '本文'));
    const s = setup(undefined, stores, {}, { MY_API_TOKEN: 'leakyslug-0123456789' });
    await turn(s, '1回目', 1);

    await firePreCompact(s);
    const second = await turn(s, '2回目', 2);

    const [line] = await gaugeTexts(stores);
    expect(second).toContain('leakyslug-0123456789');
    expect(line).not.toContain('leakyslug-0123456789');
    expect(line).toMatchInlineSnapshot(
      `"[計器] 記憶の索引を載せ直した（要約後。違った文書 1 件: [REDACTED]（焼いた時点に無かった））。載せ直した文字数 264。全文書数 1"`,
    );
    await s.clone.stop();
  });
});

describe('1 つの入力に載る順（#runTurn の 1 式: 記憶 → 人間の操作 → 断り → 本文）', () => {
  it('記憶の載せ直しが先頭、人間の操作の節がその次、本文が最後に並ぶ', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('notes', doc('notes見出し', 'v1'));
    const s = setup(undefined, stores);
    await turn(s, '1回目', 1);

    at('09:01:00');
    await stores.persona.write('notes', doc('notes見出し', 'v2'));
    await stores.journal.append(humanDecision('practice_write', 'ordered-target'));
    at('09:02:00');
    const input = await turn(s, '2回目', 2);

    const memoryAt = input.indexOf(UPDATE_HEAD);
    const humanAt = input.indexOf(HEAD);
    const bodyAt = input.lastIndexOf('2回目');
    expect(memoryAt).toBe(0);
    expect(humanAt).toBeGreaterThan(memoryAt);
    expect(bodyAt).toBeGreaterThan(humanAt);
    await s.clone.stop();
  });
});

describe('人間の操作の控え（#humanActionCarriedAt・#humanActionCarriedIds）の更新', () => {
  function flakyDecisionRead(stores: Stores): { stores: Stores; fail(on: boolean): void } {
    let failing = false;
    return {
      fail: (on) => {
        failing = on;
      },
      stores: {
        ...stores,
        journal: {
          ...stores.journal,
          list: (query) =>
            failing && query?.types?.length === 1 && query.types[0] === 'decision'
              ? Promise.reject(new Error('日誌が読めない'))
              : stores.journal.list(query),
        },
      },
    };
  }

  it('読めなかった回は、前回載せた行の id の控えを残す: 次の回に境目の行をもう一度載せない', async () => {
    at('09:01:00');
    const stores = createMemoryStores();
    await stores.journal.append(humanDecision('practice_remove', 'same-ms'));
    const flaky = flakyDecisionRead(stores);
    const s = setup(undefined, flaky.stores);

    const first = await turn(s, '1回目', 1);
    flaky.fail(true);
    const second = await turn(s, '2回目', 2);
    flaky.fail(false);
    const third = await turn(s, '3回目', 3);

    expect(first).toContain('やり方を消した: same-ms');
    expect(second).not.toContain('same-ms');
    expect(third).not.toContain('same-ms');
    await s.clone.stop();
  });

  it('読めなかった回も、控えの時刻は読み始めの時刻へ進む: 読めなかった間の行は、次の回に載らない', async () => {
    const stores = createMemoryStores();
    const flaky = flakyDecisionRead(stores);
    const s = setup(undefined, flaky.stores);
    await turn(s, '1回目', 1);

    at('09:01:00');
    await stores.journal.append(humanDecision('practice_remove', 'lost-while-unreadable'));
    flaky.fail(true);
    at('09:02:00');
    const second = await turn(s, '2回目', 2);
    flaky.fail(false);
    at('09:03:00');
    const third = await turn(s, '3回目', 3);

    expect(second).not.toContain('lost-while-unreadable');
    expect(third).not.toContain('lost-while-unreadable');
    expect(third).not.toContain(HEAD);
    await s.clone.stop();
  });

  it('読み始めの時刻を控える（読み終えた後にしない）: 読んでいる間に積まれた行は、次の回に載る', async () => {
    const stores = createMemoryStores();
    let raceOnNextRead = false;
    const racing: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        list: async (query) => {
          const rows = await stores.journal.list(query);
          if (raceOnNextRead && query?.types?.length === 1 && query.types[0] === 'decision') {
            raceOnNextRead = false;
            at('09:02:10');
            await stores.journal.append(humanDecision('practice_write', 'written-while-reading'));
            at('09:02:30');
          }
          return rows;
        },
      },
    };
    const s = setup(undefined, racing);
    await turn(s, '1回目', 1);

    at('09:02:00');
    raceOnNextRead = true;
    const second = await turn(s, '2回目', 2);
    at('09:03:00');
    const third = await turn(s, '3回目', 3);

    expect(second).not.toContain('written-while-reading');
    expect(third).toContain('やり方を書き直した: written-while-reading');
    await s.clone.stop();
  });
});

describe('文脈窓の畳みの断り（#contextWindowFoldNotice）は畳んだ後の最初の入力にだけ載る', () => {
  const FOLD_NOTICE = '[system] 直前のターンが文脈窓';

  it('畳む前の入力にも、畳んだ後の 2 本目の入力にも載らない', async () => {
    const stores = createMemoryStores();
    const { fn, calls } = fakeSdk(undefined, {
      resultFor: (turnIndex) =>
        turnIndex === 1
          ? { subtype: 'success', isError: true, text: 'Prompt is too long' }
          : undefined,
    });
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      inboxSettleMs: 0,
      reportSettleMs: 0,
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events, waitForEvents } = wireEvents(clone, 'conv-1');
    const sessions = (): FakeCall[] => calls.filter((call) => call.kind === 'session');
    clone.post(humanMessage('1回目'));
    await waitForDone(events);
    clone.post(humanMessage('長さで落ちる'));
    await waitForEvents((seen) => seen.some((event) => event.type === 'error'));
    clone.post(humanMessage('畳みの後'));
    await waitFor(() => (sessions()[1]?.inputs.length ?? 0) >= 1, '新しいセッションの 1 本目');
    clone.post(humanMessage('畳みの後の次'));
    await waitFor(() => (sessions()[1]?.inputs.length ?? 0) >= 2, '新しいセッションの 2 本目');

    expect(sessions()[0]?.inputs[0]).not.toContain(FOLD_NOTICE);
    expect(sessions()[1]?.inputs[0]).toContain(FOLD_NOTICE);
    expect(sessions()[1]?.inputs[1]).not.toContain(FOLD_NOTICE);
    await clone.stop();
  });
});

describe('蒸留の区間の断り（#distillGapNotice）と、外れた合図の要旨（#droppedSignalsNotice）', () => {
  const DISTILL_PROMPT = '忘れる前に、記憶へ移すべきものがあるか';
  const distillEvent: InboxEvent = {
    type: 'distill',
    id: 'evt-distill',
    at: '2026-11-01T09:00:00.000Z',
    reason: 'shutdown',
  };

  // 蒸留の区間の断り（`#distillGapNotice`）と文脈窓の畳みの断り（`#contextWindowFoldNotice`）の `kind === 'distill'` の枝は、
  // `createClone` 越しには踏めない: 蒸留のターンは生きたセッションが要り（`#handleDistill` の `!this.#sdkSession.query` の見送り）、
  // 蒸留の区間の印は最初の通常のターンが消費し、畳みの印はセッションが閉じたあと次の通常のターンの入口までセッションが無い。
  // 踏める `#droppedSignalsNotice` だけ、下で固定する。

  it('蒸留の区間の断りの全文: 断りの後ろに区切りが入り、本文が続く', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '前のプロセスで話しかけたが、蒸留される前に落ちた',
    });
    at('09:00:10');
    const s = setup(undefined, stores);
    at('09:00:20');

    const input = await turn(s, 'こんにちは', 1);

    const start = input.indexOf(DISTILL_GAP_NOTICE_HEAD);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(input.slice(start, input.indexOf(SEPARATOR, start) + SEPARATOR.length))
      .toMatchInlineSnapshot(`
        "[system] 前のセッションの終わりが記憶へ移りきっていない可能性がある。
        最後に蒸留が成功で終わった記録は、日誌の新しい方から500件を見た範囲には無かった。それより後、この器が起きるまでのあいだに、記憶へ移された記録の無い活動が 1 件ある（2026-11-01T09:00:00.000Z 〜 2026-11-01T09:00:00.000Z）。

        **これは「蒸留を始めた」ではなく「蒸留が成功で終わった」記録で数えている。**前のプロセスが蒸留の途中で消えたか、蒸留が失敗して終わったか、そもそも走らなかった、のいずれかである。この区間の出来事は**記憶（正本）には入っていない**（前のセッションを引き継いで開き直していれば会話の履歴には残っているかもしれないが、それは記憶ではない）。

        中身は日誌に在る。\`journal_read\` に \`since\`（2026-11-01T09:00:00.000Z）と \`until\`（2026-11-01T09:00:00.000Z）を渡せばその区間だけを読める。記憶へ移すべきものが在れば \`memory_write\` / \`memory_append\` で移すこと（既存の文書を \`memory_write\` で書き直すときは、先に \`memory_read\` で読んで \`base_version\` を渡すこと）。

        ---

        "
      `);
    await s.clone.stop();
  });

  it('蒸留の区間の断りは、起動前の活動を全部数える（走査の上限は 1 件ではない）', async () => {
    const stores = createMemoryStores();
    for (const text of ['一つ目', '二つ目', '三つ目']) {
      await stores.journal.append({ type: 'exchange', with: 'human', role: 'inbound', text });
    }
    at('09:00:10');
    const s = setup(undefined, stores);
    at('09:00:20');

    const input = await turn(s, 'こんにちは', 1);

    expect(input).toContain('記憶へ移された記録の無い活動が 3 件ある');
    await s.clone.stop();
  });

  it('蒸留の区間の読み出しが投げたら、断りは出さず stderr へ 1 行残す。印は読む前に下ろすので次の回にも出ない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '前のプロセスで話しかけたが、蒸留される前に落ちた',
    });
    at('09:00:10');
    const broken: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        list: (query) =>
          query?.until === undefined
            ? stores.journal.list(query)
            : Promise.reject(new Error('日誌が読めない')),
        listPage: (query) =>
          query?.until === undefined
            ? stores.journal.listPage(query)
            : Promise.reject(new Error('日誌が読めない')),
      },
    };
    const s = setup(undefined, broken);
    at('09:00:20');

    let first = '';
    const lines = await captureStderr(async () => {
      first = await turn(s, '1回目', 1);
    });
    const second = await turn(s, '2回目', 2);

    expect(first).not.toContain(DISTILL_GAP_NOTICE_HEAD);
    expect(first).toContain('1回目');
    expect(lines.join('')).toContain('蒸留の区間の読み出しを記録できませんでした（until=');
    expect(lines.join('')).toContain('日誌が読めない');
    expect(second).not.toContain(DISTILL_GAP_NOTICE_HEAD);
    await s.clone.stop();
  });

  it('外れた合図の要旨: 蒸留のターンには載せず、通常のターンが終わるまで消さない', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, {
      resultFor: (turnIndex) =>
        turnIndex < 1
          ? { subtype: 'error_during_execution', text: 'API Error: 500 Internal server error' }
          : undefined,
    });
    const inputs = (): string[] => s.calls.flatMap((call) => call.inputs);
    const NOTICE = '[system] 前のターンが枠以外の理由で失敗したので';

    s.clone.post({
      type: 'manager_message',
      id: 'evt-report',
      at: '2026-11-01T09:00:00.000Z',
      managerId: 'mgr-a',
      kind: 'report',
      text: '消えてはいけない報告の本文',
    });
    await waitFor(async () => {
      const rows = await stores.journal.list({ types: ['exchange'] });
      return rows.some((row) => JSON.stringify(row).includes('処理されないまま受信箱から外した'));
    }, '外した合図の日誌の行');

    s.clone.post(distillEvent);
    await waitFor(() => inputs().some((input) => input.includes(DISTILL_PROMPT)), '蒸留のターン');
    s.clone.post(humanMessage('通常のターン'));
    await waitFor(() => inputs().some((input) => input.includes('通常のターン')), '通常のターン');
    s.clone.post(humanMessage('その次のターン'));
    await waitFor(() => inputs().some((input) => input.includes('その次のターン')), 'その次');

    const distill = inputs().find((input) => input.includes(DISTILL_PROMPT)) ?? '';
    const normal = inputs().find((input) => input.includes('通常のターン')) ?? '';
    const after = inputs().find((input) => input.includes('その次のターン')) ?? '';
    expect(distill).not.toContain(NOTICE);
    expect(normal).toContain(NOTICE);
    expect(normal).toContain('消えてはいけない報告の本文');
    expect(after).not.toContain(NOTICE);
    await s.clone.stop();
  });
});
