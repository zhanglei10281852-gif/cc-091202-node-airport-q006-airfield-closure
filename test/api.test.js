import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { buildServer } from "../src/server.js";
import { EventStore } from "../src/domain/store.js";
import { AirfieldService } from "../src/domain/service.js";

const MANAGER = { "x-user-id": "mgr-01", "x-user-role": "MANAGER" };
const FIELD = { "x-user-id": "fld-01", "x-user-role": "FIELD" };

async function harness(service) {
  const server = buildServer(service ? { service } : {}).listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    close: () => server.close(),
  };
}

async function req(base, method, path, { body, headers, query } = {}) {
  const url = new URL(path, base);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text();
  return { status: response.status, json };
}

async function seededService() {
  const clock = () => Date.parse("2026-09-13T00:10:00+08:00");
  const store = new EventStore(undefined, { clock });
  const service = new AirfieldService(store, { clock });
  await service.defineSegment({ userId: "sys", role: "MANAGER" }, { segmentId: "RWY18L-A", from: "L1", to: "L3", adjacent: ["RWY18L-B"] });
  await service.defineSegment({ userId: "sys", role: "MANAGER" }, { segmentId: "RWY18L-B", from: "L3", to: "L5", adjacent: ["RWY18L-A"] });
  await service.createRestriction({ userId: "mgr-01", role: "MANAGER" }, {
    restrictionId: "close-fod-1", reason: "FOD", segments: ["RWY18L-A"],
    from: "2026-09-12T23:50:00+08:00", to: "2026-09-13T00:30:00+08:00",
    time: "2026-09-12T23:50:00+08:00",
  });
  await service.createRestriction({ userId: "mgr-01", role: "MANAGER" }, {
    restrictionId: "close-work-2", reason: "VEHICLE_WORK", segments: ["RWY18L-A", "RWY18L-B"],
    from: "2026-09-13T00:05:00+08:00", to: "2026-09-13T01:00:00+08:00",
    time: "2026-09-13T00:05:00+08:00",
  });
  return service;
}

test("GET /segments 返回 fixtures 播种的相邻拓扑", async () => {
  const h = await harness();
  try {
    const { status, json } = await req(h.base, "GET", "/segments");
    assert.equal(status, 200);
    const a = json.segments.find((s) => s.segmentId === "RWY18L-A");
    assert.deepEqual(a.adjacent, ["RWY18L-B"]);
  } finally {
    h.close();
  }
});

test("对外 /availability 只暴露可用状态与 ETA，不暴露原因", async () => {
  const service = await seededService();
  const h = await harness(service);
  try {
    const { status, json } = await req(h.base, "GET", "/availability", {
      query: { at: "2026-09-13T00:10:00+08:00" },
    });
    assert.equal(status, 200);
    const a = json.segments.find((s) => s.segmentId === "RWY18L-A");
    assert.deepEqual(Object.keys(a).sort(), ["available", "eta", "segmentId"]);
    assert.equal(a.available, false);
    assert.equal(a.eta, new Date("2026-09-13T00:30:00+08:00").toISOString());
  } finally {
    h.close();
  }
});

test("内部接口需要现场或经理身份，并暴露原因与阻塞项", async () => {
  const service = await seededService();
  const h = await harness(service);
  try {
    assert.equal((await req(h.base, "GET", "/internal/availability", { query: { at: "2026-09-13T00:10:00+08:00" } })).status, 401);
    assert.equal((await req(h.base, "GET", "/timeline", { headers: { "x-user-id": "x", "x-user-role": "OBSERVER" } })).status, 403);

    const { status, json } = await req(h.base, "GET", "/internal/availability", {
      headers: FIELD,
      query: { at: "2026-09-13T00:10:00+08:00" },
    });
    assert.equal(status, 200);
    const a = json.segments.find((s) => s.segmentId === "RWY18L-A");
    assert.deepEqual(a.causes.map((c) => c.restrictionId).sort(), ["close-fod-1", "close-work-2"]);
  } finally {
    h.close();
  }
});

test("只有经理可以建立封闭/复核/开放；现场只能提交证据", async () => {
  const service = await seededService();
  const h = await harness(service);
  try {
    const asField = await req(h.base, "POST", "/reopen", {
      headers: FIELD,
      body: { restrictionId: "close-fod-1", time: "2026-09-13T00:20:00+08:00" },
    });
    assert.equal(asField.status, 403);

    // 无证据无复核，经理开放同样被领域规则拒绝（返回阻塞项）
    const blocked = await req(h.base, "POST", "/reopen", {
      headers: MANAGER,
      body: { restrictionId: "close-fod-1", time: "2026-09-13T00:20:00+08:00" },
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error, "reopen_blocked");
    assert.ok(blocked.json.details.some((d) => d.code === "clearance_missing"));
  } finally {
    h.close();
  }
});

test("完整协同流程（报告→派工→到场→发现→清除→复核→开放）经 HTTP 贯通", async () => {
  const service = await seededService();
  const h = await harness(service);
  try {
    const post = (path, body, headers = MANAGER, extra = {}) =>
      req(h.base, "POST", path, { headers, body: { ...body, time: body.time ?? "2026-09-13T00:20:00+08:00" }, ...extra });

    assert.equal((await post("/inspections/dispatch", { restrictionId: "close-fod-1", teamId: "t1" })).status, 200);
    assert.equal((await post("/inspections/arrive", { restrictionId: "close-fod-1", teamId: "t1", time: "2026-09-12T23:55:00+08:00" }, FIELD)).status, 200);
    assert.equal((await post("/findings", { restrictionId: "close-fod-1", findingId: "f1", kind: "METAL", time: "2026-09-13T00:00:00+08:00" }, FIELD)).status, 200);
    assert.equal((await post("/findings/resolve", { restrictionId: "close-fod-1", findingId: "f1", time: "2026-09-13T00:10:00+08:00" }, FIELD)).status, 200);
    assert.equal((await post("/clearances", { restrictionId: "close-fod-1", evidence: "照片×3", time: "2026-09-13T00:12:00+08:00" }, FIELD)).status, 200);
    assert.equal((await post("/reviews/reopen", { restrictionId: "close-fod-1", decision: "APPROVED", time: "2026-09-13T00:15:00+08:00" })).status, 200);
    const opened = await post("/reopen", { restrictionId: "close-fod-1", time: "2026-09-13T00:20:00+08:00" });
    assert.equal(opened.status, 200);
    assert.equal(opened.json.event.type, "restrictionOpened");

    // 开放 FOD 后 A 仍被车辆作业封闭
    const avail = await req(h.base, "GET", "/internal/availability", {
      headers: MANAGER,
      query: { at: "2026-09-13T00:25:00+08:00" },
    });
    const a = avail.json.segments.find((s) => s.segmentId === "RWY18L-A");
    assert.equal(a.available, false);
    assert.deepEqual(a.causes.map((c) => c.restrictionId), ["close-work-2"]);
  } finally {
    h.close();
  }
});

test("Idempotency-Key 头保证重复 POST 只产生一个事件", async () => {
  const service = await seededService();
  const h = await harness(service);
  try {
    const body = {
      restrictionId: "close-routine-9", reason: "INSPECTION", segments: ["RWY18L-B"],
      from: "2026-09-13T01:00:00+08:00", to: "2026-09-13T02:00:00+08:00", time: "2026-09-13T00:50:00+08:00",
    };
    const r1 = await req(h.base, "POST", "/restrictions", { headers: { ...MANAGER, "idempotency-key": "K-1" }, body });
    const r2 = await req(h.base, "POST", "/restrictions", { headers: { ...MANAGER, "idempotency-key": "K-1" }, body });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r1.json.event.seq, r2.json.event.seq);
    assert.equal(service.state.restrictions.size, 3);
  } finally {
    h.close();
  }
});

test("紧急延长后，旧版本开放命令返回 stale_version，且新版本 ETA 更新", async () => {
  const service = await seededService();
  const h = await harness(service);
  try {
    const extend = await req(h.base, "POST", "/restrictions/extend", {
      headers: MANAGER,
      body: { restrictionId: "close-fod-1", to: "2026-09-13T02:00:00+08:00", time: "2026-09-13T00:25:00+08:00" },
    });
    assert.equal(extend.status, 200);
    assert.equal(extend.json.event.data.version, 2);

    const stale = await req(h.base, "POST", "/reopen", {
      headers: MANAGER,
      body: { restrictionId: "close-fod-1", version: 1, time: "2026-09-13T00:26:00+08:00" },
    });
    assert.equal(stale.status, 409);
    assert.ok(stale.json.details.some((d) => d.code === "stale_version"));

    const avail = await req(h.base, "GET", "/availability", { headers: FIELD, query: { at: "2026-09-13T01:10:00+08:00" } });
    const a = avail.json.segments.find((s) => s.segmentId === "RWY18L-A");
    assert.equal(a.available, false);
    assert.equal(a.eta, new Date("2026-09-13T02:00:00+08:00").toISOString());
  } finally {
    h.close();
  }
});

test("时间轴接口按绝对时刻排列协同阶段", async () => {
  const service = await seededService();
  const h = await harness(service);
  try {
    const { status, json } = await req(h.base, "GET", "/timeline", { headers: MANAGER });
    assert.equal(status, 200);
    assert.ok(json.events.length >= 2);
    const phases = json.events.map((e) => e.phase);
    assert.ok(phases.includes("CLOSURE"));
    const times = json.events.map((e) => Date.parse(e.at));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  } finally {
    h.close();
  }
});

test("内部措施列表展示版本、阻塞项与车辆状态", async () => {
  const service = await seededService();
  const h = await harness(service);
  try {
    // 车辆到场但未声明撤离
    await req(h.base, "POST", "/inspections/arrive", {
      headers: FIELD,
      body: { restrictionId: "close-work-2", teamId: "s-9", time: "2026-09-13T00:20:00+08:00" },
    });
    const { status, json } = await req(h.base, "GET", "/internal/restrictions", {
      headers: MANAGER,
      query: { at: "2026-09-13T00:30:00+08:00" },
    });
    assert.equal(status, 200);
    const work = json.restrictions.find((r) => r.restrictionId === "close-work-2");
    assert.equal(work.vehiclesPresent, true);
    assert.ok(work.blockers.includes("vehicles_present"));
    assert.ok(work.blockers.includes("clearance_missing"));
    assert.ok(work.blockers.includes("review_missing"));
    const fod = json.restrictions.find((r) => r.restrictionId === "close-fod-1");
    assert.equal(fod.currentVersion, 1);
  } finally {
    h.close();
  }
});
