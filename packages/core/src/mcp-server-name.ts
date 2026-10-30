// alteroid 自身の MCP サーバの名前。tools.ts（道具名の接頭辞）と mcp-servers-schema.ts（この名前の登録を断る）が同じものを使う。
// 何も import しない小さな入口に置く: ブラウザの束（web の保存前の検査）へ tools.ts を引き込まないため
export const MCP_SERVER_NAME = 'alteroid';
