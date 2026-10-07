import { stdout } from './terminal-out.js';

import { describeProgress } from '@alteroid/core/cli-light';

import { createClient } from './client.js';
import { describeAuthFailure, resolveTarget } from './target.js';
import { redactError } from './redact.js';

export interface ProgressOptions {
  windowHours?: string;
}

export async function progressCommand(options: ProgressOptions = {}): Promise<void> {
  if (options.windowHours !== undefined) {
    const hours = Number(options.windowHours);
    if (options.windowHours.trim() === '' || !Number.isFinite(hours) || hours <= 0) {
      throw new Error(
        `--window-hours は正の数（時間）で指定する（渡されたのは ${options.windowHours}。例: --window-hours 5）`,
      );
    }
  }
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.progress.$get({
    query: options.windowHours === undefined ? {} : { windowHours: options.windowHours },
  });
  if (!response.ok) {
    if (response.status === 400) {
      // daemon の断り文言を言い換えない: daemon 側が変わったときここだけ古くなるため
      const errorBody = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(
        errorBody.error === undefined
          ? '進捗を読めませんでした（--window-hours の形が不正です。正の数（時間）で指定する）'
          : redactError(errorBody.error).replaceAll('windowHours', '--window-hours'),
      );
    }
    const described = describeAuthFailure(response.status, target);
    throw new Error(described ?? `進捗を読めませんでした（HTTP ${String(response.status)}）`);
  }
  const body = await response.json();
  stdout.write(`${describeProgress(body)}\n`);
}
