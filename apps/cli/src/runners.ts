import { stdout } from './terminal-out.js';

import { describeRevisionStatus } from '@alteroid/core/cli-light';
import type {
  RunnerCredentialFingerprint,
  RunnerProfileFingerprint,
  RunnerPushHealth,
  RunnerPushOutcome,
  RunnerRevisionReport,
  RunnerRevisionStatus,
} from '@alteroid/core';

import { createClient } from './client.js';
import { formatElapsedAgo, withErrorReason } from './format.js';
import { describeAuthFailure, resolveTarget } from './target.js';
import { redactError } from './redact.js';

export async function runnersCommand(): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.runners.$get();
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `runner の一覧を読めませんでした（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  const now = Date.now();
  stdout.write(`${renderRunners(await response.json(), now)}\n`);
}

export async function runnersVacateCommand(runnerId: string): Promise<void> {
  const target = await resolveTarget();
  // 未ログインで何もせず 0 で返さない: 「空けた」と誤読されるため
  if (target.note !== null) throw new Error(target.note);
  const client = createClient(target.baseUrl, target.headers);
  // 名簿に無い runnerId は立てずに断る: デーモンは同じ 200 を返し、打ち間違いのまま台数を減らして空いていない器を落とすため
  const rosterResponse = await client.runners.$get();
  if (!rosterResponse.ok) {
    const described = describeAuthFailure(rosterResponse.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `runner の名簿を読めなかったので、runner ${runnerId} を空けると立てていません（HTTP ${String(rosterResponse.status)}）`,
        rosterResponse,
      ),
    );
  }
  const roster = await rosterResponse.json();
  if (!roster.runners.some((runner) => runner.runnerId === runnerId)) {
    throw new Error(
      `runner ${runnerId} は名簿に無いので、空けると立てていません（runnerId の打ち間違いかもしれません。` +
        '名簿は alteroid runners で見られます）。',
    );
  }
  const response = await client.runners.vacate.$post({ json: { runnerId } });
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `runner ${runnerId} を空けると立てられませんでした（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  stdout.write(
    `runner ${runnerId} を空けると立てた。まだ空き終わってはいない——` +
      '載っている委譲は確かめた停止を経て他の runner へ移る。' +
      '進捗は alteroid runners（state: vacating）と、委譲の runnerId が動いたかで追うこと。\n',
  );
  // `handshakeSkipped` を見る: HTTP は 200 のままで、名簿や一覧を読めなかったことが端末から見えないため
  const body: unknown = await response.json().catch(() => null);
  const skipped =
    typeof body === 'object' && body !== null && 'handshakeSkipped' in body
      ? body.handshakeSkipped
      : undefined;
  if (typeof skipped === 'object' && skipped !== null && 'message' in skipped) {
    stdout.write(
      `⚠️ 載っている委譲への握手は飛ばした（${String(skipped.message)}）——` +
        '同じコマンドを呼び直すと握手をやり直す。\n',
    );
  }
}

// 3状態を1つも潰さない: 「配られていない」のか「確かめられなかった」のかが端末から区別できなくなるため
type RunnerProbe =
  { status: 'asked' } | { status: 'unheard' } | { status: 'failed'; error: string };

// `daemonRevision` と runner の版を同じ型にしない: 自分の版は訊きに行く経路が無く、`unheard` が意味を持たないため
interface RunnersView {
  runners: {
    label: string;
    state: string;
    since: string;
    runnerId?: string;
    workspacePath?: string;
    error?: string;
    instanceId?: string;
    instanceSince?: string;
    // 空であることだけで「鍵が配られていない」と読まない: 叩けなかったときも空になるため
    credentials: RunnerCredentialFingerprint[];
    credentialsProbe: RunnerProbe;
    // 無いことだけで「置かれていない」と読まない: 叩けなかったときも省略されるため
    profile?: RunnerProfileFingerprint;
    profileProbe: RunnerProbe;
    revision: RunnerRevisionStatus;
    pushHealth?: RunnerPushHealth;
  }[];
  daemonRevision: RunnerRevisionReport;
}

// デーモン自身の版は runner が0台でも出す: 0台は版を確かめたい状態そのもので、そこで答えが消えるため
export function renderRunners(view: RunnersView, now: number = Date.now()): string {
  const lines = [`デーモンの版: ${describeRevisionStatus(view.daemonRevision)}`, ''];

  if (view.runners.length === 0) {
    lines.push(
      '登録されている runner は0台（設定に ALTEROID_RUNNER_URLS 等が無いか、まだ配線されていない）。',
    );
    return lines.join('\n');
  }

  lines.push(
    view.runners.length === 1
      ? 'runner は1台のみ登録されている（分散していない）。'
      : `runner は${view.runners.length}台登録されている。`,
  );

  for (const runner of view.runners) {
    lines.push(
      '',
      // state を畳まない: `unreachable` と `lost` は別物のため
      `- ${runner.runnerId ?? runner.label} [${runner.state}]`,
    );
    lines.push(`  この状態になった: ${runner.since}（${formatElapsedAgo(runner.since, now)}）`);
    if (runner.runnerId !== undefined) lines.push(`  宛先: ${runner.label}`);
    if (runner.workspacePath !== undefined) lines.push(`  workspace: ${runner.workspacePath}`);
    // 名乗らないことを黙らせない: 出さないと「入れ替わっていない」と「判定できない」が同じに見えるため
    lines.push(
      runner.instanceId === undefined
        ? '  応えているプロセス: 名乗っていない（この器では入れ替わりを判定できない）'
        : `  応えているプロセス: ${runner.instanceId}` +
            (runner.instanceSince === undefined ? '' : `（${runner.instanceSince} から）`),
    );
    lines.push(`  版: ${describeRevisionStatus(runner.revision)}`);
    if (runner.error !== undefined) lines.push(`  直近の失敗: ${redactError(runner.error)}`);
    lines.push(`  ${renderCredentialsFingerprint(runner)}`);
    lines.push(`  ${renderProfileFingerprint(runner)}`);
    // 未試行の種類は行を出さない: `undefined` を「成功した」の既定値として埋めないため
    if (runner.pushHealth !== undefined) {
      const line = renderPushHealth(runner.pushHealth);
      if (line !== undefined) lines.push(`  直近の押し込み: ${line}`);
    }
  }

  // マネージャーの本数を出さない: `GET /runners` は返さず、返っていない値を 0 と書くことになるため
  // 名簿の注記は末尾に1度だけ出す: 再起動で全 runner の `since` が巻き戻り、「保持されている記録」と誤読されるため
  lines.push(
    '',
    '（「この状態になった」は名簿の値。名簿（Registry）はインメモリなので、' +
      'デーモンを再起動すると作り直される）',
  );

  return lines.join('\n');
}

// 4欄を独立に扱う: 1つが失敗していても他の成否を畳まないため
function renderPushHealth(pushHealth: RunnerPushHealth): string | undefined {
  const outcomeText = (label: string, outcome: RunnerPushOutcome | undefined) =>
    outcome === undefined
      ? undefined
      : outcome.status === 'ok'
        ? `${label} ok（${outcome.at}）`
        : `${label} 失敗（${outcome.at}）: ${outcome.error === undefined ? '理由不明' : redactError(outcome.error)}`;
  const parts = [
    outcomeText('プロファイル', pushHealth.profile),
    outcomeText('環境変数', pushHealth.credentials),
    outcomeText('認証トークン', pushHealth.agentToken),
    outcomeText('MCP の登録', pushHealth.mcpServers),
    outcomeText('plugin', pushHealth.plugins),
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(' / ');
}

// sha256 を出さない: Web は名前だけを出しており、人間向けの2画面の見せ方が割れ、鍵が増えるほど1行が長くなるため
function renderCredentialsFingerprint(runner: RunnersView['runners'][number]): string {
  if (runner.credentialsProbe.status === 'unheard') {
    return '鍵: 確かめていない（繋がっていないので聞いていない）';
  }
  if (runner.credentialsProbe.status === 'failed') {
    return `鍵を確かめられなかった: ${redactError(runner.credentialsProbe.error)}`;
  }
  if (runner.credentials.length === 0) {
    return '鍵: 渡している鍵は無い';
  }
  return `鍵: ${runner.credentials.map((c) => c.name).join(', ')}`;
}

// 切り詰めない: `profile.sha256` は既に先頭12桁のため
function renderProfileFingerprint(runner: RunnersView['runners'][number]): string {
  if (runner.profileProbe.status === 'unheard') {
    return 'プロファイル: 確かめていない（繋がっていないので聞いていない）';
  }
  if (runner.profileProbe.status === 'failed') {
    return `プロファイルを確かめられなかった: ${redactError(runner.profileProbe.error)}`;
  }
  if (runner.profile === undefined) {
    return 'プロファイル: 置いていない';
  }
  return `プロファイル: 置いてある（指紋 ${runner.profile.sha256}、${runner.profile.updatedAt} 更新）`;
}
