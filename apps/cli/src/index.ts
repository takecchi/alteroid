#!/usr/bin/env node
import { stdout } from 'node:process';

import { initWorkspace } from '@alteroid/storage-fs';
import { Command } from 'commander';

import { accessGrantCommand, accessListCommand, accessRevokeCommand } from './access.js';
import { chatCommand } from './chat.js';
import * as daemon from './daemon.js';
import { loginCommand, logoutCommand, whoamiCommand } from './login.js';
import {
  profileClearCommand,
  profileEditCommand,
  profileSetCommand,
  profileShowCommand,
  profileStatusCommand,
} from './profile.js';
import { alteroidRoot } from './paths.js';
import { usageCommand } from './usage.js';

/**
 * alteroid — デーモンへの薄いクライアント。
 *
 * ここに脳は無い。core を CLI にも埋めると chat のたびにクローンが分岐する
 * （docs/architecture.md「脳は1インスタンス」）。init だけはデーモン起動前に
 * 動く必要があるので、ストレージ層（記憶の置き場を作るだけ）に直接触る。
 */
const program = new Command();

program.name('alteroid').description('クローンと会話し、クローンに仕事を任せる').version('0.1.0');

program
  .command('init')
  .description('人格データディレクトリ（~/.alteroid）を初期化する')
  .action(async () => {
    const { paths, created } = await initWorkspace();
    stdout.write(`${paths.root} を初期化しました\n`);
    for (const path of created) stdout.write(`  作成: ${path}\n`);
    if (created.length === 0)
      stdout.write('  （既に初期化済み。既存のファイルには触れていません）\n');
    stdout.write('\n次: alteroid chat\n');
  });

program
  .command('chat')
  .description('クローンと会話する（デーモンが居なければ起こす）')
  .action(async () => {
    await chatCommand();
  });

/**
 * 利用状況（いくら使ったか）。経路は `GET /usage` の1本だけで、chat の
 * `/usage` と Web UI の画面も同じものを見る（`apps/cli/src/usage.ts`）。
 */
program
  .command('usage')
  .description('alteroid が使った分（トークンと費用）を見る')
  .option('--from <date>', 'この日から（YYYY-MM-DD）')
  .option('--to <date>', 'この日まで（YYYY-MM-DD）')
  .option('--manager <id>', 'このマネージャーの分だけ')
  // **誰が・どこで の絞り込みは4つの口すべてに置く。** 片方にだけ足すと、そこに
  // しかできない分析が生まれる（PRD「インターフェース」）。
  .option('--layer <layer>', '誰が（clone / manager）')
  .option('--site <site>', 'どこで（session / distill）')
  .action(
    async (options: {
      from?: string;
      to?: string;
      manager?: string;
      layer?: string;
      site?: string;
    }) => {
      await usageCommand(options);
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
  .description('この端末に保存したアクセストークンを消す')
  .action(async () => {
    await logoutCommand();
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
  .description('誰が alteroid を使えるかを決める（実行環境の持ち主だけが操作できる）');

accessCommand
  .command('list')
  .description('ログインしたアカウントと許可の状態を見る')
  .action(async () => {
    await accessListCommand();
  });

accessCommand
  .command('grant <accountId>')
  .description('alteroid を使う許可を与える')
  .action(async (accountId: string) => {
    await accessGrantCommand(accountId);
  });

accessCommand
  .command('revoke <accountId>')
  .description('alteroid を使う許可を取り消す')
  .action(async (accountId: string) => {
    await accessRevokeCommand(accountId);
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
  .command('show')
  .description('いま置かれているプロファイルの本文を出す')
  .action(async () => {
    await profileShowCommand();
  });

profileCommand
  .command('status')
  .description('プロファイルが各層へ届いているかを見る（本文は出さない）')
  .action(async () => {
    await profileStatusCommand();
  });

profileCommand
  .command('edit')
  .description('$EDITOR で開いて書き換える（閉じたら反映）')
  .action(async () => {
    await profileEditCommand();
  });

profileCommand
  .command('set')
  .description('ファイル（または標準入力）の内容で丸ごと置き換える')
  .option('-f, --file <path>', '読み込むファイル（省略か - で標準入力）')
  .action(async (options: { file?: string }) => {
    await profileSetCommand(options);
  });

profileCommand
  .command('clear')
  .description('プロファイルを外す')
  .action(async () => {
    await profileClearCommand();
  });

const daemonCommand = program.command('daemon').description('常駐デーモンの操作');

daemonCommand
  .command('start')
  .description('デーモンを起こす')
  .action(async () => {
    const info = await daemon.start();
    stdout.write(`alteroidd を起動しました (pid ${info.pid}, port ${info.port})\n`);
  });

daemonCommand
  .command('stop')
  .description('デーモンを止める')
  .action(async () => {
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
        return;
    }
  });

daemonCommand
  .command('status')
  .description('デーモンの状態を見る')
  .action(async () => {
    const { running, info } = await daemon.status();
    if (running && info) {
      stdout.write(`稼働中: pid ${info.pid}, http://127.0.0.1:${info.port}\n`);
      stdout.write(`  起動: ${info.startedAt}\n`);
    } else {
      stdout.write('停止中\n');
    }
    // 記憶がどこにあるかは**デーモンに聞く**。クラウド構成では PostgreSQL に
    // あるので、CLI 側のパスを表示すると人間が器を取り違える。
    const storage = running ? await daemon.storageOf(info) : null;
    stdout.write(`  記憶: ${storage ?? alteroidRoot()}\n`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`alteroid: ${String(error)}\n`);
  process.exit(1);
});
