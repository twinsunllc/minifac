import type { NodeExecutor } from "./types.js";

export class ExecutorRegistry {
  private readonly map = new Map<string, NodeExecutor>();

  register(executor: NodeExecutor): void {
    if (this.map.has(executor.type)) {
      throw new Error(`Executor "${executor.type}" is already registered`);
    }
    this.map.set(executor.type, executor);
  }

  get(type: string): NodeExecutor | undefined {
    return this.map.get(type);
  }

  has(type: string): boolean {
    return this.map.has(type);
  }
}
