import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * **新しい `JournalStore` 実装が契約から漏れたら落ちる歯（issue #418 の
 * 再発防止 (ii)）。**
 *
 * `JournalStore` の契約（`packages/core/src/journal-with-contract.ts` の
 * `verifyJournalStoreWithContract` / `packages/core/src/journal-order-with-contract.ts`
 * の `verifyJournalStoreOrderContract`）は、それを**呼ぶ側**が3実装
 * （インメモリ / fs / pg）ぶん揃えて初めて意味を持つ——1つで測って3つとも
 * 測ったことにしない、が #370 以来の作法である。だが「歯を3本書いた」だけ
 * では、**4本目の実装が増えたときに誰も気づけない**（契約テストは既存の
 * 3つを測り続けて緑のまま、4本目だけが野放しになる）。
 *
 * この歯は、リポジトリ内の `JournalStore` 実装を機械的に列挙し、下の
 * `KNOWN_IMPLEMENTATIONS` に登録されていないものが見つかったら落ちる。
 * **素通しの委譲層**（`journal-bus.ts` — `list(query)` を `inner.list(query)`
 * へそのまま渡すだけで、絞りの実装を持たない）は「委譲なので契約不要」と
 * 理由付きで登録できる。
 *
 * **⚠️ issue #432 の2本目でここを広げた理由。** `JournalStore` の契約は
 * 現在2つ（`with` 絞り / `order`・`after` ページング）在るが、**この歯は
 * 元々 `verifyJournalStoreWithContract` という1本の文字列しか見ていな
 * かった。** それでは新しい契約（`verifyJournalStoreOrderContract`）を
 * 足しても、**既存の実装がそれを呼び忘れていることにこの歯は気づけない**
 * ——「歯を3本書いただけでは4本目の実装に気づけない」という上の再発防止と
 * 同じ形の穴が、「契約を1本足しただけでは既存の実装の呼び忘れに気づけない」
 * という向きでもう一度開く。`KNOWN_IMPLEMENTATIONS` の各エントリに
 * `contracts`（要求する契約関数の一覧）を持たせ、**登録した契約の全部を
 * 呼んでいるか**を検算する形にしてある（`RegistryEntry` の doc）。
 *
 * **`grep` を使わない。** 理由は `conversation-window-single-source.test.ts`
 * と同じ（`AGENTS.md`「静かに失敗する道具」の4つの取りこぼし）。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.react-router', '.vite']);

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

export function findJournalStoreImplementations(
  files: readonly string[],
): DetectedImplementation[] {
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
      /**
       * その実装を下の `contracts` へ通しているテストファイル。
       *
       * **複数ファイルに分かれていてもよい**（`readonly string[]`）——
       * `packages/core/src/testing.ts` は契約ごとに別ファイル
       * （`journal-with-contract.test.ts` / `journal-order-with-contract.test.ts`）
       * に分かれている。**`contracts` の全部が、この一覧の *どれか1つ* の
       * ファイルに見つかればよい**（1ファイルに全部揃っている必要はない）。
       */
      testFile: string | readonly string[];
      /**
       * この実装が通すべき契約関数の一覧（`@alteroid/core` からの export 名）。
       *
       * **1つで測って全部測ったことにしない。** `JournalStore` には現在2つの
       * 契約が在る——`with` 絞り（issue #418。`verifyJournalStoreWithContract`）
       * と `order`/`after` ページング（issue #432 の2本目。
       * `verifyJournalStoreOrderContract`）。**この一覧が1本しか持たないと、
       * 新しい契約を足したときに古いほうしか見ない歯になる**——#418 の (ii) が
       * 立てた「歯を3本書いただけでは4本目の実装に気づけない」の同型を、
       * 「契約を1本足しただけでは既存の実装の抜けに気づけない」という向きで
       * もう一度踏む。だから `testFile` が**この一覧の全部**を呼んでいることを
       * 下の歯が検算する。
       */
      contracts: readonly string[];
    }
  | {
      status: 'delegates';
      /** 契約テストが要らない理由（素通しであること）。 */
      reason: string;
    };

/** 3実装がそろって通すべき契約関数の一覧（`@alteroid/core` からの export 名）。 */
const REQUIRED_CONTRACTS = [
  'verifyJournalStoreWithContract',
  'verifyJournalStoreOrderContract',
  'verifyJournalStoreQueryEdgeContract',
] as const;

/**
 * 既知の `JournalStore` 実装の一覧。
 *
 * **新しい実装を足したら、ここへも登録すること。** 登録しないとこのファイルの
 * 「登録漏れが無い」の歯が落ちる。契約が要るなら `status: 'contract-tested'`
 * にして、その実装を `REQUIRED_CONTRACTS` の全部へ通すテストファイルを書き、
 * `testFile` に指す（このファイルの「契約テストが実際に契約関数を呼んで
 * いる」歯がそれを検算する）。素通しの委譲層なら `status: 'delegates'` と
 * 理由を書く。
 */
const KNOWN_IMPLEMENTATIONS: Record<string, RegistryEntry> = {
  'packages/core/src/testing.ts': {
    status: 'contract-tested',
    testFile: [
      'packages/core/src/journal-with-contract.test.ts',
      'packages/core/src/journal-order-with-contract.test.ts',
      'packages/core/src/journal-query-edge-contract.test.ts',
    ],
    contracts: REQUIRED_CONTRACTS,
  },
  'packages/storage-fs/src/journal.ts': {
    status: 'contract-tested',
    testFile: 'packages/storage-fs/src/index.test.ts',
    contracts: REQUIRED_CONTRACTS,
  },
  'packages/storage-pg/src/journal.ts': {
    status: 'contract-tested',
    testFile: 'packages/storage-pg/src/index.test.ts',
    contracts: REQUIRED_CONTRACTS,
  },
  'apps/daemon/src/journal-bus.ts': {
    status: 'delegates',
    reason:
      '`createJournalBus` の `journal.list` は `inner.list(query)` をそのまま返す ' +
      '（`journal-bus.ts` の doc「ここに判断は無い」）。絞りの実装を持たないので、' +
      '契約群を測る対象は inner 側（実際のストア）である。',
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
      expect(
        detected.some((d) => d.file === file),
        `${file} が実装として検出されなかった`,
      ).toBe(true);
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

  /**
   * **`contracts` を手で書いたエントリが痩せていても、下（実際に呼んでいるか
   * を測る歯）は緑のまま通る**——あの歯が検算しているのは「`entry.contracts`
   * に並んだものを呼んでいるか」までであって、**`entry.contracts` 自身が
   * `REQUIRED_CONTRACTS` を全部含んでいるか**は誰も見ていない。4本目の実装を
   * 足す人が `contracts: ['verifyJournalStoreWithContract']` とだけ書けば
   * （新しい契約を書き忘れて）、下の歯は素通りする。**3つの歯は同じ穴の
   * 3つの高さである** —— 実装の登録漏れ（上） / 契約の呼び忘れ（下） /
   * **要求そのものの痩せ（この歯）**。
   */
  it('contract-tested の各エントリが REQUIRED_CONTRACTS を全部要求している（要求そのものが痩せていないか）', () => {
    for (const [file, entry] of Object.entries(KNOWN_IMPLEMENTATIONS)) {
      if (entry.status === 'delegates') continue;
      const missing = REQUIRED_CONTRACTS.filter((contract) => !entry.contracts.includes(contract));
      expect(
        missing,
        missing.length === 0
          ? ''
          : `${file} の contracts が REQUIRED_CONTRACTS を全部要求していない（欠けている: ` +
              `${missing.join(', ')}）。REQUIRED_CONTRACTS に契約を足したなら、` +
              `各エントリの contracts にも足すこと。`,
      ).toEqual([]);
    }
  });

  it.each(Object.entries(KNOWN_IMPLEMENTATIONS))(
    '%s: 契約テストが実在し、REQUIRED_CONTRACTS の全部を実際に呼んでいる',
    (file, entry) => {
      if (entry.status === 'delegates') {
        expect(entry.reason.length).toBeGreaterThan(0);
        return;
      }
      const testFiles = typeof entry.testFile === 'string' ? [entry.testFile] : entry.testFile;
      const combinedText = testFiles
        .map((testFile) => {
          const testPath = path.join(ROOT, testFile);
          try {
            return readFileSync(testPath, 'utf8');
          } catch {
            throw new Error(`${file} の契約テストとして登録された ${testFile} が読めない`);
          }
        })
        .join('\n');

      // **`contracts` の全部が要る。1つでも欠けたら落ちる。** ここが1本しか
      // 見なければ、新しい契約（issue #432 の `verifyJournalStoreOrderContract`
      // 等）を足したときに、既存の実装がそれを呼んでいなくても気づけない
      // （`RegistryEntry` の doc）。
      for (const contract of entry.contracts) {
        expect(
          combinedText.includes(contract),
          `${testFiles.join(', ')} が ${contract} を呼んでいない（${file} の契約が測られていない）`,
        ).toBe(true);
      }
    },
  );
});
