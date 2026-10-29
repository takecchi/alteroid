import { stdout } from './terminal-out.js';

import {
  describeDroppedTraceEmpty,
  describeDroppedTraceOrigin,
  describeDroppedTraceRetention,
} from '@alteroid/core/cli-light';
import type { DroppedTraceOrigin } from '@alteroid/core';

import { createClient } from './client.js';
import { describeFailedResponse } from './format.js';
import { redactBody } from './redact.js';
import { resolveTarget } from './target.js';

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
    throw new Error(
      await describeFailedResponse(
        `握り潰しの跡を読めませんでした（HTTP ${String(response.status)}）`,
        response,
        target,
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
  // 伏せる: 跡の行は理由の文を含むため（Web の握り潰しの跡と揃える）
  lines.push(...view.traces.map((trace) => redactBody(trace)));
  return lines.join('\n');
}
