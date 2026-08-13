import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * ローカルの人格データディレクトリ（既定 `~/.alteroid/`）。
 * 記憶が素の Markdown ファイルであることが「人間がいつでも読んで直せる」の
 * 最短の実装である（docs/architecture.md「ストレージ」）。
 */
export interface AlteroidPaths {
  root: string;
  /** 記憶: Markdown */
  memory: string;
  /** 日誌: JSONL（日付ごと） */
  journal: string;
  /** ジョブ・承認待ち: JSON */
  jobs: string;
  /** セッション生ログのアーカイブ: JSONL */
  archive: string;
  /** クローンのセッション id など、デーモンの状態 */
  state: string;
  /**
   * ログインしたアカウントとアクセス許可: JSON（0600）。
   *
   * **`memory/` には置かない。** 記憶は人間が手で書き換える前提の場所だが、
   * ここは鍵の材料（トークンの sha256）と許可の2値が入る。
   */
  auth: string;
}

export const ALTEROID_HOME_ENV = 'ALTEROID_HOME';

export function defaultRoot(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[ALTEROID_HOME_ENV];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.alteroid');
}

export function resolvePaths(root: string = defaultRoot()): AlteroidPaths {
  return {
    root,
    memory: join(root, 'memory'),
    journal: join(root, 'journal'),
    jobs: join(root, 'jobs'),
    archive: join(root, 'archive'),
    state: join(root, 'state'),
    auth: join(root, 'auth'),
  };
}
