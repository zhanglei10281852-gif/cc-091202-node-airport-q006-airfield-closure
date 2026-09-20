import assert from "node:assert/strict";
import test from "node:test";
import { EventStore, replay } from "../src/domain/store.js";
import { AirfieldService } from "../src/domain/service.js";
import { EventType } from "../src/domain/events.js";

const MANAGER = { userId: "mgr-01", role: "MANAGER" };
const FIELD = { userId: "fld-01", role: "FIELD" };

// 样例时刻（跨午夜）
const T_2350 = "2026-09-12T23:50:00+08:00";
const T_0005 = "2026-09-13T00:05:00+08:00";
const T_0010 = "2026-09-13T00:10:00+08:00";
const T_0020 = "2026-09-13T00:20:00+08:00";
const T_0030 = "2026-09-13T00:30:00+08:00";
const T_0035 = "2026-09-13T00:35:00+08:00";
const T_0040 = "2026-09-13T00:40:00+08:00";
const T_0045 = "2026-09-13T00:45:00+08:00";
const T_0050 = "2026-09-13T00:50:00+08:00";
const T_0100 = "2026-09-13T01:00:00+08:00";
const T_0200 = "2026-09-13T02:00:00+08:00";

async function makeService() {
  const store = new EventStore(undefined, { clock: () => Date.parse(T_0010) });
  await store.load();
  const service = new AirfieldService(store, { clock: () => Date.parse(T_0010) });
  await service.defineSegment(MANAGER, { segmentId: "RWY18L-A", from: "L1", to: "L3", adjacent: ["RWY18L-B"] });
  await service.defineSegment(MANAGER, { segmentId: "RWY18L-B", from: "L3", to: "L5", adjacent: ["RWY18L-A"] });
  await service.defineSegment(MANAGER, { segmentId: "TWY-Y", from: "Y1", to: "Y2", adjacent: [] });
  return service;
}

async function seedOverlappingClosures(service) {
  await service.reportIncident(FIELD, {
    incidentId: "inc-fod", type: "FOD", segments: ["RWY18L-A"], time: T_2350, summary: "跑道中部疑似金属片",
  });
  await service.createRestriction(MANAGER, {
    restrictionId: "close-fod-1", reason: "FOD", segments: ["RWY18L-A"], incidentId: "inc-fod",
    from: T_2350, to: T_0030, time: T_2350,
  });
  await service.createRestriction(MANAGER, {
    restrictionId: "close-work-2", reason: "VEHICLE_WORK", segments: ["RWY18L-A", "RWY18L-B"],
    from: T_0005, to: T_0100, time: T_0005,
  });
}

const seg = (avail, id) => avail.segments.find((s) => s.segmentId === id);

test("跨午夜叠加：两条不同原因限制在重叠时段共同作用，ETA 取最早到期", async () => {
  const service = await makeService();
  await seedOverlappingClosures(service);

  const at0010 = service.internalAvailability({ at: T_0010 });
  assert.equal(seg(at0010, "RWY18L-A").available, false);
  assert.equal(seg(at0010, "RWY18L-A").status, "CLOSED");
  assert.deepEqual(seg(at0010, "RWY18L-A").causes.map((c) => c.restrictionId).sort(), ["close-fod-1", "close-work-2"]);
  assert.equal(seg(at0010, "RWY18L-A").eta, new Date(T_0030).toISOString());
  assert.equal(seg(at0010, "RWY18L-B").available, false);
  assert.deepEqual(seg(at0010, "RWY18L-B").causes.map((c) => c.restrictionId), ["close-work-2"]);
  // 不相邻也不被任何限制覆盖的滑行道始终可用
  assert.equal(seg(at0010, "TWY-Y").available, true);
  assert.equal(seg(at0010, "TWY-Y").eta, null);
});

test("时间窗按绝对时刻过期；过期限制自然失效但不抵消仍有效的其他限制", async () => {
  const service = await makeService();
  await seedOverlappingClosures(service);

  const at0035 = service.internalAvailability({ at: T_0035 });
  // FOD 措施 00:30 到期；A 仍因车辆作业关闭，B 同样关闭
  assert.equal(seg(at0035, "RWY18L-A").available, false);
  assert.deepEqual(seg(at0035, "RWY18L-A").causes.map((c) => c.restrictionId), ["close-work-2"]);
  assert.equal(seg(at0035, "RWY18L-B").available, false);
  assert.equal(seg(at0035, "RWY18L-A").eta, new Date(T_0100).toISOString());

  const at0101 = service.publicAvailability({ at: "2026-09-13T01:01:00+08:00" });
  assert.equal(seg(at0101, "RWY18L-A").available, true);
  assert.equal(seg(at0101, "RWY18L-B").available, true);
});

test("解除一项重叠封闭不抵消其他仍有效限制", async () => {
  const service = await makeService();
  await seedOverlappingClosures(service);

  // FOD 现场清除并完成证据+复核+开放（00:20）
  await service.dispatch(MANAGER, { restrictionId: "close-fod-1", teamId: "team-1", time: "2026-09-12T23:52:00+08:00" });
  await service.arrive(FIELD, { restrictionId: "close-fod-1", teamId: "team-1", time: "2026-09-12T23:55:00+08:00" });
  await service.submitClearance(FIELD, { restrictionId: "close-fod-1", evidence: "巡检照片×3，金属片已取走", time: "2026-09-13T00:15:00+08:00" });
  await service.reviewReopen(MANAGER, { restrictionId: "close-fod-1", decision: "APPROVED", time: "2026-09-13T00:18:00+08:00" });
  await service.reopen(MANAGER, { restrictionId: "close-fod-1", time: T_0020 });

  const at0020 = service.internalAvailability({ at: T_0020 });
  // A 仍被车辆作业封闭；B 也封闭——解除 FOD 没有“穿透”另一条限制
  assert.equal(seg(at0020, "RWY18L-A").available, false);
  assert.deepEqual(seg(at0020, "RWY18L-A").causes.map((c) => c.restrictionId), ["close-work-2"]);
  assert.equal(seg(at0020, "RWY18L-B").available, false);
});

test("相邻不等于重叠：仅覆盖 A 的封闭不会牵连相邻的 B", async () => {
  const service = await makeService();
  await service.createRestriction(MANAGER, {
    restrictionId: "close-only-a", reason: "DAMAGE", segments: ["RWY18L-A"], from: T_0005, to: T_0100, time: T_0005,
  });
  const at = service.internalAvailability({ at: T_0010 });
  assert.equal(seg(at, "RWY18L-A").available, false);
  assert.equal(seg(at, "RWY18L-B").available, true);
});

test("有车辆在场时禁止开放；撤离并重新提交证据后才可开放", async () => {
  const service = await makeService();
  await seedOverlappingClosures(service);
  const id = "close-work-2";

  await service.arrive(FIELD, { restrictionId: id, teamId: "sweeper-7", time: "2026-09-13T00:12:00+08:00" });
  await service.submitClearance(FIELD, { restrictionId: id, evidence: "清扫完成", time: T_0040 });
  await service.reviewReopen(MANAGER, { restrictionId: id, decision: "APPROVED", time: "2026-09-13T00:42:00+08:00" });

  await assert.rejects(
    () => service.reopen(MANAGER, { restrictionId: id, time: T_0045 }),
    (err) => err.code === "reopen_blocked" && err.details.some((b) => b.code === "vehicles_present"),
  );

  // 声明班组撤离后，证据与批准仍然有效，开放成功
  await service.submitClearance(FIELD, { restrictionId: id, evidence: "sweeper-7 已驶离", teamsCleared: ["sweeper-7"], time: "2026-09-13T00:48:00+08:00" });
  await service.reopen(MANAGER, { restrictionId: id, time: T_0050 });
  const at0050 = service.internalAvailability({ at: T_0050 });
  assert.equal(seg(at0050, "RWY18L-A").available, true);
  assert.equal(seg(at0050, "RWY18L-B").available, true);
});

test("未结阻断缺陷一票否决；结项后可开放", async () => {
  const service = await makeService();
  await service.createRestriction(MANAGER, {
    restrictionId: "close-dmg", reason: "DAMAGE", segments: ["TWY-Y"], from: T_0005, to: T_0100, time: T_0005,
  });
  await service.arrive(FIELD, { restrictionId: "close-dmg", teamId: "team-2", time: "2026-09-13T00:10:00+08:00" });
  await service.recordFinding(FIELD, {
    restrictionId: "close-dmg", findingId: "f-1", kind: "POTHOLE", detail: "盖板松动", time: "2026-09-13T00:20:00+08:00",
  });
  await service.submitClearance(FIELD, { restrictionId: "close-dmg", evidence: "已检查", teamsCleared: ["team-2"], time: T_0040 });
  await service.reviewReopen(MANAGER, { restrictionId: "close-dmg", decision: "APPROVED", time: "2026-09-13T00:42:00+08:00" });
  await assert.rejects(
    () => service.reopen(MANAGER, { restrictionId: "close-dmg", time: T_0045 }),
    (err) => err.code === "reopen_blocked" && err.details.some((b) => b.code === "open_defect"),
  );
  await service.resolveFinding(FIELD, { restrictionId: "close-dmg", findingId: "f-1", time: "2026-09-13T00:46:00+08:00" });
  await service.reopen(MANAGER, { restrictionId: "close-dmg", time: "2026-09-13T00:47:00+08:00" });
  assert.equal(seg(service.internalAvailability({ at: T_0050 }), "TWY-Y").available, true);
});

test("证据缺失或未经经理复核不能开放", async () => {
  const service = await makeService();
  await service.createRestriction(MANAGER, {
    restrictionId: "c1", reason: "INSPECTION", segments: ["TWY-Y"], from: T_0005, to: T_0100, time: T_0005,
  });
  await assert.rejects(() => service.reopen(MANAGER, { restrictionId: "c1", time: T_0020 }), (err) =>
    err.details.some((b) => b.code === "clearance_missing") && err.details.some((b) => b.code === "review_missing"));
  await service.submitClearance(FIELD, { restrictionId: "c1", evidence: "ok", time: T_0020 });
  await assert.rejects(() => service.reopen(MANAGER, { restrictionId: "c1", time: T_0030 }), (err) =>
    err.details.some((b) => b.code === "review_missing") && !err.details.some((b) => b.code === "clearance_missing"));
});

test("紧急延长沿用原关联并形成新版本；旧版本开放命令被拒绝", async () => {
  const service = await makeService();
  await seedOverlappingClosures(service);
  await service.extendRestriction(MANAGER, { restrictionId: "close-fod-1", to: T_0200, time: T_0020 });

  const r = service.state.restrictions.get("close-fod-1");
  assert.equal(r.currentVersion, 2);
  assert.equal(r.reason, "FOD"); // 关联不变
  assert.deepEqual(r.segments, ["RWY18L-A"]);

  // v1 的证据+复核在 v2 上无效；带 version:1 的开放命令属于过期命令
  await service.submitClearance(FIELD, { restrictionId: "close-fod-1", version: 1, evidence: "旧证据", time: T_0020 });
  await service.reviewReopen(MANAGER, { restrictionId: "close-fod-1", version: 1, decision: "APPROVED", time: T_0020 });
  await assert.rejects(
    () => service.reopen(MANAGER, { restrictionId: "close-fod-1", version: 1, time: T_0030 }),
    (err) => err.code === "reopen_blocked" && err.details.some((b) => b.code === "stale_version"),
  );

  // 新版本必须重新取证、复核后才能开放
  await assert.rejects(() => service.reopen(MANAGER, { restrictionId: "close-fod-1", time: T_0035 }), (err) =>
    err.details.some((b) => b.code === "clearance_missing"));
  await service.submitClearance(FIELD, { restrictionId: "close-fod-1", version: 2, evidence: "新证据", time: T_0040 });
  await service.reviewReopen(MANAGER, { restrictionId: "close-fod-1", version: 2, decision: "APPROVED", time: T_0045 });
  await service.reopen(MANAGER, { restrictionId: "close-fod-1", time: T_0050 });
  assert.equal(seg(service.internalAvailability({ at: T_0050 }), "RWY18L-A").available, false); // work-2 仍在
});

test("重复消息（commandId）只生效一次", async () => {
  const service = await makeService();
  const body = { restrictionId: "dup-1", reason: "FOD", segments: ["TWY-Y"], from: T_0005, to: T_0100, time: T_0005 };
  const e1 = await service.createRestriction(MANAGER, body, "cmd-xyz");
  const e2 = await service.createRestriction(MANAGER, body, "cmd-xyz");
  assert.equal(e1.seq, e2.seq);
  assert.equal(service.state.restrictions.size, 1);
  assert.equal(service.state.events.length, 4); // 3 个区段定义 + 1 条封闭
});

test("内部时间轴覆盖报告/派工/到场/发现/清除/复核/开放并按绝对时刻排序", async () => {
  const service = await makeService();
  await seedOverlappingClosures(service);
  const id = "close-fod-1";
  await service.dispatch(MANAGER, { restrictionId: id, teamId: "team-1", time: "2026-09-12T23:52:00+08:00" });
  await service.arrive(FIELD, { restrictionId: id, teamId: "team-1", time: "2026-09-12T23:58:00+08:00" });
  await service.recordFinding(FIELD, { restrictionId: id, findingId: "fod-a", kind: "METAL", time: "2026-09-13T00:05:00+08:00" });
  await service.resolveFinding(FIELD, { restrictionId: id, findingId: "fod-a", time: "2026-09-13T00:12:00+08:00" });
  await service.submitClearance(FIELD, { restrictionId: id, evidence: "照片", time: "2026-09-13T00:15:00+08:00" });
  await service.reviewReopen(MANAGER, { restrictionId: id, decision: "APPROVED", time: "2026-09-13T00:18:00+08:00" });
  await service.reopen(MANAGER, { restrictionId: id, time: T_0020 });

  const phases = service.timeline().filter((e) => e.restrictionId === id).map((e) => e.phase);
  assert.deepEqual(phases, ["CLOSURE", "DISPATCH", "ARRIVE", "FIND", "DEFECT_RESOLVED", "CLEAR", "REVIEW", "OPEN"]);
  // 报告属于事件
  assert.ok(service.timeline().some((e) => e.phase === "REPORT" && e.incidentId === "inc-fod"));
  // 时间严格有序
  const times = service.timeline().map((e) => Date.parse(e.at));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test("并发解除的先后顺序不影响最终可用性（两种交错顺序结果相同）", async () => {
  async function runScenario(order) {
    const service = await makeService();
    await service.createRestriction(MANAGER, { restrictionId: "rA", reason: "FOD", segments: ["RWY18L-A"], from: T_0005, to: T_0200, time: T_0005 });
    await service.createRestriction(MANAGER, { restrictionId: "rB", reason: "DAMAGE", segments: ["RWY18L-B"], from: T_0005, to: T_0200, time: T_0005 });

    async function closeOne(id, team, t1, t2) {
      await service.arrive(FIELD, { restrictionId: id, teamId: team, time: t1 });
      await service.submitClearance(FIELD, { restrictionId: id, evidence: "clear", teamsCleared: [team], time: t1 });
      await service.reviewReopen(MANAGER, { restrictionId: id, decision: "APPROVED", time: t1 });
      await service.reopen(MANAGER, { restrictionId: id, time: t2 });
    }
    const flowA = () => closeOne("rA", "ta", "2026-09-13T00:10:00+08:00", "2026-09-13T00:20:00+08:00");
    const flowB = () => closeOne("rB", "tb", "2026-09-13T00:11:00+08:00", "2026-09-13T00:30:00+08:00");
    if (order === "AB") { await flowA(); await flowB(); } else { await flowB(); await flowA(); }

    const finalAvail = service.publicAvailability({ at: T_0050 });
    const canonTimeline = service.timeline({ at: T_0050 })
      .map((e) => `${e.phase}:${e.restrictionId ?? e.incidentId ?? ""}:${e.at}`)
      .sort();
    return { finalAvail, canonTimeline };
  }

  const ab = await runScenario("AB");
  const ba = await runScenario("BA");
  assert.deepEqual(ab.finalAvail, ba.finalAvail);
  assert.deepEqual(ab.canonTimeline, ba.canonTimeline);
  for (const s of ab.finalAvail.segments) assert.equal(s.available, true);
});

test("事件日志重放（服务恢复）后可用性与时间轴保持相同", async () => {
  const { rm } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const path = fileURLToPath(new URL("../tmp-test-events.jsonl", import.meta.url));
  await rm(path, { force: true });
  try {
    const store1 = new EventStore(path, { clock: () => Date.parse(T_0010) });
    await store1.load();
    const service1 = new AirfieldService(store1);
    await service1.defineSegment(MANAGER, { segmentId: "RWY18L-A", from: "L1", to: "L3" });
    await service1.createRestriction(MANAGER, { restrictionId: "r1", reason: "FOD", segments: ["RWY18L-A"], from: T_0005, to: T_0100, time: T_0005 });

    const before = service1.internalAvailability({ at: T_0010 });

    const store2 = new EventStore(path, { clock: () => Date.parse(T_0010) });
    await store2.load();
    const service2 = new AirfieldService(store2);
    const after = service2.internalAvailability({ at: T_0010 });
    assert.deepEqual(after, before);
    assert.equal(store2.state.restrictions.get("r1").currentVersion, 1);
  } finally {
    await rm(path, { force: true });
  }
});

test("并发竞争：紧急延长先入队时，针对旧版本的开放不会穿透新决定", async () => {
  const service = await makeService();
  await seedOverlappingClosures(service);
  // 先给 v1 备齐证据与复核
  await service.submitClearance(FIELD, { restrictionId: "close-fod-1", evidence: "旧证据", time: T_0010 });
  await service.reviewReopen(MANAGER, { restrictionId: "close-fod-1", decision: "APPROVED", time: T_0010 });

  // 两个命令同时发出：延长（形成 v2）排在开放 v1 之前
  const results = await Promise.all([
    service.extendRestriction(MANAGER, { restrictionId: "close-fod-1", to: T_0200, time: T_0020 }, "cmd-extend"),
    service.reopen(MANAGER, { restrictionId: "close-fod-1", version: 1, time: T_0020 }, "cmd-stale-open").then(
      () => "opened",
      (err) => err.code,
    ),
  ]);
  assert.equal(results[0].type, EventType.RESTRICTION_EXTENDED);
  assert.equal(results[1], "reopen_blocked");
  assert.equal(service.state.restrictions.get("close-fod-1").currentVersion, 2);
  assert.equal(service.state.restrictions.get("close-fod-1").opened, null);
});

test("命令失败不会中断后续命令的串行队列", async () => {
  const service = await makeService();
  const bad = service.createRestriction(MANAGER, {
    restrictionId: "bad", reason: "FOD", segments: ["NOPE"], from: T_0005, to: T_0100, time: T_0005,
  }).then(
    () => "should-not-happen",
    (err) => err.code,
  );
  const good = service.createRestriction(MANAGER, {
    restrictionId: "good", reason: "FOD", segments: ["TWY-Y"], from: T_0005, to: T_0100, time: T_0005,
  }, "cmd-good");
  assert.equal(await bad, "unknown_segment");
  assert.equal((await good).type, EventType.RESTRICTION_CREATED);
  assert.ok(service.state.restrictions.has("good"));
});

test("事件投影本身是纯函数：乱序重放同一事件集合结果一致", () => {
  const events = [
    { type: EventType.SEGMENT_DEFINED, at: 0, data: { segmentId: "S1", from: "a", to: "b", adjacent: [] } },
    { type: EventType.RESTRICTION_CREATED, at: 1, data: { restrictionId: "x", reason: "FOD", segments: ["S1"], incidentId: null, createdBy: "m", at: 10, from: 0, to: 20 } },
  ];
  const s1 = replay(events);
  const s2 = replay([...events].reverse());
  assert.deepEqual(
    [...s1.restrictions.keys()],
    [...s2.restrictions.keys()],
  );
  assert.deepEqual([...s1.topology.segments.keys()], ["S1"]);
});
