import { describe, expect, it } from 'vitest';

import { runnerUrlsOf } from './index.js';
import { readWorkspaceConfig } from './workspace.js';

/**
 * 複数 runner の宛先と、workspace の運用選択（roadmap M5）。
 *
 * どちらも**設定で決まる方針**であって、能力の制限ではない。だから既定は M4 と
 * 同じ挙動のままで、増やしたい人が増やせる形にしてある。
 */
describe('runner の宛先', () => {
  it('URLS でも URL でも読み、重ねても畳む', () => {
    expect(runnerUrlsOf({})).toEqual([]);
    expect(runnerUrlsOf({ ALTEROID_RUNNER_URL: 'unix:/run/a.sock' })).toEqual(['unix:/run/a.sock']);
    expect(runnerUrlsOf({ ALTEROID_RUNNER_URLS: 'http://r1:4518, http://r2:4518' })).toEqual([
      'http://r1:4518',
      'http://r2:4518',
    ]);
    // 1台構成からの移行で両方が置かれることがある（同じ宛先を二重に載せない）
    expect(
      runnerUrlsOf({
        ALTEROID_RUNNER_URLS: 'http://r1:4518 http://r2:4518',
        ALTEROID_RUNNER_URL: 'http://r1:4518',
      }),
    ).toEqual(['http://r1:4518', 'http://r2:4518']);
  });
});

describe('workspace の運用選択', () => {
  it('既定は runner ごとの volume（M4 の挙動を変えない）', () => {
    expect(readWorkspaceConfig({})).toEqual({ policy: { kind: 'runner-volume' }, notes: [] });
  });

  it('共有 FS はパスを省くと委譲時の cwd を使う', () => {
    expect(readWorkspaceConfig({ ALTEROID_WORKSPACE_KIND: 'shared-volume' }).policy).toEqual({
      kind: 'shared-volume',
    });
    expect(
      readWorkspaceConfig({
        ALTEROID_WORKSPACE_KIND: 'shared-volume',
        ALTEROID_WORKSPACE_PATH: '/mnt/shared/app',
      }).policy,
    ).toEqual({ kind: 'shared-volume', path: '/mnt/shared/app' });
  });

  it('git 再構築は宛先が要る。ref は既定 main', () => {
    expect(
      readWorkspaceConfig({
        ALTEROID_WORKSPACE_KIND: 'git',
        ALTEROID_WORKSPACE_REPOSITORY: 'git@github.com:acme/app.git',
      }).policy,
    ).toEqual({ kind: 'git', repository: 'git@github.com:acme/app.git', ref: 'main' });
  });

  it('移送できるつもりで穴を空けない（設定不足は言ってから既定へ落とす）', () => {
    const missing = readWorkspaceConfig({ ALTEROID_WORKSPACE_KIND: 'git' });
    expect(missing.policy).toEqual({ kind: 'runner-volume' });
    expect(missing.notes[0]).toContain('ALTEROID_WORKSPACE_REPOSITORY');

    const unknown = readWorkspaceConfig({ ALTEROID_WORKSPACE_KIND: 'nfs' });
    expect(unknown.policy).toEqual({ kind: 'runner-volume' });
    expect(unknown.notes[0]).toContain('読めない');
  });
});
