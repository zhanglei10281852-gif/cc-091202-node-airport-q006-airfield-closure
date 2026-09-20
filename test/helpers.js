import { once } from "node:events";
import { ClosureStore } from "../src/store.js";
import { buildServer, loadTopology } from "../src/server.js";

export const TOPOLOGY_URL = new URL("../fixtures/context.json", import.meta.url);

export const STAFF = { id: "staff-1", role: "staff" };
export const MANAGER = { id: "manager-1", role: "manager" };

/** 启动一个内存存储的服务实例；时钟可注入、可拨动。 */
export async function startService(t, { now = "2026-09-12T23:40:00+08:00", segments } = {}) {
  let nowMs = Date.parse(now);
  const clock = () => new Date(nowMs);
  const store = new ClosureStore({ segments: segments ?? (await loadTopology(TOPOLOGY_URL)), clock });
  const server = buildServer({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    store,
    setNow(iso) {
      nowMs = Date.parse(iso);
    },
  };
}

export async function api(base, { method = "GET", path, role, actorId, body }) {
  const headers = {};
  if (role) headers["x-actor-role"] = role;
  if (actorId) headers["x-actor-id"] = actorId;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

export function post(base, path, { role = "staff", actorId = "actor-1", body } = {}) {
  return api(base, { method: "POST", path, role, actorId, body });
}

/** 对外可用性查询（at 含 +08:00 必须编码，否则 + 会被当作空格）。 */
export function pubAvailability(base, at) {
  return api(base, { path: `/api/public/availability?at=${encodeURIComponent(at)}` });
}
