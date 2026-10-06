#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

import { REMOVE_MANY_LIMIT_DEFAULT, REMOVE_MANY_LIMIT_MAX } from '@alteroid/core/cli-light';
import { Command } from 'commander';

import {
  accessGrantCommand,
  accessListCommand,
  accessOwnerCommand,
  accessRemoveUnreadableCommand,
  accessRevokeCommand,
} from './access.js';
import { localizeCommander } from './commander-ja.js';
import {
  conversationsListCommand,
  conversationsReadCommand,
  conversationsShowCommand,
} from './conversations.js';
import * as daemon from './daemon.js';
import { droppedCommand } from './dropped.js';
import { formatElapsedAgo } from './format.js';
import { loginCommand, logoutCommand, whoamiCommand } from './login.js';
import {
  memoryEditCommand,
  memoryListCommand,
  memoryRemoveCommand,
  memorySetCommand,
  memoryShowCommand,
} from './memory.js';
import {
  practiceEditCommand,
  practiceHistoryCommand,
  practiceListCommand,
  practiceRemoveCommand,
  practiceSetCommand,
  practiceShowCommand,
} from './practice.js';
import {
  profileClearCommand,
  profileEditCommand,
  profileListCommand,
  profileRemoveCommand,
  profileSetCommand,
  profileShowCommand,
  profileStatusCommand,
} from './profile.js';
import {
  integrationCreateCommand,
  integrationListCommand,
  integrationRemoveUnreadableCommand,
  integrationRevokeCommand,
} from './integration.js';
import {
  mcpClearCommand,
  mcpEditCommand,
  mcpListCommand,
  mcpSetCommand,
  mcpShowCommand,
} from './mcp.js';
import { alteroidRoot } from './paths.js';
import {
  permissionListCommand,
  permissionRemoveUnreadableCommand,
  permissionRevokeCommand,
} from './permission.js';
import { resetCommand } from './reset.js';
import { launchTui, opensTuiByDefault } from './tui/launch.js';
import { interruptCommand } from './interrupt.js';
import { runnersCommand, runnersVacateCommand } from './runners.js';
import { topologyCommand } from './topology.js';
import {
  credentialListCommand,
  credentialRemoveCommand,
  credentialSetCommand,
} from './credential.js';
import {
  tokenAddCommand,
  tokenDisableCommand,
  tokenEnableCommand,
  tokenListCommand,
  tokenPolicyCommand,
  tokenRemoveCommand,
  tokenRemoveUnreadableCommand,
} from './token.js';
import { progressCommand } from './progress.js';
import { HELP_EXAMPLES } from './help-examples.js';
import { describeCliVersion } from './version.js';
import { describeCliFailure } from './failure-message.js';

/**
 * alteroid — デーモンへの薄いクライアント。
 *
 * ここに脳は無い。core を CLI にも埋めると chat のたびにクローンが分岐する
 * （docs/architecture.md「脳は1インスタンス」）。init だけはデーモン起動前に
 * 動く必要があるので、ストレージ層（記憶の置き場を作るだけ）に直接触る。
 */
/**
 * `alteroid init` — 人格データディレクトリ（`~/.alteroid`）を初期化する。
 *
 * **テストのために切り出してある。** 元は `program.command('init').action(...)`
 * の中に直書きされていて、他のコマンド（`access` / `conversations` / `memory` /
 * `profile` など）が exported な `*Command` 関数を持つのに対し、ここだけ
 * その導線が無かった（#333）。挙動・出力は1文字も変えていない —
 * `program` 側は `await initCommand()` を呼ぶだけの薄い配線に変わっただけである。
 */
export async function initCommand(): Promise<void> {
  const { paths, created } = await (await import('@alteroid/storage-fs')).initWorkspace();
  stdout.write(`${paths.root} を初期化しました\n`);
  for (const path of created) stdout.write(`  作成: ${path}\n`);
  if (created.length === 0)
    stdout.write('  （既に初期化済み。既存のファイルには触れていません）\n');
  stdout.write('\n次: alteroid chat\n');
}

/**
 * `alteroid daemon start`。切り出した理由は {@link initCommand} と同じ（#333）。
 *
 * `--force` を付けたときだけ {@link daemon.startWithRecovery} を通す
 * （Issue #1851）。**既定（`options.force` が無い/false）の経路は1文字も
 * 変えていない** — 従来どおり `daemon.start()` を直接呼ぶだけで、`start()` /
 * `ensureRunning()` の安全弁（`unknown` なら起こさない）はそのまま効く。
 */
export async function daemonStartCommand(options: { force?: boolean } = {}): Promise<void> {
  if (!options.force) {
    const info = await daemon.start();
    stdout.write(`alteroidd を起動しました (pid ${info.pid}, port ${info.port})\n`);
    return;
  }

  const outcome = await daemon.startWithRecovery();
  switch (outcome.kind) {
    case 'already-present':
      // 本人確認できているデーモンが既に居る——`--force` を付けていても、
      // 本物を二重に起こさない（Issue #1851）。
      stdout.write(
        `alteroidd は既に動いています (pid ${outcome.info.pid}, port ${outcome.info.port})。` +
          ' 本人確認できたので --force は使いませんでした（退避も再起動もしていません）。\n',
      );
      return;
    case 'started':
      // 居ないと確定できた（absent）——退避は要らず、今までどおりの経路。
      stdout.write(
        `alteroidd を起動しました (pid ${outcome.info.pid}, port ${outcome.info.port})\n`,
      );
      return;
    case 'recovered':
      stdout.write(`確かめられなかった状態ファイルを退避しました: ${outcome.quarantinedTo}\n`);
      if (outcome.previousPidAlive === true) {
        stdout.write(
          `前のデーモン (pid ${outcome.previousPid}) はまだ生きているように見えます。` +
            ' 二重起動になっている可能性があります。自分で確認してください。\n',
        );
      } else if (outcome.previousPidAlive === false) {
        stdout.write(`前のデーモン (pid ${outcome.previousPid}) は既に居ないようです。\n`);
      } else {
        stdout.write(`前のデーモン (pid ${outcome.previousPid}) の生死は確認できませんでした。\n`);
      }
      stdout.write(
        'これは二重起動の危険を引き受ける操作です。データの不整合が無いか自分で確認してください。\n',
      );
      stdout.write(
        `alteroidd を起動しました (pid ${outcome.info.pid}, port ${outcome.info.port})\n`,
      );
      return;
  }
}

/** `alteroid daemon stop`。切り出した理由は {@link initCommand} と同じ（#333）。 */
export async function daemonStopCommand(): Promise<void> {
  switch (await daemon.stop()) {
    case 'stopped':
      stdout.write('alteroidd を停止しました\n');
      return;
    case 'not-running':
      stdout.write('alteroidd は動いていません\n');
      return;
    case 'stale':
      // 本人確認できない PID にシグナルは送らない（別プロセスを殺しうる）
      stdout.write(
        'alteroidd は応答しません。古い状態ファイルを片付けました。\n' +
          'プロセスが残っている場合は手で確認して終了してください。\n',
      );
      return;
    case 'unresponsive':
      stdout.write('alteroidd が停止要求に応じません。ログを確認してください。\n');
      // 止まっていない＝失敗。スクリプトから成功と見分けが付くよう非 0（#3140）。
      process.exitCode = 1;
      return;
    case 'unknown':
      // 確かめられなかっただけで、「居ない」と確定したわけではない
      // （Issue #1818）。状態ファイルは残したままにしたので、そう正直に言う
      // ——ここで「停止しました」「片付けました」と言うと、実際には生きて
      // いるかもしれない本物のデーモンを見捨てたことになる。
      stdout.write(
        'alteroidd の生死を確認できませんでした（応答が無いかタイムアウトしました）。\n' +
          '状態ファイルは残したままにしました。ネットワークや負荷を確認してから、' +
          '`alteroid daemon status` で様子を見てください。\n',
      );
      // 止まったと確かめられなかった＝成功とは言えないので非 0（#3140）。
      // 'stale'（状態ファイルを片付けた＝居なかった）と 'not-running' は 0 のまま。
      process.exitCode = 1;
      return;
  }
}

/** `alteroid daemon status`。切り出した理由は {@link initCommand} と同じ（#333）。 */
export async function daemonStatusCommand(now: number = Date.now()): Promise<void> {
  const { presence, info } = await daemon.status();
  if (presence === 'present' && info) {
    stdout.write(`稼働中: pid ${info.pid}, http://127.0.0.1:${info.port}\n`);
    // **経過（issue #2141 段1）を横に添える。** ISO はそのまま残す。
    stdout.write(`  起動: ${info.startedAt}（${formatElapsedAgo(info.startedAt, now)}）\n`);
  } else if (presence === 'unknown') {
    // 「居ない」と確定できたわけではない — 応答が無かっただけかもしれない。
    // ここで「停止中」と言い切ると、生きているデーモンを見落とした誤報になる。
    stdout.write(
      '確認できません（応答が無いかタイムアウトしました。状態ファイルは残っています）\n',
    );
  } else {
    stdout.write('停止中\n');
  }
  // 記憶がどこにあるかは**デーモンに聞く**（資格が要る `GET /status`。無認証の
  // `/health` は返さない。#2869）。クラウド構成では PostgreSQL にあるので、CLI 側の
  // パスを表示すると人間が器を取り違える。**稼働中なのに聞けなかったときは、ローカルの
  // パスへ落とさず「取得できません」と言う**（落とすと取り違えを起こす）。
  if (presence === 'present') {
    const storage = await daemon.storageOf(info);
    stdout.write(
      `  記憶: ${storage ?? '取得できません（デーモンが答えない、または資格が通らない）'}\n`,
    );
  } else {
    stdout.write(`  記憶: ${alteroidRoot()}\n`);
  }
}

/**
 * **`export` してあるのは、サブコマンドが実際に登録されているかを歯で見るため
 * である（#1055 段3③）。** 挙動は1文字も変えていない —— `parseAsync` を呼ぶのは
 * 直下の `invokedDirectly()` の分岐だけなので、import しても登録しか走らない。
 *
 * **登録漏れは、関数側の歯では1本も赤くならない。** `practice.ts` の
 * `practice*Command` が全部緑でも、ここへ繋いでいなければ人間は
 * `alteroid practice` を打てない —— 段3 の受け入れ基準「人間がやり方を読んで
 * 書き換えられる（3入口すべて）」が満たされないのは、まさにその形である
 * （実際、この PR の前に `practice.ts` だけが書かれて登録されていない状態が
 * 存在した）。⟹ 「入口が在る」を測れるのはここだけなので、`program` を出す。
 */
export const program = new Command();

// サブコマンドは作った時点の親の設定を引き継ぐので、`.command()` を足す前に掛ける（#2857）。
localizeCommander(program);

program
  .name('alteroid')
  .description('クローンと会話し、クローンに仕事を任せる')
  .version(describeCliVersion(), '-V, --version', 'バージョンを出す');

program
  .command('init')
  .description('人格データディレクトリ（~/.alteroid）を初期化する')
  .action(async () => {
    await initCommand();
  });

program
  .command('chat')
  .description('クローンと会話する（デーモンが居なければ起こす）')
  .action(async () => {
    await (await import('./chat.js')).chatCommand();
  });

program
  .command('tui')
  .description(
    '全画面の TUI を開く（いまは会話の画面。承認待ち・委譲・日誌・記憶は順に足していく。端末でだけ動く）',
  )
  .action(async () => {
    await launchTui();
  });

/**
 * 会話（chat の履歴）。**読めるだけの面を作らない、が今回はその逆を直す。**
 *
 * `POST /chat` の SSE は流すだけで、後から読み直す口が無かった。Web
 * （`apps/web/app/routes/chat.tsx` / `packages/swr/src/hooks/queries.ts`）は
 * `GET /conversations` と `GET /conversations/{id}` の両方を使っているのに、
 * CLI からは0件だった。docs/PRD.md「インターフェース」は3面で同じことができると
 * 書いており、これはその等価性が崩れていたバグである（north_star 禁止1）。
 *
 * 形は `alteroid memory`（一覧して、id で1件読む）に合わせてある。
 */
const conversationsCommand = program
  .command('conversations')
  .description('会話（chat の履歴）を読む（器を替えても続きから話せるための口）');

conversationsCommand
  .command('list')
  .description('会話の一覧（新しい順）')
  .option('--limit <n>', '返す最大件数（デーモンの既定 20、最大 200）')
  .option('--scan <n>', '日誌をどこまで遡って集計するか（デーモンの既定 2000、最大 10000）')
  .action(async (options: { limit?: string; scan?: string }) => {
    await conversationsListCommand(options);
  });

conversationsCommand
  .command('show <id>')
  .addHelpText('after', HELP_EXAMPLES.conversationsShow)
  .description('1つの会話の中身（古い順）')
  .option('--scan <n>', '日誌をどこまで遡って探すか（デーモンの既定 2000、最大 10000）')
  .option(
    '--include-superseded',
    'チャットの編集で既定ビューから畳まれた旧発言・その応答も含めて読む（既定は含めない）',
  )
  .action(async (id: string, options: { scan?: string; includeSuperseded?: boolean }) => {
    await conversationsShowCommand(id, options);
  });

conversationsCommand
  .command('read <id>')
  .description('会話を、いちばん新しい発言まで既読にする（既読は Web の画面と共通）')
  .action(async (id: string) => {
    await conversationsReadCommand(id);
  });

/**
 * 利用状況（いくら使ったか）。経路は `GET /usage` の1本だけで、chat の
 * `/usage` と Web UI の画面も同じものを見る（`apps/cli/src/usage.ts`）。
 */
program
  .command('usage')
  .addHelpText('after', HELP_EXAMPLES.usage)
  .description('alteroid が使った分（トークンと費用）を見る')
  .option('--from <date>', 'この日から（YYYY-MM-DD）')
  .option('--to <date>', 'この日まで（YYYY-MM-DD）')
  .option('--manager <id>', 'このマネージャーの分だけ')
  // **誰が・どこで の絞り込みは4つの口すべてに置く。** 片方にだけ足すと、そこに
  // しかできない分析が生まれる（PRD「インターフェース」）。
  .option('--layer <layer>', '誰が（clone / manager）')
  .option('--site <site>', 'どこで（session / distill / peer）')
  .option('--token <id>', 'どの認証トークンで（alteroid token list の id）')
  .action(
    async (options: {
      from?: string;
      to?: string;
      manager?: string;
      layer?: string;
      site?: string;
      token?: string;
    }) => {
      await (await import('./usage.js')).usageCommand(options);
    },
  );

/**
 * 委譲先の器と、**いま走っているコードの版**。
 *
 * 経路は `GET /runners` の1本だけで、Web UI の設定画面とクローンの `runner_list` も
 * 同じものを見る。**版を読む口が Web とクローンにしか無い状態を残さない**
 * （PRD「インターフェース」— 片方でしかできないことを作らない）。
 */
const runnersProgram = program
  .command('runners')
  .description('委譲先の器と、デーモン / runner がいま走っている版を見る')
  .action(async () => {
    await runnersCommand();
  });

/**
 * 器を意図して空ける（drain）。経路は `POST /runners/vacate` の1本だけ
 * （`apps/cli/src/runners.ts` の `runnersVacateCommand`）。
 */
runnersProgram
  .command('vacate')
  .description('その runner を意図して空ける（載っている委譲を他の runner へ移す）')
  .argument('<runnerId>', '空ける runner の id（alteroid runners で見える）')
  .action(async (runnerId: string) => {
    await runnersVacateCommand(runnerId);
  });

/**
 * 稼働の地図（クローン・記憶・runner・マネージャー・作業者と、線の最後の活動）。
 *
 * 経路は `GET /topology`（`--watch` は `GET /topology/stream`）の1本だけで、Web UI の
 * 地図も同じものを見る（`apps/cli/src/topology.ts`）。
 */
program
  .command('topology')
  .description('稼働の地図（各層の状態と、指示・報告が最後にいつ流れたか）を見る')
  .option('--json', '整形せず、デーモンが返した JSON をそのまま出す')
  .option('--watch', '変化を追って描き直す（Ctrl-C で終わる。--json なら1行1スナップショット）')
  .action(async (options: { json?: boolean; watch?: boolean }) => {
    await topologyCommand(options);
  });

/**
 * いま走っているクローンのターンを止める（#1398 c23-1）。経路は `POST /clone/interrupt`
 * の1本だけ（`apps/cli/src/interrupt.ts`）。
 */
program
  .command('interrupt')
  .description('いま走っているクローンのターンを止める（会話の続きと受信箱は残る）')
  .action(async () => {
    await interruptCommand();
  });

/**
 * 握り潰しの跡（記録・読み出しの失敗の跡。本文は含まない）。
 *
 * 経路は `GET /dropped` の1本だけで、Web UI の `/dropped` 画面とクローンの
 * MCP 道具 `self_dropped` も同じ帳面を見る（`apps/cli/src/dropped.ts`）。
 */
program
  .command('dropped')
  .description('握り潰しの跡（記録・読み出しの失敗の跡。本文は含まない）を見る')
  .action(async () => {
    await droppedCommand();
  });

/**
 * 作業の進捗（積み上がり・実施中・窓の中の消化・見込み）。経路は `GET /progress` の
 * 1本だけ（`apps/cli/src/progress.ts`。#2241）。
 */
program
  .command('progress')
  .addHelpText('after', HELP_EXAMPLES.progress)
  .description('作業の進捗（積み上がり・実施中・窓の中の消化・見込み）を見る')
  .option('--window-hours <n>', '消化と見込みを数える窓の長さ（時間。既定は daemon が決める）')
  .action(async (options: { windowHours?: string }) => {
    await progressCommand(options);
  });

/**
 * 受信箱（`inbox_events`。まだ処理し終えていない合図の器）。issue #972 / #783。
 *
 * `remove`（絞り込んでまとめて畳む＝消す。`POST /inbox/remove`、PR #1007）と
 * `show`（内訳を読む。`GET /inbox`、#783 段0）の2本。詳しい経緯・設計は
 * `apps/cli/src/inbox.ts` の doc を見ること。
 */
const inboxCommand = program
  .command('inbox')
  .description('受信箱（クローンの未処理の合図をためておく場所）');

inboxCommand
  .command('show')
  .description('受信箱の滞留の内訳を読む（読み取り専用。何も変更しない）')
  .action(async () => {
    await (await import('./inbox.js')).inboxShowCommand();
  });

inboxCommand
  .command('remove')
  .addHelpText('after', HELP_EXAMPLES.inboxRemove)
  .description(
    '受信箱の未読を、絞り込んでまとめて畳む（消す）。既定は試算で1件も消さない（実際に消すのは --execute）',
  )
  .requiredOption(
    '--types <種類>',
    '消す対象の種類（カンマ区切り。human_message,human_answer,distill,timer,external,' +
      'self_initiative,manager_message から選ぶ。在る7種類全部を並べた呼びは断られる）',
  )
  .option('--sources <送信元>', '送信元での絞り込み（完全一致、カンマ区切り）')
  .option('--before <ISO8601>', 'この時刻より古い行だけを対象にする')
  .requiredOption('--reason <理由>', '日誌に残す理由')
  .option('--execute', '試算ではなく実際に消す（既定は試算）')
  // 既定・上限は `@alteroid/core` の定数から組む（`usage` / `conversations` の
  // `--limit` / `--scan` が既定と最大をヘルプに書いているのと同じ慣習だが、
  // 数を書き写すと腐るので値そのものを参照する）。
  .option(
    '--limit <N>',
    `1回で消す上限（デーモンの既定 ${REMOVE_MANY_LIMIT_DEFAULT}、最大 ${REMOVE_MANY_LIMIT_MAX}）`,
  )
  .action(
    async (options: {
      types: string;
      sources?: string;
      before?: string;
      reason: string;
      execute?: boolean;
      limit?: string;
    }) => {
      await (await import('./inbox.js')).inboxRemoveCommand(options);
    },
  );

/**
 * ログイン。**手元のデーモンには不要**（状態ファイルを読める＝実行環境の持ち主
 * として通る）。要るのは ALTEROID_URL で別のデーモンへ繋ぐときと、
 * 外部アプリ用のトークンを発行したいときである。
 */
program
  .command('login')
  .description('ブラウザでログインして、この端末用のアクセストークンを貰う')
  .option('--provider <id>', 'ログイン手段（既定はデーモンが持つ最初のもの）')
  .action(async (options: { provider?: string }) => {
    await loginCommand(options);
  });

program
  .command('logout')
  .description('サーバ側のアクセストークンを失効させ、この端末の資格も消す')
  .option(
    '--local-only',
    'サーバ側を失効させず、手元の資格だけを消す（トークンは期限か access revoke まで有効）',
  )
  .action(async (options: { localOnly?: boolean }) => {
    await logoutCommand(options);
  });

program
  .command('whoami')
  .description('いま自分がどの資格で繋いでいるかを見る')
  .action(async () => {
    await whoamiCommand();
  });

/**
 * アクセス許可。**ログインしただけでは alteroid は使えない。**
 *
 * 持つのは許可の2値だけで、行為ごとのスコープは作らない — それは PRD「権限境界」が
 * 禁じている「確認が要る行為の一覧」と同じ形になる。ここが決めるのは入口を通すか
 * どうかだけで、通った後に何を人間へ確認するかはクローンが記憶で判断し続ける。
 */
const accessCommand = program
  .command('access')
  .description(
    '誰が alteroid を使えるかを決める（実行環境の持ち主、または alteroid を使う許可を得たアカウント）',
  );

accessCommand
  .command('list')
  .description('ログインしたアカウントと許可の状態を見る')
  .action(async () => {
    await accessListCommand();
  });

accessCommand
  .command('grant <accountId>')
  .addHelpText('after', HELP_EXAMPLES.accessGrant)
  .description('alteroid を使う許可を与える')
  .action(async (accountId: string) => {
    await accessGrantCommand(accountId);
  });

accessCommand
  .command('revoke <accountId>')
  .addHelpText('after', HELP_EXAMPLES.accessRevoke)
  .description('alteroid を使う許可を取り消す（取り消せない。既定は対話で確認する）')
  .option('--yes', '確認を飛ばす（スクリプト・CI 向け。端末でなければ必須）')
  .action(async (accountId: string, options: { yes?: boolean }) => {
    await accessRevokeCommand(accountId, options);
  });

accessCommand
  .command('remove-unreadable <ids...>')
  .description(
    '読めないアカウントの行を id を指して消す（id はデーモンの stderr の「accounts の不正な行を読み飛ばしました」の跡。' +
      'access revoke は読めない行に触れない。id が取れない行はこの口では消せない）',
  )
  .option('--yes', '確認を飛ばす（スクリプト・CI 向け。端末でなければ必須）')
  .action(async (ids: string[], options: { yes?: boolean }) => {
    await accessRemoveUnreadableCommand(ids, options);
  });

/**
 * **注記: 資格の判断には使っていない（2026-10-05 オーナーの判断：ログインできる人＝持ち主。#2862）。** 下の「通すのに要る」は #2862 以前の記述。仕組みは当面残してある。
 *
 * 実行環境の持ち主としての宣言（issue #1198）。**`access grant` とは別の資格**
 * ——`alteroid credential set` / `alteroid reset` を通すのに要る。デーモンが
 * 動いているのと同じ環境（実行環境の持ち主）でしか実行できない
 * （`accessOwnerCommand` の doc）。
 */
accessCommand
  .command('owner <accountId>')
  .description(
    '実行環境の持ち主として宣言する／取り消す（資格の判断には使っていない。ログインできる人＝持ち主。#2862）',
  )
  .option('--revoke', '宣言を取り消す')
  .action(async (accountId: string, options: { revoke?: boolean }) => {
    await accessOwnerCommand(accountId, options);
  });

/**
 * 許可の棚卸し（Issue #863「許可をコードではなくデータにする」）。
 *
 * `request_permission` でクローンが要求し、人間が「許可します」と定型文で答えた
 * Bash 許可（`packages/core/src/permission-rule.ts`）を一覧・取り消しする——
 * 記録そのもの（`request_permission` / `answerApproval`）はここには無い。
 * #863 が #193 から引き継いだ残項目「CLI / Web UI（入口の等価性）」を埋める側。
 */
const permissionCommand = program
  .command('permission')
  .description(
    '人間が承認した Bash 許可を棚卸しする（一覧・取り消し。許可の記録そのものは、クローンが承認を受けて残す）',
  );

permissionCommand
  .command('list')
  .description('承認済みの許可を一覧する（既定は有効なものだけ）')
  .option('--all', '取り消し済みも含めて全部見る')
  .action(async (options: { all?: boolean }) => {
    await permissionListCommand(options);
  });

permissionCommand
  .command('remove-unreadable <ids...>')
  .description(
    '読めない許可の行を id を指して消す（id はデーモンの stderr の「許可の記録の不正な行を読み飛ばしました」の跡。' +
      'permission revoke は読めない行に触れない。id が取れない行はこの口では消せない）',
  )
  .option('--yes', '確認を飛ばす（スクリプト・CI 向け。端末でなければ必須）')
  .action(async (ids: string[], options: { yes?: boolean }) => {
    await permissionRemoveUnreadableCommand(ids, options);
  });

permissionCommand
  .command('revoke <id>')
  .description('許可を取り消す（次の Bash 呼び出しから効く。取り消せない。既定は対話で確認する）')
  .option('--yes', '確認を飛ばす（スクリプト・CI 向け。端末でなければ必須）')
  .action(async (id: string, options: { yes?: boolean }) => {
    await permissionRevokeCommand(id, options);
  });

/**
 * 添付（Issue #3111 段2）。会話に添えるファイルを CLI からも上げ・取り出せる
 * （`chat` / `tui` の `/attach` と同じ `POST /attachments`・`GET /attachments/:id`）。
 */
const attachmentsCommand = program
  .command('attachments')
  .description('添付ファイルを上げる・取り出す・控えを見る');

attachmentsCommand
  .command('put <path>')
  .description('ファイルを上げて id を出す（発言に添えないと 1 時間で掃除される）')
  .action(async (path: string) => {
    await (await import('./attachments.js')).attachmentsPutCommand(path);
  });

attachmentsCommand
  .command('get <id>')
  .description('添付の中身を保存する（既定は控えの名前でカレントへ。既存のファイルは上書きしない）')
  .option('-o, --output <file>', '保存先（- なら標準出力）')
  .addHelpText('after', HELP_EXAMPLES.attachmentsGet)
  .action(async (id: string, options: { output?: string }) => {
    await (await import('./attachments.js')).attachmentsGetCommand(id, options);
  });

attachmentsCommand
  .command('meta <id>')
  .description('添付の控え（名前・種類・大きさ・sha256・期限）を出す。中身は読まない')
  .action(async (id: string) => {
    await (await import('./attachments.js')).attachmentsMetaCommand(id);
  });

/**
 * 記憶（人格）。**読めるだけの面を作らない。**
 *
 * PRD「インターフェース」は3面で同じことができると書いており、起こせることの
 * 列挙に「記憶の書き換え」がある。ここが無かったので、CLI からは `chat` の
 * `/memory` で読むことしかできなかった。
 *
 * **これは M1 受け入れ基準3（人間が記憶を手で書き換えられる）を器に依存させない
 * ためでもある。** ローカルの fs 構成なら Markdown を直に開けるが、pg 構成や
 * コンテナの向こうではそれができない — 器を替えると受け入れ基準が満たせなく
 * なるのは、そのまま能力の削除である。
 */
const memoryCommand = program.command('memory').description('記憶（人格）を読む・書き換える・消す');

memoryCommand
  .command('list')
  .description('記憶の一覧（slug と題）')
  .action(async () => {
    await memoryListCommand();
  });

memoryCommand
  .command('show <slug>')
  .description('記憶の本文を出す')
  .action(async (slug: string) => {
    await memoryShowCommand(slug);
  });

memoryCommand
  .command('edit <slug>')
  .description('$EDITOR で開いて書き換える（無い slug なら新しく作る）')
  .action(async (slug: string) => {
    await memoryEditCommand(slug);
  });

memoryCommand
  .command('set <slug>')
  .addHelpText('after', HELP_EXAMPLES.memorySet)
  .description('ファイル（または標準入力）の内容で丸ごと置き換える')
  .option('-f, --file <path>', '読み込むファイル（省略か - で標準入力）')
  .option('--yes', '確認を飛ばす（スクリプト・CI 向け。端末でなければ必須）')
  .option('--allow-empty', '本文が空でも置き換える（既定では空の本文は断る。空にしたいときだけ）')
  .action(async (slug: string, options: { file?: string; yes?: boolean; allowEmpty?: boolean }) => {
    await memorySetCommand(slug, options);
  });

memoryCommand
  .command('remove <slug>')
  .description('記憶を1つ消す（消した事実は日誌に残るが、本文は戻らない。既定は対話で確認する）')
  .option(
    '--if-match <version>',
    '読んだ版（memory show が stderr に出す版）。いまの版と違えば消さずに失敗する。省略すると消す直前に読んだ版で照合する',
  )
  .option('--yes', '確認を飛ばす（スクリプト・CI 向け。端末でなければ必須）')
  .action(async (slug: string, options: { ifMatch?: string; yes?: boolean }) => {
    await memoryRemoveCommand(slug, options);
  });

/**
 * 仕事のやり方（`PracticeStore`）。**#1055 段3③ の3つ目の入口である。**
 *
 * 段3 の受け入れ基準は「人間がやり方を読んで書き換えられる（3入口すべて）」で、
 * `docs/PRD.md` の3入口は **CLI / HTTP API / Web UI** である（クローンの道具
 * `practice_*` は入口の数には入らない — あれはクローンの能力であって、人間の
 * 入口ではない）。#1316 で HTTP 口と画面が通ったので、残っていたのがここである。
 *
 * **`memory` と同じ構成にしてあるが、写していない概念が2つある。**
 * `PracticeStore` は human guard を持たず、`kind` は列挙ではない自由文字列である
 * （`practiceKindSchema` の doc「⛔ ここを `z.enum` にしないこと」）。だから
 * `--kind` に選択肢を置かない。理由は `practice.ts` の冒頭に在る。
 */
const practiceCommand = program
  .command('practice')
  .description('仕事のやり方を読む・書き換える・消す');

practiceCommand
  .command('list')
  .description('やり方の一覧（種類と slug と題）')
  .action(async () => {
    await practiceListCommand();
  });

practiceCommand
  .command('show <slug>')
  .addHelpText('after', HELP_EXAMPLES.practiceShow)
  .description('やり方の本文を出す（--version で過去の版を読む）')
  .option('--version <version>', '省略時はいまの本文。指定すると過去の版を読む')
  .action(async (slug: string, options: { version?: string }) => {
    const version = options.version === undefined ? undefined : Number(options.version);
    await practiceShowCommand(slug, { version });
  });

practiceCommand
  .command('history <slug>')
  .description('やり方の版の履歴を出す（メタだけ。本文は show --version で）')
  .action(async (slug: string) => {
    await practiceHistoryCommand(slug);
  });

practiceCommand
  .command('edit <slug>')
  .description('$EDITOR で開いて書き換える（無い slug なら新しく作る）')
  .option('--kind <kind>', '仕事の種類（省略すると現在の値。新しいやり方では必須）')
  .option('--title <title>', '題（省略すると現在の値。新しいやり方では必須）')
  .action(async (slug: string, options: { kind?: string; title?: string }) => {
    await practiceEditCommand(slug, options);
  });

practiceCommand
  .command('set <slug>')
  .addHelpText('after', HELP_EXAMPLES.practiceSet)
  .description('ファイル（または標準入力）の内容で丸ごと置き換える')
  .option('-f, --file <path>', '読み込むファイル（省略か - で標準入力）')
  .option('--kind <kind>', '仕事の種類（省略すると現在の値。新しいやり方では必須）')
  .option('--title <title>', '題（省略すると現在の値。新しいやり方では必須）')
  .option('--allow-empty', '本文が空でも置き換える（既定では空の本文は断る。空にしたいときだけ）')
  .action(
    async (
      slug: string,
      options: { file?: string; kind?: string; title?: string; allowEmpty?: boolean },
    ) => {
      await practiceSetCommand(slug, options);
    },
  );

practiceCommand
  .command('remove <slug>')
  .description('やり方を1つ消す（消した事実は日誌に残る）')
  .option(
    '--if-match <version>',
    '読んだ版（practice show が stderr に出す版）。いまの版と違えば消さずに失敗する。省略すると消す直前に読んだ版で照合する',
  )
  .action(async (slug: string, options: { ifMatch?: string }) => {
    await practiceRemoveCommand(slug, options);
  });

/**
 * 実行環境プロファイル。**器の環境変数を増やす代わりの口である。**
 *
 * 道具の鍵や `PATH` を1つ足すたびに `compose.yaml` を直して器を焼き直すのは、
 * 人間が `~/.zshenv` に1行足せば済ませていることを実装作業に変えることであり、
 * それはデグレードである（north_star 禁止1）。
 */
const profileCommand = program
  .command('profile')
  .description('実行環境プロファイル（~/.zprofile に当たるもの）を見る・書き換える');

profileCommand
  .command('list')
  .description('置かれている行の名前・撒く先・バイト数・更新時刻を並べる（本文は出さない）')
  .action(async () => {
    await profileListCommand();
  });

profileCommand
  .command('show [名前]')
  .description('1行の本文を出す（名前を省くと default。標準出力は本文だけ）')
  .action(async (name: string | undefined) => {
    await profileShowCommand(name);
  });

profileCommand
  .command('status')
  .description('プロファイルが各層へ届いているかを見る（本文は出さない）')
  .action(async () => {
    await profileStatusCommand();
  });

profileCommand
  .command('edit [名前]')
  .description('1行を $EDITOR で開いて書き換える（閉じたら反映。名前を省くと default）')
  .option(
    '--scope <all|app|runner>',
    '撒く先。all=共通(既定) / app=clone だけ / runner=manager だけ。' +
      '省略すると今の撒く先を引き継ぐ（置かれていなければ all）',
  )
  .action(async (name: string | undefined, options: { scope?: string }) => {
    await profileEditCommand(name, options);
  });

profileCommand
  .command('set [名前]')
  .addHelpText('after', HELP_EXAMPLES.profileSet)
  .description('ファイル（または標準入力）の内容で1行を丸ごと置き換える（名前を省くと default）')
  .option('-f, --file <path>', '読み込むファイル（省略か - で標準入力）')
  .option(
    '--scope <all|app|runner>',
    '撒く先。all=共通(既定) / app=clone だけ / runner=manager だけ。' +
      '省略すると今の撒く先を引き継ぐ（置かれていなければ all）',
  )
  .option('--yes', '確認を飛ばす（スクリプト・CI 向け。端末でなければ必須）')
  .action(
    async (name: string | undefined, options: { file?: string; scope?: string; yes?: boolean }) => {
      await profileSetCommand(name, options);
    },
  );

profileCommand
  .command('rm <名前>')
  .description('1行を外す（他の行は変えない。取り消せない。既定は対話で確認する）')
  .option('--yes', '確認を飛ばす（スクリプト・CI 向け。端末でなければ必須）')
  .action(async (name: string, options: { yes?: boolean }) => {
    await profileRemoveCommand(name, options);
  });

profileCommand
  .command('clear')
  .description('全行を外す（取り消せない。既定は対話で確認する）')
  .option('--yes', '確認を飛ばす（スクリプト・CI 向け。端末でなければ必須）')
  .action(async (options: { yes?: boolean }) => {
    await profileClearCommand(options);
  });

/**
 * `alteroid mcp` — 人間の MCP 連携の登録（`.mcp.json` 相当。#325 段4）。
 *
 * **器に `.mcp.json` を置く代わりの口である。** Railway には volume が無く、ファイルは
 * 器と一緒に消える（`packages/core/src/mcp-servers.ts` の doc）。正本は記憶ストアで、
 * クローンには次のセッションから、マネージャー・作業者には runner へ降ろしたうえで
 * 次に開くセッションから効く。Web UI の `/mcp-servers` と同じ2本の口を打つ。
 */
const mcpCommand = program
  .command('mcp')
  .description('MCP サーバの登録（.mcp.json に当たるもの）を見る・書き換える');

mcpCommand
  .command('list')
  .description('登録の名前・種類・宛先を並べる（値は出さない）')
  .action(async () => {
    await mcpListCommand();
  });

mcpCommand
  .command('show')
  .description('登録を JSON で出す（値は --reveal を付けたときだけ）')
  .option('--reveal', 'env / headers / args の値と URL をそのまま出す')
  .action(async (options: { reveal?: boolean }) => {
    await mcpShowCommand(options);
  });

mcpCommand
  .command('edit')
  .description('$EDITOR で開いて書き換える（閉じたら反映）')
  .action(async () => {
    await mcpEditCommand();
  });

mcpCommand
  .command('set')
  .addHelpText('after', HELP_EXAMPLES.mcpSet)
  .description('.mcp.json（{ "mcpServers": { … } }）の内容で丸ごと置き換える')
  .argument('<file>', '読み込むファイル（- で標準入力）')
  .option('--yes', '確認を飛ばす（スクリプト・CI 向け。端末でなければ必須）')
  .action(async (file: string, options: { yes?: boolean }) => {
    await mcpSetCommand(file, options);
  });

mcpCommand
  .command('clear')
  .description('登録を全部外す（取り消せない。既定は対話で確認する）')
  .option('--yes', '確認を飛ばす（スクリプト・CI 向け。端末でなければ必須）')
  .action(async (options: { yes?: boolean }) => {
    await mcpClearCommand(options);
  });

/**
 * `alteroid credential` — マネージャーへ降ろす環境変数（名前→値の袋）。
 *
 * **器（`compose.yaml` の環境変数 / Railway の Shared Variables）を焼き直す
 * 代わりの口である。** 正本は記憶ストアなので、器を作り直しても runner が名乗り
 * 直したときに降り直す。
 */
const credentialCommand = program
  .command('credential')
  .description('マネージャーへ降ろす環境変数（GH_TOKEN / GIT_AUTHOR_NAME など）を見る・置く');

credentialCommand
  .command('list')
  .description('正本に置かれた名前と指紋を一覧する（値は出さない）')
  .action(async () => {
    await credentialListCommand();
  });

credentialCommand
  .command('set <名前>')
  .description('1つ置く（英大文字・数字・_ の名前。既に在れば入れ替える）')
  .option('-f, --file <path>', '値を読むファイル（省略か - で標準入力）')
  .option(
    '--scope <all|app|runner>',
    '撒く先。all=共通(既定) / app=clone だけ / runner=manager だけ。' +
      '既存行の更新では省略すると前回の値を引き継ぐ',
  )
  .option(
    '--secret',
    '値をシークレット扱いにする（既定。新規行にのみ効く。API/CLI/Web UI で値を返さない）',
  )
  .option(
    '--no-secret',
    '値を非シークレット扱いにする（新規行にのみ効く。API/CLI/Web UI でそのまま見える）',
  )
  .option('--yes', '確認を飛ばす（スクリプト・CI 向け。端末でなければ必須）')
  .addHelpText(
    'after',
    '\n値はコマンドライン引数では受け取りません（argv は同じ器の他のプロセスから' +
      '見えるため）。ファイルか標準入力から渡してください:\n' +
      '  alteroid credential set GH_TOKEN -f ./pat.txt\n' +
      '  echo -n "$GH_TOKEN" | alteroid credential set GH_TOKEN\n' +
      '\n非シークレットな設定値の例（TZ 等）:\n' +
      '  echo -n "Asia/Tokyo" | alteroid credential set TZ --scope app --no-secret\n' +
      '\n⚠ シークレット可否は作成時に決まり、後から変更できません。\n' +
      '\nCLAUDE_CODE_OAUTH_TOKEN はここへは置けません（正本はプールの側です）:\n' +
      '  alteroid token add --label <名前> -f <path>\n',
  )
  .action(
    async (
      name: string,
      options: { file?: string; scope?: string; secret?: boolean; yes?: boolean },
    ) => {
      await credentialSetCommand(name, options);
    },
  );

credentialCommand
  .command('remove <名前>')
  .description('1つ外す（runner の器からも消す。取り消せない。既定は対話で確認する）')
  .option('--yes', '確認を飛ばす（スクリプト・CI 向け。端末でなければ必須）')
  .action(async (name: string, options: { yes?: boolean }) => {
    await credentialRemoveCommand(name, options);
  });

/**
 * 認証トークンのプール（Issue #393「PR1 プールの器」）。**回さない。**
 *
 * 枠に当たったときに人間が登録した候補へ回すための器を、ここから覗く・並べる・
 * 外す。検知・切替はここには無い（デーモンの中の回し手が持つ）。
 */
const tokenCommand = program
  .command('token')
  .description('認証トークンのプール（枠に当たったときに回す候補）を見る・書き換える');

tokenCommand
  .command('list')
  .description('登録済みのトークンを一覧する（label・指紋・状態。値は出さない）')
  .action(async () => {
    await tokenListCommand();
  });

tokenCommand
  .command('add')
  .description('トークンを1本足す')
  .requiredOption('-l, --label <名前>', '人間が読む名前（秘密ではない）')
  .option('-f, --file <path>', '値を読むファイル（省略か - で標準入力）')
  .addHelpText(
    'after',
    '\n値はコマンドライン引数では受け取りません（argv は同じ器の他のプロセスから' +
      '見えるため）。ファイルか標準入力から渡してください:\n' +
      '  alteroid token add --label work -f ./token.txt\n' +
      '  echo -n "$TOKEN" | alteroid token add --label work\n',
  )
  .action(async (options: { label: string; file?: string }) => {
    await tokenAddCommand(options);
  });

tokenCommand
  .command('remove <id>')
  .description('トークンを1本消す（取り消せない。既定は対話で確認する）')
  .option('--yes', '確認を飛ばす（スクリプト・CI 向け。端末でなければ必須）')
  .action(async (id: string, options: { yes?: boolean }) => {
    await tokenRemoveCommand(id, options);
  });

tokenCommand
  .command('disable <id>')
  .description('トークンを人間の判断で外す（戻すには enable）')
  .action(async (id: string) => {
    await tokenDisableCommand(id);
  });

tokenCommand
  .command('enable <id>')
  .description('外したトークンを戻す')
  .action(async (id: string) => {
    await tokenEnableCommand(id);
  });

tokenCommand
  .command('remove-unreadable <ids...>')
  .description(
    '読めないトークンの行を id を指して消す（token list の「読めない行」の id。' +
      'add / remove などの書き換えは、読めない行を持ち越す）',
  )
  .option('--yes', '確認を飛ばす（スクリプト・CI 向け。端末でなければ必須）')
  .action(async (ids: string[], options: { yes?: boolean }) => {
    await tokenRemoveUnreadableCommand(ids, options);
  });

tokenCommand
  .command('policy [rotateOn]')
  .addHelpText('after', HELP_EXAMPLES.tokenPolicy)
  .description(
    '回す契機・冷却の既定を見る（引数無し）／変える（free_exhausted|overage_exhausted|off）',
  )
  .option('--cooldown-ms <N>', '枠が戻る時刻が取れないときの冷却の既定（ミリ秒）')
  .action(async (rotateOn: string | undefined, options: { cooldownMs?: string }) => {
    await tokenPolicyCommand(rotateOn, options);
  });

const daemonCommand = program.command('daemon').description('常駐デーモンの操作');

daemonCommand
  .command('start')
  .description('デーモンを起こす')
  .option(
    '--force',
    '本人確認できない（unknown）状態ファイルを退避してから起こし直す（二重起動の危険を引き受ける）',
  )
  .action(async (options: { force?: boolean }) => {
    await daemonStartCommand(options);
  });

daemonCommand
  .command('stop')
  .description('デーモンを止める')
  .action(async () => {
    await daemonStopCommand();
  });

daemonCommand
  .command('status')
  .description('デーモンの状態を見る')
  .action(async () => {
    await daemonStatusCommand();
  });

/**
 * `alteroid integration` — 連携の鍵（外のサービスへ渡す、固定の1つの source で外部イベントを
 * 送れる鍵。#3113 段2）。Web UI の `/integrations` と同じ3本の口を打つ。
 */
const integrationCommand = program
  .command('integration')
  .description(
    '連携の鍵（外のサービスが外部イベントを送るための鍵）を一覧・発行・失効する（読めない行は remove-unreadable で消す）',
  );

integrationCommand
  .command('list')
  .description('連携の鍵を並べる（名前・source・状態・期限・最終使用。値は出ない）')
  .action(async () => {
    await integrationListCommand();
  });

integrationCommand
  .command('create')
  .addHelpText('after', HELP_EXAMPLES.integrationCreate)
  .description('連携の鍵を発行する（値はこの1回だけ表示される）')
  .requiredOption('--name <名前>', '見分けるための名前')
  .requiredOption('--source <source>', '送れる唯一の source（^[a-z0-9._-]{1,64}$）')
  .option('--expires <日時か期間>', '期限（例: 2027-01-01T00:00:00Z / 30d / 12h）。省略は無期限')
  .option('--max-body-bytes <N>', '本文の上限バイト（既定 1048576）')
  .option('--rate-per-minute <N>', '1分あたりの回数の上限（既定 60）')
  .option(
    '--json',
    '整形せず、デーモンが返した JSON（key と value）だけを標準出力へ出す。警告は標準エラーへ（値はログに残さないこと）',
  )
  .action(
    async (options: {
      name: string;
      source: string;
      expires?: string;
      maxBodyBytes?: string;
      ratePerMinute?: string;
      json?: boolean;
    }) => {
      await integrationCreateCommand(options);
    },
  );

integrationCommand
  .command('revoke')
  .description('連携の鍵を失効させる（取り消せない。既定で確認する）')
  .argument('<id>', '鍵の id（alteroid integration list で見る）')
  .option('--yes', '確認を飛ばす（スクリプト・CI 向け。端末でなければ必須）')
  .action(async (id: string, options: { yes?: boolean }) => {
    await integrationRevokeCommand(id, options);
  });

integrationCommand
  .command('remove-unreadable <ids...>')
  .description(
    '読めない連携の鍵の行を id を指して消す（id は alteroid integration list の「読めない連携の鍵の行」に出る。' +
      'integration revoke は読めない行に触れない。id が取れない行はこの口では消せない）',
  )
  .option('--yes', '確認を飛ばす（スクリプト・CI 向け。端末でなければ必須）')
  .action(async (ids: string[], options: { yes?: boolean }) => {
    await integrationRemoveUnreadableCommand(ids, options);
  });

/**
 * ワークスペースのリセット（「トークン情報以外を全部消す」）。
 *
 * **既定では対話で確認する**（`resetCommand` の doc）。`--yes` はスクリプト・
 * CI から呼ぶための脱出口——確認そのものを無くすのではなく、確認の主体を
 * 対話の相手から呼び出し側へ移すだけである。**端末でなく `--yes` も無ければ、実行せずに
 * 断る**（#3200。他の取り消せない操作の `confirmIrreversible` と同じ）。
 */
program
  .command('reset')
  .description('ワークスペースをリセットする（トークン情報以外を全部消す。取り消せない）')
  .option('--yes', '確認を飛ばす（スクリプト・CI 向け。端末でなければ必須）')
  .action(async (options: { yes?: boolean }) => {
    await resetCommand(options);
  });

/**
 * 入口の最上位が、コマンドの失敗（投げられた例外）を stderr に1行で言い、終了コードを返す。
 *
 * 終了コードは**失敗なら 1**（`daemon stop` が止まらなかったときの `process.exitCode = 1`〔#3140〕と
 * 同じ値）。戻せない操作の確認で使い手がやめた（`ConfirmDeclinedError`、#3450）ときも同じ 1 で、
 * 「何もしなかった」をスクリプトが成功と区別できる。テストから argv 経由で測れるよう切り出してある。
 */
export function reportCliFailure(error: unknown): number {
  process.stderr.write(`alteroid: ${describeCliFailure(error)}\n`);
  return 1;
}

/**
 * 直接起動されたときだけ parseAsync を走らせる。
 *
 * `apps/runner/src/index.ts` / `apps/daemon/src/index.ts` と同じ形（既存の
 * 先例）。**これが無いと、この module をテストのために import しただけで
 * `program.parseAsync(process.argv)` が走ってしまう** — vitest の argv を
 * commander が解釈することになり、テスト実行そのものが壊れる。
 * `import.meta.url` は realpath 済み・パーセントエンコード済みなので、
 * `argv[1]` を素の文字列と比べると空白入りパスや symlink で誤判定する
 * （`apps/daemon/src/index.ts` の同名関数の doc と同じ理由）。
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  // 引数なし かつ stdin/stdout がともに TTY のときだけ TUI。そうでなければ従来どおり（help）。
  const run = opensTuiByDefault(process.argv.slice(2), process.stdin, process.stdout)
    ? launchTui()
    : program.parseAsync(process.argv);
  run.catch((error: unknown) => {
    process.exit(reportCliFailure(error));
  });
}
