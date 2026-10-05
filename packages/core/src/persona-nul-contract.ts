import type { PersonaStore } from './store.js';

/**
 * `PersonaStore` の本文の NUL の約束（issue #2927。teto の判断、2026-10-05）を、**実装1つに対して**
 * 測る。3実装（インメモリ / fs / pg）が同じ関数を呼ぶ。
 *
 * - 本文の NUL は、`write` も `append` も **fs も含めて落として残す**（pg は元から落としていた）
 * - slug は入口のスキーマ（`memorySlugSchema`）が NUL を含めて弾く。3実装とも投げる
 *
 * 書いた文書は消して終わる。vitest に依存しない。
 */
export async function verifyPersonaNulContract(persona: PersonaStore): Promise<void> {
  function fail(message: string): never {
    throw new Error(`PersonaStore の NUL の契約違反: ${message}`);
  }
  const slug = 'persona-nul-contract';

  const written = await persona.write(slug, '# 題\n\n本\u0000文\n');
  if (written.content !== '# 題\n\n本文\n')
    fail(`writeの返り値に NUL が残る: ${JSON.stringify(written.content)}`);
  const read = await persona.read(slug);
  if (read?.content !== '# 題\n\n本文\n')
    fail(`writeの読み戻しに NUL が残る: ${JSON.stringify(read?.content)}`);

  const appended = await persona.append(slug, '追\u0000記\n');
  if (appended.content.includes('\u0000') || !appended.content.includes('追記')) {
    fail(`appendで NUL が残る・欠ける: ${JSON.stringify(appended.content)}`);
  }

  for (const bad of ['persona-\u0000-nul']) {
    let thrown: unknown;
    try {
      await persona.write(bad, 'x\n');
    } catch (error) {
      thrown = error;
    }
    if (thrown === undefined) fail('NULを含む slug を受け付けた');
  }

  await persona.remove(slug);
}
