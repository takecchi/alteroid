import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inspectReleaseProdDispatch } from './bash-release-prod-guard.js';
import { describeDenialStreakForManager } from './classifier-denial-streak.js';
import { composePeerCloseNotices, rescueStashClause } from './manager.js';
import { buildManagerSystemPrompt } from './prompt.js';
import { formatWorkspaceCloneHintLines, type WorkspaceCloneHint } from './workspace-swap-hints.js';

// マネージャーから見たユーザーは人間と同じ相手であり、相手をクローンと呼ぶ文はマネージャーへ届けない（#5469 P1）。
// システムプロンプト以外の経路（道具の説明・結果・拒否の理由・再開文・知らせ）をここで押さえる。
// 作業者向けのプロンプトと、クローンだけが読む文（日誌・クローン宛の確認）は対象外。
const WORD = 'クローン';

function readSource(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');
}

describe('マネージャーに届く文に「クローン」の語が残っていない（#5469 P1）', () => {
  it('システムプロンプト', () => {
    expect(buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' })).not.toContain(
      WORD,
    );
  });

  it('本番デプロイ起動の拒否の理由', () => {
    const verdict = inspectReleaseProdDispatch('gh workflow run release-prod.yml');
    expect(verdict.matched).toBe(true);
    if (verdict.matched) expect(verdict.reason).not.toContain(WORD);
  });

  it('分類器の拒否が続いたときの担当への知らせ', () => {
    const text = describeDenialStreakForManager({ consecutive: 5, total: 9, firstReason: 'x' });
    expect(text).not.toContain(WORD);
  });

  it('peer の閉じの知らせ（人間が止めた場合を含む全理由）', () => {
    for (const reason of ['expired', 'replaced', 'shutdown', 'stopped'] as const) {
      const text = composePeerCloseNotices({ reason, peers: [{ id: 'p1', provider: 'codex' }] });
      expect(text).not.toContain(WORD);
    }
  });

  it('救出の預かりの段落（rescue_restore を持たない器の文を含む）', () => {
    const stash = [
      {
        worktree: '.',
        path: 'a.txt',
        attachmentId: 'att-1',
        size: 1,
        sha256: 'a'.repeat(64),
        at: '2026-10-29T00:00:00.000Z',
      },
    ];
    for (const restorable of [true, false]) {
      for (const from of [undefined, 'mgr-old']) {
        const text = rescueStashClause(stash, {
          restorable,
          ...(from === undefined ? {} : { from }),
        });
        expect(text).not.toContain(WORD);
      }
    }
  });

  it('器の入れ替え後の再開文が指す、省略の行', () => {
    const hints: WorkspaceCloneHint[] = Array.from({ length: 200 }, (_, i) => ({
      kind: 'clone',
      relativePath: `repo-${String(i)}`,
      unpushed: { kind: 'known', n: 1 },
      uncommitted: { kind: 'known', n: 1 },
    }));
    const text = formatWorkspaceCloneHintLines(hints, undefined, 'short');
    expect(text).toContain('省略');
    expect(text).not.toContain(WORD);
  });

  it('peer_approve の道具説明（ソースの当該ブロックを読む。道具の組み立てに broker が要るため）', () => {
    const source = readSource('peer-broker.ts');
    const start = source.indexOf("'peer_approve',");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('tool(', start + 1);
    const block = source.slice(start, end === -1 ? undefined : end);
    expect(block).not.toContain(WORD);
  });

  it('peer_run / peer_reply の結果文に載る escalate の案内', () => {
    const source = readSource('peer-broker.ts');
    const at = source.indexOf('escalate=判断できないので');
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(at, at + 40)).not.toContain(WORD);
  });
});
