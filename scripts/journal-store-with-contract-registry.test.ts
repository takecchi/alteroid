import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * **新しい `JournalStore` 実装が `with` 契約から漏れたら落ちる歯（issue #418 の
 * 再発防止 (ii)）。**
 *
 * `with` の契約（`packages/core/src/journal-with-contract.ts` の
 * `verifyJournalStoreWithContract`）は、それを**呼ぶ側**が3実装（インメモリ /
 * fs / pg）ぶん揃えて初めて意味を持つ——1つで測って3つとも測ったことにしない、
 * が #370 以来の作法である。だが「歯を3本書いた」だけでは、**4本目の実装が
 * 増えたときに誰も気づけない**（契約テストは既存の3つを測り続けて緑のまま、
 * 4本目だけが野放しになる）。
 *
 * この歯は、リポジトリ内の `JournalStore` 実装を機械的に列挙し、下の
 * `KNOWN_IMPLEMENTATIONS` に登録されていないものが見つかったら落ちる。
 * **素通しの委譲層**（`journal-bus.ts` — `list(query)` を `inner.list(query)`
 * へそのまま渡すだけで、絞りの実装を持たない）は「委譲なので契約不要」と
 * 理由付きで登録できる。
 *
 * **`grep` を使わない。** 理由は `conversation-window-single-source.test.ts`
 * と同じ（`AGENTS.md`「静かに失敗する道具」の4つの取りこぼし）。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.react-router',
  '.vite',
]);

function collectFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (entry.isFile()) {
      out.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  }
}

/**
 * `JournalStore` を実装している疑いのある箇所を検出する2つの形。
 *
 * 1. `class X implements ... JournalStore`（`storage-fs` / `storage-pg`）
 * 2. `: JournalStore = {`（`testing.ts` のインメモリ実装、`journal-bus.ts` の
 *    委譲層のように、クラスを立てず型注釈付きのオブジェクトリテラルで作る形）
 *
 * **`.test.ts` / `.test.tsx` は対象外。** テストが仮に自分専用のスタブを
 * `JournalStore` として書いても（実例: `apps/daemon/src/reports.test.ts`）、
 * それは本番の実装ではなく使い捨てである（issue #418 の (ii) が言う
 * 「本番のソース」に当たらない）。
 */
const CLASS_IMPLEMENTS = /class\s+\w+[^{;]*\bimplements\b[^{;]*\bJournalStore\b/g;
const TYPED_OBJECT_LITERAL = /:\s*JournalStore\s*=\s*\{/g;

export interface DetectedImplementation {
  file: string;
  form: 'class' | 'typed-object-literal';
}

export function findJournalStoreImplementations(files: readonly string[]): DetectedImplementation[] {
  const out: DetectedImplementation[] = [];
  for (const file of files) {
    if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
    if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    if (CLASS_IMPLEMENTS.test(text)) out.push({ file, form: 'class' });
    CLASS_IMPLEMENTS.lastIndex = 0;
    if (TYPED_OBJECT_LITERAL.test(text)) out.push({ file, form: 'typed-object-literal' });
    TYPED_OBJECT_LITERAL.lastIndex = 0;
  }
  return out;
}

type RegistryEntry =
  | {
      status: 'contract-tested';
      /** その実装を `verifyJournalStoreWithContract` へ通しているテストファイル。 */
      testFile: string;
    }
  | {
      status: 'delegates';
      /** 契約テストが要らない理由（素通しであること）。 */
      reason: string;
    };

/**
 * 既知の `JournalStore` 実装の一覧。
 *
 * **新しい実装を足したら、ここへも登録すること。** 登録しないとこのファイルの
 * 「登録漏れが無い」の歯が落ちる。契約が要るなら `status: 'contract-tested'`
 * にして、その実装を `verifyJournalStoreWithContract` へ通すテストファイルを
 * 書き、`testFile` に指す（このファイルの「契約テストが実際に契約関数を呼んで
 * いる」歯がそれを検算する）。素通しの委譲層なら `status: 'delegates'` と
 * 理由を書く。
 */
const KNOWN_IMPLEMENTATIONS: Record<string, RegistryEntry> = {
  'packages/core/src/testing.ts': {
    status: 'contract-tested',
    testFile: 'packages/core/src/journal-with-contract.test.ts',
  },
  'packages/storage-fs/src/journal.ts': {
    status: 'contract-tested',
    testFile: 'packages/storage-fs/src/index.test.ts',
  },
  'packages/storage-pg/src/journal.ts': {
    status: 'contract-tested',
    testFile: 'packages/storage-pg/src/index.test.ts',
  },
  'apps/daemon/src/journal-bus.ts': {
    status: 'delegates',
    reason:
      '`createJournalBus` の `journal.list` は `inner.list(query)` をそのまま返す ' +
      '（`journal-bus.ts` の doc「ここに判断は無い」）。絞りの実装を持たないので、' +
      'with の契約を測る対象は inner 側（実際のストア）である。',
  },
};

const allFiles: string[] = [];
collectFiles(ROOT, allFiles);
const detected = findJournalStoreImplementations(allFiles);

describe('JournalStore 実装の一覧が with 契約の登録から漏れていない（issue #418 再発防止）', () => {
  it('前提: 少なくとも1つの実装を見つけている', () => {
    expect(detected.length).toBeGreaterThan(0);
  });

  it('前提: 登録した4つの実装がすべて実在する（ファイルそのものが動いていないか）', () => {
    for (const file of Object.keys(KNOWN_IMPLEMENTATIONS)) {
      expect(detected.some((d) => d.file === file), `${file} が実装として検出されなかった`).toBe(
        true,
      );
    }
  });

  it('見つかった実装がすべて登録済みである（未登録の実装が増えたら落ちる）', () => {
    const files = [...new Set(detected.map((d) => d.file))];
    const unregistered = files.filter((file) => !(file in KNOWN_IMPLEMENTATIONS));
    expect(
      unregistered,
      unregistered.length === 0
        ? ''
        : `登録されていない JournalStore 実装が見つかった。KNOWN_IMPLEMENTATIONS へ登録すること:\n${unregistered.join('\n')}`,
    ).toEqual([]);
  });

  it.each(Object.entries(KNOWN_IMPLEMENTATIONS))(
    '%s: 契約テストが実在し、実際に verifyJournalStoreWithContract を呼んでいる',
    (file, entry) => {
      if (entry.status === 'delegates') {
        expect(entry.reason.length).toBeGreaterThan(0);
        return;
      }
      const testPath = path.join(ROOT, entry.testFile);
      let text: string;
      try {
        text = readFileSync(testPath, 'utf8');
      } catch {
        throw new Error(`${file} の契約テストとして登録された ${entry.testFile} が読めない`);
      }
      expect(
        text.includes('verifyJournalStoreWithContract'),
        `${entry.testFile} が verifyJournalStoreWithContract を呼んでいない（${file} の with 契約が測られていない）`,
      ).toBe(true);
    },
  );
});
