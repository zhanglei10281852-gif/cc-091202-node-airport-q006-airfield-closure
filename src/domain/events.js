// 领域事件定义。所有事实只追加、不修改；状态由 fold 从事件日志归约得到。

export const EventType = Object.freeze({
  SEGMENT_DEFINED: "segmentDefined",
  INCIDENT_REPORTED: "incidentReported",
  RESTRICTION_CREATED: "restrictionCreated",
  RESTRICTION_EXTENDED: "restrictionExtended",
  INSPECTION_DISPATCHED: "inspectionDispatched",
  TEAM_ARRIVED: "teamArrived",
  FINDING_RECORDED: "findingRecorded",
  FINDING_RESOLVED: "findingResolved",
  CLEARANCE_SUBMITTED: "clearanceSubmitted",
  REOPEN_REVIEWED: "reopenReviewed",
  RESTRICTION_OPENED: "restrictionOpened",
});

// 内部时间轴阶段（报告、派工、到场、发现、清除、复核、开放），键与 EventType 的值对应
export const Phase = Object.freeze({
  segmentDefined: "TOPOLOGY",
  incidentReported: "REPORT",
  restrictionCreated: "CLOSURE",
  restrictionExtended: "EXTEND",
  inspectionDispatched: "DISPATCH",
  teamArrived: "ARRIVE",
  findingRecorded: "FIND",
  findingResolved: "DEFECT_RESOLVED",
  clearanceSubmitted: "CLEAR",
  reopenReviewed: "REVIEW",
  restrictionOpened: "OPEN",
});

export const IncidentType = Object.freeze({
  FOD: "FOD", // 跑道异物
  DAMAGE: "DAMAGE", // 道面损伤
  ROUTINE: "ROUTINE", // 例行检查
});

export const RestrictionReason = Object.freeze({
  FOD: "FOD",
  DAMAGE: "DAMAGE",
  VEHICLE_WORK: "VEHICLE_WORK",
  INSPECTION: "INSPECTION",
  OTHER: "OTHER",
});

export const Role = Object.freeze({
  FIELD: "FIELD", // 现场人员
  MANAGER: "MANAGER", // 授权值班经理
  OBSERVER: "OBSERVER",
});

export const ReviewDecision = Object.freeze({
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
});

// 所有时间一律解析为 epoch 毫秒（绝对时刻）。跨午夜的 “23:50/00:30” 绝不按字符串或本地日历比较。
export function parseInstant(value, field = "time") {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    const err = new Error(`时间字段 ${field} 无法解析: ${value}`);
    err.code = "invalid_time";
    throw err;
  }
  return ms;
}

export function iso(ms) {
  return new Date(ms).toISOString();
}
