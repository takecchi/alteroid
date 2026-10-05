import { describe, expect, it } from 'vitest';

import { inspectReleaseProdDispatch } from './bash-release-prod-guard.js';

/**
 * 本番デプロイ（release-prod）を起動する Bash の形を見分ける（issue #2884）。
 * 旧 `docker/gh` の門（`gh workflow run … release-prod…` / `gh api …/workflows/…release-prod…/dispatches`）
 * と同じ形を、uid の門ではなく確認（ask）で扱うための判定器。
 */

describe('本番デプロイを起動する形は matched', () => {
  const matched: ReadonlyArray<[string, string]> = [
    ['gh workflow run release-prod.yml', 'gh workflow run release-prod.yml'],
    ['パス形', 'gh workflow run .github/workflows/release-prod.yml --repo o/r'],
    ['--ref を前に', 'gh workflow run --ref main release-prod.yml'],
    ['-R を後ろに', 'gh workflow run release-prod.yml -R o/r'],
    ['-f 付き', 'gh workflow run release-prod.yml -f dry_run=false'],
    ['大文字小文字', 'gh workflow run Release-Prod.yml'],
    [
      'gh api の dispatches（-X POST）',
      'gh api -X POST repos/o/r/actions/workflows/release-prod.yml/dispatches -f ref=main',
    ],
    [
      'gh api の dispatches（--method）',
      'gh api --method POST /repos/o/r/actions/workflows/release-prod.yml/dispatches',
    ],
    [
      'gh api で引数順が違う',
      'gh api repos/o/r/actions/workflows/release-prod.yml/dispatches -f ref=main -X POST',
    ],
    ['&& の後ろ', 'cd x && gh workflow run release-prod.yml'],
    ['; の後ろ', 'echo a; gh workflow run release-prod.yml'],
    ['パイプの後ろ', 'echo y | gh workflow run release-prod.yml'],
    ['改行の後ろ', 'echo a\ngh workflow run release-prod.yml'],
    ['環境変数の前置き', 'GH_TOKEN=x gh workflow run release-prod.yml'],
    ['gh のフルパス', '/usr/bin/gh workflow run release-prod.yml'],
    ['timeout の前置き', 'timeout 60 gh workflow run release-prod.yml'],
    ['bash -c の中', 'bash -c "gh workflow run release-prod.yml"'],
    ['単一引用符の bash -c', "sh -c 'gh workflow run release-prod.yml'"],
    ['引用符で囲んだ gh', '"gh" workflow run release-prod.yml'],
    ['サブシェル', '(gh workflow run release-prod.yml)'],
  ];
  for (const [label, command] of matched) {
    it(`${label}: matched`, () => {
      const verdict = inspectReleaseProdDispatch(command);
      expect(verdict.matched).toBe(true);
      if (!verdict.matched) throw new Error('unreachable');
      expect(verdict.form).toBe('gh-release-prod');
      expect(verdict.reason).toContain('release-prod');
    });
  }
});

describe('別の操作・読み取りは matched にしない', () => {
  const passing: ReadonlyArray<[string, string]> = [
    ['別のワークフロー', 'gh workflow run ci.yml'],
    [
      '別のワークフローの api',
      'gh api -X POST repos/o/r/actions/workflows/ci.yml/dispatches -f ref=main',
    ],
    ['run list（読み取り）', 'gh run list --workflow=release-prod.yml --limit 10'],
    ['workflow view（読み取り）', 'gh workflow view release-prod.yml'],
    ['api の GET（runs の一覧）', 'gh api repos/o/r/actions/workflows/release-prod.yml/runs'],
    ['無関係な gh', 'gh pr create --title x --body y'],
    ['gh の無い行', 'echo release-prod'],
    ['echo の引数に書いただけ', 'echo "run release-prod"'],
    ['git push（別の経路。この判定は見ない）', 'git push origin main'],
    ['空', ''],
  ];
  for (const [label, command] of passing) {
    it(`${label}: matched にしない`, () => {
      expect(inspectReleaseProdDispatch(command).matched).toBe(false);
    });
  }

  it('データだけを書くヒアドキュメントの本文は見ない', () => {
    const command = "cat > notes.md <<'EOF'\ngh workflow run release-prod.yml\nEOF\necho ok";
    expect(inspectReleaseProdDispatch(command).matched).toBe(false);
  });
});

describe('既知の抜け道（この判定は文字列しか見ない。硬い境界は release/prod の ruleset 側）', () => {
  it('workflow を数値 ID で指定した形は見分けられない', () => {
    expect(inspectReleaseProdDispatch('gh workflow run 12345678').matched).toBe(false);
  });

  it('変数で組んだ gh は見分けられない', () => {
    expect(inspectReleaseProdDispatch('$GH workflow run release-prod.yml').matched).toBe(false);
  });
});
