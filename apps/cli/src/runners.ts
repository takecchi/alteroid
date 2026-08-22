import { stdout } from 'node:process';

import {
  describeRevisionStatus,
  type RunnerRevisionReport,
  type RunnerRevisionStatus,
} from '@alteroid/core';

import { createClient } from './client.js';
import { resolveTarget } from './target.js';

/**
 * `alteroid runners` — 委譲先の器と、**いま走っているコードの版**を見る。
 *
 * 経路は `GET /runners` の1本だけで、Web UI の設定画面とクローンの `runner_list` も
 * 同じものを見る（`apps/daemon/src/app.ts`「経路は1本だけにする」）。
 *
 * **なぜ CLI にも要るのか。** 版はここまで Web UI とクローンからしか読めなかった。
 * 片方の口でしかできないことを作らないのがこのプロダクトの約束であり（PRD
 * 「インターフェース」）、しかも版を確かめたい場面（デプロイ直後・器が上がって
 * こない・「コードはこうなっている」という主張の検算）は**端末に居るときが多い。**
 *
 * **文言は core（`describeRevisionStatus`）に任せ、ここで作り直さない。** 口ごとに
 * 違う言葉で同じ状態が出ると、読む側は別の状態だと読む。
 */
export async function runnersCommand(): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.runners.$get();
  if (!response.ok) {
    stdout.write('runner の一覧を読めませんでした\n');
    return;
  }
  stdout.write(`${renderRunners(await response.json())}\n`);
}

/**
 * `GET /runners` の応答のうち、この口が読む分。
 *
 * **`daemonRevision` は2値（`RunnerRevisionReport`）で、runner の版は3値
 * （`RunnerRevisionStatus`）である。** 同じ型にしないこと — 自分の版は訊きに行く
 * 経路が無いので `unheard`（名乗りを聞けていない）が意味を持たない。
 */
interface RunnersView {
  runners: {
    label: string;
    state: string;
    runnerId?: string;
    workspacePath?: string;
    error?: string;
    /**
     * いまその名前に応えているプロセス。**`runnerId` は器を作り直しても同じ**なので、
     * 名前だけでは「さっき仕事を渡した相手と同じか」が言えない。名乗らない器も在る
     * ので省略可能で、**そのときは黙らずに「判定できない」と言う。**
     */
    instanceId?: string;
    instanceSince?: string;
    revision: RunnerRevisionStatus;
  }[];
  daemonRevision: RunnerRevisionReport;
}

/**
 * 器の一覧を、人間が読める形へ。
 *
 * **デーモン自身の版を最初に、runner が0台でも出す。** 0台は「まだ配線されて
 * いない」状態、つまり版を確かめたい状態そのものなので、そこで落とすとその状態で
 * だけ答えが消える。並べて出すのは、別々の場所に出すと人間が手で突き合わせる
 * ことになり、突き合わせ忘れがそのまま見逃しになるからである（2つの Service は
 * 別々にデプロイされるので、ずれている窓が実際に在る）。
 */
export function renderRunners(view: RunnersView): string {
  const lines = [`デーモンの版: ${describeRevisionStatus(view.daemonRevision)}`, ''];

  if (view.runners.length === 0) {
    lines.push(
      '登録されている runner は0台（設定に ALTEROID_RUNNER_URLS 等が無いか、まだ配線されていない）。',
    );
    return lines.join('\n');
  }

  lines.push(
    view.runners.length === 1
      ? 'runner は1台のみ登録されている（分散していない）。'
      : `runner は${view.runners.length}台登録されている。`,
  );

  for (const runner of view.runners) {
    lines.push(
      '',
      // **state を畳まない。** 5値のまま出す（`unreachable` と `lost` は別物である）。
      `- ${runner.runnerId ?? runner.label} [${runner.state}]`,
    );
    if (runner.runnerId !== undefined) lines.push(`  宛先: ${runner.label}`);
    if (runner.workspacePath !== undefined) lines.push(`  workspace: ${runner.workspacePath}`);
    // **「どのプロセスか」を版と並べて出す。** クローンの `runner_list` と Web UI の
    // 設定画面が既に両方を出しているので、ここに片方だけ出すと**この口でだけ
    // 判定材料が欠ける**（この PR が直そうとしている非対称そのものである）。
    // **名乗らないことを黙らせない** — 出さないと「入れ替わっていない」と
    // 「判定できない」が同じに見える。
    lines.push(
      runner.instanceId === undefined
        ? '  応えているプロセス: 名乗っていない（この器では入れ替わりを判定できない）'
        : `  応えているプロセス: ${runner.instanceId}` +
            (runner.instanceSince === undefined ? '' : `（${runner.instanceSince} から）`),
    );
    // 版は上の隣に置く。**別の問いに答える2つである** — 上は「同じプロセスか」、
    // こちらは「そのプロセスがどのコミットで走っているか」。並べないと、どちらか
    // 片方でもう片方を推測することになる。
    lines.push(`  版: ${describeRevisionStatus(runner.revision)}`);
    if (runner.error !== undefined) lines.push(`  直近の失敗: ${runner.error}`);
  }

  // **器ごとのマネージャーの本数はここでは出さない。** `GET /runners` はそれを
  // 返さない（返すのはクローンの `runner_list` が読む `ManagerPool.runners()` の
  // 側で、経路が違う）。**返っていない値を、それらしく 0 と書かないこと。**
  // 本数が要るなら `alteroid` の別の口（`/managers`）が持つ。

  return lines.join('\n');
}
