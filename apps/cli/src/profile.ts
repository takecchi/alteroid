import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stdin } from 'node:process';
import { stdout } from './terminal-out.js';

import { redactedExcerpt } from '@alteroid/core/redact';
import {
  hasRunnerPushFailure,
  LEGACY_PROFILE_NOTICE,
  normalizeProfile,
  type NormalizedProfile,
  type ProfileState,
} from '@alteroid/logic';

import { confirmIrreversible, type ConfirmIo } from './confirm.js';
import { describeScope } from './credential.js';
import { describeAuthFailure, forbiddenKindOf, resolveTarget, type Target } from './target.js';
import { keepDraftOnFailure, openEditorKeepingEdits, readInputFile } from './input-errors.js';
import { shellQuote } from './shell-quote.js';

const ERROR_LIMIT = 512;
const DETAIL_LIMIT = 2000;

/**
 * `packages/core/src/store.ts` の `PROFILE_ENTRY_NAME` と揃える。CLI は core 本体を import しない
 * （軽い subpath だけを使う）ので写してあり、ずれてもデーモンが 400 で弾く。
 */
const PROFILE_ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const EMPTY_BODY_MESSAGE =
  '本文が空では行を置けない。外すなら alteroid profile rm <名前>（全部外すなら clear）。';

const DEFAULT_ENTRY = 'default';

type ProfileScope = 'all' | 'app' | 'runner';

interface ProfileEntryView {
  name: string;
  script: string;
  scope: ProfileScope;
  updatedAt: string;
  sha256: string;
  bytes: number;
}

type ProfileView = NormalizedProfile;

interface ApplyResult {
  ok: boolean;
  error?: string;
  output?: string;
  names?: string[];
}

interface UpdateView {
  updatedAt: string;
  entries?: ProfileEntryView[];
  composed?: { clone: ProfileView['clone']; runner: ProfileView['runner'] };
  clone: ApplyResult;
  runners: (ApplyResult & { runnerId: string })[];
}

function parseScope(raw: string | undefined): ProfileScope | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'all' || raw === 'app' || raw === 'runner') return raw;
  throw new Error(`--scope は all / app / runner のいずれかである（渡されたのは ${raw}）`);
}

function parseName(raw: string | undefined): string {
  const name = raw ?? DEFAULT_ENTRY;
  if (!PROFILE_ENTRY_NAME.test(name)) {
    throw new Error(
      `行の名前の形が不正である（${PROFILE_ENTRY_NAME.source}。渡されたのは ${name}）`,
    );
  }
  return name;
}

/** 古いデーモンの形（`entries` 無し）も `default` 1行として読める形にする。新しい CLI から古いデーモンを叩く窓で落ちないため。 */
async function fetchProfile(target: Target): Promise<ProfileView> {
  return normalizeProfile((await request(target, '/profile')) as ProfileState);
}

function noteLegacy(profile: ProfileView): void {
  if (profile.legacy) stdout.write(`（${LEGACY_PROFILE_NOTICE}）\n`);
}

/** 生の 404 / 400 にせず「サーバが古い」と分かる文言で落とす。 */
function assertLegacySupports(profile: ProfileView, name: string, scope?: ProfileScope): void {
  if (!profile.legacy) return;
  if (name !== 'default' || (scope !== undefined && scope !== 'all')) {
    throw new Error(LEGACY_PROFILE_NOTICE);
  }
}

function describeEntry(entry: ProfileEntryView): string {
  return (
    `${entry.name}  ${describeScope(entry.scope)}  ${String(entry.bytes)} バイト` +
    `  更新 ${entry.updatedAt}`
  );
}

export async function profileListCommand(): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const profile = await fetchProfile(target);

  if (profile.entries.length === 0) {
    stdout.write('プロファイルは置かれていません。\n');
    stdout.write('置くには: alteroid profile set [名前] --scope <all|app|runner>\n');
    return;
  }
  for (const entry of profile.entries) stdout.write(`${describeEntry(entry)}\n`);
  noteLegacy(profile);
  stdout.write('（名前のコード単位順につなげて効きます。本文は alteroid profile show <名前>）\n');
}

/** 標準出力は本文だけ（パイプで `set` へ戻せる）。 */
export async function profileShowCommand(name?: string): Promise<void> {
  const wanted = parseName(name);
  const target = await resolveTarget();
  // 例外にする: note を標準出力へ書くと、`show | set` で note が本文として撒かれるため
  if (target.note !== null) throw new Error(target.note);
  const profile = await fetchProfile(target);

  if (profile.entries.length === 0) {
    // 例外にする: 案内文を標準出力へ書いて 0 で終えると、`show | set` で案内文が本文として撒かれるため
    throw new Error('プロファイルは置かれていません。置くには: alteroid profile edit');
  }
  const entry = profile.entries.find((row) => row.name === wanted);
  if (entry === undefined) {
    throw new Error(
      `プロファイルに行 ${wanted} は無い。行の一覧は alteroid profile list で見られる。`,
    );
  }
  stdout.write(entry.script.endsWith('\n') ? entry.script : `${entry.script}\n`);
}

export async function profileStatusCommand(): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const profile = await fetchProfile(target);

  if (profile.entries.length === 0) {
    stdout.write('プロファイル: 置かれていません\n');
  } else {
    stdout.write(`プロファイル: ${String(profile.entries.length)} 行\n`);
    for (const entry of profile.entries) {
      stdout.write(`  ${describeEntry(entry)} (sha256 ${entry.sha256})\n`);
    }
    if (!profile.legacy)
      stdout.write(
        `クローン用（合成後）: ${profile.clone.sha256 === undefined ? '掛かる行なし' : `${String(profile.clone.bytes ?? 0)} バイト (sha256 ${profile.clone.sha256})`}\n`,
      );
    if (!profile.legacy)
      stdout.write(
        `runner 用（合成後）: ${profile.runner.sha256 === undefined ? '掛かる行なし' : `${String(profile.runner.bytes ?? 0)} バイト (sha256 ${profile.runner.sha256})`}\n`,
      );
  }

  noteLegacy(profile);

  // どの runner に何が届いているかを見せる: 見えないと「置いた」「効いていない」のすれ違いが起きて、鍵の権限の問題なのか配布の問題なのかを誰も切り分けられない。
  const { runners } = (await request(target, '/runners')) as {
    runners: {
      label: string;
      state: string;
      runnerId?: string;
      profile?: { sha256: string; updatedAt: string };
    }[];
  };
  // 旧形式では合成後の指紋が無い。古いデーモンは全文を runner へ降ろすので、本文の指紋と見る。
  const expected = profile.legacy ? profile.sha256 : profile.runner.sha256;
  for (const runner of runners) {
    // 繋がるまで runner_id は分からない。宛先（label）なら登録した時点で言える。
    const name = runner.runnerId ?? runner.label;
    // runner に掛かる行が0なら、載っていないのが正しい: 食い違いとして見せると、直せないものを直させる。
    if (runner.profile === undefined) {
      stdout.write(
        profile.entries.length > 0 && expected === undefined
          ? `  ${name}: プロファイル無し（runner に掛かる行が無いので、載っていないのが正しい。${runner.state}）\n`
          : `  ${name}: プロファイル無し（${runner.state}）\n`,
      );
      continue;
    }
    const note =
      expected === undefined
        ? '（runner に掛かる行が無いので載っているはずがない — 外しの降ろしが済んでいない）'
        : runner.profile.sha256 === expected
          ? '（runner 用の合成と一致）'
          : `（runner 用の合成 ${expected} と食い違う — 降ろし直しが済んでいない）`;
    stdout.write(
      `  ${name}: sha256 ${runner.profile.sha256} (${runner.profile.updatedAt})${note}\n`,
    );
  }
}

/** 確認は入力を読む前に出す: 標準入力を読み切ると、端末の `yes` を聞けない。 */
export async function profileSetCommand(
  nameArg: string | undefined,
  options: { file?: string; scope?: string; yes?: boolean },
  io?: ConfirmIo,
): Promise<void> {
  // 先に検査する: 標準入力を読み終えてから「綴りが違う」で落とさない。
  const name = parseName(nameArg);
  const scope = parseScope(options.scope);
  const target = await resolveTarget();
  // 確認を出す前・標準入力を読む前に断る: 読み切ってから落ちると、渡した本文が無駄になるため
  if (target.note !== null) throw new Error(target.note);
  const profile = await fetchProfile(target);
  assertLegacySupports(profile, name, scope);
  if (profile.entries.some((row) => row.name === name)) {
    await confirmIrreversible(
      `プロファイルの行 ${name} を置き換えます。前の本文は残りません（控えるなら alteroid profile show ${name}）。`,
      options,
      io,
    );
  }
  const script =
    options.file === undefined || options.file === '-'
      ? await readAll()
      : await readInputFile(options.file, '--file', '--file <path>、または標準入力（-）');
  if (script.trim().length === 0) throw new Error(EMPTY_BODY_MESSAGE);
  await put(name, script, target, scope, profile.legacy);
}

export async function profileEditCommand(
  nameArg?: string,
  options: { scope?: string } = {},
): Promise<void> {
  const name = parseName(nameArg);
  const scope = parseScope(options.scope);
  const target = await resolveTarget();
  // エディタを開く前に断る: 書き終えてから落ちると、書いた本文が無駄になるため
  if (target.note !== null) throw new Error(target.note);
  const profile = await fetchProfile(target);
  assertLegacySupports(profile, name, scope);
  const current = profile.entries.find((row) => row.name === name);

  const dir = await mkdtemp(join(tmpdir(), 'alteroid-profile-'));
  const path = join(dir, `${name}.sh`);
  const resume = `alteroid profile set ${name} --file ${shellQuote(path)}${scope === undefined ? '' : ` --scope ${scope}`}`;
  await openEditorKeepingEdits({
    dir,
    path,
    initial: current !== undefined ? current.script : TEMPLATE,
    // 中身は人間が置いた鍵そのものになりうるので、一時ファイルでも絞る。
    mode: 0o600,
    resume,
    alternative: 'alteroid profile set <name> --file <path>',
  });
  await keepDraftOnFailure(dir, path, resume, async () => {
    const edited = await readFile(path, 'utf8');

    // 撒く先だけを変えるのも更新である（本文が同じでも、外れる側が出る）。
    const scopeChanged = current !== undefined && scope !== undefined && scope !== current.scope;
    if (current === undefined ? edited === TEMPLATE : edited === current.script && !scopeChanged) {
      stdout.write('変更はありません。\n');
      return;
    }
    await put(name, edited, target, scope, profile.legacy);
  });
}

export async function profileRemoveCommand(
  nameArg: string,
  options: { yes?: boolean } = {},
  io?: ConfirmIo,
): Promise<void> {
  const name = parseName(nameArg);
  const target = await resolveTarget();
  if (target.note !== null) throw new Error(target.note);
  const profile = await fetchProfile(target);
  assertLegacySupports(profile, name);
  // 古いデーモン（`legacy`）は見ない: 行の一覧が旧形式の合成で、空の PUT へ倒す挙動のまま。
  if (!profile.legacy && !profile.entries.some((row) => row.name === name)) {
    throw new Error(`プロファイルに行 ${name} は無い`);
  }
  await confirmIrreversible(
    `プロファイルの行 ${name} を外します。行の本文は残りません（控えるなら alteroid profile show ${name}）。`,
    options,
    io,
  );
  const result = (await (profile.legacy
    ? request(target, '/profile', { method: 'PUT', body: JSON.stringify({ script: '' }) })
    : request(target, `/profile/${encodeURIComponent(name)}`, { method: 'DELETE' }))) as UpdateView;
  stdout.write(
    hasRunnerPushFailure(result)
      ? `警告: プロファイルの行 ${name} は外しましたが、一部の runner へ反映できていません。\n`
      : `プロファイルの行 ${name} を外しました。\n`,
  );
  describeComposed(result);
  report('クローン', result.clone);
  for (const runner of result.runners) report(runner.runnerId, runner);
  failOnPartialPush(result);
}

/** 空の `PUT /profile` を1回で叩く: 行ごとに `DELETE` を並べると、途中で落ちたとき半端に残る。 */
export async function profileClearCommand(options: { yes?: boolean } = {}): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) throw new Error(target.note);
  await confirmIrreversible(
    'プロファイルの全行を外します。行の本文は残りません（控えるなら alteroid profile show）。',
    options,
  );
  const result = (await request(target, '/profile', {
    method: 'PUT',
    body: JSON.stringify({ script: '' }),
  })) as UpdateView;
  stdout.write(
    hasRunnerPushFailure(result)
      ? '警告: プロファイルを全部外しましたが、一部の runner へ反映できていません。\n'
      : 'プロファイルを全部外しました。\n',
  );
  report('クローン', result.clone);
  for (const runner of result.runners) report(runner.runnerId, runner);
  failOnPartialPush(result);
}

/** 見出しと台ごとの結果を出した後で例外にする（保存は済んでいる）。 */
function failOnPartialPush(result: UpdateView): void {
  if (!hasRunnerPushFailure(result)) return;
  throw new Error(
    'runner への反映が一部失敗しました（プロファイルの保存は済んでいます。失敗した runner へは次に名乗ったときに降ろし直します）',
  );
}

function describeComposed(result: UpdateView): void {
  if (result.composed === undefined) return;
  const { clone, runner } = result.composed;
  stdout.write(
    `  合成後の指紋: クローン用 ${clone.sha256 ?? '掛かる行なし'} / runner 用 ${runner.sha256 ?? '掛かる行なし'}\n`,
  );
}

async function put(
  name: string,
  script: string,
  known?: Target,
  scope?: ProfileScope,
  legacy = false,
): Promise<void> {
  if (script.trim().length === 0) {
    throw new Error(EMPTY_BODY_MESSAGE);
  }
  const target = known ?? (await resolveTarget());
  const result = (await (legacy
    ? request(target, '/profile', { method: 'PUT', body: JSON.stringify({ script }) })
    : request(target, `/profile/${encodeURIComponent(name)}`, {
        method: 'PUT',
        body: JSON.stringify({ script, ...(scope === undefined ? {} : { scope }) }),
      }))) as UpdateView;

  const row = result.entries?.find((entry) => entry.name === name);
  const sha = row?.sha256 ?? (result as { sha256?: string }).sha256 ?? '?';
  stdout.write(
    hasRunnerPushFailure(result)
      ? `警告: プロファイルの行 ${name} は保存しましたが、一部の runner へ反映できていません (sha256 ${sha})\n`
      : `プロファイルの行 ${name} を更新しました (sha256 ${sha})\n`,
  );
  stdout.write(`  撒く先: ${describeScope(row?.scope ?? 'all')}\n`);
  if (legacy) stdout.write(`（${LEGACY_PROFILE_NOTICE}）\n`);
  describeComposed(result);

  report('クローン', result.clone);
  for (const runner of result.runners) report(runner.runnerId, runner);

  // 走行中の仕事に全部届くとは言わない: 実測では届く相手と届かない相手が混在する（`packages/core/src/profile.ts` のモジュール doc）。
  stdout.write('（これから起こす仕事には即座に効きます。走行中の仕事は gh / git だけが\n');
  stdout.write('  次の呼び出しから拾います — それ以外は次の仕事から）\n');
  failOnPartialPush(result);
}

function report(label: string, result: ApplyResult): void {
  if (result.ok) {
    const names = result.names ?? [];
    stdout.write(
      names.length === 0
        ? `  ${label}: 反映しました\n`
        : `  ${label}: 反映しました（${names.join(' ')}）\n`,
    );
  } else {
    stdout.write(`  ${label}: 反映できませんでした — ${result.error ?? '理由不明'}\n`);
  }
  const output = result.output ?? '';
  if (output.trim().length > 0) {
    for (const line of output.trimEnd().split('\n')) stdout.write(`    | ${line}\n`);
  }
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function request(target: Target, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${target.baseUrl}${path}`, {
    ...init,
    headers: { ...target.headers, 'content-type': 'application/json' },
  });

  if (!response.ok) {
    // 403 は持ち主でない以外の理由でも返る（ログイン済みだが未 grant）。本文を見ずに固定の文言を出すと、
    // 未 grant の人に直らない「持ち主だけです」を案内してしまうので、本文で出し分ける。
    if (response.status === 403) {
      const body = await response.json().catch(() => ({}));
      const kind = forbiddenKindOf(body);
      // `not_operator` の枝は、`GET /profile` `PUT /profile` が `requireOperator` のままなので残す。
      if (kind === 'not_operator') {
        throw new Error(
          '実行環境プロファイルを触れるのは、その実行環境の持ち主だけです。\n' +
            'デーモンが動いているのと同じ環境で実行してください:\n' +
            '  docker compose exec app alteroid profile edit\n' +
            '（人間が ~/.zshenv を直すのも、その人が持っている箱の上である、という線引きです）',
        );
      }
      if (kind === 'not_granted') {
        throw new Error(
          describeAuthFailure(403, target) ??
            'このアカウントには alteroid を使う許可がありません。',
        );
      }
      // 理由が判別できないときは解決策を書かない: 「器の中で実行しろ」と「access grant しろ」は正反対で、当てずっぽうだと半分は嘘になる。
      throw new Error(
        '実行環境プロファイルへのアクセスが拒否されました（403）。理由を判別でき' +
          'なかったため、次にすべきことは案内しません。',
      );
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    const body = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      detail?: unknown;
    };
    if (typeof body.error === 'string') {
      // 伏せてから切る: `detail` はシェルの stderr で、bash は構文エラーで入力の行そのもの（`export GH_TOKEN=…`）を引用する。
      const error = redactedExcerpt(body.error, ERROR_LIMIT, process.env);
      throw new Error(
        typeof body.detail === 'string' && body.detail.length > 0
          ? `${error}\n${redactedExcerpt(body.detail, DETAIL_LIMIT, process.env)}`
          : error,
      );
    }
    throw new Error(`${path} が失敗しました (${String(response.status)})`);
  }
  return response.json();
}

/** 「確認が要る行為の一覧」を書かせない: ここは実行環境の宣言で、何をしてよいかの表ではない（クローンが記憶で判断する）。 */
const TEMPLATE = `# alteroid 実行環境プロファイル（人間の ~/.zprofile に当たるもの）
#
# ここに書いたものは、既定ではクローン・マネージャー・作業者のすべてに効きます
# （プロファイルは名前付きの行の集まりで、名前のコード単位順につなげて効きます）
# （alteroid profile edit --scope runner のように撒く先を絞れます。
#  all=両方 / app=クローンだけ / runner=マネージャー・作業者だけ）。
# 器（コンテナ）を作り直す必要はありません。
#
# 例:
#   export SOME_API_TOKEN=xxxx
#   export PATH="$HOME/.local/bin:$PATH"
#   eval "$(some-tool env)"
#
# 注意:
# - 重い処理や、返ってこないコマンドを書かないでください（仕事を起こすたびに
#   1度評価されるので、そのぶん遅くなります）
# - 差し替えは**これから起こす仕事**に効きます。既に走っている仕事のうち、
#   次の呼び出しから拾うのは gh / git だけです
# - 記憶（人格）ではありません。価値観や「何を任せてよいか」は alteroid chat で
#   伝えてください
`;
