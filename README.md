# 飞行区检查封闭协同服务

跑道、滑行道按**区段**建模的 Node.js 协同服务：受理异物（FOD）、道面损伤（DAMAGE）和例行检查（ROUTINE）事件，
生成带**影响范围（区段集合）与有效时间（半开区间）**的封闭措施，支撑值班经理完成
报告 → 派工 → 到场 → 发现 → 清除 → 复核 → 开放的完整协同流程。

无外部依赖，仅使用 Node.js 20+ 标准库。

## 运行

```bash
npm test        # 运行测试（node --test）
npm start       # 启动 HTTP 服务，默认 :3000
docker compose up --build
```

环境变量：`PORT`（默认 3000）、`EVENT_LOG`（事件日志路径，默认 `data/events.jsonl`；置空则纯内存）。
首次启动若日志为空，会从 `fixtures/context.json` 播种区段拓扑与跨午夜叠加封闭样例。

## 核心规则

- **相邻 ≠ 重叠**：区段端点相同（如 L3）只构成相邻关系；限制是否共同作用，必须同时比较**区段集合**与**有效时间窗**。
- **跨午夜按绝对时刻**：所有时间解析为 epoch 毫秒，`23:50→次日00:30` 的封闭绝不按字符串或本地日历比较。
- **叠加不抵消**：不同原因的封闭可以重叠；解除/过期其中一项不影响其他仍有效限制。
  区段可用性由**该时刻全部有效限制共同推导**（纯函数投影），因此与并发解除的先后顺序无关，服务重启重放后结论相同。
- **开放一票否决**：涉及未结阻断缺陷或仍有车辆在场时禁止开放；此外必须有现场检查证据 + 授权经理复核通过。
- **紧急延长**：沿用原 `restrictionId`（区段、原因、关联事件不变），形成新版本；针对旧版本的开放命令以 `stale_version` 拒绝。
- **过期/重复消息不穿透**：`Idempotency-Key`（或 body.commandId）在业务校验之前短路；命令永远针对“当前版本 + 当前投影”。

## 数据模型

事件溯源（event sourcing）：只追加的 JSONL 日志，当前状态由日志归约（fold）得到。

事件类型覆盖：`segmentDefined`、`incidentReported`、`restrictionCreated`、`restrictionExtended`、
`inspectionDispatched`、`teamArrived`、`findingRecorded`、`findingResolved`、
`clearanceSubmitted`、`reopenReviewed`、`restrictionOpened`。

限制在某时刻的效力：`CLOSED`（时间窗内）/ `HOLD`（窗外但车辆或缺陷未清，不得判可用）/ `LAPSED`（自然失效）/ `OPENED`（正式解除）。

## HTTP 接口

请求头：`x-user-id`（脱敏人员编号）、`x-user-role`（`MANAGER` | `FIELD` | `OBSERVER`）；写操作可带 `Idempotency-Key`。
所有时间字段接受 ISO 8601（建议带偏移量），响应统一返回 UTC ISO 字符串。

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | 任意 | 健康检查 |
| GET/POST | `/segments` | 报告需身份 | 区段拓扑；端点相连自动建立相邻 |
| POST | `/incidents` | 任意身份 | 受理 FOD/DAMAGE/ROUTINE 报告 |
| POST | `/restrictions` | MANAGER | 生成封闭：`reason`、`segments`、`from`、`to`、可选 `incidentId` |
| POST | `/restrictions/extend` | MANAGER | 紧急延长，产生新版本 |
| POST | `/inspections/dispatch` | MANAGER | 派工（teamId） |
| POST | `/inspections/arrive` | FIELD | 班组到场 |
| POST | `/findings` | FIELD | 记录发现（`blocking` 默认 true） |
| POST | `/findings/resolve` | FIELD | 结项 |
| POST | `/clearances` | FIELD | 提交检查证据，可带 `teamsCleared` 声明撤离班组 |
| POST | `/reviews/reopen` | MANAGER | 复核（APPROVED/REJECTED） |
| POST | `/reopen` | MANAGER | 开放；被阻断时 409 返回阻塞项 |
| GET | `/availability` | 公开 | **仅** `available` + `eta`（预计恢复时刻），可带 `?at=` |
| GET | `/internal/availability` | FIELD/MANAGER | 含原因、版本、效力、阻塞状态 |
| GET | `/internal/restrictions` | FIELD/MANAGER | 各措施版本、证据/复核状态、未结缺陷、车辆在场与开放阻塞项 |
| GET | `/timeline` | FIELD/MANAGER | 按绝对时刻排列的完整协同时间轴 |

开放被阻断示例：

```json
{
  "error": "reopen_blocked",
  "details": [
    { "code": "vehicles_present", "message": "仍有车辆在区段内作业" },
    { "code": "open_defect", "findingIds": ["f-1"] }
  ]
}
```

## 说明

机场生产地图、真实人员身份与访问凭据不得进入版本库；`x-user-*` 头仅为演示占位，生产部署须替换为真实认证与授权。
