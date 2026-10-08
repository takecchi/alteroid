import { stderr, stdout } from './terminal-out.js';

import { createClient } from './client.js';
import { withErrorReason } from './format.js';
import { redactBody, redactError } from './redact.js';
import { describeAuthFailure, resolveTarget } from './target.js';
import { readSSE } from './tui/sse.js';

export interface TopologyView {
  observedAt: string;
  clone: { state: string; turn?: { conversationId?: string; kind: string } };
  storage: { label?: string; state: string; checkedAt?: string; error?: string };
  runners: { label: string; runnerId?: string; state: string; since: string }[];
  managers: {
    managerId: string;
    status: string;
    live: boolean;
    runnerId?: string;
    runnerListedAt?: string;
    usageStoppedAt?: string;
    request: string;
    startedAt: string;
    updatedAt: string;
    lastReportAt?: string;
    waiting: { requestId: string; kind?: string; summary: string; askedAt?: string }[];
    waitingOmitted?: number;
    awaitingBackground?: {
      tasks: number;
      withheldReports: number;
      breakdown: string;
      since: string;
    };
    workers: {
      agentType: string;
      lastTool?: string;
      lastToolAt?: string;
      runningTool?: { tool: string; startedAt: string };
    }[];
  }[];
  managersOmitted?: number;
  unreadable?: { id?: string; reason: string }[];
  links: { key: string; lastDownAt?: string; lastUpAt?: string; lastActivityAt?: string }[];
}

export function formatAge(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '経過不明';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${String(seconds)}秒前`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}分前`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))}時間前`;
  return `${String(Math.floor(seconds / 86_400))}日前`;
}

// 無い向きを 0 や「流れていない」にしない: 観測していないだけのため
function renderLink(
  link: TopologyView['links'][number] | undefined,
  labels: { down: string; up: string; activity?: string },
  now: number,
): string {
  const part = (label: string, at: string | undefined): string =>
    `${label} ${at === undefined ? '—（未観測）' : formatAge(at, now)}`;
  const parts = [
    part(`↓ ${labels.down}`, link?.lastDownAt),
    part(`↑ ${labels.up}`, link?.lastUpAt),
  ];
  if (labels.activity !== undefined) {
    parts.push(part(`・ ${labels.activity}`, link?.lastActivityAt));
  }
  return parts.join('   ');
}

function renderClone(clone: TopologyView['clone']): string {
  const turn =
    clone.turn === undefined
      ? ''
      : `（${clone.turn.kind}${clone.turn.conversationId === undefined ? '' : `・会話 ${clone.turn.conversationId}`}）`;
  const note = clone.state === 'unknown' ? '（この器はターンの有無を答えられない）' : '';
  return `${clone.state}${turn}${note}`;
}

function renderStorage(storage: TopologyView['storage'], now: number): string {
  const label = storage.label === undefined ? '' : `${storage.label}: `;
  const checked =
    storage.checkedAt === undefined ? '' : `（${formatAge(storage.checkedAt, now)}に確認）`;
  const error = storage.error === undefined ? '' : `  理由: ${redactError(storage.error)}`;
  const note =
    storage.state === 'unknown' ? '（確かめる手段が無い、またはまだ確かめていない）' : '';
  return `${label}${storage.state}${checked}${note}${error}`;
}

function usageStoppedNote(usageStoppedAt: string, status: string, now: number): string {
  const head = `        ⚠ 枠(利用上限)で止まっている（${usageStoppedAt} から・${formatAge(usageStoppedAt, now)}）。`;
  if (status === 'failed' || status === 'lost' || status === 'stopped') {
    return `${head}ただし status: ${status}——既に終端している。「鍵が回れば続く」は成り立たない。`;
  }
  return `${head}セッションは生きているので、鍵が回ればこの委譲は続く。`;
}

export function renderTopology(view: TopologyView, now: number = Date.now()): string {
  const linkOf = (key: string) => view.links.find((link) => link.key === key);
  const lines: string[] = [
    `稼働の地図（${formatAge(view.observedAt, now)}に観測 / ${view.observedAt}）`,
    '',
    '人間',
    `  └ ${renderLink(linkOf('human~clone'), { down: '発言', up: '応答' }, now)}`,
    `クローン [${renderClone(view.clone)}]`,
    `  ├ 記憶 [${renderStorage(view.storage, now)}]`,
    `  │   ${renderLink(linkOf('clone~storage'), { down: '書き込み', up: '読み出し' }, now)}`,
  ];

  if (view.runners.length === 0) {
    lines.push('  ├ runner: 名簿に載っていない');
  } else {
    for (const runner of view.runners) {
      lines.push(
        `  ├ runner ${runner.runnerId ?? runner.label} [${runner.state}] ${formatAge(runner.since, now)}からこの状態`,
      );
      if (
        runner.runnerId !== undefined &&
        (runner.state === 'connected' || runner.state === 'vacating') &&
        !view.managers.some((manager) => manager.runnerId === runner.runnerId)
      ) {
        lines.push('  │   └ マネージャー: 走っているマネージャーはいません');
      }
    }
  }

  if (view.managers.length === 0) {
    lines.push(
      '  └ マネージャー: 走行中・返事待ち・直近10分に終わった委譲は無い（runner の上に居ると観測できた委譲も無い）',
    );
  } else {
    lines.push(`  └ マネージャー（${String(view.managers.length)} 本）`);
    const liveRunnerIds = new Set(
      view.runners
        .filter((r) => r.state === 'connected' || r.state === 'vacating')
        .flatMap((r) => (r.runnerId === undefined ? [] : [r.runnerId])),
    );
    for (const manager of view.managers) {
      const live = manager.live ? 'live' : 'not live';
      lines.push(
        `      ${manager.managerId} [${manager.status}・${live}]  ${redactBody(manager.request)}`,
      );
      lines.push(
        manager.runnerId !== undefined && liveRunnerIds.has(manager.runnerId)
          ? `        器: ${manager.runnerId}`
          : '        器: 分からない（生きた runner の一覧と突き合わない）',
      );
      lines.push(
        `        ${renderLink(
          linkOf(`clone~manager:${manager.managerId}`),
          { down: '指示', up: '報告・確認' },
          now,
        )}`,
      );
      if (manager.usageStoppedAt !== undefined) {
        lines.push(usageStoppedNote(manager.usageStoppedAt, manager.status, now));
      }
      if (manager.awaitingBackground !== undefined) {
        const { tasks, breakdown, since } = manager.awaitingBackground;
        lines.push(
          `        完了待ち: 背景処理 ${String(tasks)} 件${breakdown === '' ? '' : `（${breakdown}）`}（${formatAge(since, now)}から）`,
        );
      }
      if (
        manager.runnerListedAt !== undefined &&
        manager.status !== 'running' &&
        manager.status !== 'waiting_human'
      ) {
        lines.push(
          `        runner の一覧に載っている（観測 ${formatAge(manager.runnerListedAt, now)}）`,
        );
      }
      if (manager.lastReportAt !== undefined) {
        lines.push(`        最後の報告 ${formatAge(manager.lastReportAt, now)}`);
      }
      for (const waiting of manager.waiting) {
        const asked =
          waiting.askedAt === undefined ? '' : `（${formatAge(waiting.askedAt, now)}から）`;
        lines.push(
          `        返事待ち ${waiting.kind ?? '種別不明'}${asked}: ${redactBody(waiting.summary)}`,
        );
      }
      if (manager.waitingOmitted !== undefined) {
        lines.push(
          `        …ほか返事待ち ${String(manager.waitingOmitted)} 件は省略（全件は GET /managers）`,
        );
      }
      for (const worker of manager.workers) {
        const tool =
          worker.lastTool === undefined || worker.lastToolAt === undefined
            ? '道具の実行はまだ観測していない'
            : `最後の道具 ${worker.lastTool}（${formatAge(worker.lastToolAt, now)}）`;
        lines.push(`        作業者 ${worker.agentType}（種類ごとに束ねた1行）: ${tool}`);
        if (worker.runningTool !== undefined) {
          lines.push(
            `          実行中の道具 ${worker.runningTool.tool}（開始 ${formatAge(worker.runningTool.startedAt, now)}）`,
          );
        }
        lines.push(
          `          ${renderLink(
            linkOf(`manager:${manager.managerId}~worker:${worker.agentType}`),
            { down: '背景で起動', up: '結果が戻った', activity: '活動' },
            now,
          )}`,
        );
      }
    }
    if (view.managersOmitted !== undefined) {
      lines.push(
        `      …ほか ${String(view.managersOmitted)} 本は文字数の予算で省略（全件は GET /managers）`,
      );
    }
  }

  if (view.unreadable !== undefined && view.unreadable.length > 0) {
    lines.push(
      '',
      `⚠️ 台帳から読めなかった委譲の行が ${String(view.unreadable.length)} 件ある。上の一覧には数えていない（「居ない」とは限らない）。`,
    );
    for (const row of view.unreadable) {
      lines.push(`    ${row.id ?? '（id 不明）'}: ${redactError(row.reason)}`);
    }
    lines.push('    詳細は GET /managers の unreadable');
  }

  lines.push(
    '',
    '（作業者は managerId × agentType で束ねた行で、個体は見分けない。' +
      '作業者の線の ↓ は背景で起こした時刻、↑ は前景の呼び出しが終わって結果が戻った時刻。' +
      '前景で起こした瞬間は日誌に載らない）',
  );
  return lines.join('\n');
}

export interface TopologyOptions {
  json?: boolean;
  watch?: boolean;
}

const CLEAR_SCREEN = '\u001b[2J\u001b[H';

export async function topologyCommand(options: TopologyOptions = {}): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    // `--json` の案内を標準出力へ出さない: `| jq` へ渡せなくなるため
    if (options.json === true) stderr.write(`${target.note}\n`);
    else stdout.write(`${target.note}\n`);
    return;
  }

  if (options.watch === true) {
    await watchTopology(target, options.json === true);
    return;
  }

  const client = createClient(target.baseUrl, target.headers);
  const response = await client.topology.$get();
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `稼働の地図を読めませんでした（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  const view = await response.json();
  if (options.json === true) {
    stdout.writeRaw(`${JSON.stringify(view, null, 2)}\n`);
    return;
  }
  stdout.write(`${renderTopology(view as TopologyView)}\n`);
}

async function watchTopology(
  target: Awaited<ReturnType<typeof resolveTarget>>,
  json: boolean,
): Promise<void> {
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);

  let latest: TopologyView | null = null;
  let notice: string | null = null;
  const tty = stdout.isTTY === true;
  const paint = (): void => {
    if (latest === null) return;
    const warning = notice === null ? '' : `\n${notice}`;
    // 画面消去は掃除せずに書く: 自前の制御列のため
    if (tty) stdout.writeRaw(CLEAR_SCREEN);
    stdout.write(`${renderTopology(latest)}${warning}\n${tty ? '' : '\n'}`);
  };
  const ticker = !json && tty ? setInterval(paint, 1000) : null;

  try {
    let response: Response;
    try {
      response = await fetch(`${target.baseUrl}/topology/stream`, {
        method: 'GET',
        headers: { ...target.headers, 'content-type': 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      throw new Error(`稼働の地図の購読: デーモンに繋がりません（${redactError(String(error))}）`, {
        cause: error,
      });
    }
    if (!response.ok || response.body === null) {
      const described = describeAuthFailure(response.status, target);
      if (described !== null) throw new Error(described);
      throw new Error(
        await withErrorReason(
          `稼働の地図の購読に失敗しました（HTTP ${String(response.status)}）`,
          response,
        ),
      );
    }
    try {
      for await (const event of readSSE(response.body)) {
        if (event.name === 'unavailable') {
          const body = event.json<{ error?: unknown }>();
          const kind = typeof body?.error === 'string' ? body.error : 'unknown';
          if (json) {
            stdout.writeRaw(`${JSON.stringify({ type: 'unavailable', error: kind })}\n`);
          } else {
            notice = `⚠️ デーモンが地図を組めていない（理由の種別: ${redactError(kind)}）。復旧すると続きを描く。`;
            if (latest === null) stdout.write(`${notice}\n`);
            else paint();
          }
          continue;
        }
        if (event.name !== 'snapshot') continue;
        const view = event.json<TopologyView>();
        if (view === null) continue;
        notice = null;
        latest = view;
        if (json) stdout.writeRaw(`${JSON.stringify(view)}\n`);
        else paint();
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      throw new Error(`稼働の地図の購読: 接続が切れました（${redactError(String(error))}）`, {
        cause: error,
      });
    }
    if (!controller.signal.aborted) {
      throw new Error('稼働の地図の購読: デーモンが接続を閉じました');
    }
  } finally {
    if (ticker !== null) clearInterval(ticker);
    process.off('SIGINT', onSigint);
  }
}
