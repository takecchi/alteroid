import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

// #6753: SDK の `tools/list` は zod の `toJSONSchema` を draft-7 固定で呼び、道具の schema ごとに
// `"$schema": "http://json-schema.org/draft-07/schema#"` が付く。モデルには何も伝えず、毎ターンの固定量になる。
// SDK に落とす口が無いので、公開の `connect(transport)` の送信側で `tools/list` の応答だけから `$schema` を外す
// （SDK の非公開の構造には触れない）。

function stripSchemaKey(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return schema;
  const rest = { ...(schema as Record<string, unknown>) };
  delete rest.$schema;
  return rest;
}

function stripToolsListMessage(message: JSONRPCMessage): JSONRPCMessage {
  if (!('result' in message)) return message;
  const result = message.result as { tools?: unknown } | undefined;
  if (!Array.isArray(result?.tools)) return message;
  const tools = result.tools.map((tool: unknown) => {
    if (typeof tool !== 'object' || tool === null) return tool;
    const entry = tool as Record<string, unknown>;
    return {
      ...entry,
      ...('inputSchema' in entry ? { inputSchema: stripSchemaKey(entry.inputSchema) } : {}),
      ...('outputSchema' in entry ? { outputSchema: stripSchemaKey(entry.outputSchema) } : {}),
    };
  });
  return { ...message, result: { ...message.result, tools } };
}

function leanTransport(transport: Transport): Transport {
  return new Proxy(transport, {
    get(target, prop) {
      if (prop === 'send') {
        return (message: JSONRPCMessage, options?: Parameters<Transport['send']>[1]) =>
          target.send(stripToolsListMessage(message), options);
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value, target);
    },
  });
}

/** `createSdkMcpServer` の結果の `tools/list` から、意味のない `$schema` だけを外す。 */
export function withoutSchemaKey<T extends McpSdkServerConfigWithInstance>(config: T): T {
  const { instance } = config;
  const connect = instance.connect.bind(instance);
  instance.connect = (transport: Transport) => connect(leanTransport(transport));
  return config;
}
