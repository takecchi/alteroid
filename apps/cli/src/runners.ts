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

import { describeCloneProvider } from '@alteroid/logic';

import { createClient } from './client.js';
import { formatElapsedAgo, withErrorReason } from './format.js';
import { describeAuthFailure, resolveTarget } from './target.js';
import { redactError } from './redact.js';

/**
 * `alteroid runners` — 委譲先の器と、**いま走っているコードの版**を見る。
 *
 * 経路は `GET /runners` の1本だけで、Web UI の設定画面とクローンの `runner_list` も
 * 同じものを見る（`apps/daemon/src/app.ts`「経路は1本だけにする」）。
 *
 * **なぜ CLI にも要るのか。** 版はここまで Web UI とクローンからしか読めなかった。
 * 片方の口でしかできないことを作らないのがこのプロダクトの約束であり（PRD
 * 「インターフェース」）、しかも版を確かめたい場面（デプロイ直後・器が上がって
 * こない・「コードはこうなっている」という主張の検算）は**端末に居るときが多い。**
 *
 * **文言は core（`describeRevisionStatus`）に任せ、ここで作り直さない。** 口ごとに
 * 違う言葉で同じ状態が出ると、読む側は別の状態だと読む。
 */
export async function runnersCommand(): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.runners.$get();
  if (!response.ok) {
    // 失敗は例外で上へ通す（＝終了コードが 0 でなくなる。#3446。`usage.ts` と同じ）。
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `runner の一覧を読めませんでした（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  // **`now` はここで1回だけ取る**（issue #2141 段1）。`renderRunners` はテストで
  // 差し込めるよう引数で受ける。
  const now = Date.now();
  stdout.write(`${renderRunners(await response.json(), now)}\n`);
}

/**
 * `alteroid runners vacate <runnerId>` — その runner を意図して空ける（drain）。
 *
 * 経路は `POST /runners/vacate` の1本だけである。**この口は HTTP にしか無かった**
 * ——台数を減らす前に器を空けたい場面（`railway/scale-runners.sh`、#1377）は
 * 端末に居るときで、`curl` と認証を手で組ませるのは CLI と HTTP の片方でしか
 * できないことを作る形だった（PRD「インターフェース」）。
 *
 * **応答は「立てた」ことの確認であって「空き終わった」ことの確認ではない**
 * （`app.ts` の `POST /runners/vacate` の doc）。だから終わったとは言わず、
 * 進捗を追う口を名指しする。名簿に無い runnerId でもデーモンは同じ 200 を返すので、
 * 「そんな器は無い」とは**デーモンの応答からは**言えない。だから**CLI が先に `GET /runners`
 * （`alteroid runners` と同じ口）で名簿を引き**、名簿に無い runnerId は立てずに断る（#3451。
 * 打ち間違いのまま台数を減らして、空いていない器を落とさないため）。名簿を読めないときも
 * 「立てた」とは言わず失敗にする。
 *
 * **失敗（HTTP の 4xx/5xx）は例外で上へ通す（＝終了コードが 0 でなくなる）。**
 * 上の「緩さ」は**成功の意味**の話（「立てた」までしか確認しない）であって、
 * **失敗の扱い**とは別である——401 や 500 は「立てた」ことすら起きていない
 * ので、`reset.ts` / `access.ts` / `token.ts` / `alteroid interrupt`（#1621）/
 * `memory.ts` / `practice.ts`（#1641）と同じく握り潰さない（#1641。以前は
 * ここで `stdout.write` して正常 return していた）。
 *
 * **`railway/scale-runners.sh` はこの CLI コマンドを呼ばない。** 減らす操作
 * （`--vacate`）は `POST /runners/vacate` を自前の node スクリプトで直接叩き、
 * 失敗時は独自に `process.exit(2)` する（`railway/scale-runners.sh` の
 * `vacateResponse.ok` の分岐）——つまりこの CLI コマンドの終了コードに依存
 * している自動化は無い。
 */
export async function runnersVacateCommand(runnerId: string): Promise<void> {
  const target = await resolveTarget();
  // 未ログインの note も例外にする（#2456、クローン teto の判断 2026-09-30）。
  // 何もせず 0 で返すと「空けた」と誤読される。読み取り系（`runnersCommand`）は今のまま。
  if (target.note !== null) throw new Error(target.note);
  const client = createClient(target.baseUrl, target.headers);
  // **先に名簿（`GET /runners`）で runnerId が在るかを確かめる**（#3451）。デーモンは名簿に無い
  // runnerId にも同じ 200 を返す（契約は変えない）ので、打ち間違いを「立てた」と言わないための
  // CLI 側の確認。名簿を読めないときも、立てずに失敗にする。確かめてから立てるまでの間の競合は
  // 1回の往復分だけ残る。
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
  /*
   * **握手を飛ばした回は、そう言う**（#2376）。HTTP は 200 のままなので、応答の
   * `handshakeSkipped` を見ないと、名簿や一覧を読めなかったことが端末から見えない。
   * 欄が無い応答（普通の成功）では何も足さない。
   */
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

/**
 * 指紋（`credentials`/`profile`）を聞きに行けたかの3状態。
 *
 * **`asked` / `unheard` / `failed` を1つも潰さない**（`apps/web/app/routes/
 * settings.tsx` の `Credentials` と同じ意味）——繋がっていないので聞いて
 * いない（`unheard`）／聞いたが失敗した（`failed`）／聞いて0件だった
 * （`asked` かつ空）を同じ文言に潰すと、「配られていない」のか「確かめ
 * られなかった」のかが端末からは区別できなくなる（#1947）。
 *
 * **この型の生成元は無い。** 本体（`runnerProbeSchema`）は daemon の
 * `apps/daemon/src/openapi.ts` にしか定義が無く、CLI は daemon の実装を
 * import しないので、ここに同じ形を書く（型だけの複製——3状態の文言を
 * 作る関数は下の `renderCredentialsFingerprint`/`renderProfileFingerprint`
 * に1本ずつしか無く、複製していない）。
 */
type RunnerProbe =
  { status: 'asked' } | { status: 'unheard' } | { status: 'failed'; error: string };

/**
 * `GET /runners` の応答のうち、この口が読む分。
 *
 * **`daemonRevision` は2値（`RunnerRevisionReport`）で、runner の版は3値
 * （`RunnerRevisionStatus`）である。** 同じ型にしないこと — 自分の版は訊きに行く
 * 経路が無いので `unheard`（名乗りを聞けていない）が意味を持たない。
 */
interface RunnersView {
  runners: {
    label: string;
    state: string;
    /**
     * この状態になった時刻（#1948）。**「作成」「更新」ではない**（#211の決定）
     * ——単に「いまの `state` に変わった時刻」である。
     *
     * **名簿（`Registry`。`packages/core/src/runner-protocol.ts`）はインメモリ
     * で、永続化するストアを持たない。** デーモンを再起動すると名簿ごと作り
     * 直され、この値も現在時刻へ巻き戻る——「ずっと保持されている記録」だと
     * 誤読しないよう、この注記は道具の出力側（`renderRunners` の末尾）にも
     * 1度だけ添える。
     */
    since: string;
    runnerId?: string;
    workspacePath?: string;
    error?: string;
    /**
     * いまその名前に応えているプロセス。**`runnerId` は器を作り直しても同じ**なので、
     * 名前だけでは「さっき仕事を渡した相手と同じか」が言えない。名乗らない器も在る
     * ので省略可能で、**そのときは黙らずに「判定できない」と言う。**
     */
    instanceId?: string;
    instanceSince?: string;
    /**
     * 配られている鍵の指紋（#1947）。**空であることだけを見ないこと。** 叩けな
     * かったときもここは空になるので、「鍵が配られていない」と読んでよいのは
     * `credentialsProbe.status === 'asked'` のときだけである（`credentials`/
     * `credentialsProbe` は daemon が接続している runner には毎回必ず probe
     * する——opt-in のクエリは無いので、CLI が読んでも追加の往復は発生しない）。
     */
    credentials: RunnerCredentialFingerprint[];
    /** 指紋を聞きに行けたか。上の空と、聞けなかったことを分ける。 */
    credentialsProbe: RunnerProbe;
    /**
     * 置かれている実行環境プロファイルの指紋（#1947）。**無いことだけを見ない
     * こと。** 叩けなかったときもここは省略される。
     */
    profile?: RunnerProfileFingerprint;
    /** プロファイルの指紋を聞きに行けたか。上の不在と、聞けなかったことを分ける。 */
    profileProbe: RunnerProbe;
    revision: RunnerRevisionStatus;
    /**
     * 押し込み（push）の直近結果。**指紋（`credentialsProbe`/`profileProbe`）とは
     * 別物**——こちらはデーモンが最後に送ろうとして何が起きたかの記憶で、新たな
     * 往復は発生しない。一度も試みていなければ欄自体が無い（`RunnerOverview.pushHealth`
     * の doc）。この口はまだ `credentialsProbe`/`profileProbe` を読んでいない
     * （版と同じく段階的に足す）。
     */
    pushHealth?: RunnerPushHealth;
  }[];
  daemonRevision: RunnerRevisionReport;
  /** クローン層の provider（デーモン全体で1つ）。無ければ「不明」と書く。 */
  cloneProvider?: string;
}

/**
 * 器の一覧を、人間が読める形へ。
 *
 * **デーモン自身の版を最初に、runner が0台でも出す。** 0台は「まだ配線されて
 * いない」状態、つまり版を確かめたい状態そのものなので、そこで落とすとその状態で
 * だけ答えが消える。並べて出すのは、別々の場所に出すと人間が手で突き合わせる
 * ことになり、突き合わせ忘れがそのまま見逃しになるからである（2つの Service は
 * 別々にデプロイされるので、ずれている窓が実際に在る）。
 */
export function renderRunners(view: RunnersView, now: number = Date.now()): string {
  const lines = [
    `デーモンの版: ${describeRevisionStatus(view.daemonRevision)}`,
    `クローンの provider: ${describeCloneProvider(view.cloneProvider)}`,
    '',
  ];

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
      // **state を畳まない。** 5値のまま出す（`unreachable` と `lost` は別物である）。
      `- ${runner.runnerId ?? runner.label} [${runner.state}]`,
    );
    // **「この状態になった時刻」であって「作成」「更新」ではない**（#1948、
    // #211 の決定）。名簿がインメモリで再起動すると作り直される注記は、
    // 器ごとに繰り返さず一覧の末尾に1度だけ出す（下の `tail`）。
    // **経過（issue #2141 段1）を横に添える。** ISO はそのまま残す。
    lines.push(`  この状態になった: ${runner.since}（${formatElapsedAgo(runner.since, now)}）`);
    if (runner.runnerId !== undefined) lines.push(`  宛先: ${runner.label}`);
    if (runner.workspacePath !== undefined) lines.push(`  workspace: ${runner.workspacePath}`);
    // **「どのプロセスか」を版と並べて出す。** クローンの `runner_list` と Web UI の
    // 設定画面が既に両方を出しているので、ここに片方だけ出すと**この口でだけ
    // 判定材料が欠ける**（この PR が直そうとしている非対称そのものである）。
    // **名乗らないことを黙らせない** — 出さないと「入れ替わっていない」と
    // 「判定できない」が同じに見える。
    lines.push(
      runner.instanceId === undefined
        ? '  応えているプロセス: 名乗っていない（この器では入れ替わりを判定できない）'
        : `  応えているプロセス: ${runner.instanceId}` +
            (runner.instanceSince === undefined ? '' : `（${runner.instanceSince} から）`),
    );
    // 版は上の隣に置く。**別の問いに答える2つである** — 上は「同じプロセスか」、
    // こちらは「そのプロセスがどのコミットで走っているか」。並べないと、どちらか
    // 片方でもう片方を推測することになる。
    lines.push(`  版: ${describeRevisionStatus(runner.revision)}`);
    if (runner.error !== undefined) lines.push(`  直近の失敗: ${redactError(runner.error)}`);
    // **指紋（credentials/profile）は「聞けたか」の3状態を潰さない**（#1947）。
    // Web の設定画面（`Credentials`）と同じ判断——繋がっていないので聞いて
    // いない（`unheard`）／聞いたが失敗した（`failed`）／聞いて0件だった
    // （`asked` かつ空）を同じ文言に潰すと、「配られていない」のか「確かめ
    // られなかった」のかが端末からは区別できなくなる。
    lines.push(`  ${renderCredentialsFingerprint(runner)}`);
    lines.push(`  ${renderProfileFingerprint(runner)}`);
    // **押し込みの結果（`pushHealth`）は新たな往復を払わない**（`credentialsProbe`/
    // `profileProbe` とは別物）ので、その場で聞き直すのではなく記憶をそのまま出す。
    // **3種類とも「まだ一度も試みていない」ことがある。** その種類だけ行を出さない
    // ——`undefined` を「成功した」の既定値として埋めない（`packages/core/src/tools.ts`
    // の `runner_list` と同じ判断・同じ文言）。
    if (runner.pushHealth !== undefined) {
      const line = renderPushHealth(runner.pushHealth);
      if (line !== undefined) lines.push(`  直近の押し込み: ${line}`);
    }
  }

  // **器ごとのマネージャーの本数はここでは出さない。** `GET /runners` はそれを
  // 返さない（返すのはクローンの `runner_list` が読む `ManagerPool.runners()` の
  // 側で、経路が違う）。**返っていない値を、それらしく 0 と書かないこと。**
  // 本数が要るなら `alteroid` の別の口（`/managers`）が持つ。

  // **「この状態になった」の注記（#1948）。** 名簿（`Registry`）はインメモリ
  // で永続化するストアを持たないので、デーモンを再起動すると名簿ごと作り
  // 直され、全 runner の `since` が現在時刻へ巻き戻る——「ずっと保持されて
  // いる記録」だと誤読しないよう1度だけ添える（器ごとに繰り返さない）。
  lines.push(
    '',
    '（「この状態になった」は名簿の値。名簿（Registry）はインメモリなので、' +
      'デーモンを再起動すると作り直される）',
  );

  return lines.join('\n');
}

/**
 * `pushHealth` の4欄（プロファイル・環境変数・認証トークン・MCP の登録）を1行へまとめる。
 * **独立の軸として扱う** — 1つが失敗していても他の成否を畳まない。1つも
 * 試みていなければ `undefined` を返し、呼び出し側で行そのものを出さない。
 */
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
    // #325 段4。ラベルはクローンの `runner_list`（`packages/core/src/tools.ts`）と揃える。
    outcomeText('MCP の登録', pushHealth.mcpServers),
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(' / ');
}

/**
 * 鍵の指紋（`credentials`/`credentialsProbe`）を1行へ（#1947）。
 *
 * **3状態を1つも潰さない**（`RunnerProbe` の doc と同じ理由）。
 *
 * **名前だけを出し、sha256 は出さない。** Web（`apps/web/app/routes/
 * settings.tsx` の `Credentials`）は名前だけを Badge で出しており、CLI だけ
 * が `NAME=sha256` を全部の鍵について並べると、(1) 人間向けの2つの画面の
 * 見せ方が割れる (2) 鍵の本数が増えるほど1行が長くなる。core の
 * `runner_list`（`packages/core/src/tools.ts`、`fingerprints: true` の
 * とき）が sha256 まで出すのは別の事情（エージェントの文脈で「人間が置いた
 * 鍵とマネージャーが握っている鍵が同じか」を照合する必要があるため）で、
 * こちら（人間が端末で読む一覧）には当てはまらないので、core 側は変えて
 * いない。
 */
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

/**
 * プロファイルの指紋（`profile`/`profileProbe`）を1行へ（#1947）。上と同じ3状態
 * ・同じ理由。Web にもこの PR で同じ形（`Profile` コンポーネント）を足した。
 *
 * **`profile.sha256` は既に「先頭12桁」であって64桁の生の sha256 ではない**
 * （`packages/core/src/profile.ts` の `fingerprintOf`——`createHash('sha256')
 * .digest('hex').slice(0, 12)`。`runnerProfileFingerprintSchema.sha256` の
 * doc も「先頭12桁」と明記している）。だからここでさらに切り詰める必要は
 * 無く、`updatedAt` を添えて「置いてある」ことと「いつの内容か」を1行で
 * 分かるようにする。
 */
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
