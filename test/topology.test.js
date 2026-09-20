import assert from "node:assert/strict";
import test from "node:test";
import { Topology, segmentSetsIntersect, intervalsOverlap } from "../src/domain/topology.js";

test("端点相连自动建立相邻；相邻是对称关系", () => {
  const topo = new Topology();
  topo.define({ segmentId: "A", from: "L1", to: "L3" });
  topo.define({ segmentId: "B", from: "L3", to: "L5" });
  topo.define({ segmentId: "C", from: "L5", to: "L7" });
  assert.ok(topo.isAdjacent("A", "B"));
  assert.ok(topo.isAdjacent("B", "A"));
  assert.ok(topo.isAdjacent("B", "C"));
  assert.ok(!topo.isAdjacent("A", "C"));
});

test("显式相邻允许前向引用，后续定义不重复", () => {
  const topo = new Topology();
  topo.define({ segmentId: "A", from: "L1", to: "L3", adjacent: ["B"] });
  topo.define({ segmentId: "B", from: "L3", to: "L5", adjacent: ["A"] });
  assert.deepEqual(topo.get("A").adjacent, new Set(["B"]));
});

test("区段集合只有共同成员才算交叠；相邻成员名不算", () => {
  assert.equal(segmentSetsIntersect(["A"], ["A", "B"]), true);
  assert.equal(segmentSetsIntersect(["A"], ["B"]), false);
  assert.equal(segmentSetsIntersect(["A", "B"], ["B", "C"]), true);
});

test("时间区间半开且按绝对时刻比较：跨午夜 23:50-00:30 与 00:05-01:00 交叠", () => {
  const t = (s) => Date.parse(s);
  const a = t("2026-09-12T23:50:00+08:00");
  const b1 = t("2026-09-13T00:30:00+08:00");
  const c = t("2026-09-13T00:05:00+08:00");
  const d = t("2026-09-13T01:00:00+08:00");
  assert.equal(intervalsOverlap(a, b1, c, d), true);
  // 端点相接（前区间 to === 后区间 from）不算交叠
  assert.equal(intervalsOverlap(a, c, c, d), false);
  // 完全在前
  assert.equal(intervalsOverlap(a, b1, d, d + 1000), false);
});
