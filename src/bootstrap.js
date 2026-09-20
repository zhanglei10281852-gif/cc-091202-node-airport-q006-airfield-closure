// 启动引导：加载事件日志（不存在时从 fixtures 样例播种），组装服务。

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EventStore } from "./domain/store.js";
import { AirfieldService } from "./domain/service.js";
import { EventType, parseInstant } from "./domain/events.js";

function defaultFixture() {
  return fileURLToPath(new URL("../fixtures/context.json", import.meta.url));
}

function buildEvent(rec) {
  if (rec.restrictionId) {
    const from = parseInstant(rec.from, "from");
    const to = parseInstant(rec.to, "to");
    return [
      EventType.RESTRICTION_CREATED,
      {
        restrictionId: rec.restrictionId,
        reason: rec.reason,
        segments: rec.segments,
        incidentId: null,
        createdBy: "fixture",
        at: from,
        from,
        to,
      },
      `seed:${rec.restrictionId}`,
    ];
  }
  if (rec.segmentId) {
    return [
      EventType.SEGMENT_DEFINED,
      { segmentId: rec.segmentId, from: rec.from, to: rec.to, adjacent: rec.adjacent ?? [] },
      `seed:${rec.segmentId}`,
    ];
  }
  return null;
}

export async function seedFromFixture(store, path = defaultFixture()) {
  const data = JSON.parse(await readFile(path, "utf8"));
  for (const rec of data.records ?? []) {
    const built = buildEvent(rec);
    if (built) await store.append(...built);
  }
}

function seedFromFixtureSync(store, path = defaultFixture()) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  for (const rec of data.records ?? []) {
    const built = buildEvent(rec);
    if (built) store.appendSync(...built);
  }
}

export async function createApp(options = {}) {
  const store = new EventStore(options.logPath, { clock: options.clock });
  await store.load();
  if (store.state.events.length === 0 && options.seedPath !== null) {
    await seedFromFixture(store, options.seedPath ?? defaultFixture());
  }
  return new AirfieldService(store, { clock: options.clock ?? (() => Date.now()) });
}

// 同步版本：供 HTTP 服务器的同步工厂使用
export function createAppSync(options = {}) {
  const store = new EventStore(options.logPath, { clock: options.clock });
  store.loadSync();
  if (store.state.events.length === 0 && options.seedPath !== null) {
    seedFromFixtureSync(store, options.seedPath ?? defaultFixture());
  }
  return new AirfieldService(store, { clock: options.clock ?? (() => Date.now()) });
}
