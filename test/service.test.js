import assert from "node:assert/strict";
import test from "node:test";
import { api, post, pubAvailability, startService } from "./helpers.js";

/** 把一个事件从报告驱动到已复核，返回事件与封闭编号。 */
async function driveToReviewed(base, { key, type, segmentIds, closure, times }) {
  const [t0, t1, t2, t3, t4, t5] = times;
  const report = await post(base, "/api/incidents", {
    role: "staff",
    actorId: `${key}-staff`,
    body: { commandId: `${key}-1`, issuedAt: t0, type, segmentIds, closure },
  });
  assert.equal(report.status, 201, JSON.stringify(report.body));
  const { incidentId, restrictionId } = report.body;
  const steps = [
    ["dispatch", "manager", { crewId: "crew-1", vehiclesInvolved: true }, t1],
    ["arrival", "staff", {}, t2],
    ["findings", "staff", { evidence: { note: "现场检查完成" }, defects: [] }, t3],
    ["clearance", "staff", { resolvedDefects: "ALL", vehiclesCleared: true }, t4],
    ["review", "manager", { verdict: "PASS" }, t5],
  ];
  for (const [index, [action, role, payload, at]] of steps.entries()) {
    const res = await post(base, `/api/incidents/${incidentId}/${action}`, {
      role,
      actorId: `${key}-${role}`,
      body: { commandId: `${key}-${index + 2}`, issuedAt: at, ...payload },
    });
    assert.equal(res.status, 200, `${action}: ${JSON.stringify(res.body)}`);
  }
  return { incidentId, restrictionId };
}

test("完整工作流：报告到开放，时间轴齐全，缺陷未结禁止开放", async (t) => {
  const { base } = await startService(t, { now: "2026-09-12T23:40:00+08:00" });

  // 报告：异物事件生成带影响范围与有效时间的封闭措施（跨午夜）。
  const report = await post(base, "/api/incidents", {
    role: "staff",
    actorId: "op-1",
    body: {
      commandId: "w1-report",
      issuedAt: "2026-09-12T23:45:00+08:00",
      type: "FOD",
      segmentIds: ["RWY18L-A"],
      closure: { from: "2026-09-12T23:50:00+08:00", to: "2026-09-13T00:30:00+08:00" },
    },
  });
  assert.equal(report.status, 201);
  assert.equal(report.body.incidentId, "INC-0001");
  assert.equal(report.body.restrictionId, "RST-0001");
  assert.equal(report.body.status, "REPORTED");
  assert.deepEqual(report.body.closure, { from: "2026-09-12T15:50:00.000Z", to: "2026-09-12T16:30:00.000Z" });

  // 封闭生效后对外即可见不可用与预计恢复时间。
  let pub = await pubAvailability(base, "2026-09-12T23:55:00+08:00");
  assert.equal(pub.status, 200);
  assert.equal(pub.body.segments.find((s) => s.segmentId === "RWY18L-A").available, false);
  assert.equal(pub.body.segments.find((s) => s.segmentId === "RWY18L-A").estimatedRecoveryAt, "2026-09-12T16:30:00.000Z");
  assert.equal(pub.body.segments.find((s) => s.segmentId === "RWY18L-B").available, true);

  const dispatch = await post(base, "/api/incidents/INC-0001/dispatch", {
    role: "manager",
    actorId: "mgr-1",
    body: { commandId: "w1-dispatch", issuedAt: "2026-09-12T23:46:00+08:00", crewId: "crew-7", vehiclesInvolved: true },
  });
  assert.equal(dispatch.status, 200);
  assert.equal(dispatch.body.status, "DISPATCHED");

  const arrival = await post(base, "/api/incidents/INC-0001/arrival", {
    role: "staff",
    actorId: "op-1",
    body: { commandId: "w1-arrival", issuedAt: "2026-09-12T23:50:00+08:00" },
  });
  assert.equal(arrival.status, 200);

  // 现场人员提交检查证据，并登记一项未结缺陷。
  const finding = await post(base, "/api/incidents/INC-0001/findings", {
    role: "staff",
    actorId: "op-1",
    body: {
      commandId: "w1-finding",
      issuedAt: "2026-09-12T23:55:00+08:00",
      evidence: { photos: ["p-1", "p-2"], note: "金属碎片已清除，道面有剥落" },
      defects: [{ summary: "道面轻微剥落" }],
    },
  });
  assert.equal(finding.status, 200);
  assert.deepEqual(finding.body.defects, [{ defectId: "INC-0001-D1", summary: "道面轻微剥落", status: "OPEN" }]);

  const clearance = await post(base, "/api/incidents/INC-0001/clearance", {
    role: "staff",
    actorId: "op-1",
    body: { commandId: "w1-clearance", issuedAt: "2026-09-13T00:05:00+08:00", vehiclesCleared: true },
  });
  assert.equal(clearance.status, 200);
  assert.equal(clearance.body.status, "CLEARED");

  // 复核需要授权经理。
  const deniedReview = await post(base, "/api/incidents/INC-0001/review", {
    role: "staff",
    actorId: "op-1",
    body: { commandId: "w1-review-x", issuedAt: "2026-09-13T00:08:00+08:00", verdict: "PASS" },
  });
  assert.equal(deniedReview.status, 403);
  const review = await post(base, "/api/incidents/INC-0001/review", {
    role: "manager",
    actorId: "mgr-1",
    body: { commandId: "w1-review", issuedAt: "2026-09-13T00:10:00+08:00", verdict: "PASS" },
  });
  assert.equal(review.status, 200);
  assert.equal(review.body.status, "REVIEWED");

  // 未结缺陷禁止开放。
  const blocked = await post(base, "/api/incidents/INC-0001/reopen", {
    role: "manager",
    actorId: "mgr-1",
    body: { commandId: "w1-reopen-x", issuedAt: "2026-09-13T00:12:00+08:00" },
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, "open_defects");
  assert.deepEqual(blocked.body.error.details.defectIds, ["INC-0001-D1"]);

  // 补充清除记录结清缺陷后放行。
  const fix = await post(base, "/api/incidents/INC-0001/clearance", {
    role: "staff",
    actorId: "op-1",
    body: { commandId: "w1-clearance-2", issuedAt: "2026-09-13T00:13:00+08:00", resolvedDefects: ["INC-0001-D1"] },
  });
  assert.equal(fix.status, 200);
  const reopen = await post(base, "/api/incidents/INC-0001/reopen", {
    role: "manager",
    actorId: "mgr-1",
    body: { commandId: "w1-reopen", issuedAt: "2026-09-13T00:14:00+08:00" },
  });
  assert.equal(reopen.status, 200);
  assert.equal(reopen.body.status, "REOPENED");

  pub = await pubAvailability(base, "2026-09-13T00:15:00+08:00");
  assert.equal(pub.body.segments.find((s) => s.segmentId === "RWY18L-A").available, true);

  // 内部时间轴：报告、派工、到场、发现、清除、复核、开放依次可见。
  const timeline = await api(base, { path: "/api/incidents/INC-0001/timeline", role: "staff", actorId: "op-1" });
  assert.equal(timeline.status, 200);
  assert.deepEqual(
    timeline.body.entries.map((e) => e.stage),
    ["report", "dispatch", "arrival", "finding", "clearance", "review", "clearance", "reopen"],
  );
  const findingEntry = timeline.body.entries.find((e) => e.stage === "finding");
  assert.equal(findingEntry.details.evidence.note, "金属碎片已清除，道面有剥落");
  assert.equal(findingEntry.actor, "op-1");
  const reportEntry = timeline.body.entries[0];
  assert.equal(reportEntry.details.closure.from, "2026-09-12T15:50:00.000Z");
});

test("涉及车辆未撤离时禁止开放", async (t) => {
  const { base } = await startService(t);
  await post(base, "/api/incidents", {
    role: "staff",
    body: {
      commandId: "v1-report",
      issuedAt: "2026-09-12T23:45:00+08:00",
      type: "ROUTINE_INSPECTION",
      segmentIds: ["RWY18L-B"],
      closure: { from: "2026-09-13T00:00:00+08:00", to: "2026-09-13T02:00:00+08:00" },
    },
  });
  await post(base, "/api/incidents/INC-0001/dispatch", {
    role: "manager",
    body: { commandId: "v1-dispatch", issuedAt: "2026-09-12T23:46:00+08:00", crewId: "crew-9", vehiclesInvolved: true },
  });
  await post(base, "/api/incidents/INC-0001/arrival", {
    role: "staff",
    body: { commandId: "v1-arrival", issuedAt: "2026-09-12T23:50:00+08:00" },
  });
  await post(base, "/api/incidents/INC-0001/findings", {
    role: "staff",
    body: { commandId: "v1-finding", issuedAt: "2026-09-12T23:55:00+08:00", evidence: { note: "巡检中" } },
  });
  await post(base, "/api/incidents/INC-0001/clearance", {
    role: "staff",
    body: { commandId: "v1-clearance", issuedAt: "2026-09-13T00:05:00+08:00", vehiclesCleared: false },
  });
  await post(base, "/api/incidents/INC-0001/review", {
    role: "manager",
    body: { commandId: "v1-review", issuedAt: "2026-09-13T00:10:00+08:00", verdict: "PASS" },
  });

  // 车辆仍在作业，开放被拒绝——这正是电话记录事故要防的情况。
  const blocked = await post(base, "/api/incidents/INC-0001/reopen", {
    role: "manager",
    body: { commandId: "v1-reopen-x", issuedAt: "2026-09-13T00:12:00+08:00" },
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, "vehicles_present");

  await post(base, "/api/incidents/INC-0001/clearance", {
    role: "staff",
    body: { commandId: "v1-clearance-2", issuedAt: "2026-09-13T00:13:00+08:00", vehiclesCleared: true },
  });
  const reopen = await post(base, "/api/incidents/INC-0001/reopen", {
    role: "manager",
    body: { commandId: "v1-reopen", issuedAt: "2026-09-13T00:14:00+08:00" },
  });
  assert.equal(reopen.status, 200);
  assert.equal(reopen.body.status, "REOPENED");
});

test("叠加封闭：解除一项不抵消另一项，可用性由全部有效限制推导", async (t) => {
  const { base } = await startService(t);
  const i1 = await driveToReviewed(base, {
    key: "i1",
    type: "FOD",
    segmentIds: ["RWY18L-A"],
    closure: { from: "2026-09-12T23:50:00+08:00", to: "2026-09-13T00:30:00+08:00" },
    times: [
      "2026-09-12T23:45:00+08:00",
      "2026-09-12T23:46:00+08:00",
      "2026-09-12T23:50:00+08:00",
      "2026-09-12T23:55:00+08:00",
      "2026-09-13T00:05:00+08:00",
      "2026-09-13T00:10:00+08:00",
    ],
  });
  const i2 = await driveToReviewed(base, {
    key: "i2",
    type: "ROUTINE_INSPECTION",
    segmentIds: ["RWY18L-A", "RWY18L-B"],
    closure: { from: "2026-09-13T00:05:00+08:00", to: "2026-09-13T01:00:00+08:00" },
    times: [
      "2026-09-12T23:48:00+08:00",
      "2026-09-12T23:49:00+08:00",
      "2026-09-12T23:52:00+08:00",
      "2026-09-12T23:56:00+08:00",
      "2026-09-13T00:06:00+08:00",
      "2026-09-13T00:11:00+08:00",
    ],
  });

  // 00:10 两条封闭叠加：A 的预计恢复取最晚结束 01:00。
  let pub = await pubAvailability(base, "2026-09-13T00:10:00+08:00");
  assert.equal(pub.body.segments.find((s) => s.segmentId === "RWY18L-A").estimatedRecoveryAt, "2026-09-12T17:00:00.000Z");
  assert.equal(pub.body.segments.find((s) => s.segmentId === "RWY18L-B").available, false);

  // 先解除异物封闭：A、B 仍被巡检封闭，与电话记录里"谁先解除"无关。
  const reopen1 = await post(base, `/api/incidents/${i1.incidentId}/reopen`, {
    role: "manager",
    body: { commandId: "i1-reopen", issuedAt: "2026-09-13T00:20:00+08:00" },
  });
  assert.equal(reopen1.status, 200);
  pub = await pubAvailability(base, "2026-09-13T00:25:00+08:00");
  assert.equal(pub.body.segments.find((s) => s.segmentId === "RWY18L-A").available, false);
  assert.equal(pub.body.segments.find((s) => s.segmentId === "RWY18L-B").available, false);

  const reopen2 = await post(base, `/api/incidents/${i2.incidentId}/reopen`, {
    role: "manager",
    body: { commandId: "i2-reopen", issuedAt: "2026-09-13T00:30:00+08:00" },
  });
  assert.equal(reopen2.status, 200);
  pub = await pubAvailability(base, "2026-09-13T00:35:00+08:00");
  assert.ok(pub.body.segments.every((s) => s.available));
});

test("紧急延长沿用原关联并形成新版本", async (t) => {
  const { base } = await startService(t);
  await post(base, "/api/incidents", {
    role: "staff",
    body: {
      commandId: "e1-report",
      issuedAt: "2026-09-12T23:45:00+08:00",
      type: "FOD",
      segmentIds: ["RWY18L-A"],
      closure: { from: "2026-09-12T23:50:00+08:00", to: "2026-09-13T00:30:00+08:00" },
    },
  });

  // 延长需要授权经理。
  const denied = await post(base, "/api/restrictions/RST-0001/extend", {
    role: "staff",
    body: { commandId: "e1-extend-x", issuedAt: "2026-09-13T00:10:00+08:00", newTo: "2026-09-13T01:30:00+08:00" },
  });
  assert.equal(denied.status, 403);

  const extended = await post(base, "/api/restrictions/RST-0001/extend", {
    role: "manager",
    actorId: "mgr-1",
    body: {
      commandId: "e1-extend",
      issuedAt: "2026-09-13T00:10:00+08:00",
      newTo: "2026-09-13T01:30:00+08:00",
      reason: "清扫未完成",
    },
  });
  assert.equal(extended.status, 200);
  assert.equal(extended.body.restrictionId, "RST-0001");
  assert.equal(extended.body.incidentId, "INC-0001"); // 沿用原关联
  assert.equal(extended.body.version, 2); // 形成新版本

  // 原窗口 00:30 已过的时刻仍不可用，预计恢复跟随新版本。
  const pub = await pubAvailability(base, "2026-09-13T00:45:00+08:00");
  assert.equal(pub.body.segments.find((s) => s.segmentId === "RWY18L-A").available, false);
  assert.equal(pub.body.segments.find((s) => s.segmentId === "RWY18L-A").estimatedRecoveryAt, "2026-09-12T17:30:00.000Z");

  const detail = await api(base, { path: "/api/restrictions/RST-0001", role: "staff" });
  assert.equal(detail.body.currentVersion, 2);
  assert.deepEqual(
    detail.body.versions.map((v) => [v.version, v.to]),
    [
      [1, "2026-09-12T16:30:00.000Z"],
      [2, "2026-09-12T17:30:00.000Z"],
    ],
  );

  // 不能缩短，也不能用更早签发的命令覆盖较新的决定。
  const shrink = await post(base, "/api/restrictions/RST-0001/extend", {
    role: "manager",
    body: { commandId: "e1-extend-2", issuedAt: "2026-09-13T00:15:00+08:00", newTo: "2026-09-13T01:00:00+08:00" },
  });
  assert.equal(shrink.status, 400);
  const stale = await post(base, "/api/restrictions/RST-0001/extend", {
    role: "manager",
    body: { commandId: "e1-extend-3", issuedAt: "2026-09-13T00:05:00+08:00", newTo: "2026-09-13T02:00:00+08:00" },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "stale_command");

  const again = await post(base, "/api/restrictions/RST-0001/extend", {
    role: "manager",
    body: { commandId: "e1-extend-4", issuedAt: "2026-09-13T00:20:00+08:00", newTo: "2026-09-13T02:00:00+08:00" },
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.version, 3);

  // 时间轴包含延长版本记录。
  const timeline = await api(base, { path: "/api/incidents/INC-0001/timeline", role: "staff" });
  const extensions = timeline.body.entries.filter((e) => e.stage === "extension");
  assert.equal(extensions.length, 2);
  assert.deepEqual(extensions.map((e) => e.details.version), [2, 3]);

  // 解除后不得再延长。
  await driveToReviewedAfter(base, "INC-0001", "e2", [
    "2026-09-13T00:21:00+08:00",
    "2026-09-13T00:22:00+08:00",
    "2026-09-13T00:23:00+08:00",
    "2026-09-13T00:24:00+08:00",
    "2026-09-13T00:25:00+08:00",
  ]);
  const reopen = await post(base, "/api/incidents/INC-0001/reopen", {
    role: "manager",
    body: { commandId: "e2-reopen", issuedAt: "2026-09-13T00:30:00+08:00" },
  });
  assert.equal(reopen.status, 200);
  const afterLift = await post(base, "/api/restrictions/RST-0001/extend", {
    role: "manager",
    body: { commandId: "e1-extend-5", issuedAt: "2026-09-13T00:31:00+08:00", newTo: "2026-09-13T03:00:00+08:00" },
  });
  assert.equal(afterLift.status, 409);
  assert.equal(afterLift.body.error.code, "invalid_state");
});

/** 对已存在事件补齐 派工→到场→发现→清除→复核。 */
async function driveToReviewedAfter(base, incidentId, key, [t1, t2, t3, t4, t5]) {
  const steps = [
    ["dispatch", "manager", { crewId: "crew-1", vehiclesInvolved: false }, t1],
    ["arrival", "staff", {}, t2],
    ["findings", "staff", { evidence: { note: "ok" } }, t3],
    ["clearance", "staff", {}, t4],
    ["review", "manager", { verdict: "PASS" }, t5],
  ];
  for (const [index, [action, role, payload, at]] of steps.entries()) {
    const res = await post(base, `/api/incidents/${incidentId}/${action}`, {
      role,
      body: { commandId: `${key}-${index}`, issuedAt: at, ...payload },
    });
    assert.equal(res.status, 200, `${action}: ${JSON.stringify(res.body)}`);
  }
}

test("重复消息与过期命令不会穿透较新的决定", async (t) => {
  const { base } = await startService(t, { now: "2026-09-12T23:40:00+08:00" });
  const body = {
    commandId: "d1-report",
    issuedAt: "2026-09-12T23:45:00+08:00",
    type: "FOD",
    segmentIds: ["RWY18L-A"],
    closure: { from: "2026-09-12T23:50:00+08:00", to: "2026-09-13T00:30:00+08:00" },
  };
  const first = await post(base, "/api/incidents", { role: "staff", body });
  assert.equal(first.status, 201);
  // 重复消息：返回首次结果，不产生第二个事件。
  const dup = await post(base, "/api/incidents", { role: "staff", body });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.duplicated, true);
  assert.equal(dup.body.incidentId, first.body.incidentId);
  const list = await api(base, { path: "/api/incidents", role: "staff" });
  assert.equal(list.body.incidents.length, 1);

  // 已过有效期的命令直接拒绝。
  const expired = await post(base, "/api/incidents", {
    role: "staff",
    body: { ...body, commandId: "d2-report", expiresAt: "2026-09-12T23:00:00+08:00" },
  });
  assert.equal(expired.status, 409);
  assert.equal(expired.body.error.code, "command_expired");

  await post(base, "/api/incidents/INC-0001/dispatch", {
    role: "manager",
    body: { commandId: "d1-dispatch", issuedAt: "2026-09-12T23:46:00+08:00", crewId: "crew-1" },
  });
  // 签发时间早于较新决定的迟到命令被拒绝。
  const staleArrival = await post(base, "/api/incidents/INC-0001/arrival", {
    role: "staff",
    body: { commandId: "d1-arrival-x", issuedAt: "2026-09-12T23:45:30+08:00" },
  });
  assert.equal(staleArrival.status, 409);
  assert.equal(staleArrival.body.error.code, "stale_command");
  // 状态未被穿透，后续正常命令仍可执行。
  const arrival = await post(base, "/api/incidents/INC-0001/arrival", {
    role: "staff",
    body: { commandId: "d1-arrival", issuedAt: "2026-09-12T23:47:00+08:00" },
  });
  assert.equal(arrival.status, 200);
  // 重复的旧命令也不会因时间检查而报错，而是按幂等返回。
  const dupDispatch = await post(base, "/api/incidents/INC-0001/dispatch", {
    role: "manager",
    body: { commandId: "d1-dispatch", issuedAt: "2026-09-12T23:46:00+08:00", crewId: "crew-1" },
  });
  assert.equal(dupDispatch.status, 200);
  assert.equal(dupDispatch.body.duplicated, true);
});

test("对外视图只暴露可用性与预计恢复时间", async (t) => {
  const { base } = await startService(t);
  await post(base, "/api/incidents", {
    role: "staff",
    body: {
      commandId: "p1-report",
      issuedAt: "2026-09-12T23:45:00+08:00",
      type: "PAVEMENT_DAMAGE",
      segmentIds: ["RWY18L-A"],
      closure: { from: "2026-09-12T23:50:00+08:00", to: "2026-09-13T00:30:00+08:00" },
    },
  });
  // 无需任何身份即可查询对外视图。
  const pub = await pubAvailability(base, "2026-09-12T23:55:00+08:00");
  assert.equal(pub.status, 200);
  assert.deepEqual(Object.keys(pub.body).sort(), ["asOf", "segments"]);
  for (const segment of pub.body.segments) {
    assert.deepEqual(Object.keys(segment).sort(), ["available", "estimatedRecoveryAt", "segmentId"]);
  }
  // 内部接口必须带内部身份。
  const denied = await api(base, { path: "/api/incidents" });
  assert.equal(denied.status, 401);
  const allowed = await api(base, { path: "/api/incidents", role: "staff" });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.incidents[0].type, "PAVEMENT_DAMAGE");
});

test("参数校验与未知资源", async (t) => {
  const { base } = await startService(t);
  const validBody = {
    commandId: "x1",
    issuedAt: "2026-09-12T23:45:00+08:00",
    type: "FOD",
    segmentIds: ["RWY18L-A"],
    closure: { from: "2026-09-12T23:50:00+08:00", to: "2026-09-13T00:30:00+08:00" },
  };
  const cases = [
    [{ ...validBody, commandId: "x2", segmentIds: ["RWY-UNKNOWN"] }, 400],
    [{ ...validBody, commandId: "x3", type: "BIRD_STRIKE" }, 400],
    [{ ...validBody, commandId: "x4", closure: { from: "2026-09-13T00:30:00+08:00", to: "2026-09-12T23:50:00+08:00" } }, 400],
    [{ ...validBody, commandId: undefined }, 400],
    [{ ...validBody, commandId: "x5", issuedAt: "not-a-time" }, 400],
  ];
  for (const [body, expected] of cases) {
    const res = await post(base, "/api/incidents", { role: "staff", body });
    assert.equal(res.status, expected, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "invalid_request");
  }
  assert.equal((await api(base, { path: "/api/incidents/INC-9999", role: "staff" })).status, 404);
  assert.equal((await api(base, { path: "/api/restrictions/RST-9999", role: "staff" })).status, 404);
  assert.equal((await api(base, { path: "/nope" })).status, 404);

  // 状态机：未派工不能到场；发现必须带证据。
  await post(base, "/api/incidents", { role: "staff", body: validBody });
  const earlyArrival = await post(base, "/api/incidents/INC-0001/arrival", {
    role: "staff",
    body: { commandId: "x6", issuedAt: "2026-09-12T23:46:00+08:00" },
  });
  assert.equal(earlyArrival.status, 409);
  assert.equal(earlyArrival.body.error.code, "invalid_state");
  await post(base, "/api/incidents/INC-0001/dispatch", {
    role: "manager",
    body: { commandId: "x7", issuedAt: "2026-09-12T23:46:00+08:00", crewId: "crew-1" },
  });
  await post(base, "/api/incidents/INC-0001/arrival", {
    role: "staff",
    body: { commandId: "x8", issuedAt: "2026-09-12T23:47:00+08:00" },
  });
  const noEvidence = await post(base, "/api/incidents/INC-0001/findings", {
    role: "staff",
    body: { commandId: "x9", issuedAt: "2026-09-12T23:48:00+08:00" },
  });
  assert.equal(noEvidence.status, 400);
});
