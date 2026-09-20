// 状态投影：把只追加的事件日志归约为当前状态；可用性是状态的纯函数，
// 因此无论命令到达先后、无论重放多少次（含服务重启），同一绝对时刻得到同一结论。

import { Topology, DomainError } from "./topology.js";
import { EventType } from "./events.js";

export function createState() {
  return {
    topology: new Topology(),
    /** @type {Map<string, any>} */
    incidents: new Map(),
    /** @type {Map<string, any>} */
    restrictions: new Map(),
    /** 命令幂等索引：commandId -> 首次处理结果 */
    commands: new Map(),
    events: [],
  };
}

export function applyEvent(state, evt) {
  const d = evt.data;
  switch (evt.type) {
    case EventType.SEGMENT_DEFINED: {
      state.topology.define({ segmentId: d.segmentId, from: d.from, to: d.to, adjacent: d.adjacent ?? [] });
      break;
    }
    case EventType.INCIDENT_REPORTED: {
      state.incidents.set(d.incidentId, {
        incidentId: d.incidentId,
        type: d.type,
        segments: [...d.segments],
        summary: d.summary ?? "",
        reporterId: d.reporterId,
        at: d.at,
      });
      break;
    }
    case EventType.RESTRICTION_CREATED: {
      state.restrictions.set(d.restrictionId, {
        id: d.restrictionId,
        reason: d.reason,
        segments: [...d.segments],
        incidentId: d.incidentId ?? null,
        createdBy: d.createdBy,
        createdAt: d.at,
        versions: [{ version: 1, from: d.from, to: d.to, decidedAt: d.at, by: d.createdBy }],
        currentVersion: 1,
        opened: null,
        dispatch: null,
        arrivals: [],
        findings: [],
        clearancesByVersion: new Map(),
        reviewsByVersion: new Map(),
      });
      break;
    }
    case EventType.RESTRICTION_EXTENDED: {
      const r = mustGet(state, d.restrictionId);
      r.versions.push({
        version: d.version,
        from: r.versions[r.versions.length - 1].from, // 生效起点沿用原封闭，措施连续
        to: d.to,
        decidedAt: d.at,
        by: d.by,
        predecessor: d.predecessorVersion,
      });
      r.currentVersion = d.version;
      break;
    }
    case EventType.INSPECTION_DISPATCHED: {
      const r = mustGet(state, d.restrictionId);
      r.dispatch = { teamId: d.teamId, at: d.at, by: d.by };
      break;
    }
    case EventType.TEAM_ARRIVED: {
      const r = mustGet(state, d.restrictionId);
      r.arrivals.push({ teamId: d.teamId, at: d.at, by: d.by });
      break;
    }
    case EventType.FINDING_RECORDED: {
      const r = mustGet(state, d.restrictionId);
      r.findings.push({
        findingId: d.findingId,
        kind: d.kind,
        blocking: d.blocking,
        detail: d.detail ?? "",
        at: d.at,
        by: d.by,
        status: "open",
        resolvedAt: null,
        resolvedBy: null,
      });
      break;
    }
    case EventType.FINDING_RESOLVED: {
      const r = mustGet(state, d.restrictionId);
      const finding = r.findings.find((f) => f.findingId === d.findingId);
      if (finding && finding.status === "open") {
        finding.status = "resolved";
        finding.resolvedAt = d.at;
        finding.resolvedBy = d.by;
      }
      break;
    }
    case EventType.CLEARANCE_SUBMITTED: {
      const r = mustGet(state, d.restrictionId);
      const list = r.clearancesByVersion.get(d.version) ?? [];
      list.push({ at: d.at, by: d.by, evidence: d.evidence ?? "", teamsCleared: [...(d.teamsCleared ?? [])] });
      r.clearancesByVersion.set(d.version, list);
      break;
    }
    case EventType.REOPEN_REVIEWED: {
      const r = mustGet(state, d.restrictionId);
      r.reviewsByVersion.set(d.version, { decision: d.decision, note: d.note ?? "", at: d.at, by: d.by });
      break;
    }
    case EventType.RESTRICTION_OPENED: {
      const r = mustGet(state, d.restrictionId);
      r.opened = { version: d.version, at: d.at, by: d.by };
      break;
    }
    default:
      throw new Error(`未知事件类型: ${evt.type}`);
  }
  state.events.push(evt);
}

function mustGet(state, restrictionId) {
  const r = state.restrictions.get(restrictionId);
  if (!r) throw new DomainError("unknown_restriction", 404, `未知封闭措施 ${restrictionId}`);
  return r;
}

// ---- 派生判断 ----------------------------------------------------------------

export function latestVersion(r) {
  return r.versions[r.versions.length - 1];
}

export function openBlockingFindings(r) {
  return r.findings.filter((f) => f.status === "open" && f.blocking);
}

// 车辆是否仍在场：按班组比较，任一班组最后一次到场之后没有对应的清场证据即视为在场。
// （清场证据可以在检查清除时一并提交，列出已撤离的班组。）
export function vehiclesStillPresent(r, at = Number.POSITIVE_INFINITY) {
  if (r.reason !== "VEHICLE_WORK") return false;
  const lastArrivalByTeam = new Map();
  for (const a of r.arrivals) {
    if (a.at <= at) lastArrivalByTeam.set(a.teamId, Math.max(lastArrivalByTeam.get(a.teamId) ?? -Infinity, a.at));
  }
  if (lastArrivalByTeam.size === 0) return false;
  if (r.opened && r.opened.at <= at) return false;
  const lastClearedByTeam = new Map();
  for (const c of [...r.clearancesByVersion.values()].flat()) {
    for (const teamId of c.teamsCleared ?? []) {
      if (c.at <= at) lastClearedByTeam.set(teamId, Math.max(lastClearedByTeam.get(teamId) ?? -Infinity, c.at));
    }
  }
  for (const [teamId, arrivedAt] of lastArrivalByTeam) {
    if ((lastClearedByTeam.get(teamId) ?? -Infinity) < arrivedAt) return true;
  }
  return false;
}

export function openingBlockers(r, version = r.currentVersion, at = Number.POSITIVE_INFINITY) {
  const blockers = [];
  if (r.opened) blockers.push({ code: "already_open", message: "该区段已开放" });
  if (version !== r.currentVersion) {
    blockers.push({ code: "stale_version", message: `命令针对版本 v${version}，当前为 v${r.currentVersion}` });
  }
  const defects = openBlockingFindings(r);
  if (defects.length > 0) {
    blockers.push({
      code: "open_defect",
      message: `存在 ${defects.length} 项未结缺陷`,
      findingIds: defects.map((f) => f.findingId),
    });
  }
  if (vehiclesStillPresent(r, at)) blockers.push({ code: "vehicles_present", message: "仍有车辆在区段内作业" });
  if (version === r.currentVersion) {
    const clearances = r.clearancesByVersion.get(version) ?? [];
    if (clearances.length === 0) blockers.push({ code: "clearance_missing", message: "现场尚未提交当前版本的检查证据" });
    const review = r.reviewsByVersion.get(version);
    if (!review) blockers.push({ code: "review_missing", message: "值班经理尚未复核" });
    else if (review.decision !== "APPROVED") blockers.push({ code: "review_rejected", message: "复核未通过" });
  }
  return blockers;
}

/**
 * 某条限制在绝对时刻 at 的效力：
 * - OPENED   已正式解除（在开放时刻起失效）
 * - CLOSED   处于有效时间窗内
 * - HOLD     时间窗已过但仍有安全阻塞（在场车辆/未结缺陷），不得判为可用
 * - LAPSED   时间窗已过且无阻塞，自然失效
 */
export function restrictionEffect(r, at) {
  const v = latestVersion(r);
  if (r.opened && r.opened.version === r.currentVersion && at >= r.opened.at) return "OPENED";
  const inWindow = at >= v.from && at < v.to;
  const blocked = openBlockingFindings(r).length > 0 || vehiclesStillPresent(r, at);
  if (inWindow) return "CLOSED";
  return blocked ? "HOLD" : "LAPSED";
}

/**
 * 由“全部有效限制”共同推导每个区段的当前可用性。
 * 相邻区段不会相互牵连；只有区段集合与时间窗同时交叠的限制才共同作用。
 */
export function computeAvailability(state, at) {
  const active = [];
  for (const r of state.restrictions.values()) {
    const effect = restrictionEffect(r, at);
    if (effect === "CLOSED" || effect === "HOLD") active.push({ r, effect });
  }

  return state.topology.list().map((segment) => {
    const covering = active.filter(({ r }) => r.segments.includes(segment.segmentId));
    if (covering.length === 0) {
      return { segmentId: segment.segmentId, available: true, status: "AVAILABLE", eta: null, causes: [] };
    }
    // 预计恢复：取所有时间窗内限制的最早到期时刻；若仅剩安全阻塞（无时间窗），恢复时刻不可预测
    const etas = covering.filter(({ effect }) => effect === "CLOSED").map(({ r }) => latestVersion(r).to);
    const holdOnly = etas.length === 0;
    return {
      segmentId: segment.segmentId,
      available: false,
      status: covering.some(({ effect }) => effect === "HOLD") ? "BLOCKED" : "CLOSED",
      eta: holdOnly ? null : Math.min(...etas),
      causes: covering.map(({ r, effect }) => ({
        restrictionId: r.id,
        reason: r.reason,
        effect,
        version: r.currentVersion,
      })),
    };
  });
}
