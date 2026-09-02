import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import type { CloneHost } from './host.js';
import type { ChatStreamEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { createCloneTools } from './tools.js';

/**
 * `clone.ts` の `#withFreshMemory()` を SDK 抜きで固定する。
 *
 * 対象は「記憶が複数の文書からなり、そのうち1つだけが変わったとき、注入される
 * のは変わった文書だけであり、変わっていない文書の本文は含まれない」という
 * 1点だけ。この振る舞いは PR #97 が実装済みで、現在の実装
 * （`packages/core/src/clone.ts` の `#withFreshMemory()` にある
 * `documents.filter((doc) => this.#memoryOnRecord.get(doc.slug) !== doc.content)`）
 * が差分判定を行っている。このファイルは #97 のテスト（`clone.test.ts`）とは
 * 別の組み立て方（下記 `fakeSdk` を自前で組み直したもの）から、その差分判定を
 * 押さえる歯である。
 *
 * **なぜ2ファイルに分けて置くか**: 変異試験（差分判定 `changed =
 * documents.filter(...)` を `changed = documents` に潰す変異）では、
 * `clone.test.ts` とこのファイルの両方が落ちた。一方、削除の伝え方
 * （`削除された記憶: ...` の生成を `[]` へ握り潰す変異）では `clone.test.ts`
 * だけが落ち、このファイルの3本はいずれも緑のままだった。つまり**このファイルが
 * 押さえているのは差分判定だけで、削除の名前通知には歯が無い**。片方を
 * 「重複だから」と消すと、その一方だけが持つ歯が消える（詳細は PR 本文の
 * 変異試験の表を参照）。
 *
 * このファイルは新規追加であり、`clone.ts` / `clone.test.ts` はどちらも
 * 1文字も変更していない。ここでは `clone.test.ts` の `setup()` と同じ組み立て方
 * （`createClone({ queryFn })` に偽の `query` を渡す）を、この新規ファイル内に
 * 自前で組み直している（`clone.test.ts` を export するための変更はしない）。
 */

interface FakeCall {
  options: Options;
  inputs: string[];
}

/**
 * `clone.test.ts` の `fakeSdk` と同じ骨格の簡約版。ここで検証したいのは
 * 「クローンへ渡る入力テキストに何が載るか」だけなので、レート制限・システム
 * 通知・モデル使用量といった他テストの関心事は削り、`inputs` の捕獲だけを残す。
 */
function fakeSdk(): { fn: typeof sdkQuery; calls: FakeCall[] } {
  const calls: FakeCall[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const call: FakeCall = { options: params.options ?? {}, inputs: [] };
    calls.push(call);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
        model: 'claude-fake-init-model-xyz',
        claude_code_version: '9.9.9-fake',
        apiKeySource: 'user',
        permissionMode: 'default',
        mcp_servers: [{ name: 'alteroid', status: 'connected' }],
      } as unknown as SDKMessage;

      const prompt = params.prompt;
      if (typeof prompt === 'string') {
        call.inputs.push(prompt);
        yield* turn(prompt);
        return;
      }

      for await (const message of prompt as AsyncIterable<{ message: { content: unknown } }>) {
        const text = String(message.message.content);
        call.inputs.push(text);
        yield* turn(text);
      }
    }

    function* turn(inputText: string): Generator<SDKMessage> {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'わかった' }] },
        parent_tool_use_id: null,
        session_id: 'sess-fake',
        uuid: 'uuid-assistant',
      } as unknown as SDKMessage;
      yield {
        type: 'result',
        subtype: 'success',
        result: 'わかった',
        session_id: 'sess-fake',
        uuid: 'uuid-result',
      } as unknown as SDKMessage;
      void inputText;
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, calls };
}

interface Setup {
  clone: CloneHost;
  stores: Stores;
  calls: FakeCall[];
  events: ChatStreamEvent[];
}

function setup(stores: Stores = createMemoryStores()): Setup {
  const { fn, calls } = fakeSdk();
  const clone = createClone({ stores, queryFn: fn, env: {} });
  const events: ChatStreamEvent[] = [];
  clone.subscribe('conv-1', (event) => events.push(event));
  return { clone, stores, calls, events };
}

/** chat の1往復が終わる（done が届く）まで待つ（`clone.test.ts` の同名関数と同じ形）。 */
function waitForDone(events: ChatStreamEvent[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (events.some((event) => event.type === 'done')) {
        clearInterval(tick);
        resolve();
      } else if (Date.now() - started > 3000) {
        clearInterval(tick);
        reject(new Error(`done が来ない: ${JSON.stringify(events)}`));
      }
    }, 5);
  });
}

// 記憶を2文書にする。「十分長い」を実際に確かめられるよう、about-me は
// notes よりずっと長く、かつ notes とは重ならない一意な語を含める。
const ABOUT_ME_BODY = Array.from(
  { length: 40 },
  (_, i) => `about-me文書の本文${i}行目: 変わらないはずの長い自己紹介の一節である。`,
).join('\n');
const NOTES_BODY_OLD = 'notes文書の本文（旧）: 短いメモである。';
const NOTES_BODY_NEW = 'notes文書の本文（新）: 短いメモを書き換えた。';

describe('クローンの記憶注入（差分のみを載せるべき、という固定したい振る舞い）', () => {
  it('変わっていない文書の本文は、注入に含まれてはならない', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('about-me', ABOUT_ME_BODY);
    await stores.persona.write('notes', NOTES_BODY_OLD);

    const s = setup(stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    // notes だけを書き換える。about-me は1文字も触らない。
    await stores.persona.write('notes', NOTES_BODY_NEW);

    const events: ChatStreamEvent[] = [];
    s.clone.subscribe('conv-2', (event) => events.push(event));
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);

    const secondInjectedInput = (s.calls[0] as FakeCall).inputs[1] ?? '';

    // #97 が実装した差分判定（clone.ts の #withFreshMemory にある
    // `documents.filter((doc) => this.#memoryOnRecord.get(doc.slug) !== doc.content)`）
    // により、notes だけが変わったこのケースでは about-me の本文は注入に含まれない。
    expect(secondInjectedInput).not.toContain(ABOUT_ME_BODY);

    await s.clone.stop();
  });

  it('歯1（足場健全性チェック）: 変わった文書の本文は、注入に含まれる（現状の実装でも通る）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('about-me', ABOUT_ME_BODY);
    await stores.persona.write('notes', NOTES_BODY_OLD);

    const s = setup(stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.write('notes', NOTES_BODY_NEW);

    const events: ChatStreamEvent[] = [];
    s.clone.subscribe('conv-2', (event) => events.push(event));
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);

    const secondInjectedInput = (s.calls[0] as FakeCall).inputs[1] ?? '';

    // 上のテストが通っている理由が「差分判定が正しく効いているから」ではなく
    // 「足場が壊れていて secondInjectedInput が空文字列のままだから」である
    // 可能性が残る（`not.toContain` は対象が空でも空振りで真になる）。この
    // テストは通らなければならない（AGENTS.md「テストの足場・スタブ・モックは、
    // 動くのに嘘をつく」）。
    expect(secondInjectedInput).toContain(NOTES_BODY_NEW);

    await s.clone.stop();
  });

  it('歯2（空振り防止）: 偽 query は実際に呼ばれ、入力テキストを1件以上捕まえている', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('about-me', ABOUT_ME_BODY);
    await stores.persona.write('notes', NOTES_BODY_OLD);

    const s = setup(stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.write('notes', NOTES_BODY_NEW);

    const events: ChatStreamEvent[] = [];
    s.clone.subscribe('conv-2', (event) => events.push(event));
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);

    // 0件でも上の2テストの `not.toContain` / `toContain` はどちらも「空文字列に
    // 対する判定」として成立してしまいうる（`not.toContain` は静かに空振りして
    // 真になり、AGENTS.md「不在チェックは X が存在しうる場所で」が指す穴その
    // ものになる）。ここで「そもそも入力が捕まっているか」を独立に確かめる。
    const capturedInputs = (s.calls[0] as FakeCall).inputs;
    expect(capturedInputs.length).toBeGreaterThanOrEqual(2);

    await s.clone.stop();
  });
});

/**
 * ⭐ 通しの歯（依頼者の門5）: `memory_write`（道具）の応答に出る「次のターンの
 * 会話へ載る見込み: N 文字」の N が、次のターンに `#withFreshMemory` が実際に
 * 載せる塊の文字数と一致すること。
 *
 * **書く側と読む側を同じストアの実物で繋ぐ。** `describeMemoryReinjectionEstimate`
 * （書く側。`tools.ts` の `memory_write`）と `#withFreshMemory`（読む側。
 * `clone.ts`）は別々の場所で `renderMemoryDocuments` を呼ぶ——どちらも正しく
 * 見えても、渡す `presentInMemory` の中身が食い違えば数は合わない。この歯は
 * `createCloneTools` と `createClone` の両方へ**同じ `createMemoryStores()` の
 * 実体**を渡し、(1) 道具のハンドラを直接呼んで応答から N を取り出し、
 * (2) 同じストアで次のターンをクローンへ流して実際に載った塊の文字数を数え、
 * 両者を突き合わせる。**期待値をこのテストの中で `renderMemoryDocuments(...)`
 * を呼び直して組み立てない**——呼び直すと実装と同じ式を2度書くだけになり、
 * 書く側と読む側が食い違っても検出できない（依頼者の門5そのもの）。
 *
 * ## シナリオ: 親が今回の書き込みに含まれない fact を書く
 *
 * 1ターン目で premise `core` だけを記憶に置く。2ターン目相当のところで
 * （クローンのターンは経由せず）`memory_write` 道具を直接叩いて、`core` を
 * 親に持つ fact `child` を**新規作成**する——`core` はこの書き込みには
 * 含まれない。直す前はここで「見つからない」（短い印）で数えていたため、
 * 見込みが実際より32文字少なかった（`memory.ts` の「⭐ 直っていたもの」の doc）。
 * 続けてクローンへ次のターンを流すと、`#withFreshMemory` は `child` だけを
 * 差分として載せ直す（`core` は今回変わっていないので載らない——「親も
 * 一緒に載せる」に化けていないことも見る）。
 */
describe('通しの歯 — memory_write の見込み文字数と、次のターンに実際に載る塊の文字数が一致する', () => {
  it('⭐ 親が今回の書き込みに含まれない fact を書いたとき、見込みと実物が一致する（直す前は32文字少なかった）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('core', '# core\n\n前提の本文\n');

    const s = setup(stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    // **道具を直接叩く。** `memory_write` のハンドラは `tools.ts` の実装
    // そのもの——クローンの中を経由しない分、書く側だけを狙って呼べる。
    const emitted: ChatStreamEvent[] = [];
    const tools = createCloneTools({
      stores,
      emit: (event) => emitted.push(event),
      memoryCause: () => 'clone',
    });
    const memoryWrite = tools.find((entry) => entry.name === 'memory_write');
    if (memoryWrite === undefined) throw new Error('memory_write が無い（足場の欠陥）');
    const result = await memoryWrite.handler(
      {
        slug: 'child',
        content: '---\ntype: fact\ndescription: 子の要旨\nparent: core\n---\n# child\n\n子の本文\n',
        summary: '子を書いた',
      } as never,
      {},
    );
    const reply = (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');

    // 書く側の応答から N を取り出す（`formatMemoryCharCount` は
    // `toLocaleString('en-US')` で桁区切りを入れうるので、カンマを剥がして戻す）。
    const match = reply.match(/次のターンの会話へ載る見込み: ([\d,]+) 文字/);
    const matchedDigits = match?.[1];
    expect(matchedDigits).toBeDefined();
    const estimatedChars = Number((matchedDigits ?? '').replaceAll(',', ''));

    // 読む側: 同じストアで次のターンをクローンへ流す。
    const events: ChatStreamEvent[] = [];
    s.clone.subscribe('conv-2', (event) => events.push(event));
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);
    const secondTurnInput = (s.calls[0] as FakeCall).inputs[1] ?? '';

    // 「親も一緒に載せる」に化けていないこと——`core` の本文（premise としての
    // 全文）は載せ直しに出てこない（このシナリオでは `core` は変わっていない）。
    expect(secondTurnInput).not.toContain('前提の本文');
    expect(secondTurnInput).not.toContain('<!-- memory: core.md -->');
    expect(secondTurnInput).toContain('親 core は在るが、ここに載せた分には含まれない');

    // **実際に載った塊を取り出す。** `#withFreshMemory`（`clone.ts`）は
    // `[head, '', renderMemoryDocuments(changed, {...}), '', '---', '', text]`
    // を `'\n'` で繋ぐ——`renderMemoryDocuments` の直後には必ず空行 +
    // `---` + 空行が続き、その先が元のターンの本文（`text`。ここでは
    // commitments の断りと人間の発話がさらに続く）である。この書き込みは
    // fact 1件だけなので、`renderMemoryDocuments` の出力は目次節
    // （`<!-- memory: index -->` から始まる）だけになる——だから
    // その印から、直後に現れる `\n\n---\n\n`（元の本文との区切り。他の場所には
    // 出ない——出るなら `text` の中の別の区切りで、それはこの印より後ろにしか
    // 無い）までがそのまま「実際に載った塊」である。
    const marker = '<!-- memory: index -->';
    const markerIndex = secondTurnInput.indexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const boundary = '\n\n---\n\n';
    const boundaryIndex = secondTurnInput.indexOf(boundary, markerIndex);
    expect(boundaryIndex).toBeGreaterThan(markerIndex);
    const actualInjectedChars = secondTurnInput.slice(markerIndex, boundaryIndex).length;

    // **本体。** 書く側（見込み）と読む側（実物）が一致する。
    expect(actualInjectedChars).toBe(estimatedChars);

    await s.clone.stop();
  });
});
