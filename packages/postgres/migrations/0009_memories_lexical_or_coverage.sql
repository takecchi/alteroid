-- 0009_memories_lexical_or_coverage.sql
--
-- ADR 0092（クエリ語彙を OR で結び、lexicalMatch を被覆率にする。Issue #106、
-- ADR 0084 §10「検討した代替案」が示した独立の変更）。
--
-- ## 何を変えるか
--
-- `migrations/0008_memories_lexical_index.sql` の `mnemora_lexical_normalize` /
-- `mnemora_lexical_query_terms` 関数と `idx_memories_lexical` 式索引は**一切変えない**
-- （マイグレーションは追記のみ。索引の左辺の式は 0008 のままで、この移行後も同じ
-- 式索引が選ばれる——`buildLexicalSearchSelect` の `WHERE` の左辺は字句どおり
-- `to_tsvector('simple', mnemora_lexical_normalize(content))` のままである）。
--
-- 変わるのは `WHERE` の右辺（`@@` の相手）と `ORDER BY` の式だけである。ADR 0084 は
-- クエリ全体を1つの `websearch_to_tsquery` に渡していた（既定の空白区切りは AND）。
-- ここでは**クエリを語ごとに分解し、語ごとの tsquery を OR で結ぶ**。
--
-- ## なぜ語ごとに `"..."` で囲むか
--
-- `websearch_to_tsquery` の演算子（`-` = NOT、`or`、`"..."` = フレーズ）を、
-- 語1つ1つの単位で誤って解釈させないためである。囲まないと、例えば
-- クエリ "what did we say about -1234"（ハイフンから始まる語がたまたま混じる場合）の
-- ような入力で `-1234` が NOT 演算子として解釈され、OR で結んだときに
-- **ほぼ全件に一致する**tsquery になりかねない。各語を `"<語>"` というフレーズとして
-- 渡すことで、演算子ではなく文字列そのものとして解釈させる。
--
-- **副作用として、フレーズ化は識別子の隣接要求を保つ**——`"PROJ-1234"` は
-- `'proj' <-> '-1234'`（隣接必須）になる。これは 0008 のコメントが実測した
-- 「`plainto_tsquery` は隣接を要求しないため `PROJ-1234 and TASK-5678` を含む本文に
-- `PROJ-5678` が偽陽性で一致する」という失敗を、語ごとに OR で結んだ後も避け続ける
-- ために必須である（`websearch_to_tsquery` はもともと隣接を要求する。囲むかどうかで
-- 変わるのは演算子解釈の有無であり、隣接要求はどちらでも成立する）。
--
-- **⚠ もう1つの副作用**: 生クエリに含まれる websearch の演算子（`-`/`or`/`"..."`）が、
-- 語単位に分解された時点でもう解釈されなくなる。これは意図した変更である——
-- `packages/testkit` の `InMemoryLexicalStore` はもともと websearch の演算子を
-- 一切解釈しない（doc に明記されている）ので、この変更は postgres 実装と
-- in-memory 実装の差を縮める方向に働く。詳細と、採らなかった案は
-- [ADR 0092](../../../docs/decisions/0092-lexical-or-coverage.md) を参照。
--
-- ## 3つの関数
--
-- (a) `mnemora_lexical_query_tsqueries(text) RETURNS tsquery[]`
--     クエリ文字列を語に分解し（`mnemora_lexical_query_terms` を呼ぶ。正規表現は
--     書き写さない）、語ごとに `"<語>"` を websearch_to_tsquery へ渡した結果を
--     配列にする。空の tsquery（記号だけの語等）は落とす。
-- (b) `mnemora_lexical_query_or(text) RETURNS tsquery`
--     (a) の配列を `|`（OR）で畳んで1つの tsquery にする。1語も無ければ
--     空の tsquery を返す（空の tsquery は `@@` で常に false になる。
--     `lexical-store.ts` の doc・0008 のコメント参照）。
-- (c) `mnemora_lexical_coverage(content text, query text) RETURNS float8`
--     (a) の配列のうち、`content` の tsvector（本文側の正規化を通す）に一致する
--     tsquery の個数を数え、配列の要素数で割る。**一致した語彙数 ÷ クエリ語彙の総数**
--     ——これが `LexicalHit.coverage`（`@mnemora/core`）にそのまま入る値である。
--
-- IMMUTABLE / PARALLEL SAFE の理由は 0008 の関数と同じ（テーブル参照・現在時刻参照・
-- 設定参照が無い。`to_tsvector`/`websearch_to_tsquery` は config 引数がリテラル定数
-- （'simple'）であるため IMMUTABLE として扱える——`idx_memories_lexical` の式索引が
-- 同種の呼び出しで既に成立していることがその根拠である）。
--
-- ⚠ この SQL はマネージャーが手元の PostgreSQL 無しで書き、本 PR の作業者が構文・意味を
-- 確認したものだが、**本物の PostgreSQL に対しては CI でしか実行できていない**
-- （このリポジトリのこの作業環境には psql も DATABASE_URL も無い）。特に
-- `array_agg(DISTINCT q)`（tsquery の DISTINCT）と、文字列連結からの `::tsquery` への
-- 再パースが疑わしい点として残る——CI が赤ければ、まずこの2点を疑うこと。

CREATE FUNCTION mnemora_lexical_query_tsqueries(text) RETURNS tsquery[] AS $$
  SELECT coalesce(array_agg(DISTINCT q), ARRAY[]::tsquery[])
  FROM (
    SELECT websearch_to_tsquery('simple', '"' || replace(t, '"', '') || '"') AS q
    FROM unnest(regexp_split_to_array(btrim(mnemora_lexical_query_terms($1)), '\s+')) AS t
    WHERE t <> ''
  ) s
  WHERE q::text <> '';
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

CREATE FUNCTION mnemora_lexical_query_or(text) RETURNS tsquery AS $$
  SELECT coalesce(
    (SELECT string_agg('(' || q::text || ')', ' | ')
       FROM unnest(mnemora_lexical_query_tsqueries($1)) AS q)::tsquery,
    ''::tsquery);
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

CREATE FUNCTION mnemora_lexical_coverage(content text, query text) RETURNS float8 AS $$
  SELECT count(*) FILTER (
           WHERE to_tsvector('simple', mnemora_lexical_normalize(content)) @@ tq
         )::float8 / NULLIF(count(*), 0)
  FROM unnest(mnemora_lexical_query_tsqueries(query)) AS tq;
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;
