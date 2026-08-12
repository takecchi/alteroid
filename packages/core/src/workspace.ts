import { z } from 'zod';

import type { WorkspaceLocator } from './schema.js';

/**
 * workspace の運用選択と、runner を跨いだ移送の可否（roadmap M5）。
 *
 * M4 では locator を**残すところまで**だった。runner が増えると「落ちた器で
 * 触っていた作業を、別の器から続けられるか」が実際の問いになる（M5 受け入れ基準4）。
 * その答えは器の外側の運用で決まるので、ここでは**決まりごとを1か所に集めるだけ**に
 * してある。
 *
 * | 選択 | 別の器から辿り着けるか | 何が失われるか |
 * |---|---|---|
 * | `runner-volume` | **不可**（その器の volume の中） | 落ちれば作業ディレクトリごと。未コミット分は復旧できない |
 * | `shared-volume` | 可（同じパスが見える） | 何も失われない |
 * | `git` | 可（作り直す） | コミットしていない変更 |
 *
 * **「できない」を黙って諦めないこと。** 移送できないと判った場合に要るのは
 * 沈黙ではなく報告である（受け入れ基準4 の後段: 復旧不能な未永続状態を人間へ
 * 明示できること）。ここが返す文言がそのまま上へ流れる。
 */

/** locator の種別だけを指す口（設定から選ばせるときに使う）。 */
export const workspaceLocatorKindSchema = z.enum(['runner-volume', 'shared-volume', 'git']);

export type WorkspaceLocatorKind = z.infer<typeof workspaceLocatorKindSchema>;

/**
 * 運用の選択そのもの。**方針であって能力の制限ではない**ので、設定で切り替わる。
 *
 * 既定は `runner-volume`（M4 と同じ挙動）。器を跨いで続けたいなら、共有 FS を
 * マウントするか、git から作り直させるかを選ぶ。
 */
export const workspacePolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('runner-volume') }),
  /** 全 runner から**同じパスで**見える FS。パスを省くと委譲時の cwd を使う。 */
  z.object({ kind: z.literal('shared-volume'), path: z.string().min(1).optional() }),
  /**
   * git から作り直す。
   *
   * 作り直すのは**マネージャー自身**である（人間がやることと同じ）。デーモンが
   * 器の中で clone を代行する仕組みを足さない — 判断も手も下へ渡してあるのだから、
   * 「作業ディレクトリが空だ」と伝えれば済む。
   */
  z.object({ kind: z.literal('git'), repository: z.string().min(1), ref: z.string().min(1) }),
]);

export type WorkspacePolicy = z.infer<typeof workspacePolicySchema>;

export const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = { kind: 'runner-volume' };

/** 委譲を1本置くときの locator を作る。 */
export function locatorFor(
  policy: WorkspacePolicy,
  place: { runnerId: string; cwd: string },
): WorkspaceLocator {
  switch (policy.kind) {
    case 'shared-volume':
      return { kind: 'shared-volume', path: policy.path ?? place.cwd };
    case 'git':
      return { kind: 'git', repository: policy.repository, ref: policy.ref };
    case 'runner-volume':
      return { kind: 'runner-volume', runnerId: place.runnerId, path: place.cwd };
    default: {
      const exhaustive: never = policy;
      throw new Error(`未知の workspace 運用選択: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** その locator に縛られている runner（居なければ null）。 */
export function pinnedRunnerId(locator: WorkspaceLocator | undefined): string | null {
  return locator?.kind === 'runner-volume' ? locator.runnerId : null;
}

/** 別の器から辿り着けるか。 */
export function isPortable(locator: WorkspaceLocator | undefined): boolean {
  if (locator === undefined) return false;
  return locator.kind !== 'runner-volume';
}

export interface Relocation {
  /** 移送先での作業ディレクトリ。 */
  cwd: string;
  /** 移送先での locator（台帳を書き換える値）。 */
  locator: WorkspaceLocator;
  /**
   * 再開の一言に足す説明。**空でよい場合もある**（共有 FS は何も変わらない）。
   *
   * ここで嘘をつくと、マネージャーは無い作業ディレクトリの上で続きを書き始める。
   */
  nudge: string;
}

/**
 * 落ちた器から別の器へ、作業の続きを置き直す。
 *
 * 返るのは「どこで続けるか」だけである。セッションの続き（resume）は呼び出し側が
 * 台帳と預かった生ログから行う — ここは workspace の話しかしない。
 *
 * 移送できないときは `null`。そのときは `describeLoss` を人間へ回すこと。
 */
export function relocate(
  locator: WorkspaceLocator | undefined,
  target: { runnerId: string; workspacePath: string },
): Relocation | null {
  if (locator === undefined) return null;

  switch (locator.kind) {
    case 'shared-volume':
      // 同じパスが見えるので、作業ディレクトリはそのまま。器だけが変わる。
      return {
        cwd: locator.path,
        locator,
        nudge:
          '[system] 走らせていた器が落ちたので、別の器で続きを開いた。' +
          `作業ディレクトリ（${locator.path}）は共有されているのでそのまま残っている。中断していた作業の続きを進めよ。`,
      };

    case 'git':
      // 作業ディレクトリは器と一緒に消えている。**作り直すのはマネージャー自身**。
      return {
        cwd: target.workspacePath,
        locator,
        nudge:
          '[system] 走らせていた器が落ちたので、別の器で続きを開いた。' +
          `作業ディレクトリは器と一緒に失われている（いまの cwd は ${target.workspacePath} で、空か別物である）。` +
          `${locator.repository} の ${locator.ref} を clone し直してから、中断していた作業の続きを進めよ。` +
          'コミットしていなかった変更は残っていないので、必要なら書き直すこと。',
      };

    case 'runner-volume':
      // その器の volume の中にしか無い。**別の器へ移したふりをしない。**
      return null;

    default: {
      const exhaustive: never = locator;
      throw new Error(`未知の workspace locator: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * 移送できないことを人間の言葉にする（受け入れ基準4 の後段）。
 *
 * **「復旧した」と読めないように書くこと。** セッション（会話の続き）は預かって
 * あるが、作業ディレクトリの中身は無い — その差を曖昧にすると、人間は失われた
 * 作業を残っているものと思い込む。
 */
export function describeLoss(locator: WorkspaceLocator | undefined, runnerId?: string): string {
  const where = runnerId === undefined ? '走らせていた runner' : `runner ${runnerId}`;
  if (locator === undefined) {
    return (
      `${where} が居なくなり、この委譲の workspace の所在が台帳に無い。` +
      '別の器で続きを開くと、どこで何を触っていたのかが分からないまま再開することになる。'
    );
  }
  if (locator.kind === 'runner-volume') {
    return (
      `${where} が落ちた。作業ディレクトリ（${locator.path}）はその器の volume の上にあり、` +
      '別の器からは辿り着けない。セッション（会話の続き）は預かってあるので別の器で開き直せるが、' +
      'コミットしていない変更は復旧できない。' +
      '器を跨いで続けられるようにするなら、共有 FS か git 再構築へ運用を切り替えること（ALTEROID_WORKSPACE_KIND）。'
    );
  }
  return `${where} が落ち、別の器も見つからないので続きを開けない。`;
}
