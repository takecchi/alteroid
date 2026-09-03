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
 *
 * ## ⚠️ 切り出しは範囲を自己確認する（PR #620 が自己申告で残した限界を閉じる）
 *
 * 直後のコードは、載せ直した塊を `<!-- memory: index -->`（marker）から
 * 最初の `\n\n---\n\n`（boundary）までで切り出して文字数を数える。**PR #620
 * の本文はこれを「範囲外」として明記していた**——`#withFreshMemory`
 * （`clone.ts`）の連結の並びが変われば、この切り出しは落ちずに黙って
 * 別の範囲を測りうる、という自己申告である。
 *
 * **現物の連結は、コメントが言うより枝が多い。** `#withFreshMemory` の
 * `return [...]` は次の可変な枝を持つ（`grep -Fn -- '削除された記憶: '
 * packages/core/src/clone.ts` / `grep -Fn -- '（記憶は空になった）'
 * packages/core/src/clone.ts` が当たる）:
 * - `resumeNotice`（resume 直後の断り）が **`head` より前** に付く枝
 * - `removed`（削除された文書名の列挙）が **`renderMemoryDocuments` の後・
 *   boundary の手前** に入る枝
 * - `documents.length === 0` のとき「（記憶は空になった）」が **同じ位置**
 *   に入る枝
 *
 * このシナリオでは4本ともガードが `false`（resume していない・何も削除して
 * いない・記憶は空でない）なので、**いまの marker→boundary が緑なのは
 * これらの枝が1本も立たないからであって、切り出しが頑健だからではない**。
 * 枝が立てば、marker から最初の boundary までの範囲は「意図した記憶の塊」
 * より広い／狭いものを指しうる——それでも `estimatedChars`（書く側）は
 * これらの枝を知らないので、値が一致してしまえば `toBe` だけでは気づけない
 * （値の食い違いは検出できても、範囲そのものの正しさは示せない）。
 *
 * **だから、値の一致とは別に、切り出した範囲そのものを自己確認する歯を足す**
 * （下の「切り出しの自己確認」ブロック）。少なくとも: (1) marker が入力全体で
 * ちょうど1回しか現れない（複数あれば、どれを取ったかは運になる）、
 * (2) 切り出した塊が marker で始まる、(3) 塊が印だけではなく実際の中身
 * （目次の見出し・`child` の行・「親 core は在るが…」の注記）を含む、
 * (4) 塊の外に在るはずのもの（`head` の断り文・commitments 相当・人間の
 * 発話そのもの）を塊が含まない、(5) boundary の直後が元のターンの本文
 * （このシナリオでは通知が1つも立たないので、人間の発話 `'2回目'` そのもの
 * と厳密に一致する）であること——を見る。
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

    // このシナリオは resume していない（`#resumedHistoryHasMemory` は
    // 立っていない）ので、resume 直後の断り（`RESUMED_MEMORY_NOTICE`。
    // clone.ts）が入力のどこにも現れてはならない。これは marker/boundary の
    // 範囲の外——連結の先頭（`head` より前）に付く枝なので、marker→boundary
    // の切り出し（下）だけでは捕まらない。**この節が捕まえるのは、まさに
    // そこ**（`resumeNotice` を常に先頭へ付けるように変異させると、
    // marker→boundary の値もその範囲も1文字も変わらないまま、ここだけが
    // 落ちる——変異試験(a)の実測は PR 本文にある）。
    expect(secondTurnInput).not.toContain('前のセッションを引き継いで');

    // **実際に載った塊を取り出す。** `#withFreshMemory`（`clone.ts`）の現物の
    // 連結は `[...(resumeNotice?), head, ...(changed?), ...(removed?),
    // ...(documents.length===0?), '', '---', '', text]`——このシナリオでは
    // resumeNotice / removed / 「空になった」の3枝がいずれも立たないので、
    // `renderMemoryDocuments` の直後には必ず空行 + `---` + 空行が続き、その先が
    // 元のターンの本文（`text`）である。この書き込みは fact 1件だけなので、
    // `renderMemoryDocuments` の出力は目次節（`<!-- memory: index -->` から
    // 始まる）だけになる——だからその印から、直後に現れる `\n\n---\n\n`
    // （元の本文との区切り。他の場所には出ない——出るなら `text` の中の別の
    // 区切りで、それはこの印より後ろにしか無い）までがそのまま
    // 「実際に載った塊」である。
    const marker = '<!-- memory: index -->';
    const markerIndex = secondTurnInput.indexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const boundary = '\n\n---\n\n';
    const boundaryIndex = secondTurnInput.indexOf(boundary, markerIndex);
    expect(boundaryIndex).toBeGreaterThan(markerIndex);
    const actualInjectedChars = secondTurnInput.slice(markerIndex, boundaryIndex).length;

    // **本体。** 書く側（見込み）と読む側（実物）が一致する。
    expect(actualInjectedChars).toBe(estimatedChars);

    // ## 切り出しの自己確認（依頼者の基準: 測る対象が意図した範囲であることを、
    // 歯自身が確かめられること）
    //
    // 上の `toBe` は「値」が合っているかしか見ない——marker から最初の
    // boundary までという「範囲」そのものが正しいかは、値の一致だけでは
    // 保証できない（値が偶然揃えば `toBe` は素通りする）。以下は範囲の正しさを
    // 直接見る。

    // (1) marker は入力全体でちょうど1回しか現れない。2回以上あれば
    // `indexOf` がどれを拾うかは実装の詳細に依存する「運」になる。
    const markerOccurrences = secondTurnInput.split(marker).length - 1;
    expect(markerOccurrences).toBe(1);

    // 切り出した塊そのもの。
    const chunk = secondTurnInput.slice(markerIndex, boundaryIndex);

    // (2) 塊は marker で始まる（スライスの定義から自明に見えるが、抽出の
    // やり方が変われば崩れうる不変条件として明示する）。
    expect(chunk.startsWith(marker)).toBe(true);

    // (3) 塊は印だけを掴んでいるのではなく、実際に載るはずの中身を含む——
    // 目次の見出し、`child` の行、そして「親は在るが今回載せた分には
    // 含まれない」という parent-not-rendered の注記（これが無いと、直す前の
    // 欠落——親の frontmatter を「見つからない」の短い印で数える——へ戻っても
    // この歯は気づけない）。
    expect(chunk).toContain('## 記憶の目次');
    expect(chunk).toContain('child');
    expect(chunk).toContain('子の要旨');
    expect(chunk).toContain('親 core は在るが、ここに載せた分には含まれない');
    // 塊は印1つぶんより十分に長い——空や印だけを掴んでいる状態ではない。
    expect(actualInjectedChars).toBeGreaterThan(marker.length + 20);

    // (4) 塊は「塊の外に在るはずのもの」を含まない——`head`（marker より前に
    // 付くはずの断り文）、`core` の premise 本文、そして元のターンの本文
    // （人間の発話）そのもの。head が万一 marker と boundary の間へ紛れ込む
    // 連結（例: head を renderMemoryDocuments の後ろへ動かす）が入っても、
    // 上の `toBe`（値の一致）だけでは長さがずれて落ちるとは限らない
    // （head の長さぶんズレるので実際にはここでも落ちるが、値だけに頼らない
    // ためにここでも明示する）。
    expect(chunk).not.toContain('[system] 記憶が更新された');
    expect(chunk).not.toContain('前提の本文');
    expect(chunk).not.toContain('<!-- memory: core.md -->');
    expect(chunk).not.toContain('2回目');

    // (5) boundary の直後は元のターンの本文の始まり——具体的には**必ず末尾に
    // 人間の発話そのものが来る**（`#runTurn` が `#withFreshMemory` へ渡す
    // 引数は `distillGapNotice + contextWindowFoldNotice + redeliveryNotice +
    // commitmentNotice + text` で、人間の発話（`text`）は常に最後に足される
    // ——他の断り書きが何個立っていても、末尾は変わらない）。
    //
    // ⚠️ 実測で分かったこと（依頼者の見立てにも `AGENTS.md`「通しの歯…」の
    // どちらにも無かった限界）: この2ターン目では `#commitmentNotice`
    // （引き受けたまま終わっていない仕事の断り。1ターン目の人間の発話が
    // `commitment_close` されずに残っているため立つ）が実際に非空になり、
    // **その断り自身が `\n\n---\n\n` という区切りをもう1つ内部に持つ**
    // （`describeDistillGap` などと同じ「本文の直前に `---` を足す」形）。
    // つまり `secondTurnInput` 全体では `\n\n---\n\n` が2回以上現れうる——
    // だから「boundary は全体でちょうど1回しか現れない」という不変条件は
    // **立てられない**（一度そう書いて実測に落とされた。生の失敗はこの節の
    // すぐ下、PR 本文の変異試験の節に貼ってある）。**それでも
    // `secondTurnInput.indexOf(boundary, markerIndex)` が拾う最初の1回は、
    // 塊とその後ろの通知群を隔てる本物の区切りである**——`#withFreshMemory`
    // 自身の区切り（`'', '---', ''`）は `renderMemoryDocuments` の直後、
    // `text`（＝ここに埋め込まれた commitmentNotice の区切りより必ず前）に
    // 置かれるため。**だから「厳密に1回」ではなく「末尾が人間の発話で
    // 終わる」という、通知の本数に依存しない形で確認する。**
    const afterBoundary = secondTurnInput.slice(boundaryIndex + boundary.length);
    expect(afterBoundary.endsWith('2回目')).toBe(true);
    // そして marker はここまでの (1) で入力全体につき1回だけと確認済みなので、
    // boundary の後ろ（`afterBoundary`）に記憶の塊が2つ目として紛れ込む
    // （＝ marker が再度現れる）ことも無い。
    expect(afterBoundary).not.toContain(marker);

    await s.clone.stop();
  });
});
