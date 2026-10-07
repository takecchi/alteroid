import { describe, it, expect } from 'vitest';
import { fingerprintOf } from './credentials.js';
import { tailByCodePoints } from './excerpt.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { setup, waitFor, waitForDone } from './clone-test-harness.js';

describe('クローン — 起動時に墓標を拾い直す（#564 E1b）', () => {
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
    await waitFor(
      () =>
        s.calls.some((call) =>
          call.inputs.some((input) => input.includes('GRAVE-TRANSCRIPT-MARKER-3c9d')),
        ),
      '蒸留へ生ログが渡ること',
    );
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
    expect(
      (await selfTexts(stores)).some((text) =>
        text.includes('前の器が記憶へ移せなかった区間を拾い直す'),
      ),
    ).toBe(false);

    await s.clone.stop();
  });

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
    expect(texts.some((text) => text.includes('退避が見つからないので、印を下ろした'))).toBe(false);
    expect(texts.some((text) => text.includes('前の器が記憶へ移せなかった区間を拾い直す'))).toBe(
      false,
    );
    const removedLine = texts.find((text) => text.includes('退避の本文が消されている'));
    expect(removedLine).toContain('置き場で解放した量ではなく');
    expect(removedLine).toContain('storedBytes');

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

describe('クローン — 拾い直しは退避の全文をヒープへ載せない（#1283）', () => {
  function expectedTailOf(fullBody: string, maxChars: number): string {
    const cut = tailByCodePoints(fullBody, maxChars);
    if (cut === fullBody) return fullBody;
    const newline = cut.indexOf('\n');
    return newline === -1 ? cut : cut.slice(newline + 1);
  }

  const DISTILL_TAIL_CHARS_MIRROR = 60_000;

  it('歯1: 退避の本文が巨大でも、呼び出し側が受け取る文字数は頭打ちになる', async () => {
    const stores = createMemoryStores();
    const hugeBody = `${'H'.repeat(3_000_000)}\nHUGE-TAIL-MARKER-9f2c1a\n`;
    const archiveId = (await stores.archive.archive('sess-huge', hugeBody)).id;
    await stores.sessions.setTranscriptGrave({ archiveId });

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
    expect(received.chars as number).toBeLessThan(hugeBody.length / 10);
    expect(received.chars as number).toBeGreaterThan(10_000);
  });

  it('歯2: 蒸留へ渡るものは、全文を読んで tailOf で切っていたときと同一である', async () => {
    const stores = createMemoryStores();
    const lines = Array.from(
      { length: 3000 },
      (_, i) => `LINE-${String(i).padStart(6, '0')}-${'x'.repeat(40)}`,
    );
    const fullBody = lines.join('\n');
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

    expect(chars).toBe(expected.length);
    expect(fp).toBe(fingerprintOf(expected));
  });

  it('歯3: 補助面の文字（絵文字）は、コードポイント数で短ければ蒸留の入力から消えない（issue #1829）', async () => {
    const stores = createMemoryStores();
    const overhead = 3 + 1;
    const filler = 'x'.repeat(DISTILL_TAIL_CHARS_MIRROR - overhead);
    const fullBody = `${'\u{1F600}'.repeat(3)}\n${filler}`;
    const codePoints = [...fullBody].length;
    expect(codePoints, '前提: コードポイント数はDISTILL_TAIL_CHARS_MIRROR以下').toBe(
      DISTILL_TAIL_CHARS_MIRROR,
    );
    expect(
      fullBody.length,
      '前提: UTF-16長（.length）はDISTILL_TAIL_CHARS_MIRRORを超える——ここが偽だと' +
        '旧実装の誤判定を再現できていない',
    ).toBeGreaterThan(DISTILL_TAIL_CHARS_MIRROR);

    const archiveId = (await stores.archive.archive('sess-astral-boundary', fullBody)).id;
    await stores.sessions.setTranscriptGrave({ archiveId });

    const s = setup(undefined, stores);
    await waitFor(async () => {
      const rows = (await stores.journal.list({ types: ['exchange'] })).filter(
        (entry) => entry.type === 'exchange',
      );
      return rows.some((entry) => entry.text.includes('ターンの入力: pre_compact_distill'));
    }, '蒸留の入力が日誌へ残ること');
    await s.clone.stop();

    expect(
      s.calls.some((call) => call.inputs.some((input) => input.includes('\u{1F600}'))),
      '絵文字が蒸留の入力から静かに消えている（issue #1829 の再現）',
    ).toBe(true);
  });
});

describe('クローン — 捨てた resume 素材の区間を拾い直す（#564 E1b）', () => {
  async function selfTexts(stores: Stores): Promise<string[]> {
    const rows = await stores.journal.list({ types: ['exchange'] });
    return rows
      .filter((entry) => entry.type === 'exchange' && entry.with === 'self')
      .map((entry) => (entry.type === 'exchange' ? entry.text : ''));
  }

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
        measureSize: async () => null,
      },
    };
    return { stores, asked };
  }

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
