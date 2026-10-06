import type { PersonaStore } from './store.js';

/**
 * `PersonaStore` の本文の NUL の約束（issue #2927。teto の判断、2026-10-05）を、**実装1つに対して**
 * 測る。3実装（インメモリ / fs / pg）が同じ関数を呼ぶ。
 *
 * - 本文の NUL は、`write` も `append` も **fs も含めて落として残す**（pg は元から落としていた）
 * - slug は入口のスキーマ（`memorySlugSchema`）が NUL を含めて弾く。3実装とも投げる
 * - **末尾が `\n\0` の本文**は、NUL を落としてから末尾の改行を足す（足してから落とすと空行が1つ余る。
 *   pg だけが順序を逆にしていた。issue #3284）。`write` も `append` も同じ
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

  // 末尾が `\n\0` の本文。NUL を先に落とすので、改行は1つのまま（issue #3284）。
  const tail = await persona.write(slug, 'x\n\u0000');
  if (tail.content !== 'x\n')
    fail(`write('x\\n\\0')の返り値の末尾に空行が余る・欠ける: ${JSON.stringify(tail.content)}`);
  const tailRead = await persona.read(slug);
  if (tailRead?.content !== 'x\n')
    fail(
      `write('x\\n\\0')の読み戻しの末尾に空行が余る・欠ける: ${JSON.stringify(tailRead?.content)}`,
    );
  const tailAppended = await persona.append(slug, 'y\n\u0000');
  if (tailAppended.content !== 'x\n\ny\n')
    fail(`append('y\\n\\0')の末尾に空行が余る・欠ける: ${JSON.stringify(tailAppended.content)}`);

  // NUL だけの追記。連結してから正規化するので、空行は1つだけ増える（pg が空の本文に改行を足して2つにしていた）。
  const nulOnly = await persona.append(slug, '\u0000');
  if (nulOnly.content !== 'x\n\ny\n\n')
    fail(`append('\\0')の空行が1つにならない: ${JSON.stringify(nulOnly.content)}`);

  for (const bad of ['persona-\u0000-nul']) {
    let thrown: unknown;
    try {
      await persona.write(bad, 'x\n');
    } catch (error) {
      thrown = error;
    }
    if (thrown === undefined) fail('NULを含む slug を受け付けた');
  }

  // 読む口・消す口・追記の口も、slug の NUL は入口のスキーマが弾く。3実装とも投げる（issue #3011）。
  const nulSlug = 'persona-\u0000-nul';
  const slugCalls: Array<[string, () => Promise<unknown>]> = [
    ['read(NULを含むslug)', () => persona.read(nulSlug)],
    ['append(NULを含むslug)', () => persona.append(nulSlug, 'x\n')],
    ['remove(NULを含むslug)', () => persona.remove(nulSlug)],
  ];
  for (const [label, call] of slugCalls) {
    let thrown: unknown;
    try {
      await call();
    } catch (error) {
      thrown = error;
    }
    if (thrown === undefined) fail(`${label}が投げない（入口のスキーマが弾くこと）`);
  }

  await persona.remove(slug);
}
