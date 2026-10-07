import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

import { mutateCliChildEnv } from './mutate-cli-child-env.js';
import {
  SELFTEST_RECOVERY_COMMANDS,
  selftestMarkerPresentMessage,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
} from '../.claude/skills/mutation-testing/mutate-selftest.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// 本物の REPO_ROOT を見ず、ハーネスを使い捨てツリーへ写してそのコピー側の CLI を測る: REPO_ROOT は共有資源で、外部が印を置いたり消したりするとテストが何も壊していないのに落ちるため。
function makeIsolatedHarnessCopy(prefix: string) {
  const harnessRoot = makeTempDirSync(prefix);
  const srcDir = path.join(REPO_ROOT, '.claude/skills/mutation-testing');
  const destDir = path.join(harnessRoot, '.claude/skills/mutation-testing');
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of ['mutate.mjs', 'mutate-core.mjs', 'mutate-selftest.mjs']) {
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
  }
  return {
    harnessRoot,
    cli: path.join(destDir, 'mutate.mjs'),
    markerPath: path.join(harnessRoot, 'MUTATION-IN-PROGRESS.json'),
  };
}

describe('mutate-selftest: selftestMarkerPresentMessage は復元経路を名指しする', () => {
  it('status と restore の両方のコマンドを、共有の定数そのままの形で含む', () => {
    const message = selftestMarkerPresentMessage('backup-corruption');

    expect(message).toContain(SELFTEST_RECOVERY_COMMANDS.status);
    expect(message).toContain(SELFTEST_RECOVERY_COMMANDS.restore);
  });

  it('案内するコマンドは mutate.mjs の status / restore である', () => {
    // 定数そのものを固定する: 上の2本は `toContain(定数)` なので、定数が空文字へ倒れると素通りするため。
    expect(SELFTEST_RECOVERY_COMMANDS.status).toBe(
      'node .claude/skills/mutation-testing/mutate.mjs status',
    );
    expect(SELFTEST_RECOVERY_COMMANDS.restore).toBe(
      'node .claude/skills/mutation-testing/mutate.mjs restore',
    );
  });

  it('原文が印の中にしかないことを名指しし、印を消すだけで済ませないよう止める', () => {
    const message = selftestMarkerPresentMessage('backup-corruption');

    expect(message).toContain('originalContent');
    expect(message).toContain('MUTATION-IN-PROGRESS.json');
    expect(message).toContain('消すだけで片付けないこと');
  });

  it('どのシナリオで止まったかを頭に出す（複数シナリオを回しているときに効く）', () => {
    expect(selftestMarkerPresentMessage('backup-corruption')).toMatch(/^backup-corruption: /);
    expect(selftestMarkerPresentMessage('weak-tooth')).toMatch(/^weak-tooth: /);
  });
});

// 使い捨ての ROOT を `--root` で渡す: 実リポジトリの直下に印を置くと、同時に走っている他の歯や人の作業を巻き込むため。

describe('mutate-selftest: 印が残った状態で selftest を起こすと、その案内が実際に出る', () => {
  it('印を置いた ROOT では backup-corruption が復元経路を出して止まる', () => {
    const harness = makeIsolatedHarnessCopy('mutate-selftest-marker-guidance-harness-');
    const tmp = makeTempDirSync('mutate-selftest-marker-guidance-');
    fs.writeFileSync(path.join(tmp, 'MUTATION-IN-PROGRESS.json'), '{}\n');

    const result = spawnSync(
      'node',
      [harness.cli, 'selftest', '--scenario', 'backup-corruption', '--root', tmp],
      { cwd: harness.harnessRoot, encoding: 'utf8', env: mutateCliChildEnv() },
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('印が既にある');
    expect(output).toContain(SELFTEST_RECOVERY_COMMANDS.status);
    expect(output).toContain(SELFTEST_RECOVERY_COMMANDS.restore);

    expect(fs.existsSync(harness.markerPath)).toBe(false);
  });

  it('歯（#1705 追加、消される向き）: このコピーの既定 ROOT にあらかじめ印の形のファイルが在っても、selftest の --root 実行はそれへ1バイトも触れない', () => {
    // 既定 ROOT に印の形のファイルをあらかじめ置く: 何も無い場所から「無い」ままだと、誰かが印を消してしまう欠陥があっても観測に現れないため。
    const harness = makeIsolatedHarnessCopy('mutate-selftest-marker-guidance-harness-erase-');
    const preplacedMarkerContent =
      '{"probe":"mutate-selftest-marker-guidance-preexisting-marker"}\n';
    fs.writeFileSync(harness.markerPath, preplacedMarkerContent);

    const tmp = makeTempDirSync('mutate-selftest-marker-guidance-erase-');
    fs.writeFileSync(path.join(tmp, 'MUTATION-IN-PROGRESS.json'), '{}\n');

    const result = spawnSync(
      'node',
      [harness.cli, 'selftest', '--scenario', 'backup-corruption', '--root', tmp],
      { cwd: harness.harnessRoot, encoding: 'utf8', env: mutateCliChildEnv() },
    );

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(harness.markerPath, 'utf8')).toBe(preplacedMarkerContent);
  });
});
