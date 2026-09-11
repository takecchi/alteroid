/**
 * **恒久的な許可の規則**（SDK の `Options.allowedTools` へ載せる allow rule）。
 *
 * `permission-mode.ts` と対になる。あちらは「確認をどう扱うか」（モード）を1か所に
 * 集めていて、こちらは「**どの行為を、確認なしで通すか**」を1か所に集める。
 * 判定が層ごとに散るのを止めるという狙いは同じである。
 *
 * ## なぜ要るのか
 *
 * クローンの本セッションは `permissionMode: 'auto'` で、しかも `canUseTool` を
 * 繋いでいない（理由は `claude-provider.ts` の `buildCloneSessionOptions` にある）。
 * ＝ **確認に答える相手がこのセッションには居ない。** SDK はその状態を型コメントで
 * こう言っている。
 *
 * [sdk-verbatim Options.permissionPrompts]
 * > permission mode (including auto mode's classifier), rules and hooks still
 *
 * 続きは「確認になるはずだったものは即座に拒否される」である。**つまり auto の
 * 既定では、確認へ倒れる行為は一度も実行されない。** 通したい行為が在るなら、
 * 確認へ倒れる前に当たる規則（rule）を置くしかない。
 *
 * [sdk-verbatim Options.allowedTools]
 * > List of tool names that are auto-allowed without prompting for permission.
 *
 * ## なぜ**コードに**置くのか（設定ファイルではなく）
 *
 * デーモンの器はデプロイのたびに作り直される。`~/.claude/settings.json` も
 * `$ALTEROID_HOME` の下も**イメージの層かその上の書き込み**であって、器が
 * 入れ替われば消える。そして `settingSources` の `'project'` が解決する先は
 * **セッションの cwd** であって、リポジトリのチェックアウトではない
 * （同じ事実の別の帰結を `prompt.ts` の `buildManagerSystemPrompt` の doc が
 * 「指示文書の所在をここに書く理由」として持っている —— マネージャーの cwd は
 * workspace の根で、リポジトリはその1階層下なので、`'project'` の解決先に
 * リポジトリの設定も指示文書も無い）。⟹ **`.claude/settings.json` を repo へ
 * コミットしても、クローンのセッションがそれを読む保証は無い。**
 *
 * ここはソースなので `pnpm build` の成果物に入り、イメージに焼かれ、
 * **器が入れ替わっても同じ値がセッションへ渡る。** 永続ボリュームにも
 * 人間の手作業にも依存しない。
 *
 * ## 規則の形（なぜこの形か）
 *
 * 通したいのは1つだけ ——「virchamate の Draft release を publish する」である。
 * `gh` は positional 引数より前にフラグを置けるので、**変わるのは末尾の tag だけ**に
 * できる:
 *
 * ```
 * gh release edit --repo virchamate/virchamate-backend --draft=false <tag>
 * ```
 *
 * だから末尾だけが開いた前方一致（`:*`）でちょうど書ける。**`:*` は末尾に無いと
 * 規則として不正で、末尾に在るときだけ「それ以降は何でもよい」を意味する。**
 * そして SDK 同梱の規則検査は、**`:*` で終わる規則に対しては「コマンド途中の
 * ワイルドカード」警告を出さない**（検査関数の最初の分岐が `:*` 終わりを
 * そのまま通す）。**末尾以外に `*` を置く形を採らなかったのはこのためである。**
 *
 * **広げない線を、形そのもので引いている:**
 *
 * | 書かなかった形                  | 書いていたら通ってしまうもの       |
 * | ------------------------------- | ---------------------------------- |
 * | `Bash(gh release:*)`            | `gh release delete`（リリースの削除） |
 * | `--draft=false` を含めない形    | `--draft=true`（公開の取り消し）   |
 * | repo 名をワイルドカードにする形 | virchamate の他のすべての repo     |
 *
 * **⚠️ 規則の文字列にコンマを入れないこと。** SDK はこの配列を `,` で繋いで
 * `--allowedTools` の**1引数**にする（`sdk.mjs` の引数組み立てが `join(",")` で
 * 繋いでいる）。⟹ **コンマを含む規則は、その位置で2本の別々の規則として割れる。**
 * 割れた片方が何に当たるかは誰も宣言していない ＝ **書いた人が意図していない
 * 広さが、静かに通る。** {@link CLONE_ALLOWED_PERMISSION_RULES} の全要素に
 * コンマが無いことは歯で固定してある（`permission-rules.test.ts`）。
 *
 * **⚠️ ここは「能力の制限」の話ではない。** `allowedTools` は確認なしで通す一覧で
 * あって、使える道具の一覧ではない（SDK の逐語は `claude-provider.ts` にある）。
 * この配列が空でも、道具は1つも減らない。
 */

/**
 * publish を通す repo（`owner/name`）。**2つだけを名指しする。**
 *
 * ワイルドカードにしない理由は上の表のとおりで、いま要るのがこの2つだからである。
 * 3つ目が要るようになったら、そのときにここへ書き足す判断を人間が1回する。
 */
export const RELEASE_PUBLISH_REPOS = [
  'virchamate/virchamate-backend',
  'virchamate/virchamate-frontend',
] as const;

/**
 * `<owner>/<name>` の Draft release を publish する1本ぶんの allow rule を作る。
 *
 * **`--draft=false` をここに焼き込んであるのが本題である。** 引数にすると
 * 「`--draft=true` も同じ関数で書ける」形になり、**広げるほうの変更が
 * 「引数を1つ変えるだけ」に見えてしまう。**
 */
export function releasePublishRule(repo: string): string {
  return `Bash(gh release edit --repo ${repo} --draft=false:*)`;
}

/**
 * クローン本セッションの `allowedTools` へ足す規則の全部。
 *
 * **ここに足すものは「クローンが、人間に聞かずに実行してよい」と人間が決めた行為
 * だけである。** 蒸留のサイドクエリとマネージャーには渡さない —— 前者は記憶を
 * 書くための短命セッションで publish する理由が無く、後者は `canUseTool` が
 * 繋がっているので確認がクローンへ回る（＝答える相手が既に居る）。
 */
export const CLONE_ALLOWED_PERMISSION_RULES: readonly string[] =
  RELEASE_PUBLISH_REPOS.map(releasePublishRule);
