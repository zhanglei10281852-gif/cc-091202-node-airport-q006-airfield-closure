import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ClosureStore } from "../src/store.js";
import { loadTopology } from "../src/server.js";
import { MANAGER, STAFF, TOPOLOGY_URL } from "./helpers.js";

const CLOCK = () => new Date("2026-09-13T02:00:00+08:00");

/** 两个重叠封闭（异物 + 巡检，跨午夜），其中巡检被紧急延长。 */
function setupCommands() {
  return [
    { commandId: "i1-report", issuedAt: "2026-09-12T23:45:00+08:00", actor: STAFF, action: "report_incident", type: "FOD", segmentIds: ["RWY18L-A"], closure: { from: "2026-09-12T23:50:00+08:00", to: "2026-09-13T00:30:00+08:00" } },
    { commandId: "i1-dispatch", issuedAt: "2026-09-12T23:46:00+08:00", actor: MANAGER, action: "dispatch_crew", incidentId: "INC-0001", crewId: "crew-1", vehiclesInvolved: true },
    { commandId: "i1-arrival", issuedAt: "2026-09-12T23:50:00+08:00", actor: STAFF, action: "record_arrival", incidentId: "INC-0001" },
    { commandId: "i1-finding", issuedAt: "2026-09-12T23:55:00+08:00", actor: STAFF, action: "submit_finding", incidentId: "INC-0001", evidence: { note: "金属碎片已定位" }, defects: [] },
    { commandId: "i1-clearance", issuedAt: "2026-09-13T00:05:00+08:00", actor: STAFF, action: "record_clearance", incidentId: "INC-0001", resolvedDefects: "ALL", vehiclesCleared: true },
    { commandId: "i1-review", issuedAt: "2026-09-13T00:10:00+08:00", actor: MANAGER, action: "review_incident", incidentId: "INC-0001", verdict: "PASS" },
    { commandId: "i2-report", issuedAt: "2026-09-12T23:48:00+08:00", actor: STAFF, action: "report_incident", type: "ROUTINE_INSPECTION", segmentIds: ["RWY18L-A", "RWY18L-B"], closure: { from: "2026-09-13T00:05:00+08:00", to: "2026-09-13T01:00:00+08:00" } },
    { commandId: "i2-dispatch", issuedAt: "2026-09-12T23:49:00+08:00", actor: MANAGER, action: "dispatch_crew", incidentId: "INC-0002", crewId: "crew-2", vehiclesInvolved: true },
    { commandId: "i2-arrival", issuedAt: "2026-09-12T23:52:00+08:00", actor: STAFF, action: "record_arrival", incidentId: "INC-0002" },
    { commandId: "i2-finding", issuedAt: "2026-09-12T23:56:00+08:00", actor: STAFF, action: "submit_finding", incidentId: "INC-0002", evidence: { note: "巡检未发现异常" }, defects: [] },
    { commandId: "i2-clearance", issuedAt: "2026-09-13T00:06:00+08:00", actor: STAFF, action: "record_clearance", incidentId: "INC-0002", resolvedDefects: "ALL", vehiclesCleared: true },
    { commandId: "i2-review", issuedAt: "2026-09-13T00:11:00+08:00", actor: MANAGER, action: "review_incident", incidentId: "INC-0002", verdict: "PASS" },
    { commandId: "i2-extend", issuedAt: "2026-09-13T00:12:00+08:00", actor: MANAGER, action: "extend_restriction", restrictionId: "RST-0002", newTo: "2026-09-13T01:30:00+08:00", reason: "检查范围扩大" },
  ];
}

const REOPEN_I1 = { commandId: "i1-reopen", issuedAt: "2026-09-13T00:20:00+08:00", actor: MANAGER, action: "reopen_incident", incidentId: "INC-0001" };
const REOPEN_I2 = { commandId: "i2-reopen", issuedAt: "2026-09-13T00:25:00+08:00", actor: MANAGER, action: "reopen_incident", incidentId: "INC-0002" };

const PROBE_INSTANTS = [
  "2026-09-12T23:55:00+08:00",
  "2026-09-13T00:10:00+08:00",
  "2026-09-13T00:26:00+08:00",
  "2026-09-13T01:00:00+08:00",
  "2026-09-13T01:45:00+08:00",
];

function snapshot(store) {
  return {
    availability: PROBE_INSTANTS.map((iso) => store.availabilityAt(Date.parse(iso))),
    incidents: store.listIncidents(),
    restrictions: store.listRestrictions(),
    timeline1: store.getTimeline("INC-0001"),
    timeline2: store.getTimeline("INC-0002"),
  };
}

async function openStore(file, segments) {
  return ClosureStore.open({ dataFile: file, segments, clock: CLOCK });
}

test("服务恢复后派生状态保持相同", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "closure-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "events.jsonl");
  const segments = await loadTopology(TOPOLOGY_URL);

  const before = await openStore(file, segments);
  for (const command of [...setupCommands(), REOPEN_I1, REOPEN_I2]) {
    await before.execute(command);
  }
  const snapBefore = snapshot(before);

  // 模拟服务重启：从同一日志重新打开。
  const recovered = await openStore(file, segments);
  assert.deepEqual(snapshot(recovered), snapBefore);

  // 恢复后幂等记录仍在：重复消息返回首次结果，不产生新事件。
  const dup = await recovered.execute(setupCommands()[0]);
  assert.equal(dup.duplicated, true);
  assert.equal(dup.incidentId, "INC-0001");
  assert.equal(recovered.listIncidents().length, 2);

  // 恢复后可以继续受理新工作，编号连续。
  const next = await recovered.execute({
    commandId: "i3-report",
    issuedAt: "2026-09-13T01:50:00+08:00",
    actor: STAFF,
    action: "report_incident",
    type: "PAVEMENT_DAMAGE",
    segmentIds: ["RWY18L-B"],
    closure: { from: "2026-09-13T02:00:00+08:00", to: "2026-09-13T03:00:00+08:00" },
  });
  assert.equal(next.incidentId, "INC-0003");
  assert.equal(next.restrictionId, "RST-0003");

  // 再次恢复，包含新命令的状态依然一致。
  const again = await openStore(file, segments);
  assert.deepEqual(snapshot(again), snapshot(recovered));
});

test("并发解除的先后顺序不影响最终可用区段", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "closure-order-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const segments = await loadTopology(TOPOLOGY_URL);

  // 顺序一：先解除异物封闭，再解除巡检封闭。
  const storeA = await openStore(path.join(dir, "a.jsonl"), segments);
  for (const command of [...setupCommands(), REOPEN_I1, REOPEN_I2]) await storeA.execute(command);

  // 顺序二：同样的命令，解除顺序对调（同一组签发时刻）。
  const storeB = await openStore(path.join(dir, "b.jsonl"), segments);
  for (const command of [...setupCommands(), REOPEN_I2, REOPEN_I1]) await storeB.execute(command);

  // 顺序三：两个解除并发提交（存储内部串行化）。
  const storeC = await openStore(path.join(dir, "c.jsonl"), segments);
  for (const command of setupCommands()) await storeC.execute(command);
  await Promise.all([storeC.execute(REOPEN_I2), storeC.execute(REOPEN_I1)]);

  const finalOf = (store) => PROBE_INSTANTS.map((iso) => store.availabilityAt(Date.parse(iso)));
  assert.deepEqual(finalOf(storeB), finalOf(storeA));
  assert.deepEqual(finalOf(storeC), finalOf(storeA));

  // 中间过程不同，但最终每个区段的可用性都由全部有效限制共同推导。
  const at0026 = storeA.availabilityAt(Date.parse("2026-09-13T00:26:00+08:00"));
  assert.ok(at0026.every((row) => row.available));
});
