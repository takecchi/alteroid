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
  /**
   * 実行環境プロファイル: シェルスクリプト（0600）。
   *
   * **人間の `.zprofile` に当たるもの。** 素のスクリプトで置くのは、記憶が素の
   * Markdown なのと同じ理由（いつでも開いて直せる）である。記憶ではないので
   * `memory/` には置かない — こちらへ書いたものはクローンのシステムプロンプトに
   * 載らない。
   */
  profile: string;
  /**
   * 利用状況の台帳: JSON（`usage.ts`）。
   *
   * `auth/` と同じ理由で `memory/` には置かない — 人間が手で書き換える前提の場所
   * ではない（増分は `record` を経由してのみ動くべきで、直接編集すると差分の
   * 基準がずれる）。
   */
  usage: string;
  /**
   * 認証トークンのプール: JSON（0600）。**回さない**（Issue #393「PR1」）。
   *
   * `auth` と同じ理由で `memory/` には置かない——値（トークン本体）を持つ場所で
   * あって、人間が手で書き換える前提の場所ではない（`alteroid token` / `PUT
   * /tokens` を経由する）。
   */
  tokens: string;
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
    profile: join(root, 'profile.sh'),
    usage: join(root, 'usage'),
    tokens: join(root, 'tokens.json'),
  };
}
