import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  deriveAvailability,
  intervalsOverlap,
  parseInstant,
  restrictionsOverlap,
} from "../src/domain.js";

const context = JSON.parse(await readFile(new URL("../fixtures/context.json", import.meta.url), "utf8"));
const segments = context.records.filter((r) => typeof r.segmentId === "string");
const samples = context.records
  .filter((r) => typeof r.restrictionId === "string")
  .map((r) => ({
    restrictionId: r.restrictionId,
    segments: r.segments,
    from: parseInstant(r.from, "from"),
    to: parseInstant(r.to, "to"),
    liftedAtMs: null,
  }));
const [fod, work] = samples;

const T = (iso) => parseInstant(iso, "t");

test("跨午夜封闭按绝对时刻比较", () => {
  // 23:50(+08:00) 之后是次日 00:05，而不是"同一天更早的时刻"。
  assert.ok(T("2026-09-12T23:50:00+08:00") < T("2026-09-13T00:05:00+08:00"));
  // 同一绝对瞬间的不同时区写法相等。
  assert.equal(T("2026-09-13T00:05:00+08:00"), T("2026-09-12T16:05:00Z"));
  assert.equal(T("2026-09-13T00:30:00+08:00"), T("2026-09-12T16:30:00Z"));
});

test("半开区间：首尾相接不算重叠", () => {
  assert.equal(intervalsOverlap(T("2026-09-12T23:50:00+08:00"), T("2026-09-13T00:30:00+08:00"), T("2026-09-13T00:05:00+08:00"), T("2026-09-13T01:00:00+08:00")), true);
  assert.equal(intervalsOverlap(0, 10, 10, 20), false);
  assert.equal(intervalsOverlap(0, 10, 5, 15), true);
  assert.equal(intervalsOverlap(0, null, 100, 200), true); // 无限期与任何区间相交
});

test("样例中两条封闭在 RWY18L-A 上重叠", () => {
  assert.equal(restrictionsOverlap(fod, work), true);
});

test("相邻区段不等于重叠", () => {
  // RWY18L-A 与 RWY18L-B 共用端点 L3，是相邻；把作业改到只在 B 上，时间完全重合也不重叠。
  const workOnAdjacentOnly = { ...work, segments: ["RWY18L-B"] };
  assert.equal(restrictionsOverlap(fod, workOnAdjacentOnly), false);
  // 同一区段但时间错开也不重叠。
  const fodLater = { ...fod, from: T("2026-09-13T02:00:00+08:00"), to: T("2026-09-13T03:00:00+08:00") };
  assert.equal(restrictionsOverlap(fodLater, work), false);
});

test("可用性由全部有效限制共同推导", () => {
  const at = (iso) => deriveAvailability(segments, samples, T(iso));

  // 23:55 只有异物封闭生效：A 不可用，相邻的 B 不受影响。
  let rows = at("2026-09-12T23:55:00+08:00");
  assert.deepEqual(rows.find((r) => r.segmentId === "RWY18L-A").available, false);
  assert.deepEqual(rows.find((r) => r.segmentId === "RWY18L-B").available, true);

  // 00:10 两条都生效：A 的预计恢复取最晚结束 01:00，B 被作业封闭。
  rows = at("2026-09-13T00:10:00+08:00");
  const a = rows.find((r) => r.segmentId === "RWY18L-A");
  assert.equal(a.available, false);
  assert.equal(a.estimatedRecoveryAt, "2026-09-12T17:00:00.000Z");
  assert.deepEqual(a.blockingRestrictionIds.sort(), ["close-fod-1", "close-work-2"]);
  assert.equal(rows.find((r) => r.segmentId === "RWY18L-B").available, false);

  // 00:30 整点异物封闭刚好结束（半开区间），A 仍被作业封闭。
  rows = at("2026-09-13T00:30:00+08:00");
  assert.equal(rows.find((r) => r.segmentId === "RWY18L-A").available, false);

  // 01:00 之后全部恢复。
  rows = at("2026-09-13T01:00:00+08:00");
  assert.ok(rows.every((r) => r.available));
  assert.ok(rows.every((r) => r.estimatedRecoveryAt === null));
});

test("解除其中一项不抵消其他仍有效限制", () => {
  const liftedFod = { ...fod, liftedAtMs: T("2026-09-13T00:15:00+08:00") };
  const rows = deriveAvailability(segments, [liftedFod, work], T("2026-09-13T00:20:00+08:00"));
  const a = rows.find((r) => r.segmentId === "RWY18L-A");
  assert.equal(a.available, false); // 作业封闭仍在
  assert.deepEqual(a.blockingRestrictionIds, ["close-work-2"]);
  assert.equal(a.estimatedRecoveryAt, "2026-09-12T17:00:00.000Z");
});

test("无限期封闭没有预计恢复时间", () => {
  const openEnded = { ...work, to: null };
  const rows = deriveAvailability(segments, [fod, openEnded], T("2026-09-13T00:10:00+08:00"));
  assert.equal(rows.find((r) => r.segmentId === "RWY18L-A").estimatedRecoveryAt, null);
});
