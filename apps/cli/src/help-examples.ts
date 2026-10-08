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
    'alteroid access revoke <accountId>      # その id の許可を取り消す（対話で確認。省くなら --yes）',
  ),
  progress: examples(
    'alteroid progress                       # 既定の窓で',
    'alteroid progress --window-hours 24     # 直近24時間の消化で見込みを出す',
  ),
  attachmentsPut: examples(
    'alteroid attachments put ./run.log           # 上げて id を出す（1 時間以内に発言へ添える）',
    'alteroid attachments put ./run.log --keep    # 保存して上げる（期限なし。消すのは rm）',
  ),
  attachmentsLs: examples(
    'alteroid attachments ls                          # 新しい順に 50 件と使用量',
    'alteroid attachments ls --kept --from human      # 人間が上げて保存中のもの',
    'alteroid attachments ls --query log --all        # 名前に log を含むものを全部',
    'alteroid attachments ls --all --json | jq ".items[].id"',
    'alteroid attachments keep <id>                   # 保存の印を付ける（unkeep で外す）',
    'alteroid attachments rm <id>                     # 消す（取り消せない。対話で確認。省くなら --yes）',
  ),
  attachmentsGet: examples(
    'alteroid attachments meta <id>              # 名前・種類・大きさを見る',
    'alteroid attachments get <id>               # 控えの名前でカレントに保存',
    'alteroid attachments get <id> -o out.log    # 保存先を指定',
    'alteroid attachments get <id> -o -          # 標準出力へ',
  ),
  memorySet: examples(
    'alteroid memory set values -f ./values.md            # ファイルの中身で置き換える',
    'cat ./values.md | alteroid memory set values --yes   # 標準入力から（端末ではないので、置き換えの確認は --yes で省く）',
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
    'cat ./.mcp.json | alteroid mcp set - --yes    # 標準入力から（- を付ける。端末ではないので確認は --yes で省く）',
    'alteroid mcp edit                       # エディタで開く（VISUAL か EDITOR）',
  ),
  pluginAdd: examples(
    'alteroid plugin add https://github.com/owner/repo.git --path plugins/foo --ref v1.0.0   # URL。中身を見て確認してから入れる',
    'alteroid plugin add some-plugin                          # 公式 marketplace の plugin 名',
    'alteroid plugin add some-plugin --scope runner --enable-mcp --yes   # 非対話（確認を省く）',
  ),
  integrationCreate: examples(
    'alteroid integration create --name "CI" --source ci.main              # 無期限・既定の上限',
    'alteroid integration create --name "CI" --source ci.main --expires 90d --rate-per-minute 10',
    'alteroid integration create --name "CI" --source ci.main --json      # 値は標準出力の JSON（value）。警告は標準エラー。値をログに残さない',
    'alteroid integration list                                             # 状態・最終使用を見る',
  ),
  tokenPolicy: examples(
    'alteroid token policy                                  # いまの設定を見る',
    'alteroid token policy free_exhausted                   # 無料枠が尽きたら回す',
    'alteroid token policy off --cooldown-ms 18000000       # 回さない。冷却の既定は5時間',
  ),
} as const;
