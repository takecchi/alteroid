import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Stores } from '@alteroid/core';

import { FsTranscriptArchive } from './archive.js';
import { FsAuthStore } from './auth.js';
import { FsJobStore } from './jobs.js';
import { FsJournalStore } from './journal.js';
import { FsPersonaStore } from './persona.js';
import { resolvePaths, type AlteroidPaths } from './paths.js';
import { FsSessionRegistry } from './sessions.js';

export { FsTranscriptArchive } from './archive.js';
export { FsAuthStore } from './auth.js';
export { FsJobStore } from './jobs.js';
export { FsJournalStore } from './journal.js';
export { FsPersonaStore } from './persona.js';
export { FsSessionRegistry } from './sessions.js';
export { ALTEROID_HOME_ENV, defaultRoot, resolvePaths, type AlteroidPaths } from './paths.js';

/** ローカル（fs）ドライバ一式。デーモンプロセスだけがこれを持つ。 */
export function createFsStores(root?: string): Stores & { paths: AlteroidPaths } {
  const paths = resolvePaths(root);
  return {
    paths,
    persona: new FsPersonaStore(paths.memory),
    journal: new FsJournalStore(paths.journal),
    jobs: new FsJobStore(paths.jobs),
    archive: new FsTranscriptArchive(paths.archive),
    sessions: new FsSessionRegistry(paths.state),
    auth: new FsAuthStore(paths.auth),
  };
}

export interface InitResult {
  paths: AlteroidPaths;
  /** 新しく作られたファイル（既存は上書きしない） */
  created: string[];
}

/**
 * `alteroid init` の実体。人格データディレクトリを用意する。
 *
 * 種の記憶をここで1枚だけ置くが、中身は「人間が何を書くか」の案内であって、
 * 確認が要る行為の一覧ではない。既定の権限境界を置いた瞬間に A と B の違いが
 * 潰れる（PRD「権限境界」）。
 */
export async function initWorkspace(root?: string): Promise<InitResult> {
  const paths = resolvePaths(root);
  const created: string[] = [];

  for (const dir of [
    paths.root,
    paths.memory,
    paths.journal,
    paths.jobs,
    paths.archive,
    paths.state,
    paths.auth,
  ]) {
    await mkdir(dir, { recursive: true });
  }

  const seeds: [string, string][] = [
    [join(paths.root, 'README.md'), ROOT_README],
    [join(paths.memory, 'about-me.md'), SEED_MEMORY],
  ];

  for (const [path, content] of seeds) {
    try {
      await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
      created.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  return { paths, created };
}

const ROOT_README = `# ~/.alteroid

alteroid のクローンの人格データ。**すべて人間が直接読んで書き換えてよい。**

| 場所 | 中身 |
| --- | --- |
| \`memory/\` | 記憶。クローンの価値観と学び。ここを書き換えると次の会話から反映される |
| \`journal/\` | 日誌。追記専用の記録（JSONL）。クローンが聞かずに実行した判断もここに残る |
| \`jobs/\` | ジョブと承認待ちキュー |
| \`archive/\` | セッションの生ログ（compaction 前に退避したもの） |
| \`state/\` | デーモンの内部状態（セッション id など。消してもクローンは記憶から戻る） |
| \`auth/\` | ログインしたアカウントと、alteroid を使ってよいかの許可。**手で編集しない**（許可の付与は \`alteroid access grant\`） |

書き換えるのは \`memory/\` だけでよい。日誌を読んで「それは違う」と伝えれば、
その否定が次の記憶になる。
`;

const SEED_MEMORY = `# このクローンについて

<!--
まだ何も書かれていない。alteroid chat で話した内容から、クローンが自分で
ここへ蒸留していく。人間が直接書き換えてもよく、その場合は次の会話から反映される。

書くとよいこと:
- 何を目指しているか（目的）
- 何を大事にしているか（価値観・好み）
- 何を任せてよくて、何は必ず聞いてほしいか（理由つきで）

「確認が要る行為の一覧」を書く必要はない。クローンは記憶に根拠があるかで判断する。
-->
`;
