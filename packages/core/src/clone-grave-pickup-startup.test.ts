import { describe, it, expect } from 'vitest';
import { fingerprintOf } from './credentials.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { setup, waitFor, waitForDone } from './clone-test-harness.js';

describe('クローン — 起動時に墓標を拾い直す（#564 E1b）', () => {
  /** 日誌の self/outbound を text で読む。 */
  async function selfTexts(stores: Stores): Promise<string[]> {
    const rows = await stores.journal.list({ types: ['exchange'] });
    return rows
      .filter((entry) => entry.type === 'exchange' && entry.with === 'self')
      .map((entry) => (entry.type === 'exchange' ? entry.text : ''));
  }

  it('墓標が在れば拾って蒸留し、印を下ろす', async () => {
    const stores = createMemoryStores();
    const archiveId = (
      await stores.archive.archive(
        'sess-old',
        'GRAVE-TRANSCRIPT-MARKER-3c9d 前の器が記憶へ移せなかった区間の生ログ',
      )
    ).id;
    await stores.sessions.setTranscriptGrave({ archiveId });

    const s = setup(undefined, stores);
    await waitFor(
      async () =>
        (await selfTexts(stores)).some((text) =>
          text.includes('前の器が記憶へ移せなかった区間を拾い直す'),
        ),
      '拾い直しの1行が日誌に残ること',
    );
    // **蒸留のサイドセッションへ中身が渡っている**（日誌の行だけでは、拾っただけで
    // 何も渡していない形と区別が付かない）。
    await waitFor(
      () =>
        s.calls.some((call) =>
          call.inputs.some((input) => input.includes('GRAVE-TRANSCRIPT-MARKER-3c9d')),
        ),
      '蒸留へ生ログが渡ること',
    );
    // **印は下りている**（蒸留が成功したので）。
    await waitFor(
      async () => (await stores.sessions.getTranscriptGrave()) === null,
      '印が下りること',
    );

    await s.clone.stop();
  });

  it('退避が見つからないときは、印を下ろして日誌に残す', async () => {
    const stores = createMemoryStores();
    await stores.sessions.setTranscriptGrave({ archiveId: 'sess-gone-0001' });

    const s = setup(undefined, stores);
    await waitFor(
      async () =>
        (await selfTexts(stores)).some((text) =>
          text.includes('退避が見つからないので、印を下ろした'),
        ),
      '印を下ろした1行が残ること',
    );
    expect(await stores.sessions.getTranscriptGrave()).toBeNull();
    // **蒸留は起こさない**（渡す中身が無い）。
    expect(
      (await selfTexts(stores)).some((text) =>
        text.includes('前の器が記憶へ移せなかった区間を拾い直す'),
      ),
    ).toBe(false);

    await s.clone.stop();
  });

  /**
   * #698 — 退避そのものは在ったが本文が `remove()` で落とされている場合
   * （tombstone）は、「見つからない」（missing）とは別の文言で印を下ろす。
   * `missing` の文言（直上のテスト）と字面が混ざらないことを、両方の否定で
   * 直接測る。
   */
  it('退避の本文が消されている（tombstone）ときは、missing とは別の文言で印を下ろす', async () => {
    const stores = createMemoryStores();
    const archiveId = (await stores.archive.archive('sess-removed', '畳めなかった生ログ\n')).id;
    await stores.archive.remove(archiveId);
    await stores.sessions.setTranscriptGrave({ archiveId });

    const s = setup(undefined, stores);
    await waitFor(
      async () =>
        (await selfTexts(stores)).some((text) => text.includes('退避の本文が消されている')),
      '印を下ろした1行が残ること',
    );
    expect(await stores.sessions.getTranscriptGrave()).toBeNull();

    const texts = await selfTexts(stores);
    // **missing の文言とは別物である**——同じ行が両方を名乗ることは無い。
    expect(texts.some((text) => text.includes('退避が見つからないので、印を下ろした'))).toBe(false);
    // 蒸留は起こさない（渡す中身が無い）。
    expect(texts.some((text) => text.includes('前の器が記憶へ移せなかった区間を拾い直す'))).toBe(
      false,
    );

    await s.clone.stop();
  });

  it('対照: 墓標が無ければ何も起こさない', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const texts = await selfTexts(stores);
    expect(texts.some((text) => text.includes('前の器が記憶へ移せなかった区間を拾い直す'))).toBe(
      false,
    );
    expect(texts.some((text) => text.includes('退避が見つからないので、印を下ろした'))).toBe(false);

    await s.clone.stop();
  });
});

/**
 * #1283 —— `#pickUpTranscriptGrave` が退避の本文を丸ごとヒープへ載せていた
 * （`archive.read()` で全文を取ってから `tailOf()` で末尾だけを使う＝絞り込みが
 * 「読んだ後」に在った）のを、`archive.readTail()`（末尾だけを返す口）へ直した。
 *
 * **この直しの成立条件は2つで、どちらか片方だけでは「痩せている」:**
 *
 * 1. **足りない側の裏返し** —— 呼び出し側が実際に受け取る文字数は、退避の
 *    本文がどれだけ巨大でも頭打ちになる（歯1）
 * 2. **やりすぎ側の裏返し** —— それでいて、蒸留へ渡るものは全文を読んで
 *    `tailOf()` で切っていたときと1文字も変わらない（削り過ぎていない。歯2）
 *
 * どちらも `tail.chars=` / `tail.fp=`（`turnInputEntry` が `pre_compact_distill`
 * の行へ書く、本文の長さと指紋）で測る——本文そのものを日誌へ写さない設計
 * （`turnInputEntry` の doc）なので、これが「渡った量と中身」を検算できる
 * 唯一の窓である。
 */
describe('クローン — 拾い直しは退避の全文をヒープへ載せない（#1283）', () => {
  /**
   * `tailOf`（`clone.ts`、非公開）のアルゴリズムそのままの再実装。
   *
   * ⚠️ `tailOf` は export されていない（蒸留の外へ漏らさない設計）ので、
   * ここでは doc に書かれた契約（末尾 maxChars 文字を切り、最初の改行より
   * 前を捨てる）をそのまま複製している。**この歯が測りたいのは `tailOf`
   * 自体の正しさではなく、`#pickUpTranscriptGrave` が `readTail()` 経由で
   * 渡すものが「全文に `tailOf` を適用した結果」と一致するか**である——
   * `readTail()` の契約（末尾から少なくとも maxChars 文字ぶんを返す。
   * それより多く返してもよい）が保たれている限り、超過ぶんの有無に関わらず
   * この結果は変わらないはずである。
   */
  function expectedTailOf(fullBody: string, maxChars: number): string {
    if (fullBody.length <= maxChars) return fullBody;
    const cut = fullBody.slice(-maxChars);
    const newline = cut.indexOf('\n');
    return newline === -1 ? cut : cut.slice(newline + 1);
  }

  /**
   * `DISTILL_TRANSCRIPT_TAIL_CHARS`（`clone.ts`、非公開。60,000）と同じ値を
   * 固定のリテラルとして持つ。**掛け算で合成しない**——変異試験で定数側が
   * 壊れても（例えば `Number.MAX_SAFE_INTEGER` へ変異）、ここから作る合成
   * データの長さが吹き飛ばないようにするため
   * （`.claude/skills/mutation-testing/SKILL.md` の注意）。
   */
  const DISTILL_TAIL_CHARS_MIRROR = 60_000;

  it('歯1: 退避の本文が巨大でも、呼び出し側が受け取る文字数は頭打ちになる', async () => {
    const stores = createMemoryStores();
    const hugeBody = `${'H'.repeat(3_000_000)}\nHUGE-TAIL-MARKER-9f2c1a\n`;
    const archiveId = (await stores.archive.archive('sess-huge', hugeBody)).id;
    await stores.sessions.setTranscriptGrave({ archiveId });

    // **`TranscriptArchive` を計測用の殻で包む。** `readTail` の戻り値の
    // 文字数を記録するだけで、それ以外は素通しする——「`readTail` を呼んで
    // いるか」だけを見る歯にしない（見るのは実際に呼び出し側へ渡った量その
    // もの）。もし実装が `read()`（全文）へ後退したら、その呼び出しも同じ
    // 殻を経由するので `via` が `'read'` になり、受け取る量も本文全体まで
    // 跳ね上がる——この歯自身が「足りない側」の変異（`readTail`→`read` への
    // 差し戻し）を検出する構造になっている。
    const received: { chars: number | null; via: 'read' | 'readTail' | null } = {
      chars: null,
      via: null,
    };
    const wrapped: Stores = {
      ...stores,
      archive: {
        ...stores.archive,
        async read(id) {
          const result = await stores.archive.read(id);
          if (result.kind === 'body') {
            received.chars = result.body.length;
            received.via = 'read';
          }
          return result;
        },
        async readTail(id, maxChars) {
          const result = await stores.archive.readTail(id, maxChars);
          if (result.kind === 'body') {
            received.chars = result.body.length;
            received.via = 'readTail';
          }
          return result;
        },
      },
    };

    const s = setup(undefined, wrapped);
    await waitFor(() => received.chars !== null, '拾い直しが本文を読むこと');
    await s.clone.stop();

    expect(received.via).toBe('readTail');
    // **頭打ちになっている**：受け取った量は本文全体よりオーダーで小さい。
    expect(received.chars as number).toBeLessThan(hugeBody.length / 10);
    // **削り過ぎてもいない**（0 や極端な短さへ倒れていない）——「足りない」
    // と「やりすぎ」の両方から離れた帯であることを見る。
    expect(received.chars as number).toBeGreaterThan(10_000);
  });

  it('歯2: 蒸留へ渡るものは、全文を読んで tailOf で切っていたときと同一である', async () => {
    const stores = createMemoryStores();
    const lines = Array.from(
      { length: 3000 },
      (_, i) => `LINE-${String(i).padStart(6, '0')}-${'x'.repeat(40)}`,
    );
    const fullBody = lines.join('\n');
    // 前提を先に測る。ここが偽なら、下の歯は「切っていない」ことを検出できない。
    expect(fullBody.length).toBeGreaterThan(DISTILL_TAIL_CHARS_MIRROR * 2);

    const expected = expectedTailOf(fullBody, DISTILL_TAIL_CHARS_MIRROR);

    const archiveId = (await stores.archive.archive('sess-identical', fullBody)).id;
    await stores.sessions.setTranscriptGrave({ archiveId });

    const s = setup(undefined, stores);
    await waitFor(async () => {
      const rows = (await stores.journal.list({ types: ['exchange'] })).filter(
        (entry) => entry.type === 'exchange',
      );
      return rows.some((entry) => entry.text.includes('ターンの入力: pre_compact_distill'));
    }, '蒸留の入力が日誌へ残ること');
    await s.clone.stop();

    const rows = (await stores.journal.list({ types: ['exchange'] })).filter(
      (entry) => entry.type === 'exchange',
    );
    const inputRow = rows.find((entry) => entry.text.includes('ターンの入力: pre_compact_distill'));
    expect(inputRow, '日誌に pre_compact_distill の行が無い').toBeDefined();
    const chars = Number(/tail\.chars=(\d+)/u.exec(inputRow?.text ?? '')?.[1] ?? '-1');
    const fp = /tail\.fp=([0-9a-f]+)/u.exec(inputRow?.text ?? '')?.[1];

    // **長さだけでは、別の同じ長さの何かを渡しても通る**——指紋まで見る。
    expect(chars).toBe(expected.length);
    expect(fp).toBe(fingerprintOf(expected));
  });
});

/**
 * **`init` すら来ずに落ちた回**の区間を、預けた生ログ（pg）から拾い直す
 * （#564 E1b。`#noteLostSession` / `#pickUpLostSession`）。
 *
 * ## PR1（`TranscriptGrave`）では拾えない理由
 *
 * この回は道具を1つも使っていないので在り処の控えが `null` で、**退避そのものが
 * 走っていない。** ⟹ `archive` を指す墓標は立たない。材料は pg に預けた生ログだけである。
 */
describe('クローン — 捨てた resume 素材の区間を拾い直す（#564 E1b）', () => {
  /** 日誌の self を text で読む。 */
  async function selfTexts(stores: Stores): Promise<string[]> {
    const rows = await stores.journal.list({ types: ['exchange'] });
    return rows
      .filter((entry) => entry.type === 'exchange' && entry.with === 'self')
      .map((entry) => (entry.type === 'exchange' ? entry.text : ''));
  }

  /** 末尾だけを返す口を持つ器（pg 構成の代役）。 */
  function storesWithTail(tail: string | null): {
    stores: Stores;
    asked: { key: { projectKey: string; sessionId: string }; maxChars: number }[];
  } {
    const base = createMemoryStores();
    const asked: { key: { projectKey: string; sessionId: string }; maxChars: number }[] = [];
    const stores: Stores = {
      ...base,
      sessionTranscriptTail: {
        async readTail(key, maxChars) {
          asked.push({ key, maxChars });
          return tail;
        },
        // **この describe は拾い上げ（#564 E1b）を測るもので、resume 予算
        // （#1283）の判定は対象外。** `null`（測れなかった＝従来どおり resume
        // する）にして、既存のシナリオへ影響させない。
        measureSize: async () => null,
      },
    };
    return { stores, asked };
  }

  /**
   * **⭐ 捨てる前に立てる。** 捨てた後だと、立てる前にプロセスが死んだ回で id が
   * どこにも残らない。
   *
   * そして拾う鍵（`projectKey`）は**器を跨いだ値**である —— このプロセスでは `append` が
   * 1度も来ていない（`init` すら来ていないのだから当然である）。**それがこの経路の
   * 常態なので、前の器が覚えた値から埋める。**
   */
  it('resume に失敗して素材を捨てるとき、墓標を残す', async () => {
    const { stores } = storesWithTail(null);
    await stores.sessions.setCloneSessionId('stale-session-id');
    await stores.sessions.setProjectKey('-workspace');

    const s = setup(undefined, stores, { failWith: 'No conversation found with session ID' });
    s.clone.post(humanMessage('やあ'));

    await waitFor(
      async () => (await stores.sessions.getCloneSessionId()) === null,
      'session id が消える',
    );
    expect(await stores.sessions.getCloneSessionId()).toBeNull();
    expect(await stores.sessions.getLostSessionGrave()).toEqual({
      projectKey: '-workspace',
      sessionId: 'stale-session-id',
    });

    await s.clone.stop();
  });

  /**
   * **対照: 生ログの預け先が無い器（fs 構成）では墓標を立てない。**
   *
   * 立てても拾う材料が無いので、**残るのは拾えない印だけになる。** そして fs で動かす
   * たびに同じ1行が積もる。
   */
  it('対照: 預けた生ログを読む口が無ければ墓標を立てない', async () => {
    const stores = createMemoryStores();
    await stores.sessions.setCloneSessionId('stale-session-id');
    await stores.sessions.setProjectKey('-workspace');

    const s = setup(undefined, stores, { failWith: 'No conversation found with session ID' });
    s.clone.post(humanMessage('やあ'));

    await waitFor(
      async () => (await stores.sessions.getCloneSessionId()) === null,
      'session id が消える',
    );
    expect(await stores.sessions.getCloneSessionId()).toBeNull();
    expect(await stores.sessions.getLostSessionGrave()).toBeNull();

    await s.clone.stop();
  });

  it('墓標が在れば、預けた生ログの末尾から拾って蒸留し、印を下ろす', async () => {
    const { stores, asked } = storesWithTail('LOST-SESSION-MARKER-8b41 前のセッションの末尾');
    await stores.sessions.setLostSessionGrave({
      projectKey: '-workspace',
      sessionId: 'sess-lost',
    });

    const s = setup(undefined, stores);
    await waitFor(
      async () =>
        (await selfTexts(stores)).some((text) =>
          text.includes('捨てたセッションの区間を、預けた生ログから拾い直す'),
        ),
      '拾い直しの1行が日誌に残ること',
    );
    await waitFor(
      () =>
        s.calls.some((call) =>
          call.inputs.some((input) => input.includes('LOST-SESSION-MARKER-8b41')),
        ),
      '蒸留へ末尾が渡ること',
    );
    await waitFor(
      async () => (await stores.sessions.getLostSessionGrave()) === null,
      '印が下りること',
    );

    // **⭐ 全件ではなく、有限の窓を要求している**（`load()` を使わない、が設計）。
    expect(asked[0]?.key).toEqual({ projectKey: '-workspace', sessionId: 'sess-lost' });
    expect(asked[0]?.maxChars).toBeGreaterThan(0);
    expect(asked[0]?.maxChars).toBeLessThanOrEqual(1_000_000);

    await s.clone.stop();
  });

  it('預けた生ログが1件も無ければ、印を下ろして日誌に残す', async () => {
    const { stores } = storesWithTail(null);
    await stores.sessions.setLostSessionGrave({
      projectKey: '-workspace',
      sessionId: 'sess-empty',
    });

    const s = setup(undefined, stores);
    await waitFor(
      async () =>
        (await selfTexts(stores)).some((text) =>
          text.includes('捨てたセッションの生ログが1件も無いので、印を下ろした'),
        ),
      '印を下ろした1行が残ること',
    );
    expect(await stores.sessions.getLostSessionGrave()).toBeNull();
    expect(
      (await selfTexts(stores)).some((text) =>
        text.includes('捨てたセッションの区間を、預けた生ログから拾い直す'),
      ),
    ).toBe(false);

    await s.clone.stop();
  });
});

/**
 * `UsageFold.delta`（ターン1回ぶんの増分）は台帳へ積むだけで捨てていた。
 * 台帳は日 × actor × モデル × 層 × 場所に畳むので、「そのターンがいくらだったか」
 * は台帳のどこにも残らない。ここは `#recordUsage` が `turn_usage` として
 * 日誌へ残すことを見る（`manager.ts` の `case 'usage'` にも対になる形を足した
 * — 片方だけだと非対称が残る）。
 */
