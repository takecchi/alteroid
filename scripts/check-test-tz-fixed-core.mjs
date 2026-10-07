// `toLocaleString` を検出対象から外す: 静的な正規表現では受け手が `Date` か `Number`（桁区切り）かを区別できず、大半が Number のため。
// カテゴリBはファイル全体ではなく呼び出しに近い窓（`NEARBY_WINDOW`）で `timeZone` を探す: 1ファイルに `timeZone` を明示した呼び出しとしていない呼び出しが同居するため。
// `vi.setSystemTime` の有無を見ない: システム時刻を固定しても TZ は固定されないため。
// helper 関数経由は対象外で `*.test.ts` / `*.test.tsx` だけを見る: helper の中身を書くたびに誤検出させないため。

const CATEGORY_A_PATTERNS = [
  { name: 'new Date(年, 月, …)', re: /\bnew Date\(\s*\d+\s*,/g },
  { name: '.getHours()', re: /\.getHours\(\)/g },
  { name: '.getDate()', re: /\.getDate\(\)/g },
  { name: '.getDay()', re: /\.getDay\(\)/g },
  { name: '.getMonth()', re: /\.getMonth\(\)/g },
  { name: '.getFullYear()', re: /\.getFullYear\(\)/g },
  { name: '.getMinutes()', re: /\.getMinutes\(\)/g },
  { name: '.getTimezoneOffset()', re: /\.getTimezoneOffset\(\)/g },
];

const CATEGORY_B_PATTERNS = [
  { name: 'Intl.DateTimeFormat(', re: /\bIntl\.DateTimeFormat\(/g },
  { name: '.toLocaleDateString(', re: /\.toLocaleDateString\(/g },
  { name: '.toLocaleTimeString(', re: /\.toLocaleTimeString\(/g },
];

const NEARBY_WINDOW = 6;

const TZ_PIN_RE = /process\.env\.TZ\s*=|vi\.stubEnv\(\s*['"]TZ['"]/;

export function findTzApiHits(files) {
  const hits = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { name, re } of CATEGORY_A_PATTERNS) {
        re.lastIndex = 0;
        if (re.test(line))
          hits.push({ path: file.path, line: i + 1, matched: name, category: 'A' });
      }
      for (const { name, re } of CATEGORY_B_PATTERNS) {
        re.lastIndex = 0;
        if (re.test(line)) {
          const windowEnd = Math.min(lines.length, i + 1 + NEARBY_WINDOW);
          const nearby = lines.slice(i, windowEnd).join('\n');
          const exempt = /timeZone/.test(nearby);
          hits.push({ path: file.path, line: i + 1, matched: name, category: 'B', exempt });
        }
      }
    }
  }
  return hits;
}

export function isTzPinned(content) {
  return TZ_PIN_RE.test(content);
}

export function needsTzPin(fileHits) {
  const categoryA = fileHits.filter((h) => h.category === 'A');
  if (categoryA.length > 0) return true;
  return fileHits.some((h) => h.category === 'B' && !h.exempt);
}

export function formatTzGuardMessage(violations) {
  const byPath = new Map();
  for (const h of violations) {
    if (!byPath.has(h.path)) byPath.set(h.path, []);
    byPath.get(h.path).push(h);
  }
  const lines = [];
  for (const [path, hs] of byPath) {
    lines.push(`  ${path}:`);
    for (const h of hs) {
      lines.push(
        `    :${h.line}  ${h.matched}${h.category === 'B' && !h.exempt ? '（近くに timeZone 無し）' : ''}`,
      );
    }
  }
  return [
    `check-test-tz-fixed: TZ に依存するテストファイルが ${byPath.size} 件、TZ を自分で固定していない:`,
    ...lines,
    '',
    '対策は2つ — (1) process.env.TZ を（module 読み込み前に効かせるなら vi.hoisted の',
    'なかで）固定する（apps/web/app/routes/reports.test.tsx の実例と理由を読むこと）。',
    '(2) Intl.DateTimeFormat / toLocaleDateString / toLocaleTimeString の呼び出しに',
    "{ timeZone: '...' } を明示する（packages/core/src/usage-reset-text.test.ts の実例）。",
    '実測で TZ 非依存だと確認できたなら、理由つきで',
    'scripts/check-test-tz-fixed-core.mjs の ALLOWLIST へ追加する。',
  ].join('\n');
}

export function formatStaleAllowlistMessage(stalePaths) {
  return [
    `check-test-tz-fixed: 許可リストに載っているが、もう TZ 固定が必要な hit が無いファイルが ${stalePaths.length} 件ある:`,
    ...stalePaths.map((p) => `  ${p}`),
    '',
    '固定した・呼び出しを消した等で該当しなくなったなら、',
    'scripts/check-test-tz-fixed-core.mjs の ALLOWLIST からその行を消すこと。',
  ].join('\n');
}

export function judgeTzScan(matchedPaths, hits, allowlist, pinnedPaths = new Set()) {
  if (matchedPaths.length === 0) {
    return {
      ok: false,
      kind: 'scan-empty',
      message: [
        'check-test-tz-fixed: 判定できない — 走査対象が0ファイルだった。',
        'root の vitest.config.ts の include に一致するテストファイルが1件も見つからない。',
        'include の glob 展開に失敗した、走査の起点がずれた、などが疑われる',
        '（test-guard-core.mjs の EXIT_SCAN_EMPTY と同じ状態）。',
      ].join('\n'),
    };
  }

  const byPath = new Map();
  for (const h of hits) {
    if (!byPath.has(h.path)) byPath.set(h.path, []);
    byPath.get(h.path).push(h);
  }

  const needsPinPaths = new Set();
  for (const [path, fileHits] of byPath) {
    if (pinnedPaths.has(path)) continue;
    if (needsTzPin(fileHits)) needsPinPaths.add(path);
  }

  const violations = hits.filter(
    (h) => needsPinPaths.has(h.path) && !allowlist.has(h.path) && (h.category === 'A' || !h.exempt),
  );
  if (violations.length > 0) {
    return { ok: false, kind: 'violation', message: formatTzGuardMessage(violations) };
  }

  const stalePaths = [...allowlist.keys()].filter((p) => !needsPinPaths.has(p));
  if (stalePaths.length > 0) {
    return { ok: false, kind: 'stale-allowlist', message: formatStaleAllowlistMessage(stalePaths) };
  }

  return { ok: true, scanned: matchedPaths.length, allowlisted: allowlist.size };
}

export const ALLOWLIST = new Map([
  [
    'apps/daemon/src/app.test.ts',
    '`new Date(2026, 0, i + 1)` はページングの並び順を作るためだけの入力で、' +
      'ISO 文字列を相対比較・件数比較にしか使っていない（絶対値をハードコードした期待値と' +
      '突き合わせていない）。`vi.setSystemTime` も同様、相対的な「経過」を測る入力。',
  ],
  [
    'packages/core/src/digest.test.ts',
    '`since` と `at` を両方とも同じ `new Date(2026, 7, 14, …)` で作り、その場で' +
      '`usageDate(at)` に通して消費する——構築と消費が同じプロセス内の同じ TZ で対になっている。',
  ],
  [
    'packages/core/src/schedule.test.ts',
    '`anchor` / `before` / `after` / `expected` をすべて `new Date(2026, …)` で作り、' +
      '`.getTime()` の差分や `nextAt()` の戻り値との相互比較にしか使っていない。' +
      '`.getSeconds()` は秒までしか見ておらず、秒は TZ offset の影響を受けない。',
  ],
  [
    'packages/core/src/stale-redelivery-batch.test.ts',
    '`new Date(2026, 0, 1, 0, 0, 0, i % 1000).toISOString()` は、大量のイベントに' +
      '単調増加する id を割り振るためだけの入力（`removeMany` の呼び出し回数を数える' +
      'テストで、絶対時刻の値そのものは検証していない）。',
  ],
  [
    'packages/core/src/tools.test.ts',
    '5017行目付近の `today.getFullYear()/getMonth()/getDate()` は `new Date()`（今の' +
      '瞬間）を同じプロセス内でそのまま読み戻して期待値を組み立てているので、器の TZ が' +
      '何であれ自分自身と一致する。13577行目付近は digest.test.ts と同型（構築と消費が対）。',
  ],
  [
    'packages/core/src/usage.test.ts',
    '`usageDate()` は設計として「ローカル時刻で切る」仕様であることが同ファイルの' +
      'コメント（「ローカル時刻で切る（日報の「今日」と揃える）」）に明記されている。' +
      '`new Date(2026, 7, 14, 1, 30)` の構築とその読み取りが同じプロセス内の同じ TZ で' +
      '対になるので、器の TZ に関わらず期待値と一致する。',
  ],
]);
