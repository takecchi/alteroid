import { describe, expect, it } from 'vitest';

import type { WorkspaceLocator } from './schema.js';
import {
  DEFAULT_WORKSPACE_POLICY,
  describeLoss,
  isPortable,
  locatorFor,
  pinnedRunnerId,
  relocate,
  workspaceLocatorKindSchema,
  workspacePolicySchema,
} from './workspace.js';

/**
 * workspace の運用選択（roadmap M5）。
 *
 * ここで固定したいのは受け入れ基準4 の両側である。
 *
 * - 永続化済み session と workspace から**別 runner で継続できる**（共有 FS / git）
 * - **できない場合は、復旧不能な未永続状態を人間へ明示できる**（runner-volume）
 *
 * 後者を「移せません」の一言で済ませないこと。何が残っていて何が失われたのかが
 * 読み取れなければ、人間は判断できない。
 */
const target = { runnerId: 'runner-b', workspacePath: '/work/runner-b' };

describe('workspace の運用選択', () => {
  it('既定は runner ごとの volume（M4 と同じ挙動を変えない）', () => {
    expect(DEFAULT_WORKSPACE_POLICY).toEqual({ kind: 'runner-volume' });
    expect(workspaceLocatorKindSchema.options).toEqual(['runner-volume', 'shared-volume', 'git']);
  });

  it('選択から locator を作る', () => {
    expect(locatorFor({ kind: 'runner-volume' }, { runnerId: 'runner-a', cwd: '/w' })).toEqual({
      kind: 'runner-volume',
      runnerId: 'runner-a',
      path: '/w',
    });
    // 共有 FS はパスを省くと委譲時の cwd を使う
    expect(
      locatorFor({ kind: 'shared-volume' }, { runnerId: 'runner-a', cwd: '/shared/p' }),
    ).toEqual({ kind: 'shared-volume', path: '/shared/p' });
    expect(
      locatorFor(
        { kind: 'shared-volume', path: '/mnt/shared' },
        { runnerId: 'runner-a', cwd: '/w' },
      ),
    ).toEqual({ kind: 'shared-volume', path: '/mnt/shared' });
    expect(
      locatorFor(
        { kind: 'git', repository: 'git@github.com:acme/app.git', ref: 'main' },
        { runnerId: 'runner-a', cwd: '/w' },
      ),
    ).toEqual({ kind: 'git', repository: 'git@github.com:acme/app.git', ref: 'main' });
  });

  it('設定の形を検査する（git は宛先と ref が無いと作り直せない）', () => {
    expect(workspacePolicySchema.safeParse({ kind: 'git' }).success).toBe(false);
    expect(
      workspacePolicySchema.safeParse({ kind: 'git', repository: 'r', ref: 'main' }).success,
    ).toBe(true);
    expect(workspacePolicySchema.safeParse({ kind: 'nfs' }).success).toBe(false);
  });

  it('runner に縛られているのは runner-volume だけ', () => {
    expect(pinnedRunnerId({ kind: 'runner-volume', runnerId: 'runner-a', path: '/w' })).toBe(
      'runner-a',
    );
    expect(pinnedRunnerId({ kind: 'shared-volume', path: '/w' })).toBeNull();
    expect(pinnedRunnerId(undefined)).toBeNull();
  });

  it('別の器から辿り着けるかを見分ける', () => {
    expect(isPortable({ kind: 'runner-volume', runnerId: 'runner-a', path: '/w' })).toBe(false);
    expect(isPortable({ kind: 'shared-volume', path: '/w' })).toBe(true);
    expect(isPortable({ kind: 'git', repository: 'r', ref: 'main' })).toBe(true);
    expect(isPortable(undefined)).toBe(false);
  });
});

describe('runner を跨いだ移送', () => {
  it('共有 FS はパスも中身もそのまま（何も失われない）', () => {
    const moved = relocate({ kind: 'shared-volume', path: '/mnt/shared/app' }, target);
    if (moved === null) throw new Error('共有 FS は移送できるはず');

    expect(moved.cwd).toBe('/mnt/shared/app');
    expect(moved.locator).toEqual({ kind: 'shared-volume', path: '/mnt/shared/app' });
    expect(moved.nudge).toContain('そのまま残っている');
    expect(moved.nudge).toContain('続きを進めよ');
  });

  it('git 再構築は、作り直しの指示と失われたものを一言に含める', () => {
    const moved = relocate(
      { kind: 'git', repository: 'git@github.com:acme/app.git', ref: 'feat/x' },
      target,
    );
    if (moved === null) throw new Error('git は移送できるはず');

    // 作業ディレクトリは新しい器のもの。**残っているふりをしない。**
    expect(moved.cwd).toBe('/work/runner-b');
    expect(moved.nudge).toContain('git@github.com:acme/app.git');
    expect(moved.nudge).toContain('feat/x');
    expect(moved.nudge).toContain('clone し直して');
    expect(moved.nudge).toContain('コミットしていなかった変更は残っていない');
  });

  it('runner の volume の中にしか無いものは移送しない（移したふりをしない）', () => {
    const locator: WorkspaceLocator = {
      kind: 'runner-volume',
      runnerId: 'runner-a',
      path: '/work/runner-a',
    };
    expect(relocate(locator, target)).toBeNull();
  });

  it('移送できないとき、何が残り何が失われたのかを言える（受け入れ基準4 の後段）', () => {
    const text = describeLoss(
      { kind: 'runner-volume', runnerId: 'runner-a', path: '/work/runner-a' },
      'runner-a',
    );

    expect(text).toContain('runner runner-a が落ちた');
    expect(text).toContain('/work/runner-a');
    // セッションは残っている / 作業は失われた、の両方が読み取れること
    expect(text).toContain('セッション（会話の続き）は預かってある');
    expect(text).toContain('コミットしていない変更は復旧できない');
    // 運用を変えれば避けられることも示す（できないままにしない）
    expect(text).toContain('ALTEROID_WORKSPACE_KIND');
  });

  it('workspace の所在が台帳に無い場合も黙らない', () => {
    expect(describeLoss(undefined, 'runner-a')).toContain('所在が台帳に無い');
  });
});
