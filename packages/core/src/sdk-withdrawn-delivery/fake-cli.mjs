#!/usr/bin/env node
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

// 寿命の既定を短くしない: CI が混んで起動が遅れると、stdin end より先にこの保険が発火してしまうため
setTimeout(() => {
  log('EXIT_BY_LIFETIME');
  process.exit(0);
}, exitAfterMs);
