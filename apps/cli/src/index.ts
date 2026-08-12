#!/usr/bin/env node
import { stdout } from 'node:process';

import { initWorkspace } from '@alteroid/storage-fs';
import { Command } from 'commander';

import { chatCommand } from './chat.js';
import * as daemon from './daemon.js';
import { alteroidRoot } from './paths.js';

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
    const stopped = await daemon.stop();
    stdout.write(stopped ? 'alteroidd を停止しました\n' : 'alteroidd は動いていません\n');
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
    stdout.write(`  記憶: ${alteroidRoot()}\n`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`alteroid: ${String(error)}\n`);
  process.exit(1);
});
