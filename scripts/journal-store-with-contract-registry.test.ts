import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { collectRepoFiles } from './repo-scan-files.js';

// `grep` を使わず、Node の `fs` で読んだ文字列に正規表現を通す: `grep` の取りこぼしを踏まないため。
// 登録した契約の全部を呼んでいるか検算する: 契約を1本足しても、既存の実装の呼び忘れに気づけなくなるため。

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.react-router', '.vite']);

// `.test.ts` / `.test.tsx` は対象外: テストが自分専用に書く `JournalStore` のスタブは本番の実装ではなく使い捨てのため。
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
      testFile: string | readonly string[];
      contracts: readonly string[];
      notApplicable?: Readonly<Record<string, string>>;
    }
  | {
      status: 'delegates';
      reason: string;
    };

const REQUIRED_CONTRACTS = [
  'verifyJournalStoreWithContract',
  'verifyJournalStoreOrderContract',
  'verifyJournalStoreQueryEdgeContract',
  'verifyJournalStoreSearchContract',
  'verifyJournalStoreHorizonContract',
  'verifyConversationPageContract',
  'verifyJournalStoreDeletedConversationContract',
] as const;

const READABILITY_CONTRACTS = ['verifyJournalStoreUnreadableGetContract'] as const;

const KNOWN_IMPLEMENTATIONS: Record<string, RegistryEntry> = {
  'packages/core/src/testing.ts': {
    status: 'contract-tested',
    testFile: [
      'packages/core/src/journal-with-contract.test.ts',
      'packages/core/src/journal-order-with-contract.test.ts',
      'packages/core/src/journal-query-edge-contract.test.ts',
      'packages/core/src/journal-search-contract.test.ts',
      'packages/core/src/journal-horizon-contract.test.ts',
      'packages/core/src/conversation-page-contract.test.ts',
      'packages/core/src/journal-deleted-conversation-contract.test.ts',
    ],
    contracts: REQUIRED_CONTRACTS,
    notApplicable: {
      verifyJournalStoreUnreadableGetContract:
        '読めない行を持てない（`append` が `journalEntrySchema` で断り、行は private な配列にしか入らない）。' +
        '`get` が `UnreadableJournalEntryError` を投げる場面が作れない。',
    },
  },
  'packages/storage-fs/src/journal.ts': {
    status: 'contract-tested',
    testFile: 'packages/storage-fs/src/index.test.ts',
    contracts: [...REQUIRED_CONTRACTS, ...READABILITY_CONTRACTS],
  },
  'packages/storage-pg/src/journal.ts': {
    status: 'contract-tested',
    testFile: 'packages/storage-pg/src/index.journal-jobs-schedule.test.ts',
    contracts: [...REQUIRED_CONTRACTS, ...READABILITY_CONTRACTS],
  },
  'apps/daemon/src/journal-bus.ts': {
    status: 'delegates',
    reason:
      '`createJournalBus` の `journal.list` は `inner.list(query)` をそのまま返す ' +
      '（`journal-bus.ts` の doc「ここに判断は無い」）。絞りの実装を持たないので、' +
      '契約群を測る対象は inner 側（実際のストア）である。',
  },
};

const allFiles = collectRepoFiles(ROOT, EXCLUDE_DIRS);
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

  it('contract-tested の各エントリが REQUIRED_CONTRACTS を全部要求している（要求そのものが痩せていないか）', () => {
    for (const [file, entry] of Object.entries(KNOWN_IMPLEMENTATIONS)) {
      if (entry.status === 'delegates') continue;
      const notApplicable = entry.notApplicable ?? {};
      for (const [contract, reason] of Object.entries(notApplicable)) {
        expect(reason.length, `${file} の notApplicable[${contract}] に理由が無い`).toBeGreaterThan(
          0,
        );
      }
      const missing = [...REQUIRED_CONTRACTS, ...READABILITY_CONTRACTS].filter(
        (contract) => !entry.contracts.includes(contract) && !(contract in notApplicable),
      );
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

      for (const contract of entry.contracts) {
        expect(
          combinedText.includes(contract),
          `${testFiles.join(', ')} が ${contract} を呼んでいない（${file} の契約が測られていない）`,
        ).toBe(true);
      }
    },
  );
});
