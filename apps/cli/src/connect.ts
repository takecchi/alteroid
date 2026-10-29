import { createClient, type DaemonClient } from './client.js';
import { resolveTarget, type Target } from './target.js';
import { stdout } from './terminal-out.js';

// 書き込み系では未ログインの note を例外にする: 何もせず 0 で返すと、cron などが「済んだ」と誤読するため
// 読む口では例外にしない: 人間向けの案内が例外の見た目になるため
export async function connect(
  access: 'read' | 'write',
): Promise<{ client: DaemonClient; target: Target } | null> {
  const target = await resolveTarget();
  if (target.note !== null) {
    if (access === 'write') throw new Error(target.note);
    stdout.write(`${target.note}\n`);
    return null;
  }
  return { client: createClient(target.baseUrl, target.headers), target };
}
