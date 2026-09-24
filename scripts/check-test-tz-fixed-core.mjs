/**
 * テストファイルが TZ 依存の Date API を使っているのに、TZ を自分で固定して
 * いない（＝器の時間帯に任せている）ことを検出する静的な歯（Issue #1192 N4）
 * の中核。`scripts/check-test-tz-fixed.test.ts` が読む。
 *
 * ## 背景（2026-09-19 の測定との食い違い）
 *
 * #1192 のコメント（2026-09-19T17:16Z）は N4 を「該当が実測0件（1件グレー）
 * ⟹ 費用対効果が低い」と評価していた。今回、粗い grep（`toLocale(String|
 * DateString|TimeString)` / `Intl\.DateTimeFormat` / `\.get(Hours|Date|Day|
 * Month|FullYear|Minutes)\(\)` / `getTimezoneOffset` / `new Date\(<数字>, `）を
 * 当てると、追跡テストファイルのうち14件が当たる。だが**その大半は誤検出**
 * だった —— 内訳と実測は `scripts/check-test-tz-fixed.test.ts` の doc、および
 * この PR の本文に書く。
 *
 * ## 2値では足りない理由（`toLocaleString` を外した理由）
 *
 * `Number.prototype.toLocaleString('en-US')`（桁区切りを入れるためだけの
 * 呼び出し）は**TZ に依存しない**（ロケールだけの話）。`Date.prototype.
 * toLocaleString` は TZ に依存するが、静的な正規表現では受け手が `Date` か
 * `Number` かを区別できない。この repo の実測（2026-09-25）では、`.toLocale
 * String(` の使用14件中13件が文字数・トークン数などの数値の桁区切り目的
 * だった（`packages/core/src/{clone,memory,quantity,self,tools}.test.ts`）。
 * ⟹ `toLocaleString` を検出対象から**意図的に外す**。代わりに `Date` にしか
 * 無いメソッド（`toLocaleDateString` / `toLocaleTimeString`）と、`Date` の
 * 素の getter（`getHours` 等、引数無し）・`new Date(年, 月, …)` の複数引数
 * コンストラクタ・`getTimezoneOffset` だけを見る —— これらは `Number` /
 * `BigInt` には存在しない、または存在しても意味が異なるので受け手の曖昧さが
 * 無い。
 *
 * ## 2つのカテゴリ（exempt できるか否かで分ける）
 *
 * - **カテゴリA（TZ を固定する以外に逃げ場が無い）**: `new Date(年, 月, …)`
 *   の複数引数コンストラクタ、`.getHours()` / `.getDate()` / `.getDay()` /
 *   `.getMonth()` / `.getFullYear()` / `.getMinutes()`（引数無し）、
 *   `.getTimezoneOffset()`。これらは呼び出し側でオプションを渡しても
 *   TZ 依存を打ち消せない —— 器の TZ を固定する（`process.env.TZ` を書き
 *   換える、または `vi.stubEnv('TZ', …)`）以外に安全にする方法が無い。
 * - **カテゴリB（呼び出し側で `timeZone` を明示すれば TZ 非依存にできる）**:
 *   `Intl.DateTimeFormat(` / `.toLocaleDateString(` / `.toLocaleTimeString(`。
 *   これらは第2引数に `{ timeZone: '...' }` を渡せば器の TZ を読まなくなる
 *   （`packages/core/src/usage-reset-text.test.ts` の実例）。
 *
 * 判定: カテゴリAの hit が1つでもあれば、ファイルは TZ を自分で固定する
 * （`process.env.TZ` 代入または `vi.stubEnv('TZ', …)`）以外の逃げ場が無い。
 * カテゴリBだけの hit なら、その呼び出しの近く（`NEARBY_WINDOW` 行以内）に
 * `timeZone` という語があれば免除する —— **ファイル全体ではなく呼び出しに
 * 近い窓で見る**（複数の `Intl.DateTimeFormat` 呼び出しが1ファイルに同居し、
 * 一部だけ `timeZone` を明示している場合を区別するため）。
 *
 * ## この歯の限界（doc に書いておく —— ここが対象外）
 *
 * - **`NEARBY_WINDOW` 行以内という窓は近似である。** 呼び出しの直後の行に
 *   `timeZone` が無くても、もっと離れた行にオプションが書かれていれば
 *   見逃す（false negative）。逆に窓の中に**別の**呼び出しの `timeZone` が
 *   偶然入ってしまえば見逃す方向にも倒れうる。窓を大きくするほど誤って
 *   免除する方向に、小さくするほど誤って検出する方向に倒れる —— 6行という
 *   値は `usage-reset-text.test.ts` の実例（呼び出しの1行後に `timeZone` が
 *   来る）を通すのに十分な値として選んだだけで、厳密な解析ではない。
 * - **テストファイル以外（helper 関数）経由の間接呼び出しは対象外。**
 *   `no-direct-mkdtemp-core.mjs` と同じ理由 —— helper 関数の中身を書くたびに
 *   誤検出させないため、`*.test.ts` / `*.test.tsx` だけを見る。
 * - **`vi.setSystemTime` / `vi.useFakeTimers` でシステム時刻を固定しても、
 *   TZ そのものは固定されない。** 「今日が何日か」を固定していても、
 *   その日付をカテゴリAの API で読む・作るコードは、依然として器の TZ を
 *   読む。この歯は `vi.setSystemTime` の有無を見ない —— 見ているのは TZ の
 *   固定（`process.env.TZ` / `vi.stubEnv('TZ', …)`）の有無だけである。
 * - **文字列の形だけを見る。** テンプレートリテラルや変数経由で組み立てた
 *   呼び出しは検出できない。
 * - **`Intl.DateTimeFormat` の `resolvedOptions().timeZone` のような読み取り
 *   専用の使い方も、字面に `Intl.DateTimeFormat(` を含む限り同じにカテゴリB
 *   として扱う。** 区別は複雑になるので、その先の意味までは見ていない。
 *
 * ## 許可リスト
 *
 * `ALLOWLIST` は、カテゴリAの hit を持つが自分で TZ を固定していない
 * ファイルのうち、**実測でTZ非依存であることを個別に確かめたもの**を
 * 理由つきで載せる。理由は「たまたま今は落ちない」ではなく、**なぜ
 * TZ非依存になるのか**（局所的な構築と消費が対になっている、など）を書く
 * ——`no-direct-mkdtemp-core.mjs` の許可リストと同じ作法。
 */

/** カテゴリA: TZ を固定する以外に逃げ場が無い API。 */
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

/** カテゴリB: `timeZone` を明示すれば TZ 非依存にできる API。 */
const CATEGORY_B_PATTERNS = [
  { name: 'Intl.DateTimeFormat(', re: /\bIntl\.DateTimeFormat\(/g },
  { name: '.toLocaleDateString(', re: /\.toLocaleDateString\(/g },
  { name: '.toLocaleTimeString(', re: /\.toLocaleTimeString\(/g },
];

/** カテゴリBの免除を探す窓（呼び出しの行から何行先までを見るか）。doc 参照。 */
const NEARBY_WINDOW = 6;

/** ファイル自身が TZ を固定しているか（`process.env.TZ` 代入 / `vi.stubEnv('TZ', …)`）。 */
const TZ_PIN_RE = /process\.env\.TZ\s*=|vi\.stubEnv\(\s*['"]TZ['"]/;

/**
 * `files`（`{ path, content }` の配列）を走査し、TZ 依存 API の使用箇所を
 * 返す。ディスクを読まない純粋関数。
 */
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

/** ファイルが TZ を自分で固定しているか。 */
export function isTzPinned(content) {
  return TZ_PIN_RE.test(content);
}

/**
 * `hits`（1ファイル分、`findTzApiHits` の戻りをファイルでまとめたもの）から、
 * そのファイルが「TZ を固定すべきなのに固定していない」状態かを判定する。
 * - カテゴリAの hit が1つでもあれば固定必須。
 * - カテゴリBだけなら、全部 `exempt: true`（近くに `timeZone` あり）なら不要。
 */
export function needsTzPin(fileHits) {
  const categoryA = fileHits.filter((h) => h.category === 'A');
  if (categoryA.length > 0) return true;
  return fileHits.some((h) => h.category === 'B' && !h.exempt);
}

/** 歯が落ちたときの文言（TZ 固定が要るのに固定していない）。 */
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

/** 歯が落ちたときの文言（許可リストが古びている＝もう該当しない）。 */
export function formatStaleAllowlistMessage(stalePaths) {
  return [
    `check-test-tz-fixed: 許可リストに載っているが、もう TZ 固定が必要な hit が無いファイルが ${stalePaths.length} 件ある:`,
    ...stalePaths.map((p) => `  ${p}`),
    '',
    '固定した・呼び出しを消した等で該当しなくなったなら、',
    'scripts/check-test-tz-fixed-core.mjs の ALLOWLIST からその行を消すこと。',
  ].join('\n');
}

/**
 * 歯の最終判定。3値: `matchedPaths.length === 0` → 判定できない /
 * 固定が要るのに固定していないファイルが在る（許可リストに無い）→ 検出 /
 * 許可リストが古びている → 検出 / それ以外 → 合格。ディスクを読まない純粋関数。
 *
 * `pinnedPaths`（省略可）は `isTzPinned` で「自分で TZ を固定している」と
 * 判定されたファイルの相対パス集合。固定済みのファイルは、カテゴリAの hit が
 * 在っても「固定が要るのに固定していない」から除外する——固定していれば
 * カテゴリAの hit があっても安全なので、そこが `needsTzPin`（hit の中身だけを
 * 見る、固定の有無を知らない純粋関数）との役割分担になる。
 */
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
    if (pinnedPaths.has(path)) continue; // 自分で固定済みなら「要るのに無い」からは除外
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

/**
 * 許可リスト（相対パス → 理由）。`findTzApiHits` のカテゴリAの hit を持ち、
 * かつ `process.env.TZ` / `vi.stubEnv('TZ', …)` による自前の固定を持たない
 * ファイルのうち、実測（2026-09-25、TZ=UTC / Asia/Tokyo / Pacific/Kiritimati
 * の3本、対象14ファイル計2214テストで乖離0件）で TZ 非依存だと確認した
 * ものを理由つきで載せる。
 *
 * 共通する理由: いずれも **ローカル時刻での構築と消費が対になっている**
 * （`new Date(年, 月, 日, …)` で作った値を、同じプロセス内でそのまま
 * `.getFullYear()` 等のローカル getter で読み戻す、または `.toISOString()` に
 * 通した値どうしを相対比較する）。だから実際の offset がどの値でも、
 * 構築側と消費側が同じ offset で相殺し、結果の文字列・比較結果は変わらない。
 * これは `apps/web/app/routes/reports.test.tsx` が直した回帰
 * （フォーマットした文字列をハードコードした期待値と突き合わせる形——TZ が
 * 一度しか登場せず相殺しない）とは異なる形である。
 */
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
