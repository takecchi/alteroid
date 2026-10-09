import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AlteroidPaths {
  root: string;
  memory: string;
  journal: string;
  jobs: string;
  archive: string;
  attachments: string;
  state: string;
  /** `memory/` には置かない: 記憶は人間が手で書き換える場所だが、ここは鍵の材料（トークンの sha256）が入る。 */
  auth: string;
  /** `memory/` には置かない: 記憶ではないので、こちらへ書いたものはクローンのシステムプロンプトに載らない。 */
  profile: string;
  profileDir: string;
  /** `memory/` には置かない: 増分は `record` を経由してのみ動くべきで、直接編集すると差分の基準がずれる。 */
  usage: string;
  /** `memory/` には置かない: 値（トークン本体）を持つ場所で、人間が手で書き換える前提ではない。 */
  tokens: string;
  /** `memory/` には置かない: 値（鍵そのもの）を持つ場所で、人間が手で書き換える前提ではない。 */
  credentials: string;
  /** `memory/` には置かない: `env` / `headers` に鍵が入りうる。 */
  mcpServers: string;
  /** 本体の files は JSON の中に base64 で持つ（展開しない）: path がファイルシステムの path になることを避けるため。 */
  plugins: string;
  /** `memory/` には置かない: 値そのものを持つ。 */
  codexAuth: string;
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
    attachments: join(root, 'attachments'),
    state: join(root, 'state'),
    auth: join(root, 'auth'),
    profile: join(root, 'profile.sh'),
    profileDir: join(root, 'profile.d'),
    usage: join(root, 'usage'),
    tokens: join(root, 'tokens.json'),
    credentials: join(root, 'credentials.json'),
    mcpServers: join(root, 'mcp-servers.json'),
    plugins: join(root, 'plugins'),
    codexAuth: join(root, 'codex-chatgpt-auth.json'),
  };
}
