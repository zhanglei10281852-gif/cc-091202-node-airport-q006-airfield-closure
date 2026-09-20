import { createServer } from "node:http";
import { createAppSync } from "./bootstrap.js";
import { buildHandler } from "./domain/api.js";

// 保持同步工厂：测试与调用方可以直接 buildServer().listen()。
// 无事件日志时使用内存状态 + fixtures 播种；生产入口通过 EVENT_LOG 指定持久化文件。
export function buildServer(options = {}) {
  const service = options.service ?? createAppSync({ logPath: options.logPath, clock: options.clock, seedPath: options.seedPath });
  return createServer(buildHandler(service));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const logPath = process.env.EVENT_LOG ?? "data/events.jsonl";
  const server = buildServer({ logPath });
  server.listen(port, "0.0.0.0", () => {
    console.log(`airfield service listening on :${port} (event log: ${logPath || "memory"})`);
  });
}
