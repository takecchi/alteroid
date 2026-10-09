import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AttachmentStoreOptions, Stores } from '@alteroid/core';

import { FsTranscriptArchive } from './archive.js';
import { FsAttachmentStore } from './attachments.js';
import { FsAuthStore } from './auth.js';
import { FsCodexChatgptAuthStore } from './codex-auth.js';
import { FsCommitmentStore } from './commitments.js';
import { FsCredentialVaultStore } from './credentials.js';
import { FsInboxStore } from './inbox.js';
import { FsIntegrationKeyStore } from './integration-keys.js';
import { FsConversationReadStore } from './conversation-reads.js';
import { FsJobStore } from './jobs.js';
import { FsJournalStore } from './journal.js';
import { FsMcpServerStore } from './mcp-servers.js';
import { FsPluginStore } from './plugins.js';
import { FsPersonaStore, MEMORY_INDEX_FILENAME, initialMemoryIndexJson } from './persona.js';
import { FsPermissionGrantStore } from './permission-grants.js';
import { FsPracticeStore } from './practices.js';
import { FsProfileStore } from './profile.js';
import { resolvePaths, type AlteroidPaths } from './paths.js';
import { FsScheduleStore } from './schedules.js';
import { FsSessionRegistry } from './sessions.js';
import { FsTokenPoolStore } from './token-pool.js';
import { FsUsageStore } from './usage.js';

export { FsTranscriptArchive } from './archive.js';
export { writeFileAtomic } from './atomic.js';
export { FsAttachmentStore } from './attachments.js';
export { FsAuthStore } from './auth.js';
export { CLOSED_HISTORY_LIMIT, FsCommitmentStore } from './commitments.js';
export { FsCredentialVaultStore } from './credentials.js';
export { LockTimeoutError, withPathLock } from './file-lock.js';
export { FsInboxStore } from './inbox.js';
export { FsIntegrationKeyStore } from './integration-keys.js';
export { FsConversationReadStore } from './conversation-reads.js';
export { FsJobStore } from './jobs.js';
export { FsJournalStore } from './journal.js';
export { FsMcpServerStore } from './mcp-servers.js';
export { FsPluginStore } from './plugins.js';
export { FsPersonaStore } from './persona.js';
export { FsPermissionGrantStore } from './permission-grants.js';
export { FsPracticeStore } from './practices.js';
export { FsProfileStore } from './profile.js';
export { FsScheduleStore } from './schedules.js';
export { FsSessionRegistry } from './sessions.js';
export { FsTokenPoolStore } from './token-pool.js';
export { FsUsageStore } from './usage.js';
export { ALTEROID_HOME_ENV, defaultRoot, resolvePaths, type AlteroidPaths } from './paths.js';

export function createFsStores(
  root?: string,
  attachmentOptions?: AttachmentStoreOptions,
): Stores & { paths: AlteroidPaths } {
  const paths = resolvePaths(root);
  const journal = new FsJournalStore(paths.journal);
  return {
    paths,
    persona: new FsPersonaStore(paths.memory, journal),
    journal,
    jobs: new FsJobStore(paths.jobs),
    schedules: new FsScheduleStore(paths.jobs),
    commitments: new FsCommitmentStore(paths.jobs),
    practices: new FsPracticeStore(paths.jobs),
    inbox: new FsInboxStore(paths.jobs),
    archive: new FsTranscriptArchive(paths.archive),
    sessions: new FsSessionRegistry(paths.state),
    auth: new FsAuthStore(paths.auth),
    integrationKeys: new FsIntegrationKeyStore(paths.auth),
    permissionGrants: new FsPermissionGrantStore(paths.jobs),
    profile: new FsProfileStore(paths.profile, paths.profileDir),
    credentials: new FsCredentialVaultStore(paths.credentials),
    mcpServers: new FsMcpServerStore(paths.mcpServers),
    plugins: new FsPluginStore(paths.plugins),
    conversationReads: new FsConversationReadStore(paths.jobs),
    codexAuth: new FsCodexChatgptAuthStore(paths.codexAuth),
    tokens: new FsTokenPoolStore(paths.tokens),
    usage: new FsUsageStore(paths.usage),
    attachments: new FsAttachmentStore(paths.attachments, attachmentOptions),
  };
}

export interface InitResult {
  paths: AlteroidPaths;
  created: string[];
}

/** 既定の権限境界を種の記憶に置かない: 置いた瞬間に A と B の違いが潰れる。 */
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
    paths.usage,
  ]) {
    await mkdir(dir, { recursive: true });
  }

  const seedPath = join(paths.memory, 'about-me.md');
  const seeds: [string, string][] = [
    [join(paths.root, 'README.md'), ROOT_README],
    [seedPath, SEED_MEMORY],
  ];

  for (const [path, content] of seeds) {
    try {
      await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
      created.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  // 既存の作業場（seed が既にある）には索引を置かない: 索引が無いならそれは本当に失われている。
  // 新規なのに置かないと、最初の `persona.write` が索引を「失われた」と見て日誌へ decision を書く。
  if (created.includes(seedPath)) {
    try {
      await writeFile(
        join(paths.memory, MEMORY_INDEX_FILENAME),
        initialMemoryIndexJson([{ slug: 'about-me', content: SEED_MEMORY }]),
        { encoding: 'utf8', flag: 'wx' },
      );
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
| \`jobs/\` | ジョブと承認待ちキュー、継続中の依頼（\`schedules.json\`）、引き受けたまま終わっていない仕事（\`commitments.json\`） |
| \`archive/\` | セッションの生ログ（compaction 前に退避したもの） |
| \`state/\` | デーモンの内部状態（セッション id など。消してもクローンは記憶から戻る） |
| \`auth/\` | ログインしたアカウントと、alteroid を使ってよいかの許可。**手で編集しない**（許可の付与は \`alteroid access grant\`） |
| \`profile.sh\` | 実行環境プロファイル（\`.zprofile\` 相当）。ここに \`export\` を書けば、クローンにもマネージャーにも作業者にも届く。器を作り直す必要は無い |
| \`usage/\` | 利用状況の台帳（alteroid 自身が使った Claude のトークン・費用の推定）。**手で編集しない**（差分の基準がずれる） |
| \`tokens.json\` | 認証トークンのプール（枠に当たったときに回す候補）。**手で編集しない**（\`alteroid token\` / \`PUT /tokens\` を経由する） |
| \`mcp-servers.json\` | 人間の MCP 連携の登録（\`.mcp.json\` と同じ形）。クローンの次のセッションから効く（マネージャー・作業者へは runner の名乗りのたびにデーモンが降ろし、次に開くセッションから効く。手で編集した場合は次の名乗りまで runner には届かない）。**手で編集してよいが、読めない形だとクローンは外部の連携なしで起きる**（\`PUT /mcp-servers\` を経由すれば置く前に検査される） |
| \`plugins/\` | 人間が入れた plugin（skill を含む）。plugin ごとに1つの JSON（取り元の commit SHA・本体のファイル・撒く先・hooks / MCP の可否）。**手で編集しない**（本体の指紋と合わないと読めない） |
| \`credentials.json\` | マネージャーへ降ろす環境変数の正本（名前→値）。器を作り直しても \`hello\` のときに降り直す。**手で編集しない**（\`alteroid credential\` / \`PUT /credentials\` を経由する） |

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
