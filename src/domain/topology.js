// 跑道、滑行道区段拓扑。
// 区段端点相同只表示“相邻”；限制是否“重叠”必须同时考察区段集合与有效时间（见 availability.js）。

export class Topology {
  constructor() {
    /** @type {Map<string, {segmentId:string, from:string, to:string, adjacent:Set<string>}>} */
    this.segments = new Map();
  }

  define({ segmentId, from, to, adjacent = [] }) {
    if (!segmentId || !from || !to) {
      throw new DomainError("invalid_segment", 400, "区段缺少 segmentId/from/to");
    }
    const existing = this.segments.get(segmentId);
    if (existing) {
      if (existing.from !== from || existing.to !== to) {
        throw new DomainError("segment_redefined", 409, `区段 ${segmentId} 端点定义冲突`);
      }
      for (const id of adjacent) existing.adjacent.add(id);
      this.#linkByEndpoint(existing);
      return existing;
    }
    const segment = { segmentId, from, to, adjacent: new Set(adjacent) };
    this.segments.set(segmentId, segment);
    this.#linkByEndpoint(segment);
    return segment;
  }

  // 共用端点（L1/L3 这类物理节点）的区段互为相邻
  #linkByEndpoint(segment) {
    for (const other of this.segments.values()) {
      if (other.segmentId === segment.segmentId) continue;
      if (other.from === segment.from || other.to === segment.to || other.from === segment.to || other.to === segment.from) {
        other.adjacent.add(segment.segmentId);
        segment.adjacent.add(other.segmentId);
      }
    }
  }

  get(id) {
    const segment = this.segments.get(id);
    if (!segment) throw new DomainError("unknown_segment", 404, `未知区段 ${id}`);
    return segment;
  }

  requireExist(ids) {
    for (const id of ids) this.get(id);
  }

  isAdjacent(a, b) {
    return this.segments.get(a)?.adjacent.has(b) ?? false;
  }

  list() {
    return [...this.segments.values()].map((s) => ({
      segmentId: s.segmentId,
      from: s.from,
      to: s.to,
      adjacent: [...s.adjacent].sort(),
    }));
  }
}

// 两个区段集合是否有共同区段（相邻不算重叠）
export function segmentSetsIntersect(a, b) {
  const setB = new Set(b);
  return a.some((id) => setB.has(id));
}

// 半开时间区间 [from, to) 是否交叠；跨午夜场景一律按绝对时刻（epoch 毫秒）比较
export function intervalsOverlap(fromA, toA, fromB, toB) {
  return fromA < toB && fromB < toA;
}

export class DomainError extends Error {
  constructor(code, statusCode, message, details = undefined) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}
