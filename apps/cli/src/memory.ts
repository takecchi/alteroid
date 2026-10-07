import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stdin } from 'node:process';
import { MEMORY_SLUG_RULE, describeSlugViolation } from '@alteroid/core/cli-light';
import { stderr, stdout, writeShownBody } from './terminal-out.js';

import { createClient, type DaemonClient } from './client.js';
import { formatElapsedAgo, withErrorReason } from './format.js';
import { describeAuthFailure, resolveTarget, type Target } from './target.js';
import { confirmIrreversible, type ConfirmIo } from './confirm.js';
import { keepDraftOnFailure, openEditor, readInputFile } from './input-errors.js';

export type MemoryDescriptionDrift =
  | { kind: 'measured'; describedBytes: number; currentBytes: number; deltaBytes: number }
  | {
      kind: 'at-least';
      baselineBytes: number;
      baselineAt: string;
      currentBytes: number;
      deltaBytes: number;
    }
  | { kind: 'unrecorded' };

export interface MemorySummary {
  slug: string;
  title: string;
  kind: 'premise' | 'fact' | 'indexed';
  description?: string;
  descriptionFreshness:
    | { kind: 'fresh' }
    | { kind: 'stale'; staleForMs: number; drift: MemoryDescriptionDrift }
    | { kind: 'unknown' }
    | { kind: 'absent' };
  updatedAt: string;
  createdAt: { kind: 'known'; at: string } | { kind: 'unknown' };
}

// 根拠が無ければ空欄にせず「不明」と言う: 片方だけ空欄にすると、人間とクローンが同じ記憶を見て違う判断をするため
export function formatCreatedAt(createdAt: MemorySummary['createdAt']): string {
  return createdAt.kind === 'known' ? createdAt.at : '不明';
}

// `unknown` に経過を添えない: 読めないのに `0分前` のような値を作ることになるため
function formatCreatedAtWithElapsed(createdAt: MemorySummary['createdAt'], now: number): string {
  if (createdAt.kind === 'known') {
    return `${createdAt.at}（${formatElapsedAgo(createdAt.at, now)}）`;
  }
  return formatCreatedAt(createdAt);
}

export async function memoryListCommand(now: number = Date.now()): Promise<void> {
  const conn = await connect('read');
  if (conn === null) return;
  const { client, target } = conn;
  const response = await client.memory.$get();
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `記憶の一覧を読めませんでした（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  const { documents } = (await response.json()) as { documents: MemorySummary[] };
  if (documents.length === 0) {
    stdout.write('記憶はまだ空です。\n');
    stdout.write('置くには: alteroid memory edit <slug>\n');
    return;
  }
  for (const doc of documents) {
    const marker = freshnessMarker(doc.descriptionFreshness);
    const desc = doc.description === undefined ? '' : ` — ${marker}${doc.description}`;
    stdout.write(
      `  [${doc.kind}] ${doc.slug}  — ${doc.title}` +
        ` (作成: ${formatCreatedAtWithElapsed(doc.createdAt, now)} / 更新: ${doc.updatedAt})${desc}\n`,
    );
  }
  stdout.write('本文を読むには: alteroid memory show <slug>\n');
}

// `Math.max(seconds, 0)` を残す: 受け取るのは HTTP 経由の JSON（信頼境界の外）で、型の保証だけを信じないため
function formatMemoryStaleness(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間`;
  const days = Math.floor(hours / 24);
  return `${days}日`;
}

function assertNeverMemoryDescriptionDrift(drift: never): never {
  throw new Error(`未知の要旨の変化量の状態: ${JSON.stringify(drift)}`);
}

function formatMemoryDescriptionDrift(drift: {
  describedBytes: number;
  currentBytes: number;
  deltaBytes: number;
}): string {
  const sign = drift.deltaBytes < 0 ? '-' : '+';
  const magnitude = Math.abs(drift.deltaBytes).toLocaleString('en-US');
  if (drift.describedBytes === 0) return `本文は${sign}${magnitude}バイト変わった`;
  const percent = Math.round((Math.abs(drift.deltaBytes) / drift.describedBytes) * 100);
  return `本文は${sign}${magnitude}バイト（${sign}${percent.toLocaleString('en-US')}%）変わった`;
}

function formatMemoryDescriptionDriftAtLeast(drift: {
  baselineBytes: number;
  currentBytes: number;
  deltaBytes: number;
}): string {
  const sign = drift.deltaBytes < 0 ? '-' : '+';
  const magnitude = Math.abs(drift.deltaBytes).toLocaleString('en-US');
  return `${sign}${magnitude}バイト以上変わった`;
}

function describeMemoryDescriptionDrift(drift: MemoryDescriptionDrift): string {
  switch (drift.kind) {
    case 'measured':
      return formatMemoryDescriptionDrift(drift);
    case 'at-least':
      return formatMemoryDescriptionDriftAtLeast(drift);
    case 'unrecorded':
      return '本文の変化量は記録されていない';
    default:
      return assertNeverMemoryDescriptionDrift(drift);
  }
}

// `stale` は期間に変化量も追記する: 時間差だけでは、いちばん手が入っている文書がいちばん新しく見えるため
export function freshnessMarker(freshness: MemorySummary['descriptionFreshness']): string {
  switch (freshness.kind) {
    case 'stale':
      return (
        `要旨は本文より${formatMemoryStaleness(freshness.staleForMs)}古い` +
        `（${describeMemoryDescriptionDrift(freshness.drift)}）: `
      );
    case 'unknown':
      return '要旨を書いた時刻が記録されていない: ';
    case 'fresh':
      return '要旨の後に本文は動いていない: ';
    case 'absent':
      return '';
  }
}

export async function memoryShowCommand(slug: string): Promise<void> {
  const conn = await connect('read');
  if (conn === null) return;
  const doc = await readDoc(conn.client, conn.target, slug);
  if (doc === null) {
    throw new Error(`そんな記憶はありません: ${slug}`);
  }
  const content = doc.content;
  writeShownBody(stdout, content.endsWith('\n') ? content : `${content}\n`);
  // 版を stdout に混ぜない: 本文をそのまま出す口で、パイプやリダイレクトで本文が壊れるため
  if (doc.version !== undefined) {
    stderr.write(
      `版: ${doc.version}（読んだ版を前提に消すなら: alteroid memory remove ${slug} --if-match ${doc.version}）\n`,
    );
  }
}

export async function memoryEditCommand(slug: string): Promise<void> {
  // slug の検査を後にしない: `join(dir, ...)` は `..` を畳み、一時ディレクトリの外の .md を書き換えるため
  const violation = describeSlugViolation(slug, MEMORY_SLUG_RULE);
  if (violation !== null) throw new Error(`記憶の名前が不正です: ${violation}`);
  const conn = await connect('write');
  if (conn === null) return;
  const { client, target } = conn;
  const doc = await readDoc(client, target, slug);
  const current = doc === null ? null : doc.content;
  // 黙って上書きしない: エディタを開いている間にクローンが書くと、読んだ時の版が変わっていて 409 になる
  const ifMatch = doc === null ? null : doc.version;

  const initial = template(slug);
  const dir = await mkdtemp(join(tmpdir(), 'alteroid-memory-'));
  const path = join(dir, `${slug}.md`);
  try {
    await writeFile(path, current ?? initial, 'utf8');
    await openEditor(path, 'alteroid memory set <slug> --file <path>');
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  await keepDraftOnFailure(
    dir,
    path,
    `alteroid memory set ${slug} --file ${path}`,
    async (keep) => {
      const edited = await readFile(path, 'utf8');

      // 雛形のまま閉じたら書かない: 案内文が記憶（システムプロンプトに載る）として保存されるため
      if ((current !== null && edited === current) || (current === null && edited === initial)) {
        // 書き換えていないなら書き込まない: 同じ本文でも `PUT` は日誌へ `memory_update` を積むため
        stdout.write('変更はありません。\n');
        return;
      }
      // 「変更なし」の判定より後に置く: 元から空の記憶を触らずに閉じたのは、変更なしのため
      if (edited.trim().length === 0) throw new Error(`記憶 ${slug}: ${EMPTY_BODY_MESSAGE}`);
      try {
        await write(client, target, slug, edited, ifMatch);
      } catch (error) {
        if (!(error instanceof MemoryConflictCliError)) throw error;
        keep();
        const theirs = join(dir, `${slug}.current.md`);
        if (error.current !== null) await writeFile(theirs, error.current, 'utf8');
        stdout.write(
          [
            `書き換えていません: ${slug} は、あなたが読んだ後に変わっています（クローンなど別の書き手が書いたか、消されました）。`,
            `  あなたの編集（残してあります）: ${path}`,
            error.current === null
              ? '  いまの記憶: 無い（消されています）'
              : `  いまの記憶: ${theirs}`,
            ...(error.current === null ? [] : [`  見比べる: diff -u ${theirs} ${path}`]),
            `  取り込んだら \`alteroid memory edit ${slug}\` で開き直して直してください。`,
            `  そのまま置き換えてよいなら \`alteroid memory set ${slug} --file ${path}\`（クローンの書き込みを消します）。`,
            '',
          ].join('\n'),
        );
        throw new Error(`記憶が読んだ後に変わっていたので書き換えませんでした: ${slug}`, {
          cause: error,
        });
      }
    },
  );
}

// 空の本文を書かない: 上流のコマンドが失敗して何も流さなかったとき記憶が黙って空になり、版の履歴が無く戻せないため
const EMPTY_BODY_MESSAGE =
  '本文が空なので置き換えません（既存の本文は変えていません）。空にしたいときだけ --allow-empty を付けてください。';

// 確認は入力を読む前に出す: 標準入力から本文を読み切ると、その後の `yes` を聞けないため
export async function memorySetCommand(
  slug: string,
  options: { file?: string; yes?: boolean; allowEmpty?: boolean } = {},
  io?: ConfirmIo,
): Promise<void> {
  const conn = await connect('write');
  if (conn === null) return;
  if ((await readDoc(conn.client, conn.target, slug)) !== null) {
    await confirmIrreversible(
      `記憶 ${slug} を置き換えます。前の本文は残りません（控えるなら alteroid memory show ${slug}）。`,
      options,
      io,
    );
  }
  const content =
    options.file === undefined || options.file === '-'
      ? await readAll()
      : await readInputFile(options.file, '--file', '--file <path>、または標準入力（-）');
  if (options.allowEmpty !== true && content.trim().length === 0) {
    throw new Error(`記憶 ${slug}: ${EMPTY_BODY_MESSAGE}`);
  }
  await write(conn.client, conn.target, slug, content);
}

// 確認より前に版を読む: 消すものが無いのに「取り消せません。yes と入力してください」と求めないため
// `--if-match` 明示時は事前に読まない: 明示された版は人間が `memory show` で見て決めた版で、読み直した版で置き換えないため
export async function memoryRemoveCommand(
  slug: string,
  options: { ifMatch?: string; yes?: boolean } = {},
  io?: ConfirmIo,
): Promise<void> {
  const conn = await connect('write');
  if (conn === null) return;
  const { client, target } = conn;
  let readVersion: string | undefined;
  if (options.ifMatch === undefined) {
    const missing: { status?: number } = {};
    const doc = await readDoc(client, target, slug, missing);
    if (doc === null) {
      throw new Error(
        missing.status === 400
          ? `記憶の名前として成立しません: ${slug}`
          : `そんな記憶はありません: ${slug}`,
      );
    }
    readVersion = doc.version;
  }
  await confirmIrreversible(
    `記憶 ${slug} を消します。本文は戻りません（日誌には消した事実と大きさだけが残ります）。`,
    options,
    io,
  );
  const ifMatch = options.ifMatch ?? readVersion;
  const response = await client.memory[':slug'].$delete({
    param: { slug },
    query: ifMatch === undefined ? {} : { ifMatch },
  });
  if (response.status === 409) {
    const body = (await response.json()) as {
      current?: { document?: { content?: string }; version?: string } | null;
    };
    const current = body.current ?? null;
    stdout.write(
      [
        `消していません: ${slug} は、あなたが読んだ後に変わっています（クローンなど別の書き手が書いたか、すでに消されました）。`,
        current === null
          ? '  いまの記憶: 無い（すでに消されています）'
          : `  いまの記憶の版: ${current.version ?? '（不明）'}（${String(current.document?.content?.length ?? 0)} 文字）`,
        ...(current === null
          ? []
          : [
              `  いまの内容を読み直す: \`alteroid memory show ${slug}\`（版そのものは GET /memory/${slug} の version）`,
              `  確かめたうえで消してよければ、もう一度 \`alteroid memory remove ${slug}\`（いまの版を読み直して消します）。`,
            ]),
        '',
      ].join('\n'),
    );
    throw new Error(`記憶が読んだ後に変わっていたので消しませんでした: ${slug}`);
  }
  if (response.status === 428) {
    throw new Error(
      await withErrorReason(
        `消していません: ${slug}（HTTP 428。このデーモンは削除に読んだ版を必須としています。` +
          `\`alteroid memory show ${slug}\` で版を確かめ、\`alteroid memory remove ${slug} --if-match <版>\` で打ち直してください）`,
        response,
      ),
    );
  }
  if (!response.ok) {
    if (response.status === 400) {
      throw new Error(`記憶の名前として成立しません: ${slug}`);
    }
    if (response.status === 404) {
      throw new Error(`そんな記憶はありません: ${slug}`);
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `記憶を消せませんでした: ${slug}（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  stdout.write(`消しました: ${slug}\n`);
}

// 書き込み系では未ログインの note を例外にする: 何もせず 0 で返すと、cron などが「済んだ」と誤読するため
async function connect(
  access: 'read' | 'write',
): Promise<{ client: DaemonClient; target: Target } | null> {
  const target = await resolveTarget();
  if (target.note !== null) {
    if (access === 'write') throw new Error(target.note);
    stdout.write(`${target.note}\n`);
    return null;
  }
  return { client: createClient(target.baseUrl, target.headers), target };
}

// `null` は 404 と 400 だけにする: 他の失敗を `null` にすると、`edit` が読めていない既存の記憶を空の雛形で上書きするため
async function readDoc(
  client: DaemonClient,
  target: Target,
  slug: string,
  missing?: { status?: number },
): Promise<{ content: string; version: string | undefined } | null> {
  const response = await client.memory[':slug'].$get({ param: { slug } });
  if (response.status === 404 || response.status === 400) {
    if (missing !== undefined) missing.status = response.status;
    return null;
  }
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `記憶を読めませんでした: ${slug}（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  const body = await response.json();
  if (!('document' in body)) return null;
  return {
    content: body.document.content,
    version: 'version' in body && typeof body.version === 'string' ? body.version : undefined,
  };
}

class MemoryConflictCliError extends Error {
  readonly current: string | null;
  constructor(slug: string, current: string | null) {
    super(`記憶が読んだ後に変わっています: ${slug}`);
    this.current = current;
  }
}

async function write(
  client: DaemonClient,
  target: Target,
  slug: string,
  content: string,
  ifMatch?: string | null,
): Promise<void> {
  const response = await client.memory[':slug'].$put({
    param: { slug },
    json: ifMatch === undefined ? { content } : { content, ifMatch },
  });
  if (response.status === 409) {
    const body = (await response.json()) as {
      current?: { document?: { content?: string } } | null;
    };
    throw new MemoryConflictCliError(slug, body.current?.document?.content ?? null);
  }
  if (!response.ok) {
    if (response.status === 400) {
      throw new Error(`書き換えられませんでした: ${slug}（記憶の名前が不正かもしれません）`);
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `書き換えられませんでした: ${slug}（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  stdout.write(`書き換えました: ${slug}\n`);
  stdout.write('（次の会話からクローンの判断に入ります）\n');
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// 雛形に「何をしてよいかの表」を書かせない: 記憶は判断の根拠を置く場所で、許可する行為の一覧ではないため
function template(slug: string): string {
  return `# ${slug}

（ここにクローンへ渡したい根拠を書きます。価値観・判断の基準・背景など）

- 記憶は次の会話からクローンの判断に入ります
- 鍵やトークンは書かないでください（記憶はシステムプロンプトに載ります。
  それは実行環境プロファイル: alteroid profile edit の仕事です）
`;
}
