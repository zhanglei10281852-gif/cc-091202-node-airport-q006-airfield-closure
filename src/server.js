import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { ClosureStore } from "./store.js";
import { DomainError, parseInstant, toIso } from "./domain.js";

const DEFAULT_TOPOLOGY_URL = new URL("../fixtures/context.json", import.meta.url);
const INTERNAL_ROLES = new Set(["staff", "manager"]);

/** 从资料文件加载区段拓扑（含相邻关系）；文件缺失时返回空拓扑。 */
export async function loadTopology(file = DEFAULT_TOPOLOGY_URL) {
  let data;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return data.records
    .filter((record) => typeof record.segmentId === "string")
    .map((record) => ({
      segmentId: record.segmentId,
      from: record.from ?? null,
      to: record.to ?? null,
      adjacent: Array.isArray(record.adjacent) ? record.adjacent : [],
    }));
}

/**
 * 构建 HTTP 服务。options.store 缺省时使用纯内存空拓扑存储（便于测试）；
 * 生产入口会显式注入带持久化与拓扑的存储。
 */
export function buildServer(options = {}) {
  const store = options.store ?? new ClosureStore({ segments: options.segments ?? [], clock: options.clock });

  const routes = [
    route("GET", "/health", "public", async () => ({ status: 200, body: { status: "ok" } })),

    // 对外视图：只暴露当前可用性与预计恢复时间。
    route("GET", "/api/public/availability", "public", async ({ query }) => {
      const atMs = query.has("at") ? parseInstant(query.get("at"), "at") : store.nowMs();
      const segments = store
        .availabilityAt(atMs)
        .map(({ segmentId, available, estimatedRecoveryAt }) => ({ segmentId, available, estimatedRecoveryAt }));
      return { status: 200, body: { asOf: toIso(atMs), segments } };
    }),

    route("GET", "/api/segments", "internal", async () => ({
      status: 200,
      body: { segments: store.listSegments() },
    })),

    route("POST", "/api/incidents", "internal", async ({ body, actor }) => {
      const result = await store.execute({ ...body, action: "report_incident", actor });
      return { status: result.duplicated ? 200 : 201, body: result };
    }),
    route("GET", "/api/incidents", "internal", async () => ({
      status: 200,
      body: { incidents: store.listIncidents() },
    })),
    route("GET", "/api/incidents/:id", "internal", async ({ params }) => {
      const incident = store.getIncident(params.id);
      if (!incident) throw new DomainError(404, "incident_not_found", `事件不存在: ${params.id}`);
      return { status: 200, body: incident };
    }),
    // 内部时间轴：报告、派工、到场、发现、清除、复核、开放（含延长版本）。
    route("GET", "/api/incidents/:id/timeline", "internal", async ({ params }) => {
      const entries = store.getTimeline(params.id);
      if (!entries) throw new DomainError(404, "incident_not_found", `事件不存在: ${params.id}`);
      return { status: 200, body: { incidentId: params.id, entries } };
    }),
    route("POST", "/api/incidents/:id/dispatch", "manager", async ({ params, body, actor }) => ({
      status: 200,
      body: await store.execute({ ...body, incidentId: params.id, action: "dispatch_crew", actor }),
    })),
    route("POST", "/api/incidents/:id/arrival", "internal", async ({ params, body, actor }) => ({
      status: 200,
      body: await store.execute({ ...body, incidentId: params.id, action: "record_arrival", actor }),
    })),
    route("POST", "/api/incidents/:id/findings", "internal", async ({ params, body, actor }) => ({
      status: 200,
      body: await store.execute({ ...body, incidentId: params.id, action: "submit_finding", actor }),
    })),
    route("POST", "/api/incidents/:id/clearance", "internal", async ({ params, body, actor }) => ({
      status: 200,
      body: await store.execute({ ...body, incidentId: params.id, action: "record_clearance", actor }),
    })),
    route("POST", "/api/incidents/:id/review", "manager", async ({ params, body, actor }) => ({
      status: 200,
      body: await store.execute({ ...body, incidentId: params.id, action: "review_incident", actor }),
    })),
    route("POST", "/api/incidents/:id/reopen", "manager", async ({ params, body, actor }) => ({
      status: 200,
      body: await store.execute({ ...body, incidentId: params.id, action: "reopen_incident", actor }),
    })),

    route("GET", "/api/restrictions", "internal", async ({ query }) => ({
      status: 200,
      body: {
        restrictions: store.listRestrictions({
          segmentId: query.get("segmentId"),
          activeAtMs: query.has("activeAt") ? parseInstant(query.get("activeAt"), "activeAt") : null,
        }),
      },
    })),
    route("GET", "/api/restrictions/:id", "internal", async ({ params }) => {
      const restriction = store.getRestriction(params.id);
      if (!restriction) throw new DomainError(404, "restriction_not_found", `封闭措施不存在: ${params.id}`);
      return { status: 200, body: restriction };
    }),
    route("POST", "/api/restrictions/:id/extend", "manager", async ({ params, body, actor }) => ({
      status: 200,
      body: await store.execute({ ...body, restrictionId: params.id, action: "extend_restriction", actor }),
    })),
  ];

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const matched = routes
        .map((r) => ({ ...r, match: r.method === request.method && r.regex.exec(url.pathname) }))
        .find((r) => r.match);
      if (!matched) {
        throw new DomainError(404, "not_found", "接口不存在");
      }
      const actor = {
        id: request.headers["x-actor-id"] ?? null,
        role: request.headers["x-actor-role"] ?? null,
      };
      checkRole(actor, matched.access);
      const params = {};
      matched.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(matched.match[index + 1]);
      });
      const body = request.method === "POST" ? await readJsonBody(request) : {};
      const result = await matched.handler({ params, query: url.searchParams, body, actor });
      sendJson(response, result.status, result.body);
    } catch (error) {
      if (error instanceof DomainError) {
        sendJson(response, error.status, {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details !== undefined ? { details: error.details } : {}),
          },
        });
      } else {
        console.error(error);
        sendJson(response, 500, { error: { code: "internal_error", message: "服务内部错误" } });
      }
    }
  });
}

function route(method, template, access, handler) {
  const keys = [];
  const pattern = template
    .split("/")
    .map((part) => {
      if (part.startsWith(":")) {
        keys.push(part.slice(1));
        return "([^/]+)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { method, regex: new RegExp(`^${pattern}$`), keys, access, handler };
}

function checkRole(actor, access) {
  if (access === "public") return;
  if (!INTERNAL_ROLES.has(actor.role)) {
    throw new DomainError(401, "unauthorized", "缺少有效的内部人员身份（x-actor-role: staff|manager）");
  }
  if (access === "manager" && actor.role !== "manager") {
    throw new DomainError(403, "forbidden", "该操作需要授权经理角色");
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new DomainError(413, "payload_too_large", "请求体过大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainError(400, "invalid_json", "请求体不是合法 JSON");
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const store = await ClosureStore.open({
    dataFile: process.env.DATA_FILE ?? "data/events.jsonl",
    segments: await loadTopology(process.env.TOPOLOGY_FILE ?? DEFAULT_TOPOLOGY_URL),
  });
  buildServer({ store }).listen(port, "0.0.0.0", () => {
    console.log(`airfield-closure-context listening on ${port}`);
  });
}
