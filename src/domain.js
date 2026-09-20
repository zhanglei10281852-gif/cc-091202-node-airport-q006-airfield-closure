/**
 * 领域纯函数：区段拓扑、封闭窗口与可用性推导。
 *
 * 关键语义：
 * - 所有时刻一律按绝对瞬间（epoch 毫秒）比较，跨午夜封闭不存在"日期翻转"特例；
 * - 区段相邻（共用端点）不等于限制重叠：重叠 = 区段集合相交 且 有效时间相交；
 * - 区段可用性永远由"当前全部有效限制"共同推导，而不是由解除动作逐项改标志。
 */

export const INCIDENT_TYPES = Object.freeze(["FOD", "PAVEMENT_DAMAGE", "ROUTINE_INSPECTION"]);

export class DomainError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "DomainError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** 解析 ISO-8601 时间字符串为 epoch 毫秒；非法输入抛 400。 */
export function parseInstant(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(400, "invalid_request", `${field} 必须是 ISO-8601 时间字符串`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new DomainError(400, "invalid_request", `${field} 不是有效的时间戳: ${value}`);
  }
  return ms;
}

/** epoch 毫秒 -> 规范 UTC ISO 字符串（输出统一带 Z，避免时区歧义）。 */
export function toIso(ms) {
  return new Date(ms).toISOString();
}

/** 半开区间 [from, to) 相交判定；to 为 null 表示无限期。 */
export function intervalsOverlap(aFrom, aTo, bFrom, bTo) {
  const aEnd = aTo ?? Number.POSITIVE_INFINITY;
  const bEnd = bTo ?? Number.POSITIVE_INFINITY;
  return aFrom < bEnd && bFrom < aEnd;
}

export function sharesSegment(segmentsA, segmentsB) {
  const mine = new Set(segmentsA);
  return segmentsB.some((id) => mine.has(id));
}

/**
 * 两条限制是否重叠：仅当区段集合相交且有效时间（绝对时刻）相交。
 * 相邻区段上时间完全重合的两条限制不算重叠。
 */
export function restrictionsOverlap(first, second) {
  return (
    sharesSegment(first.segments, second.segments) &&
    intervalsOverlap(first.from, first.to, second.from, second.to)
  );
}

/** 限制在 atMs 时刻是否有效：未解除，且 atMs 落在 [from, to) 内。 */
export function isEffectiveAt(restriction, atMs) {
  if (restriction.liftedAtMs != null && restriction.liftedAtMs <= atMs) return false;
  if (restriction.from > atMs) return false;
  if (restriction.to != null && atMs >= restriction.to) return false;
  return true;
}

/**
 * 由全部限制共同推导各区段在 atMs 的可用性。
 * restrictions 元素形状：{ restrictionId, segments, from, to, liftedAtMs }（毫秒，to 可为 null）。
 * 预计恢复时间 = 覆盖该区段的全部有效限制中最晚的结束时刻；存在无限期限制时为 null。
 */
export function deriveAvailability(segments, restrictions, atMs) {
  return segments.map((segment) => {
    const blocking = restrictions.filter(
      (r) => r.segments.includes(segment.segmentId) && isEffectiveAt(r, atMs),
    );
    const available = blocking.length === 0;
    let estimatedRecoveryAt = null;
    if (!available && blocking.every((r) => r.to != null)) {
      estimatedRecoveryAt = toIso(Math.max(...blocking.map((r) => r.to)));
    }
    return {
      segmentId: segment.segmentId,
      available,
      estimatedRecoveryAt,
      blockingRestrictionIds: blocking.map((r) => r.restrictionId),
    };
  });
}
