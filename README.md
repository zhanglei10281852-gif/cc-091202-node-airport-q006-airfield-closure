# 飞行区检查封闭协同服务

仓库提供跑道与滑行道区段拓扑、异物报告和叠加封闭措施样例，以及在此基础上实现的协同封闭管理服务。区段端点相同只表示相邻，限制是否重叠需要同时考虑区段集合与有效时间；现场记录均使用脱敏编号。

## 运行

Node.js 20 以上版本执行 `npm test`，`npm start` 启动服务，`GET /health` 返回健康状态。`docker compose up --build` 提供等价容器入口（事件日志落在命名卷中，容器重启后状态一致）。机场生产地图、人员身份和访问凭据不能进入版本库。

环境变量：`PORT`（默认 3000）、`DATA_FILE`（事件日志，默认 `data/events.jsonl`）、`TOPOLOGY_FILE`（区段拓扑，默认 `fixtures/context.json`）。

## 领域语义

- 跑道、滑行道按区段建模；相邻（共用端点）不等于重叠，重叠 = 区段集合相交且有效时间相交。
- 一切时刻按绝对瞬间比较（输入可带时区偏移，输出统一 UTC），跨午夜封闭没有特例。
- 受理事件类型：`FOD`（异物）、`PAVEMENT_DAMAGE`（道面损伤）、`ROUTINE_INSPECTION`（例行检查），受理后生成带影响范围与有效时间的封闭措施。
- 不同原因的封闭可以重叠；解除其中一项不抵消其他仍有效限制，区段可用性永远由当前全部有效限制共同推导。
- 工作流：报告 → 派工 → 到场 → 发现（现场人员提交检查证据）→ 清除 → 复核（授权经理）→ 开放。涉及车辆未撤离或存在未结缺陷时禁止开放。
- 紧急延长沿用原事件与封闭关联，只追加新版本，历史版本可审计。
- 命令携带 `commandId` / `issuedAt` / 可选 `expiresAt`：重复消息幂等返回首次结果，过期或早于较新决定的命令不会穿透。
- 命令日志追加写入 `DATA_FILE`，服务恢复后按序回放，派生状态与故障前完全一致。

## 接口

身份通过请求头声明：`x-actor-id`、`x-actor-role`（`staff` 现场人员 / `manager` 授权经理）。

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | 公开 | 健康检查 |
| GET | `/api/public/availability?at=<ISO>` | 公开 | 只返回各区段当前可用性与预计恢复时间 |
| GET | `/api/segments` | 内部 | 区段拓扑与相邻关系 |
| POST | `/api/incidents` | 内部 | 受理事件并生成封闭措施 |
| GET | `/api/incidents` / `/api/incidents/:id` | 内部 | 事件列表 / 详情 |
| GET | `/api/incidents/:id/timeline` | 内部 | 报告、派工、到场、发现、清除、复核、开放（含延长版本）时间轴 |
| POST | `/api/incidents/:id/dispatch` | 经理 | 派工（可标记涉及车辆） |
| POST | `/api/incidents/:id/arrival` | 内部 | 到场 |
| POST | `/api/incidents/:id/findings` | 内部 | 提交检查证据，可登记缺陷 |
| POST | `/api/incidents/:id/clearance` | 内部 | 清除记录：结清缺陷、确认车辆撤离 |
| POST | `/api/incidents/:id/review` | 经理 | 复核 |
| POST | `/api/incidents/:id/reopen` | 经理 | 开放（车辆未撤离 / 有未结缺陷时拒绝） |
| GET | `/api/restrictions` / `/api/restrictions/:id` | 内部 | 封闭措施查询（含版本历史） |
| POST | `/api/restrictions/:id/extend` | 经理 | 紧急延长，形成新版本 |

写操作请求体示例：

```json
{
  "commandId": "cmd-20260912-001",
  "issuedAt": "2026-09-12T23:45:00+08:00",
  "expiresAt": "2026-09-13T00:45:00+08:00",
  "type": "FOD",
  "segmentIds": ["RWY18L-A"],
  "closure": { "from": "2026-09-12T23:50:00+08:00", "to": "2026-09-13T00:30:00+08:00" }
}
```

错误响应统一为 `{ "error": { "code", "message", "details?" } }`，常见 `code`：`invalid_request`、`invalid_state`、`stale_command`、`command_expired`、`open_defects`、`vehicles_present`、`unauthorized`、`forbidden`、`not_found`。
