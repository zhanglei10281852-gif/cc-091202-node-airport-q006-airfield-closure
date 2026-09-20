import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  DomainError,
  INCIDENT_TYPES,
  deriveAvailability,
  parseInstant,
  toIso,
} from "./domain.js";

/**
 * 事件溯源存储。
 *
 * - 每个命令携带 commandId / issuedAt / 可选 expiresAt；
 * - 重复 commandId 直接返回首次结果，不重复生效；
 * - 已过 expiresAt 的命令拒绝执行；issuedAt 早于目标聚合最近一次决定的命令视为过期，
 *   不会穿透较新的决定；
 * - 接受的命令以 JSONL 追加到 dataFile（可为空 = 纯内存），重启后按序回放，
 *   可用性等派生状态与故障前完全一致；
 * - 解除、延长只作用于目标限制本身，可用性始终由全部有效限制共同推导。
 */
export class ClosureStore {
  /** 打开（必要时回放日志）一个存储；dataFile 为 null 时纯内存运行。 */
  static async open(options = {}) {
    const store = new ClosureStore(options);
    await store.#load();
    return store;
  }

  #dataFile;
  #clock;
  #segments = new Map();
  #incidents = new Map();
  #restrictions = new Map();
  #commands = new Map(); // commandId -> 首次响应快照
  #queue = Promise.resolve();

  constructor({ dataFile = null, segments = [], clock = () => new Date() } = {}) {
    this.#dataFile = dataFile;
    this.#clock = clock;
    for (const segment of segments) {
      this.#segments.set(segment.segmentId, {
        segmentId: segment.segmentId,
        from: segment.from ?? null,
        to: segment.to ?? null,
        adjacent: [...(segment.adjacent ?? [])],
      });
    }
  }

  nowMs() {
    return this.#clock().getTime();
  }

  // ---------------------------------------------------------------- 命令入口

  /** 串行执行命令，保证"校验-落盘-应用"原子完成。 */
  execute(command) {
    const result = this.#queue.then(() => this.#executeLocked(command));
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #executeLocked(command) {
    const envelope = this.#validateEnvelope(command);
    const existing = this.#commands.get(envelope.commandId);
    if (existing) return { ...existing, duplicated: true };

    const nowMs = this.nowMs();
    if (envelope.expiresAtMs !== null && nowMs > envelope.expiresAtMs) {
      throw new DomainError(409, "command_expired", "命令已超过有效期限，不再执行", {
        expiresAt: toIso(envelope.expiresAtMs),
      });
    }

    const handler = this.#handlers[command.action];
    if (!handler) {
      throw new DomainError(400, "unknown_action", `未知操作: ${String(command.action)}`);
    }

    const ctx = { issuedAtMs: envelope.issuedAtMs, nowMs, actor: command.actor ?? null };
    const { events, response } = handler.call(this, command, ctx);

    const record = {
      seq: this.#commands.size + 1,
      commandId: envelope.commandId,
      action: command.action,
      issuedAt: toIso(envelope.issuedAtMs),
      actor: command.actor ?? null,
      events,
      response,
    };
    await this.#persist(record);
    for (const event of events) this.#applyEvent(event, ctx);
    this.#commands.set(envelope.commandId, response);
    return response;
  }

  #validateEnvelope(command) {
    if (typeof command !== "object" || command === null) {
      throw new DomainError(400, "invalid_request", "命令必须是对象");
    }
    const commandId = requireString(command.commandId, "commandId");
    const issuedAtMs = parseInstant(command.issuedAt, "issuedAt");
    const expiresAtMs =
      command.expiresAt === undefined || command.expiresAt === null
        ? null
        : parseInstant(command.expiresAt, "expiresAt");
    return { commandId, issuedAtMs, expiresAtMs };
  }

  // ---------------------------------------------------------------- 命令处理

  #handlers = {
    /** 受理事件（异物/道面损伤/例行检查），生成带影响范围与有效时间的封闭措施。 */
    report_incident(cmd, ctx) {
      if (!INCIDENT_TYPES.includes(cmd.type)) {
        throw new DomainError(400, "invalid_request", `未知事件类型: ${String(cmd.type)}`, {
          allowed: INCIDENT_TYPES,
        });
      }
      if (!Array.isArray(cmd.segmentIds) || cmd.segmentIds.length === 0) {
        throw new DomainError(400, "invalid_request", "segmentIds 必须是非空数组");
      }
      const segmentIds = [...new Set(cmd.segmentIds)];
      for (const id of segmentIds) {
        if (!this.#segments.has(id)) {
          throw new DomainError(400, "invalid_request", `未知区段: ${String(id)}`);
        }
      }
      const closure = cmd.closure ?? {};
      const fromMs = parseInstant(closure.from, "closure.from");
      const toMs = closure.to === null || closure.to === undefined ? null : parseInstant(closure.to, "closure.to");
      if (toMs !== null && toMs <= fromMs) {
        throw new DomainError(400, "invalid_request", "封闭结束时间必须晚于开始时间");
      }
      const reportedAtMs = cmd.reportedAt ? parseInstant(cmd.reportedAt, "reportedAt") : ctx.issuedAtMs;

      const incidentId = `INC-${String(this.#incidents.size + 1).padStart(4, "0")}`;
      const restrictionId = `RST-${String(this.#restrictions.size + 1).padStart(4, "0")}`;
      const event = {
        kind: "incident_reported",
        incidentId,
        restrictionId,
        type: cmd.type,
        segmentIds,
        reportedAt: toIso(reportedAtMs),
        closure: { from: toIso(fromMs), to: toMs === null ? null : toIso(toMs) },
      };
      return {
        events: [event],
        response: {
          incidentId,
          restrictionId,
          type: cmd.type,
          status: "REPORTED",
          segmentIds,
          closure: event.closure,
        },
      };
    },

    /** 派工。 */
    dispatch_crew(cmd, ctx) {
      const incident = this.#requireIncident(cmd.incidentId);
      this.#assertFresh(incident, ctx.issuedAtMs);
      this.#assertStatus(incident, ["REPORTED"], "dispatch_crew");
      const crewId = requireString(cmd.crewId, "crewId");
      const vehiclesInvolved = Boolean(cmd.vehiclesInvolved);
      return {
        events: [{ kind: "crew_dispatched", incidentId: incident.incidentId, crewId, vehiclesInvolved }],
        response: { incidentId: incident.incidentId, status: "DISPATCHED", crewId, vehiclesInvolved },
      };
    },

    /** 到场。 */
    record_arrival(cmd, ctx) {
      const incident = this.#requireIncident(cmd.incidentId);
      this.#assertFresh(incident, ctx.issuedAtMs);
      this.#assertStatus(incident, ["DISPATCHED"], "record_arrival");
      return {
        events: [{ kind: "crew_arrived", incidentId: incident.incidentId }],
        response: { incidentId: incident.incidentId, status: "ON_SITE" },
      };
    },

    /** 现场人员提交检查证据（发现），可登记未结缺陷。 */
    submit_finding(cmd, ctx) {
      const incident = this.#requireIncident(cmd.incidentId);
      this.#assertFresh(incident, ctx.issuedAtMs);
      this.#assertStatus(incident, ["ON_SITE"], "submit_finding");
      if (cmd.evidence === undefined || cmd.evidence === null || cmd.evidence === "") {
        throw new DomainError(400, "invalid_request", "evidence 检查证据不能为空");
      }
      const defectInputs = cmd.defects === undefined ? [] : cmd.defects;
      if (!Array.isArray(defectInputs)) {
        throw new DomainError(400, "invalid_request", "defects 必须是数组");
      }
      const defects = defectInputs.map((input, index) => ({
        defectId: `${incident.incidentId}-D${incident.defects.size + index + 1}`,
        summary: requireString(input?.summary, `defects[${index}].summary`),
      }));
      return {
        events: [{ kind: "finding_submitted", incidentId: incident.incidentId, evidence: cmd.evidence, defects }],
        response: {
          incidentId: incident.incidentId,
          status: "ASSESSED",
          defects: defects.map((d) => ({ ...d, status: "OPEN" })),
        },
      };
    },

    /** 清除：可多次记录（复核后仍可补充），用于结清缺陷、确认车辆撤离。 */
    record_clearance(cmd, ctx) {
      const incident = this.#requireIncident(cmd.incidentId);
      this.#assertFresh(incident, ctx.issuedAtMs);
      this.#assertStatus(incident, ["ASSESSED", "CLEARED", "REVIEWED"], "record_clearance");
      let resolvedDefectIds;
      if (cmd.resolvedDefects === "ALL") {
        resolvedDefectIds = [...incident.defects.values()].filter((d) => d.status === "OPEN").map((d) => d.defectId);
      } else if (cmd.resolvedDefects === undefined) {
        resolvedDefectIds = [];
      } else if (Array.isArray(cmd.resolvedDefects)) {
        resolvedDefectIds = cmd.resolvedDefects.map((id) => requireString(id, "resolvedDefects[]"));
      } else {
        throw new DomainError(400, "invalid_request", "resolvedDefects 必须是数组或 \"ALL\"");
      }
      for (const id of resolvedDefectIds) {
        if (!incident.defects.has(id)) {
          throw new DomainError(400, "invalid_request", `未知缺陷: ${id}`);
        }
      }
      const vehiclesCleared = Boolean(cmd.vehiclesCleared);
      return {
        events: [{ kind: "clearance_recorded", incidentId: incident.incidentId, resolvedDefectIds, vehiclesCleared }],
        response: {
          incidentId: incident.incidentId,
          status: incident.status === "ASSESSED" ? "CLEARED" : incident.status,
          resolvedDefectIds,
          vehiclesCleared,
        },
      };
    },

    /** 授权经理复核。 */
    review_incident(cmd, ctx) {
      const incident = this.#requireIncident(cmd.incidentId);
      this.#assertFresh(incident, ctx.issuedAtMs);
      this.#assertStatus(incident, ["CLEARED"], "review_incident");
      if (cmd.verdict !== "PASS") {
        throw new DomainError(400, "invalid_request", "verdict 必须为 PASS");
      }
      return {
        events: [{ kind: "review_recorded", incidentId: incident.incidentId, verdict: "PASS" }],
        response: { incidentId: incident.incidentId, status: "REVIEWED" },
      };
    },

    /** 开放：涉及车辆未撤离或存在未结缺陷时禁止。 */
    reopen_incident(cmd, ctx) {
      const incident = this.#requireIncident(cmd.incidentId);
      this.#assertFresh(incident, ctx.issuedAtMs);
      this.#assertStatus(incident, ["REVIEWED"], "reopen_incident");
      const restriction = this.#requireRestriction(incident.restrictionId);
      this.#assertFresh(restriction, ctx.issuedAtMs);
      const openDefects = [...incident.defects.values()].filter((d) => d.status === "OPEN");
      if (openDefects.length > 0) {
        throw new DomainError(409, "open_defects", "存在未结缺陷，禁止开放", {
          defectIds: openDefects.map((d) => d.defectId),
        });
      }
      if (incident.vehiclesInvolved && !incident.vehiclesCleared) {
        throw new DomainError(409, "vehicles_present", "区段仍有车辆作业，禁止开放");
      }
      return {
        events: [
          { kind: "restriction_lifted", restrictionId: restriction.restrictionId, incidentId: incident.incidentId },
          { kind: "incident_reopened", incidentId: incident.incidentId, restrictionId: restriction.restrictionId },
        ],
        response: { incidentId: incident.incidentId, status: "REOPENED", restrictionId: restriction.restrictionId },
      };
    },

    /** 紧急延长：沿用原事件与限制关联，形成新版本。 */
    extend_restriction(cmd, ctx) {
      const restriction = this.#requireRestriction(cmd.restrictionId);
      this.#assertFresh(restriction, ctx.issuedAtMs);
      if (restriction.liftedAtMs !== null) {
        throw new DomainError(409, "invalid_state", "封闭已解除，无法延长");
      }
      const newToMs = parseInstant(cmd.newTo, "newTo");
      const current = restriction.versions[restriction.versions.length - 1];
      if (current.toMs !== null && newToMs <= current.toMs) {
        throw new DomainError(400, "invalid_request", "新的结束时间必须晚于当前结束时间", {
          currentTo: toIso(current.toMs),
        });
      }
      if (newToMs <= current.fromMs) {
        throw new DomainError(400, "invalid_request", "新的结束时间必须晚于封闭开始时间");
      }
      const version = current.version + 1;
      const reason = cmd.reason === undefined ? null : requireString(cmd.reason, "reason");
      return {
        events: [
          {
            kind: "restriction_extended",
            restrictionId: restriction.restrictionId,
            incidentId: restriction.incidentId,
            version,
            to: toIso(newToMs),
            reason,
          },
        ],
        response: {
          restrictionId: restriction.restrictionId,
          incidentId: restriction.incidentId,
          version,
          from: toIso(current.fromMs),
          to: toIso(newToMs),
        },
      };
    },
  };

  // ---------------------------------------------------------------- 事件应用（回放共用）

  #applyEvent(event, ctx) {
    switch (event.kind) {
      case "incident_reported": {
        const incident = {
          incidentId: event.incidentId,
          type: event.type,
          status: "REPORTED",
          segmentIds: [...event.segmentIds],
          restrictionId: event.restrictionId,
          reportedAt: event.reportedAt,
          crewId: null,
          vehiclesInvolved: false,
          vehiclesCleared: false,
          defects: new Map(),
          findings: [],
          reviewedBy: null,
          reopenedAt: null,
          lastDecisionAtMs: ctx.issuedAtMs,
          timeline: [],
        };
        this.#incidents.set(incident.incidentId, incident);
        this.#restrictions.set(event.restrictionId, {
          restrictionId: event.restrictionId,
          incidentId: event.incidentId,
          segments: [...event.segmentIds],
          reason: event.type,
          versions: [
            {
              version: 1,
              fromMs: parseInstant(event.closure.from, "closure.from"),
              toMs: event.closure.to === null ? null : parseInstant(event.closure.to, "closure.to"),
              reason: "INITIAL",
              createdAtMs: ctx.issuedAtMs,
            },
          ],
          liftedAtMs: null,
          lastDecisionAtMs: ctx.issuedAtMs,
        });
        this.#pushTimeline(incident, ctx, "report", {
          type: event.type,
          segmentIds: [...event.segmentIds],
          restrictionId: event.restrictionId,
          closure: event.closure,
          reportedAt: event.reportedAt,
        });
        break;
      }
      case "crew_dispatched": {
        const incident = this.#incidents.get(event.incidentId);
        incident.status = "DISPATCHED";
        incident.crewId = event.crewId;
        incident.vehiclesInvolved = event.vehiclesInvolved;
        incident.lastDecisionAtMs = ctx.issuedAtMs;
        this.#pushTimeline(incident, ctx, "dispatch", {
          crewId: event.crewId,
          vehiclesInvolved: event.vehiclesInvolved,
        });
        break;
      }
      case "crew_arrived": {
        const incident = this.#incidents.get(event.incidentId);
        incident.status = "ON_SITE";
        incident.lastDecisionAtMs = ctx.issuedAtMs;
        this.#pushTimeline(incident, ctx, "arrival", {});
        break;
      }
      case "finding_submitted": {
        const incident = this.#incidents.get(event.incidentId);
        incident.status = "ASSESSED";
        incident.findings.push({ evidence: event.evidence, defects: event.defects.map((d) => d.defectId), at: toIso(ctx.issuedAtMs) });
        for (const defect of event.defects) {
          incident.defects.set(defect.defectId, {
            defectId: defect.defectId,
            summary: defect.summary,
            status: "OPEN",
            resolvedAt: null,
          });
        }
        incident.lastDecisionAtMs = ctx.issuedAtMs;
        this.#pushTimeline(incident, ctx, "finding", {
          evidence: event.evidence,
          defects: event.defects.map((d) => ({ ...d })),
        });
        break;
      }
      case "clearance_recorded": {
        const incident = this.#incidents.get(event.incidentId);
        if (incident.status === "ASSESSED") incident.status = "CLEARED";
        for (const id of event.resolvedDefectIds) {
          const defect = incident.defects.get(id);
          if (defect && defect.status === "OPEN") {
            defect.status = "RESOLVED";
            defect.resolvedAt = toIso(ctx.issuedAtMs);
          }
        }
        if (event.vehiclesCleared) incident.vehiclesCleared = true;
        incident.lastDecisionAtMs = ctx.issuedAtMs;
        this.#pushTimeline(incident, ctx, "clearance", {
          resolvedDefectIds: [...event.resolvedDefectIds],
          vehiclesCleared: event.vehiclesCleared,
        });
        break;
      }
      case "review_recorded": {
        const incident = this.#incidents.get(event.incidentId);
        incident.status = "REVIEWED";
        incident.reviewedBy = ctx.actor?.id ?? null;
        incident.lastDecisionAtMs = ctx.issuedAtMs;
        this.#pushTimeline(incident, ctx, "review", { verdict: event.verdict });
        break;
      }
      case "restriction_extended": {
        const restriction = this.#restrictions.get(event.restrictionId);
        const current = restriction.versions[restriction.versions.length - 1];
        restriction.versions.push({
          version: event.version,
          fromMs: current.fromMs,
          toMs: parseInstant(event.to, "to"),
          reason: event.reason,
          createdAtMs: ctx.issuedAtMs,
        });
        restriction.lastDecisionAtMs = ctx.issuedAtMs;
        const incident = this.#incidents.get(event.incidentId);
        if (incident) {
          this.#pushTimeline(incident, ctx, "extension", {
            restrictionId: event.restrictionId,
            version: event.version,
            to: event.to,
            reason: event.reason,
          });
        }
        break;
      }
      case "restriction_lifted": {
        const restriction = this.#restrictions.get(event.restrictionId);
        restriction.liftedAtMs = ctx.issuedAtMs;
        restriction.lastDecisionAtMs = ctx.issuedAtMs;
        break;
      }
      case "incident_reopened": {
        const incident = this.#incidents.get(event.incidentId);
        incident.status = "REOPENED";
        incident.reopenedAt = toIso(ctx.issuedAtMs);
        incident.lastDecisionAtMs = ctx.issuedAtMs;
        this.#pushTimeline(incident, ctx, "reopen", { restrictionId: event.restrictionId });
        break;
      }
      default:
        throw new Error(`未知事件类型: ${event.kind}`);
    }
  }

  #pushTimeline(incident, ctx, stage, details) {
    incident.timeline.push({
      stage,
      at: toIso(ctx.issuedAtMs),
      actor: ctx.actor?.id ?? null,
      details,
    });
  }

  // ---------------------------------------------------------------- 校验辅助

  #requireIncident(incidentId) {
    const incident = this.#incidents.get(requireString(incidentId, "incidentId"));
    if (!incident) throw new DomainError(404, "incident_not_found", `事件不存在: ${incidentId}`);
    return incident;
  }

  #requireRestriction(restrictionId) {
    const restriction = this.#restrictions.get(requireString(restrictionId, "restrictionId"));
    if (!restriction) throw new DomainError(404, "restriction_not_found", `封闭措施不存在: ${restrictionId}`);
    return restriction;
  }

  #assertStatus(incident, allowed, action) {
    if (!allowed.includes(incident.status)) {
      throw new DomainError(409, "invalid_state", `当前状态 ${incident.status} 不允许执行 ${action}`, {
        currentStatus: incident.status,
        allowed,
      });
    }
  }

  /** 过期命令防护：issuedAt 早于该聚合最近一次决定的命令不得穿透。 */
  #assertFresh(aggregate, issuedAtMs) {
    if (aggregate.lastDecisionAtMs != null && issuedAtMs < aggregate.lastDecisionAtMs) {
      throw new DomainError(409, "stale_command", "命令签发时间早于较新的决定，已拒绝", {
        lastDecisionAt: toIso(aggregate.lastDecisionAtMs),
      });
    }
  }

  // ---------------------------------------------------------------- 持久化

  async #load() {
    if (!this.#dataFile) return;
    await mkdir(path.dirname(this.#dataFile), { recursive: true });
    let content;
    try {
      content = await readFile(this.#dataFile, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    const lines = content.split("\n").filter((line) => line.trim() !== "");
    for (let i = 0; i < lines.length; i += 1) {
      let record;
      try {
        record = JSON.parse(lines[i]);
      } catch (error) {
        if (i === lines.length - 1) break; // 末行可能是崩溃时的半截写入，忽略
        throw error;
      }
      if (this.#commands.has(record.commandId)) continue;
      const ctx = {
        issuedAtMs: parseInstant(record.issuedAt, "issuedAt"),
        actor: record.actor ?? null,
      };
      for (const event of record.events) this.#applyEvent(event, ctx);
      this.#commands.set(record.commandId, record.response);
    }
  }

  async #persist(record) {
    if (!this.#dataFile) return;
    await appendFile(this.#dataFile, `${JSON.stringify(record)}\n`, "utf8");
  }

  // ---------------------------------------------------------------- 查询

  listSegments() {
    return [...this.#segments.values()].map((s) => ({ ...s, adjacent: [...s.adjacent] }));
  }

  /** 当前各限制（最新版本）的推导视图。 */
  #currentRestrictions() {
    return [...this.#restrictions.values()].map((r) => {
      const v = r.versions[r.versions.length - 1];
      return {
        restrictionId: r.restrictionId,
        segments: [...r.segments],
        from: v.fromMs,
        to: v.toMs,
        liftedAtMs: r.liftedAtMs,
      };
    });
  }

  /** 由全部有效限制共同推导 atMs 时刻的可用性（含内部用的 blockingRestrictionIds）。 */
  availabilityAt(atMs) {
    return deriveAvailability([...this.#segments.values()], this.#currentRestrictions(), atMs);
  }

  getIncident(incidentId) {
    const incident = this.#incidents.get(incidentId);
    return incident ? this.#incidentDto(incident) : null;
  }

  listIncidents() {
    return [...this.#incidents.values()].map((i) => this.#incidentDto(i));
  }

  getTimeline(incidentId) {
    const incident = this.#incidents.get(incidentId);
    if (!incident) return null;
    return incident.timeline.map((entry) => ({
      stage: entry.stage,
      at: entry.at,
      actor: entry.actor,
      details: structuredClone(entry.details),
    }));
  }

  getRestriction(restrictionId) {
    const restriction = this.#restrictions.get(restrictionId);
    return restriction ? this.#restrictionDto(restriction) : null;
  }

  listRestrictions({ segmentId = null, activeAtMs = null } = {}) {
    let list = [...this.#restrictions.values()];
    if (segmentId !== null) list = list.filter((r) => r.segments.includes(segmentId));
    if (activeAtMs !== null) {
      list = list.filter((r) => {
        const v = r.versions[r.versions.length - 1];
        return (
          r.liftedAtMs === null &&
          v.fromMs <= activeAtMs &&
          (v.toMs === null || activeAtMs < v.toMs)
        );
      });
    }
    return list.map((r) => this.#restrictionDto(r));
  }

  #incidentDto(incident) {
    const restriction = this.#restrictions.get(incident.restrictionId);
    const v = restriction.versions[restriction.versions.length - 1];
    return {
      incidentId: incident.incidentId,
      type: incident.type,
      status: incident.status,
      segmentIds: [...incident.segmentIds],
      restrictionId: incident.restrictionId,
      reportedAt: incident.reportedAt,
      closure: { from: toIso(v.fromMs), to: v.toMs === null ? null : toIso(v.toMs) },
      restrictionLifted: restriction.liftedAtMs !== null,
      crew: {
        crewId: incident.crewId,
        vehiclesInvolved: incident.vehiclesInvolved,
        vehiclesCleared: incident.vehiclesCleared,
      },
      defects: [...incident.defects.values()].map((d) => ({ ...d })),
      findings: incident.findings.map((f) => structuredClone(f)),
      reviewedBy: incident.reviewedBy,
      reopenedAt: incident.reopenedAt,
    };
  }

  #restrictionDto(restriction) {
    return {
      restrictionId: restriction.restrictionId,
      incidentId: restriction.incidentId,
      segments: [...restriction.segments],
      reason: restriction.reason,
      currentVersion: restriction.versions[restriction.versions.length - 1].version,
      liftedAt: restriction.liftedAtMs === null ? null : toIso(restriction.liftedAtMs),
      versions: restriction.versions.map((v) => ({
        version: v.version,
        from: toIso(v.fromMs),
        to: v.toMs === null ? null : toIso(v.toMs),
        reason: v.reason,
        createdAt: toIso(v.createdAtMs),
      })),
    };
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(400, "invalid_request", `${field} 不能为空`);
  }
  return value;
}
