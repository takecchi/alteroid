import { lchownSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * SDK が resume の材料（生ログ・資格・設定）を書き出す一時ディレクトリの名前の頭。
 * SDK は `os.tmpdir()` の直下に mode 0700 で作り、子の `CLAUDE_CONFIG_DIR` をそこへ差し替える。
 * 作るのは runner（root）なので、別の UID で起こす子はそのままでは入れず、resume が会話を見つけられずに終わる。
 */
const SDK_RESUME_CONFIG_DIR_PREFIX = 'claude-resume-';

/**
 * 子へ渡す env が SDK の resume の一時ディレクトリを指していればそのパスを返す。
 * 名前と置き場所の両方で絞る: 人間がプロファイルで置いた `CLAUDE_CONFIG_DIR` の持ち主まで書き換えないため。
 */
export function sdkResumeConfigDirOf(
  env: Readonly<Record<string, string | undefined>>,
  tmp: string = tmpdir(),
): string | undefined {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (dir === undefined || dir.length === 0) return undefined;
  if (dirname(dir) !== tmp) return undefined;
  if (!basename(dir).startsWith(SDK_RESUME_CONFIG_DIR_PREFIX)) return undefined;
  return dir;
}

/**
 * 木の持ち主を子へ移す。根は最後に移す: 根が root の 0700 のうちは他の子（同じ UID の別の委譲）が中へ入れず、移し終える前の中身に触れられないため。
 * symlink は辿らず、リンクそのものの持ち主だけを移す。
 */
export function chownTreeSync(
  root: string,
  uid: number,
  gid: number,
  chown: (path: string, uid: number, gid: number) => void = lchownSync,
): void {
  if (lstatSync(root).isDirectory()) {
    for (const name of readdirSync(root)) chownTreeSync(join(root, name), uid, gid, chown);
  }
  chown(root, uid, gid);
}
