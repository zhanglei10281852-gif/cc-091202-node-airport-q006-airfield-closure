// HTTP 适配层：JSON over HTTP。
// 身份由请求头 x-user-id / x-user-role 给出（演示用脱敏编号；生产应替换为真实认证）。
// Idempotency-Key 头（或 body.commandId）作为命令幂等键。

import { DomainError } from "./topology.js";
import { Role } from "./events.js";

export function buildHandler(service) {
  const routes = [
    ["GET", /^\/health$/, () => ({ status: "ok" })],
    ["GET", /^\/segments$/, (_b, _a, q) => ({ segments: service.state.topology.list() })],
    ["POST", /^\/segments$/, (b, a, _q, idem) => service.defineSegment(a, b, idem)],
    ["POST", /^\/incidents$/, (b, a, _q, idem) => service.reportIncident(a, b, idem)],
    ["POST", /^\/restrictions$/, (b, a, _q, idem) => service.createRestriction(a, b, idem)],
    ["POST", /^\/restrictions\/extend$/, (b, a, _q, idem) => service.extendRestriction(a, b, idem)],
    ["POST", /^\/inspections\/dispatch$/, (b, a, _q, idem) => service.dispatch(a, b, idem)],
    ["POST", /^\/inspections\/arrive$/, (b, a, _q, idem) => service.arrive(a, b, idem)],
    ["POST", /^\/findings$/, (b, a, _q, idem) => service.recordFinding(a, b, idem)],
    ["POST", /^\/findings\/resolve$/, (b, a, _q, idem) => service.resolveFinding(a, b, idem)],
    ["POST", /^\/clearances$/, (b, a, _q, idem) => service.submitClearance(a, b, idem)],
    ["POST", /^\/reviews\/reopen$/, (b, a, _q, idem) => service.reviewReopen(a, b, idem)],
    ["POST", /^\/reopen$/, (b, a, _q, idem) => service.reopen(a, b, idem)],
    // 对外查询：仅当前可用性 + ETA
    ["GET", /^\/availability$/, (_b, _a, q) => service.publicAvailability(q)],
    // 内部查询：原因、版本、阻塞项、完整时间轴（需内部角色）
    ["GET", /^\/internal\/availability$/, (_b, a, q) => {
      requireInternal(a);
      return service.internalAvailability(q);
    }],
    ["GET", /^\/internal\/restrictions$/, (_b, a, q) => {
      requireInternal(a);
      return { restrictions: service.listRestrictions(q) };
    }],
    ["GET", /^\/timeline$/, (_b, a, q) => {
      requireInternal(a);
      return { events: service.timeline(q) };
    }],
  ];

  return async function handler(request, response) {
    try {
      const url = new URL(request.url, "http://airfield.local");
      const route = routes.find(([method, re]) => request.method === method && re.test(url.pathname));
      if (!route) return sendJson(response, 404, { error: "not_found" });

      const query = Object.fromEntries(url.searchParams);
      let body = {};
      if (request.method === "POST") {
        body = await readJson(request);
      }
      const actor = readActor(request);
      const commandId = request.headers["idempotency-key"] || body.commandId;
      const result = await route[2](body, actor, query, commandId ? String(commandId) : undefined);
      return sendJson(response, 200, serialize(result));
    } catch (err) {
      if (err instanceof DomainError) {
        return sendJson(response, err.statusCode, { error: err.code, message: err.message, details: err.details });
      }
      if (err?.code === "invalid_json" || err?.code === "invalid_time") {
        return sendJson(response, 400, { error: err.code, message: err.message });
      }
      return sendJson(response, 500, { error: "internal_error", message: String(err?.message ?? err) });
    }
  };
}

function requireInternal(actor) {
  if (!actor) throw new DomainError("unauthenticated", 401, "内部查询需要身份");
  if (actor.role !== Role.MANAGER && actor.role !== Role.FIELD) {
    throw new DomainError("forbidden", 403, "内部查询仅限现场人员与值班经理");
  }
}

function readActor(request) {
  const userId = request.headers["x-user-id"];
  if (!userId) return null;
  const role = String(request.headers["x-user-role"] ?? "OBSERVER").toUpperCase();
  if (!Object.values(Role).includes(role)) {
    throw new DomainError("invalid_role", 400, `未知角色 ${role}`);
  }
  return { userId: String(userId), role };
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(Object.assign(new Error("请求体过大"), { code: "invalid_json" }));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (raw.trim() === "") return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw Object.assign(new Error("请求体必须是 JSON 对象"), { code: "invalid_json" });
        }
        resolve(parsed);
      } catch (err) {
        reject(Object.assign(err, { code: "invalid_json" }));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

// 事件对象（含 BigInt 无关的数字时间戳）直接序列化即可；统一包一层 data 便于阅读
function serialize(result) {
  if (result && typeof result === "object" && "seq" in result && "type" in result && "data" in result) {
    return { ok: true, event: { seq: result.seq, type: result.type, at: new Date(result.at).toISOString(), data: result.data } };
  }
  return result;
}
