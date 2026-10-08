// clone-tool-relay-child.ts の中に置かない: clone.ts からも import されると、tsup がそのモジュールを共有チャンクへ括り出し、子プロセスとして spawn しても invokedDirectly() が真にならず中継が起動しないため
export const CLONE_TOOL_RELAY_SOCKET_ENV = 'ALTEROID_CLONE_TOOL_RELAY_SOCKET';
export const CLONE_TOOL_RELAY_TOKEN_ENV = 'ALTEROID_CLONE_TOOL_RELAY_TOKEN';
