/**
 * `--help` の末尾に足す「例:」（#2857）。引数の形が分かりにくいコマンドだけに足す。
 *
 * **コマンドの木から引ける形にしてある**（`index.ts` が `addHelpText('after', ...)` へ渡す）。
 * 例の中のコマンド・オプション名が登録と食い違っていないかは `help-examples.test.ts` が
 * 実際に解析して確かめる。
 */

function examples(...lines: string[]): string {
  return `\n例:\n${lines.map((line) => `  ${line}`).join('\n')}\n`;
}

export const HELP_EXAMPLES = {
  conversationsShow: examples(
    'alteroid conversations list              # id を見つける',
    'alteroid conversations show <id>         # その会話の中身を古い順に',
  ),
  usage: examples(
    'alteroid usage                                      # 全期間',
    'alteroid usage --from 2026-09-01 --to 2026-09-30    # 日付の範囲',
    'alteroid usage --layer clone --site session         # クローンの会話の分だけ',
  ),
  inboxRemove: examples(
    'alteroid inbox show                                          # まず内訳を見る',
    'alteroid inbox remove --types timer --reason "古い定期の合図"            # 試算（消さない）',
    'alteroid inbox remove --types timer --reason "古い定期の合図" --execute  # 実際に消す',
  ),
  accessGrant: examples(
    'alteroid access list                    # アカウントの id を見つける',
    'alteroid access grant <accountId>       # その id に許可を与える',
  ),
  accessRevoke: examples(
    'alteroid access list                    # アカウントの id を見つける',
    'alteroid access revoke <accountId>      # その id の許可を取り消す',
  ),
  progress: examples(
    'alteroid progress                       # 既定の窓で',
    'alteroid progress --window-hours 24     # 直近24時間の消化で見込みを出す',
  ),
  memorySet: examples(
    'alteroid memory set values -f ./values.md            # ファイルの中身で置き換える',
    'cat ./values.md | alteroid memory set values         # 標準入力から',
    'alteroid memory edit values                          # エディタで開く（VISUAL か EDITOR）',
  ),
  practiceShow: examples(
    'alteroid practice show release-checklist               # いまの本文',
    'alteroid practice history release-checklist            # 版の一覧',
    'alteroid practice show release-checklist --version 2   # 版 2 の本文',
  ),
  practiceSet: examples(
    'alteroid practice set release-checklist -f ./p.md --kind <種類> --title "リリース手順"',
    '  （新しいやり方は --kind と --title が両方要る。置いてあるものの書き換えでは省ける）',
    'alteroid practice list                                  # いまある slug と種類を見る',
  ),
  profileSet: examples(
    'alteroid profile set -f ./setup.sh                       # 名前を省くと default',
    'alteroid profile set gh-login -f ./gh.sh --scope runner  # manager だけに撒く',
    'alteroid profile list                                    # いま置いてあるもの',
  ),
  mcpSet: examples(
    'alteroid mcp set ./.mcp.json            # ファイルの内容で丸ごと置き換える',
    'cat ./.mcp.json | alteroid mcp set -    # 標準入力から（- を付ける）',
    'alteroid mcp edit                       # エディタで開く（VISUAL か EDITOR）',
  ),
  tokenPolicy: examples(
    'alteroid token policy                                  # いまの設定を見る',
    'alteroid token policy free_exhausted                   # 無料枠が尽きたら回す',
    'alteroid token policy off --cooldown-ms 18000000       # 回さない。冷却の既定は5時間',
  ),
} as const;
