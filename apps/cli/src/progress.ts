import { stdout } from 'node:process';

import { describeProgress } from '@alteroid/core';

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
 * 失敗の扱い: 400（`windowHours` の形が不正）は daemon の文言をそのまま例外で上へ通す
 * （`index.ts` の `parseAsync(...).catch(...)` が stderr へ出して終了コード 1）。
 * それ以外は既存の読み取り系（`dropped.ts` など）に揃えて stdout へ書いて戻る。
 */

export interface ProgressOptions {
  /** 素の文字列のまま daemon へ渡す。検査は daemon の 400 に任せる（二重に持たない）。 */
  windowHours?: string;
}

export async function progressCommand(options: ProgressOptions = {}): Promise<void> {
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
          ? '進捗を読めませんでした（windowHours の形が不正です）'
          : redactError(errorBody.error),
      );
    }
    const described = describeAuthFailure(response.status, target);
    stdout.write(`${described ?? `進捗を読めませんでした（HTTP ${String(response.status)}）`}\n`);
    return;
  }
  const body = await response.json();
  stdout.write(`${describeProgress(body)}\n`);
}
