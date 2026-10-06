import { stdout } from 'node:process';

import { describeProgress } from '@alteroid/core/cli-light';

import { createClient } from './client.js';
import { describeAuthFailure, resolveTarget } from './target.js';
import { redactError } from './redact.js';

/**
 * `alteroid progress` — 作業の進捗（積み上がり・実施中・窓の中の消化・見込み）を読む
 * （Issue #2241 の 3）。
 *
 * 経路は `GET /progress` の1本だけ（`apps/daemon/src/app.ts`「経路は1本だけにする」）。
 *
 * **数え直さない・作らない。** 数は daemon（core の `summarizeProgress`）が出したものを
 * そのまま並べる。ここで足し直したり、率（%）を作ったりしない——台帳に総量が無く
 * 分母が定まらないので、率は嘘になる。**取れないものは 0 と書かない**（`null` は「—」、
 * 見込みが `unavailable` / `not_converging` なら状態と理由を言って、時間は作らない）。
 *
 * 失敗の扱い: 400（daemon が断る範囲外）は daemon の文言（欄名は --window-hours に打ち替える）を例外で上へ通す
 * （`index.ts` の `parseAsync(...).catch(...)` が stderr へ出して終了コード 1）。
 * それ以外（401・403・500 など）も同じく例外で上へ通す（#3446。`usage.ts` と同じ）。
 */

export interface ProgressOptions {
  /** 利用者が打った文字列。形（正の数）はここで先に見て、daemon の 400（上限など）は欄名を打ち替えて出す。 */
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
      // daemon の断り文言をそのまま出す（言い換えると、daemon 側が変わったときここだけ古くなる）。
      const errorBody = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(
        errorBody.error === undefined
          ? '進捗を読めませんでした（--window-hours の形が不正です。正の数（時間）で指定する）'
          : redactError(errorBody.error).replaceAll('windowHours', '--window-hours'),
      );
    }
    // 失敗は例外で上へ通す（＝終了コードが 0 でなくなる。#3446）。
    const described = describeAuthFailure(response.status, target);
    throw new Error(described ?? `進捗を読めませんでした（HTTP ${String(response.status)}）`);
  }
  const body = await response.json();
  stdout.write(`${describeProgress(body)}\n`);
}
