import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// 出所は migrate.ts の `create table if not exists`。README の2つの一覧（`truncate` の一覧と「残す表」）の和と突き合わせる。
// このファイルには表の名前を書かない: 書くと出所から導く歯ではなく手書きの写しになるため（合成 fixture は実在しない名前にする）。

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

export function listCreatedTables(migrateSource: string): string[] {
  const names = new Set<string>();
  for (const m of migrateSource.matchAll(/create table if not exists ([a-z0-9_]+)/g)) {
    names.add(m[1]!);
  }
  return [...names].sort();
}

// `truncate table a, b, c restart identity cascade` は README の中にちょうど1つ。複数あると、どれが手順か決められない
export function listTruncatedTables(readme: string): string[] {
  const found = [...readme.matchAll(/truncate table ([a-z0-9_,\s]+?) restart identity cascade/g)];
  if (found.length !== 1) {
    throw new Error(
      `railway/README.md の \`truncate table … restart identity cascade\` が ${found.length} 個ある（ちょうど1個であること）`,
    );
  }
  return found[0]![1]!.split(',').map((s) => s.trim());
}

// 「**残す表**」の段落の直後の箇条書き。各行は `- ` + バッククォートで括った名前（`・` で並べる）+ ` — ` + 理由。名前の末尾が `*` なら接頭辞（`auth_*`）。
export function listKeptTables(readme: string): string[] {
  const lines = readme.split('\n');
  const head = lines.findIndex((l) => l.startsWith('**残す表**'));
  if (head < 0) throw new Error('railway/README.md に「**残す表**」の段落が無い');
  const kept: string[] = [];
  let i = head + 1;
  while (i < lines.length && lines[i]!.trim() === '') i += 1;
  for (; i < lines.length && lines[i]!.startsWith('- '); i += 1) {
    const names = lines[i]!.slice(2).split(' — ')[0]!;
    for (const m of names.matchAll(/`([a-z0-9_*]+)`/g)) kept.push(m[1]!);
  }
  if (kept.length === 0) throw new Error('「**残す表**」の箇条書きが空');
  return kept;
}

export interface TableListDiff {
  missing: string[];
  stale: string[];
  both: string[];
  duplicated: string[];
}

export function diffTableLists(args: {
  created: readonly string[];
  truncated: readonly string[];
  kept: readonly string[];
}): TableListDiff {
  const isKept = (table: string): boolean =>
    args.kept.some((k) => (k.endsWith('*') ? table.startsWith(k.slice(0, -1)) : k === table));
  const created = new Set(args.created);
  const truncated = new Set(args.truncated);
  const keptExact = args.kept.filter((k) => !k.endsWith('*'));
  const prefixes = args.kept.filter((k) => k.endsWith('*'));
  return {
    // 作られるのにどちらにも載っていない（truncate が成功して「消したつもり」になる）
    missing: [...created].filter((t) => !truncated.has(t) && !isKept(t)).sort(),
    // 載っているのに作られない（表が消えた・名前が変わった後の写し）
    stale: [
      ...[...truncated].filter((t) => !created.has(t)),
      ...keptExact.filter((t) => !created.has(t)),
      ...prefixes.filter((p) => ![...created].some((t) => t.startsWith(p.slice(0, -1)))),
    ].sort(),
    // 消す一覧と残す一覧の両方に載っている
    both: [...truncated].filter((t) => isKept(t)).sort(),
    // 同じ一覧の中で2回書かれている
    duplicated: [
      ...args.truncated.filter((t, n, all) => all.indexOf(t) !== n),
      ...args.kept.filter((t, n, all) => all.indexOf(t) !== n),
    ].sort(),
  };
}

const MIGRATE = 'packages/storage-pg/src/migrate.ts';
const README = 'railway/README.md';

describe('railway/README.md の truncate の一覧 + 残す表 = migrate.ts が作る表の全部', () => {
  const created = listCreatedTables(readRepoFile(MIGRATE));
  const readme = readRepoFile(README);
  const truncated = listTruncatedTables(readme);
  const kept = listKeptTables(readme);
  const diff = diffTableLists({ created, truncated, kept });

  it('前提: 3つの一覧が空ではない（歯が空振りしていないこと）', () => {
    expect(created.length).toBeGreaterThan(0);
    expect(truncated.length).toBeGreaterThan(0);
    expect(kept.length).toBeGreaterThan(0);
  });

  it('漏れが無い（migrate が作るのに、truncate の一覧にも残す表にも載っていない表）', () => {
    expect(
      diff.missing,
      `${README} に載っていない表: ${diff.missing.join(', ')}。\n` +
        '消すなら「記憶を落とす」の `truncate table …` の一覧へ、残すなら「**残す表**」の箇条書きへ（理由つきで）足すこと。\n' +
        '足さないと `truncate` は成功するのに、その表だけ「消したつもり」のまま残る。',
    ).toEqual([]);
  });

  it('余りが無い（README にあるのに migrate が作らない表）', () => {
    expect(
      diff.stale,
      `${README} にあるのに ${MIGRATE} が作らない表: ${diff.stale.join(', ')}。名前が変わったか表が消えた。README から外すこと。\n` +
        '（`truncate` に存在しない表を書くと、手順そのものが失敗する）',
    ).toEqual([]);
  });

  it('消す一覧と残す表の両方に載っている表が無い', () => {
    expect(diff.both, `両方に載っている表: ${diff.both.join(', ')}`).toEqual([]);
  });

  it('同じ一覧の中で重複して書かれた表が無い', () => {
    expect(diff.duplicated, `重複: ${diff.duplicated.join(', ')}`).toEqual([]);
  });
});

describe('突き合わせそのもの（陽性対照。合成 fixture。実在の表名は使わない）', () => {
  const created = ['alpha_one', 'alpha_two', 'beta_log', 'gamma_key', 'tmp_x_1'];
  const ok = {
    created,
    truncated: ['alpha_one', 'alpha_two', 'beta_log'],
    kept: ['gamma_key', 'tmp_*'],
  };

  it('揃っていれば空', () => {
    expect(diffTableLists(ok)).toEqual({ missing: [], stale: [], both: [], duplicated: [] });
  });

  it('漏れを作ると、その表の名前つきで落ちる', () => {
    const diff = diffTableLists({ ...ok, truncated: ['alpha_one', 'beta_log'] });
    expect(diff.missing).toEqual(['alpha_two']);
  });

  it('残す側の1行を落としても漏れとして出る（接頭辞で覆われない表）', () => {
    const diff = diffTableLists({ ...ok, kept: ['tmp_*'] });
    expect(diff.missing).toEqual(['gamma_key']);
  });

  it('余り（存在しない表）を名前つきで出す', () => {
    const diff = diffTableLists({ ...ok, truncated: [...ok.truncated, 'ghost_table'] });
    expect(diff.stale).toEqual(['ghost_table']);
  });

  it('作る表の無い接頭辞も余りとして出す', () => {
    const diff = diffTableLists({ ...ok, kept: [...ok.kept, 'nothing_*'] });
    expect(diff.stale).toEqual(['nothing_*']);
  });

  it('両方に載っている表を名前つきで出す', () => {
    const diff = diffTableLists({ ...ok, kept: [...ok.kept, 'alpha_one'] });
    expect(diff.both).toEqual(['alpha_one']);
  });

  it('接頭辞の残す表に当たる表を truncate にも書くと両方として出る', () => {
    const diff = diffTableLists({ ...ok, truncated: [...ok.truncated, 'tmp_x_1'] });
    expect(diff.both).toEqual(['tmp_x_1']);
  });

  it('重複を名前つきで出す', () => {
    const diff = diffTableLists({ ...ok, truncated: [...ok.truncated, 'beta_log'] });
    expect(diff.duplicated).toEqual(['beta_log']);
  });
});

describe('README と migrate の読み取り（合成 fixture）', () => {
  it('listCreatedTables は create table if not exists の名前を拾い、alter や index は拾わない', () => {
    const src = [
      '`create table if not exists foo_a (id text)`,',
      '`alter table foo_a add column if not exists x text`,',
      '`create unique index if not exists foo_a_idx on foo_a (id)`,',
      '`create table if not exists foo_b (id text)`,',
    ].join('\n');
    expect(listCreatedTables(src)).toEqual(['foo_a', 'foo_b']);
  });

  it('listTruncatedTables は一覧を読み、1個でなければ投げる', () => {
    const one = 'psql -c "truncate table foo_a, foo_b restart identity cascade;"';
    expect(listTruncatedTables(one)).toEqual(['foo_a', 'foo_b']);
    expect(() => listTruncatedTables('なし')).toThrow(/0 個/);
    expect(() => listTruncatedTables(`${one}\n${one}`)).toThrow(/2 個/);
  });

  it('listKeptTables は箇条書きの名前だけを拾い、理由の中の名前は拾わない', () => {
    const readme = [
      '**残す表**（説明）:',
      '',
      '- `foo_*` — 理由。`foo_a` ほか',
      '- `bar_a`・`bar_b` — 理由',
      '',
      '次の段落。`not_listed`',
    ].join('\n');
    expect(listKeptTables(readme)).toEqual(['foo_*', 'bar_a', 'bar_b']);
  });

  it('listKeptTables は段落が無い・空なら投げる', () => {
    expect(() => listKeptTables('なし')).toThrow(/残す表/);
    expect(() => listKeptTables('**残す表**:\n\n次')).toThrow(/空/);
  });
});
