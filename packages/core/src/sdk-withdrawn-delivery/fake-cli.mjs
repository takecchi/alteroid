#!/usr/bin/env node
// 偽 CLI（Issue #1586 / PR #1596 の前提を測るための足場）。
//
// `@anthropic-ai/claude-agent-sdk` の `query()` に `pathToClaudeCodeExecutable`
// として渡すと、SDK は本物の CLI バイナリの代わりにこのスクリプトを
// `node <このファイル>` として起こす（`sdk.mjs` の `spawnLocalProcess` が
// `pathToClaudeCodeExecutable` を直接 exec できないときに取るフォールバック。
// 実測: このファイルに実行ビットを立てていなくても動く）。
//
// stream-json の control プロトコルを最小限だけ話す:
//  1. SDK が最初に送ってくる control_request(subtype=initialize) に success で答える
//  2. こちらから control_request(subtype=can_use_tool) を1回送る（Bash の許可確認を模す）
//  3. SDK 側の canUseTool コールバックが返す答えが control_response として
//     戻ってくるかどうかを、stdin の受信記録から判定する（届けば記録に残る）
//
// 受け取った行はすべて `FAKE_CLI_LOG` へ1行ずつ同期で追記する
// （`fs.appendFileSync` — 読み手（テスト側）が読みに来た時点で必ずディスクに
// 出ていることを、非同期バッファリングに頼らず保証するため）。
//
// **このプロセスは stdin の EOF（＝ SDK の `close()` が `processStdin.end()`
// を呼んだ合図）を受けたら、そこで自分から終わる。** 本物の SDK の
// `close()` は stdin を閉じてから2秒待って生きていれば SIGTERM、さらに
// 5秒待って SIGKILL という「やわらかい停止」を取るが（Issue #1533 の実測）、
// この足場はそれに付き合わない——`STDIN_END` をログへ書いてすぐ
// `process.exit(0)` する。**この終わり方は測っている前提（cleanupPerformed
// の窓）とは無関係である** — 答えが書き込まれるかどうかは「もう書かない」と
// 決まる瞬間（`cleanupPerformed` が立つ瞬間、SDK 側の同期処理）で確定して
// おり、CLI 側のプロセスがいつ死ぬかには依存しない（届く経路では、届いた
// 後にいつ死のうと結果は変わらない）。
//
// **固定寿命（`FAKE_CLI_EXIT_AFTER_MS`）はぶら下がり防止の保険としてだけ
// 残す。** 既定を長く取ってある（15000ms）——CI が混んでいて起動や SDK の
// 初期化が遅れても、stdin end より先にこの保険が発火してしまわないように
// する。**もしこの保険で終わったら `EXIT_BY_LIFETIME` をログへ書く**——
// これが出た回は「stdin end で終わった」という前提そのものが崩れているので、
// 読み手（テスト側）はそれを「届いていない」の証拠として使わず、足場が
// 壊れていると読むこと。
//
// 環境変数:
//  FAKE_CLI_LOG           - 受信・送信した行を1行ずつ追記するファイル（必須）
//  FAKE_CLI_ASK_REQUEST_ID - 送る can_use_tool の request_id（既定 'ask-1'）
//  FAKE_CLI_ASK_DELAY_MS   - initialize 応答後、can_use_tool を送るまでの遅延（既定 0）
//  FAKE_CLI_EXIT_AFTER_MS  - 保険の寿命（既定 15000。stdin end で先に終わるのが正常系）

import fs from 'node:fs';
import process from 'node:process';
import readline from 'node:readline';
import { setTimeout } from 'node:timers';

const logPath = process.env.FAKE_CLI_LOG;
if (!logPath) {
  process.stderr.write('FAKE_CLI_LOG is required\n');
  process.exit(2);
}

function log(line) {
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
}

function send(obj) {
  const line = JSON.stringify(obj);
  log(`SEND ${line}`);
  process.stdout.write(`${line}\n`);
}

log(`PID ${process.pid}`);

const askRequestId = process.env.FAKE_CLI_ASK_REQUEST_ID ?? 'ask-1';
const askDelayMs = Number(process.env.FAKE_CLI_ASK_DELAY_MS ?? '0');
const exitAfterMs = Number(process.env.FAKE_CLI_EXIT_AFTER_MS ?? '15000');

const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });

let sentAsk = false;
function sendAskOnce() {
  if (sentAsk) return;
  sentAsk = true;
  // **読み手（テスト側）が「ask を送った」ことを、生の control_request の
  // JSON を解かずに確かめられるようにする専用のマーカー行。**
  log(`ASK_SENT request_id=${askRequestId}`);
  send({
    type: 'control_request',
    request_id: askRequestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'echo hi' },
      permission_suggestions: [],
    },
  });
}

rl.on('line', (line) => {
  log(`RECV ${line}`);
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    log(`PARSE_ERROR ${String(e)}`);
    return;
  }

  if (msg.type === 'control_request' && msg.request?.subtype === 'initialize') {
    send({
      type: 'control_response',
      response: { subtype: 'success', request_id: msg.request_id, response: {} },
    });
    if (askDelayMs > 0) setTimeout(sendAskOnce, askDelayMs);
    else sendAskOnce();
    return;
  }

  // それ以外の control_request（interrupt 等）にも一応 success を返す。
  if (msg.type === 'control_request') {
    send({
      type: 'control_response',
      response: { subtype: 'success', request_id: msg.request_id, response: {} },
    });
    return;
  }

  if (msg.type === 'control_response') {
    log(
      `GOT_CONTROL_RESPONSE request_id=${msg.response?.request_id} subtype=${msg.response?.subtype} raw=${JSON.stringify(msg)}`,
    );
  }
});

// **正常系の終わり方。** SDK の close() が stdin を閉じた合図（EOF）を
// 受けたら、ここでログへ書いてすぐ終わる——本物の SDK の「やわらかい停止」
// （2秒+5秒）を待たない（ファイル冒頭の doc）。
process.stdin.on('end', () => {
  log('STDIN_END');
  process.exit(0);
});

process.on('exit', (code) => {
  log(`EXIT code=${code}`);
});

process.on('SIGTERM', () => {
  log('SIGTERM');
  process.exit(0);
});

// **保険（ぶら下がり防止）だけの寿命。** 正常系では stdin end が先に効いて
// ここには来ない——来たら「stdin end で終わった」という前提が崩れている
// ということなので、読み手が区別できるようマーカーを変える（ファイル冒頭の
// doc）。
setTimeout(() => {
  log('EXIT_BY_LIFETIME');
  process.exit(0);
}, exitAfterMs);
