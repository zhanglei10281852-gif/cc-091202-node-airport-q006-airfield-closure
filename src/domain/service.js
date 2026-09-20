// 应用层：受理协同流程命令。
// 所有“基于当前投影的校验 + 事件追加”都在存储的串行队列锁内原子完成（store.commit），
// 因此并发命令按入队顺序线性化：过期命令（旧版本）与重复消息（commandId）都不会穿透较新决定。

import { DomainError } from "./topology.js";
import { EventType, IncidentType, RestrictionReason, ReviewDecision, Role, Phase, parseInstant, iso } from "./events.js";
import {
  computeAvailability,
  latestVersion,
  openBlockingFindings,
  openingBlockers,
  restrictionEffect,
  vehiclesStillPresent,
} from "./projection.js";

const REASONS = new Set(Object.values(RestrictionReason));
const TYPES = new Set(Object.values(IncidentType));

function requireRole(actor, role) {
  if (!actor || typeof actor.userId !== "string") {
    throw new DomainError("unauthenticated", 401, "缺少操作者身份");
  }
  if (role && actor.role !== role) {
    throw new DomainError("forbidden", 403, `该操作仅授权给 ${role}`);
  }
}

function pickTime(body, fallbackClock) {
  const raw = body.time;
  const ms = raw === undefined ? fallbackClock() : parseInstant(raw, "time");
  if (ms === undefined) throw new DomainError("invalid_time", 400, "缺少 time 字段");
  return ms;
}

function requireFields(body, fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === "") {
      throw new DomainError("missing_field", 400, `缺少字段 ${f}`);
    }
  }
}

export class AirfieldService {
  /**
   * @param {import("./store.js").EventStore} store
   */
  constructor(store, { clock = () => Date.now() } = {}) {
    this.store = store;
    this.clock = clock;
    // 幂等短路：重复消息在任何业务校验之前直接返回首次事件
    for (const name of MUTATING_METHODS) {
      const original = this[name].bind(this);
      this[name] = (actor, body, commandId) => {
        if (commandId) {
          const cached = this.store.getCommand(commandId);
          if (cached) return Promise.resolve(cached);
        }
        return original(actor, body, commandId);
      };
    }
  }

  get state() {
    return this.store.state;
  }

  // ---- 拓扑 ----------------------------------------------------------------

  async defineSegment(actor, body, commandId) {
    requireRole(actor);
    requireFields(body, ["segmentId", "from", "to"]);
    const adjacent = body.adjacent ?? [];
    if (!Array.isArray(adjacent)) throw new DomainError("invalid_field", 400, "adjacent 必须是数组");
    const data0 = { segmentId: body.segmentId, from: body.from, to: body.to, adjacent: [...new Set(adjacent)] };
    // 相邻允许前向引用：B 可能尚未定义；端点相连会在双方定义后自动建立相邻关系
    return this.store.commit(commandId, () => ({ type: EventType.SEGMENT_DEFINED, data: data0 }));
  }

  // ---- 受理事件：异物 / 道面损伤 / 例行检查 ---------------------------------

  async reportIncident(actor, body, commandId) {
    requireRole(actor);
    requireFields(body, ["incidentId", "type", "segments"]);
    if (!TYPES.has(body.type)) throw new DomainError("invalid_field", 400, `不支持的事件类型 ${body.type}`);
    const segments = body.segments;
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new DomainError("invalid_field", 400, "segments 必须是非空数组");
    }
    const at = pickTime(body, this.clock);
    const data = {
      incidentId: body.incidentId,
      type: body.type,
      segments: [...new Set(segments)],
      summary: typeof body.summary === "string" ? body.summary : "",
      reporterId: actor.userId,
      at,
    };
    return this.store.commit(commandId, (state) => {
      state.topology.requireExist(data.segments);
      if (state.incidents.has(data.incidentId)) {
        throw new DomainError("duplicate_incident", 409, `事件 ${data.incidentId} 已存在`);
      }
      return { type: EventType.INCIDENT_REPORTED, data };
    });
  }

  // ---- 生成封闭措施（带影响范围与有效时间，时间为半开区间 [from,to)） -------

  async createRestriction(actor, body, commandId) {
    requireRole(actor, Role.MANAGER);
    requireFields(body, ["restrictionId", "reason", "segments", "to"]);
    if (!REASONS.has(body.reason)) throw new DomainError("invalid_field", 400, `不支持的封闭原因 ${body.reason}`);
    const segments = body.segments;
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new DomainError("invalid_field", 400, "segments 必须是非空数组");
    }
    const at = pickTime(body, this.clock);
    const from = body.from === undefined ? at : parseInstant(body.from, "from");
    const to = parseInstant(body.to, "to");
    if (!(to > from)) throw new DomainError("invalid_window", 400, "to 必须晚于 from（按绝对时刻比较）");
    const data = {
      restrictionId: body.restrictionId,
      reason: body.reason,
      segments: [...new Set(segments)],
      incidentId: body.incidentId ?? null,
      createdBy: actor.userId,
      at,
      from,
      to,
    };
    return this.store.commit(commandId, (state) => {
      state.topology.requireExist(data.segments);
      if (state.restrictions.has(data.restrictionId)) {
        throw new DomainError("duplicate_restriction", 409, `封闭措施 ${data.restrictionId} 已存在`);
      }
      if (data.incidentId && !state.incidents.has(data.incidentId)) {
        throw new DomainError("unknown_incident", 404, `未知事件 ${data.incidentId}`);
      }
      return { type: EventType.RESTRICTION_CREATED, data };
    });
  }

  // 紧急延长：沿用原封闭（同一 restrictionId、同一区段与原因关联），形成新版本
  async extendRestriction(actor, body, commandId) {
    requireRole(actor, Role.MANAGER);
    requireFields(body, ["restrictionId", "to"]);
    const to = parseInstant(body.to, "to");
    const at = pickTime(body, this.clock);
    return this.store.commit(commandId, (state) => {
      const r = state.restrictions.get(body.restrictionId);
      if (!r) throw new DomainError("unknown_restriction", 404, `未知封闭措施 ${body.restrictionId}`);
      if (r.opened) throw new DomainError("already_open", 409, "已开放的措施不能延长，请新建封闭");
      const current = latestVersion(r);
      if (!(to > current.to)) throw new DomainError("invalid_window", 400, "紧急延长必须给出更晚的 to");
      return {
        type: EventType.RESTRICTION_EXTENDED,
        data: { restrictionId: r.id, version: r.versions.length + 1, predecessorVersion: current.version, to, at, by: actor.userId },
      };
    });
  }

  // ---- 派工 / 到场 ---------------------------------------------------------

  async dispatch(actor, body, commandId) {
    requireRole(actor, Role.MANAGER);
    requireFields(body, ["restrictionId", "teamId"]);
    const at = pickTime(body, this.clock);
    return this.store.commit(commandId, (state) => {
      const r = mustGet(state, body.restrictionId);
      if (r.opened) throw new DomainError("already_open", 409, "措施已开放，无需派工");
      return { type: EventType.INSPECTION_DISPATCHED, data: { restrictionId: r.id, teamId: body.teamId, at, by: actor.userId } };
    });
  }

  async arrive(actor, body, commandId) {
    requireRole(actor, Role.FIELD);
    requireFields(body, ["restrictionId", "teamId"]);
    const at = pickTime(body, this.clock);
    return this.store.commit(commandId, (state) => {
      const r = mustGet(state, body.restrictionId);
      return { type: EventType.TEAM_ARRIVED, data: { restrictionId: r.id, teamId: body.teamId, at, by: actor.userId } };
    });
  }

  // ---- 发现 / 清除缺陷 ------------------------------------------------------

  async recordFinding(actor, body, commandId) {
    requireRole(actor, Role.FIELD);
    requireFields(body, ["restrictionId", "findingId", "kind"]);
    const at = pickTime(body, this.clock);
    return this.store.commit(commandId, (state) => {
      const r = mustGet(state, body.restrictionId);
      if (r.findings.some((f) => f.findingId === body.findingId)) {
        throw new DomainError("duplicate_finding", 409, `发现记录 ${body.findingId} 已存在`);
      }
      return {
        type: EventType.FINDING_RECORDED,
        data: {
          restrictionId: r.id,
          findingId: body.findingId,
          kind: body.kind,
          blocking: body.blocking !== false, // 默认阻断开放
          detail: typeof body.detail === "string" ? body.detail : "",
          at,
          by: actor.userId,
        },
      };
    });
  }

  async resolveFinding(actor, body, commandId) {
    requireRole(actor, Role.FIELD);
    requireFields(body, ["restrictionId", "findingId"]);
    const at = pickTime(body, this.clock);
    return this.store.commit(commandId, (state) => {
      const r = mustGet(state, body.restrictionId);
      const finding = r.findings.find((f) => f.findingId === body.findingId);
      if (!finding) throw new DomainError("unknown_finding", 404, `未知发现记录 ${body.findingId}`);
      if (finding.status !== "open") throw new DomainError("finding_closed", 409, "该发现已结项");
      return { type: EventType.FINDING_RESOLVED, data: { restrictionId: r.id, findingId: body.findingId, at, by: actor.userId } };
    });
  }

  // ---- 现场提交检查证据（可同时声明已撤离班组） ------------------------------

  async submitClearance(actor, body, commandId) {
    requireRole(actor, Role.FIELD);
    requireFields(body, ["restrictionId", "evidence"]);
    const teamsCleared = body.teamsCleared ?? [];
    if (!Array.isArray(teamsCleared)) throw new DomainError("invalid_field", 400, "teamsCleared 必须是数组");
    const at = pickTime(body, this.clock);
    return this.store.commit(commandId, (state) => {
      const r = mustGet(state, body.restrictionId);
      if (r.opened) throw new DomainError("already_open", 409, "措施已开放");
      const version = body.version ?? r.currentVersion;
      if (!r.versions.some((v) => v.version === version)) {
        throw new DomainError("unknown_version", 404, `未知版本 v${version}`);
      }
      return {
        type: EventType.CLEARANCE_SUBMITTED,
        data: { restrictionId: r.id, version, at, by: actor.userId, evidence: body.evidence, teamsCleared: [...new Set(teamsCleared)] },
      };
    });
  }

  // ---- 授权经理复核 ---------------------------------------------------------

  async reviewReopen(actor, body, commandId) {
    requireRole(actor, Role.MANAGER);
    requireFields(body, ["restrictionId", "decision"]);
    if (!Object.values(ReviewDecision).includes(body.decision)) {
      throw new DomainError("invalid_field", 400, "decision 必须是 APPROVED 或 REJECTED");
    }
    const at = pickTime(body, this.clock);
    return this.store.commit(commandId, (state) => {
      const r = mustGet(state, body.restrictionId);
      if (r.opened) throw new DomainError("already_open", 409, "措施已开放");
      const version = body.version ?? r.currentVersion;
      if (!r.versions.some((v) => v.version === version)) {
        throw new DomainError("unknown_version", 404, `未知版本 v${version}`);
      }
      return {
        type: EventType.REOPEN_REVIEWED,
        data: { restrictionId: r.id, version, decision: body.decision, note: typeof body.note === "string" ? body.note : "", at, by: actor.userId },
      };
    });
  }

  // ---- 开放：证据 + 复核缺一不可，车辆/未结缺陷一票否决；旧版本命令拒绝 ------

  async reopen(actor, body, commandId) {
    requireRole(actor, Role.MANAGER);
    requireFields(body, ["restrictionId"]);
    const at = pickTime(body, this.clock);
    return this.store.commit(commandId, (state) => {
      const r = mustGet(state, body.restrictionId);
      const version = body.version ?? r.currentVersion;
      // 针对提交时刻最新投影做判断；若队列中已有更新决定（如紧急延长），此处会拿到新版本并拒绝旧命令
      const blockers = openingBlockers(r, version, at);
      if (blockers.length > 0) {
        throw new DomainError("reopen_blocked", 409, "当前不能开放", blockers);
      }
      return { type: EventType.RESTRICTION_OPENED, data: { restrictionId: r.id, version, at, by: actor.userId } };
    });
  }

  // ---- 查询 ----------------------------------------------------------------

  // 对外：只暴露当前可用性与预计恢复时间，不暴露原因细节
  publicAvailability(query = {}) {
    const at = query.at === undefined ? this.clock() : parseInstant(query.at, "at");
    return {
      at: iso(at),
      segments: computeAvailability(this.state, at).map((s) => ({
        segmentId: s.segmentId,
        available: s.available,
        eta: s.eta === null ? null : iso(s.eta),
      })),
    };
  }

  // 内部：含原因、版本、阻塞项
  internalAvailability(query = {}) {
    const at = query.at === undefined ? this.clock() : parseInstant(query.at, "at");
    return {
      at: iso(at),
      segments: computeAvailability(this.state, at).map((s) => ({
        ...s,
        eta: s.eta === null ? null : iso(s.eta),
      })),
    };
  }

  // 内部：各封闭措施的版本、证据/复核状态与当前阻塞项
  listRestrictions(query = {}) {
    const at = query.at === undefined ? this.clock() : parseInstant(query.at, "at");
    return [...this.state.restrictions.values()].map((r) => ({
      restrictionId: r.id,
      reason: r.reason,
      segments: [...r.segments],
      incidentId: r.incidentId,
      currentVersion: r.currentVersion,
      effect: restrictionEffect(r, at),
      versions: r.versions.map((v) => ({
        version: v.version,
        from: iso(v.from),
        to: iso(v.to),
        clearances: (r.clearancesByVersion.get(v.version) ?? []).map((c) => ({ at: iso(c.at), by: c.by })),
        review: r.reviewsByVersion.get(v.version)
          ? { decision: r.reviewsByVersion.get(v.version).decision, at: iso(r.reviewsByVersion.get(v.version).at), by: r.reviewsByVersion.get(v.version).by }
          : null,
      })),
      openBlockingFindings: openBlockingFindings(r).map((f) => f.findingId),
      vehiclesPresent: vehiclesStillPresent(r, at),
      opened: r.opened ? { version: r.opened.version, at: iso(r.opened.at) } : null,
      blockers: r.opened ? [] : openingBlockers(r, r.currentVersion, at).map((b) => b.code),
    }));
  }

  // 内部时间轴：报告、派工、到场、发现、清除、复核、开放，按绝对时刻排序（与写入顺序无关）
  timeline(query = {}) {
    const at = query.at === undefined ? Number.POSITIVE_INFINITY : parseInstant(query.at, "at");
    const events = [];
    for (const evt of this.state.events) {
      const d = evt.data;
      const when = d.at ?? evt.at;
      if (when > at) continue;
      events.push({
        seq: evt.seq,
        phase: Phase[evt.type] ?? "UNKNOWN",
        type: evt.type,
        at: iso(when),
        actor: d.by ?? d.reporterId ?? d.createdBy ?? null,
        restrictionId: d.restrictionId ?? null,
        incidentId: d.incidentId ?? null,
        detail: summarize(evt),
      });
    }
    // 绝对时刻优先；同一时刻用 seq 稳定次序
    events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq);
    return events;
  }
}

function mustGet(state, restrictionId) {
  const r = state.restrictions.get(restrictionId);
  if (!r) throw new DomainError("unknown_restriction", 404, `未知封闭措施 ${restrictionId}`);
  return r;
}

const MUTATING_METHODS = [
  "defineSegment",
  "reportIncident",
  "createRestriction",
  "extendRestriction",
  "dispatch",
  "arrive",
  "recordFinding",
  "resolveFinding",
  "submitClearance",
  "reviewReopen",
  "reopen",
];

function summarize(evt) {
  const d = evt.data;
  switch (evt.type) {
    case EventType.SEGMENT_DEFINED:
      return { segmentId: d.segmentId, from: d.from, to: d.to };
    case EventType.INCIDENT_REPORTED:
      return { type: d.type, segments: d.segments, summary: d.summary };
    case EventType.RESTRICTION_CREATED:
      return { reason: d.reason, segments: d.segments, from: iso(d.from), to: iso(d.to), version: 1 };
    case EventType.RESTRICTION_EXTENDED:
      return { version: d.version, predecessorVersion: d.predecessorVersion, to: iso(d.to) };
    case EventType.INSPECTION_DISPATCHED:
      return { teamId: d.teamId };
    case EventType.TEAM_ARRIVED:
      return { teamId: d.teamId };
    case EventType.FINDING_RECORDED:
      return { findingId: d.findingId, kind: d.kind, blocking: d.blocking, detail: d.detail };
    case EventType.FINDING_RESOLVED:
      return { findingId: d.findingId };
    case EventType.CLEARANCE_SUBMITTED:
      return { version: d.version, evidence: d.evidence, teamsCleared: d.teamsCleared };
    case EventType.REOPEN_REVIEWED:
      return { version: d.version, decision: d.decision, note: d.note };
    case EventType.RESTRICTION_OPENED:
      return { version: d.version };
    default:
      return {};
  }
}
