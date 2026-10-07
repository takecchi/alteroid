import { stdout } from './terminal-out.js';

import {
  describeDroppedTraceEmpty,
  describeDroppedTraceOrigin,
  describeDroppedTraceRetention,
} from '@alteroid/core/cli-light';
import type { DroppedTraceOrigin } from '@alteroid/core';

import { createClient } from './client.js';
import { withErrorReason } from './format.js';
import { describeAuthFailure, resolveTarget } from './target.js';

export async function droppedCommand(): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.dropped.$get();
  // 404 を 0 件と同じ文言にしない: 跡が無いのではなくデーモンの版が古いため
  if (response.status === 404) {
    throw new Error(
      'このデーモンには GET /dropped が無い（版が古い可能性がある。' +
        'alteroid daemon stop && alteroid chat でデーモンを更新してください）',
    );
  }
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `握り潰しの跡を読めませんでした（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  stdout.write(`${renderDropped(await response.json())}\n`);
}

export interface DroppedView {
  origin: DroppedTraceOrigin;
  since: string;
  limit: number;
  total: number;
  traces: readonly string[];
}

export function renderDropped(view: DroppedView): string {
  const lines: string[] = [
    describeDroppedTraceOrigin(view.origin),
    '',
    `帳面が数え始めた時刻: ${view.since}`,
    `件数: ${view.total}（${describeDroppedTraceRetention(view.limit)}）`,
    '',
  ];
  if (view.total === 0) {
    lines.push(describeDroppedTraceEmpty());
    return lines.join('\n');
  }
  lines.push(...view.traces);
  return lines.join('\n');
}
