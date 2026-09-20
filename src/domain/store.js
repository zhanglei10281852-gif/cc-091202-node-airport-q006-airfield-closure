// 只追加事件存储：内存状态 + JSONL 持久化。启动时重放日志得到相同状态。
// 所有 commit 在单条串行队列中执行，使“读取当前投影 → 校验 → 追加事件”原子线性化，
// 并发命令因此被完全排序，过期命令无法落在更新决定之后。

import { appendFile, readFile } from "node:fs/promises";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { applyEvent, createState } from "./projection.js";

export class EventStore {
  #chain;

  constructor(logPath, { clock = () => Date.now() } = {}) {
    this.logPath = logPath;
    this.clock = clock;
    this.state = createState();
    this.sequence = 0;
    this.#chain = Promise.resolve();
  }

  async load() {
    if (!this.logPath) return;
    let text;
    try {
      text = await readFile(this.logPath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    this.#hydrate(text);
  }

  loadSync() {
    if (!this.logPath) return;
    let text;
    try {
      text = readFileSync(this.logPath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    this.#hydrate(text);
  }

  #hydrate(text) {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const evt = JSON.parse(trimmed);
      applyEvent(this.state, evt);
      this.sequence = Math.max(this.sequence, evt.seq);
    }
  }

  getCommand(commandId) {
    return commandId ? this.state.commands.get(commandId) : undefined;
  }

  /**
   * 原子提交。produce(state) 在锁内基于最新投影决定事件内容或抛 DomainError；
   * 同一 commandId 的重复提交直接返回首次事件，不再次执行 produce。
   */
  commit(commandId, produce) {
    const run = async () => {
      if (commandId) {
        const cached = this.state.commands.get(commandId);
        if (cached) return cached;
      }
      const { type, data } = produce(this.state);
      const evt = await this.#writeAndApply(type, data);
      if (commandId) this.state.commands.set(commandId, evt);
      return evt;
    };
    // 无论前一任务成败都继续执行；链本身吞掉拒绝，错误只传给当前调用方
    const result = this.#chain.then(run, run);
    this.#chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #writeAndApply(type, data) {
    const evt = { seq: ++this.sequence, type, at: this.clock(), data };
    if (this.logPath) {
      await appendFile(this.logPath, `${JSON.stringify(evt)}\n`, "utf8");
    }
    applyEvent(this.state, evt);
    return evt;
  }

  // 同步追加，仅供启动播种（尚无并发请求时）使用
  appendSync(type, data, commandId) {
    if (commandId && this.state.commands.has(commandId)) {
      return this.state.commands.get(commandId);
    }
    const evt = { seq: ++this.sequence, type, at: this.clock(), data };
    if (this.logPath) {
      mkdirSync(dirname(this.logPath), { recursive: true });
      appendFileSync(this.logPath, `${JSON.stringify(evt)}\n`, "utf8");
    }
    applyEvent(this.state, evt);
    if (commandId) this.state.commands.set(commandId, evt);
    return evt;
  }
}

// 供测试使用：纯内存、从事件数组重放
export function replay(events) {
  const state = createState();
  for (const evt of events) applyEvent(state, evt);
  return state;
}
