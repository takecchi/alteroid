import { describe, expect, it } from 'vitest';

import { EXCHANGE_KIND_FAILURE_PREFIX } from './exchange-kind.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { setup, waitFor } from './clone-test-harness.js';

describe('クローン — ターンの失敗の文は伏せ字を通る（#2483）', () => {
  const FAKE = 'FAKE_SECRET_VALUE_2483';

  async function selfFailure(stores: Stores) {
    const entries = (await stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      text: string;
    }[];
    return entries.find(
      (entry) =>
        entry.with === 'self' &&
        entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}人間との対話ターンが失敗した`),
    );
  }

  it('drizzle の形の多行の例外: 日誌にも error イベントにも params の値は出ない', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, {
      failWith: `Failed query: insert into "turns" ("body") values ($1)\nparams: ${FAKE}`,
    });

    s.clone.post(humanMessage('やあ', 'conv-1'));
    await waitFor(async () => (await selfFailure(stores)) !== undefined, '失敗の行が積まれる');

    const failure = await selfFailure(stores);
    expect(failure?.text).toContain('Failed query');
    expect(failure?.text).not.toContain(FAKE);
    expect(JSON.stringify(await stores.journal.list({}))).not.toContain(FAKE);
    const errors = s.events.filter((event) => event.type === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(s.events)).not.toContain(FAKE);

    await s.clone.stop();
  });

  it('対照: 文脈窓の文言が2行目以降に在る例外でも、分類は生の文字列で働く（値は出ない）', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, {
      failWith: `Failed query: select 1\nparams: ${FAKE}\nprompt is too long: 220000 tokens > 200000 maximum`,
    });

    s.clone.post(humanMessage('やあ', 'conv-1'));
    await waitFor(async () => (await selfFailure(stores)) !== undefined, '失敗の行が積まれる');

    const failure = await selfFailure(stores);
    expect(failure?.text).toContain('context_window_failure');
    expect(failure?.text).toContain('prompt_too_long');
    expect(failure?.text).not.toContain(FAKE);
    expect(JSON.stringify(s.events)).not.toContain(FAKE);

    await s.clone.stop();
  });
});
