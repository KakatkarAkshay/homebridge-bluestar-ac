import type { Logger } from "homebridge";

export class SyncScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly log: Logger,
    private readonly intervalMs: number,
    private readonly onTick: (thingId: string) => void,
  ) {}

  syncThingIds(thingIds: string[]): void {
    const nextThingIds = new Set(thingIds);

    for (const [thingId, timer] of this.timers) {
      if (nextThingIds.has(thingId)) {
        continue;
      }

      clearInterval(timer);
      this.timers.delete(thingId);
    }

    for (const thingId of nextThingIds) {
      if (this.timers.has(thingId)) {
        continue;
      }

      const timer = setInterval(() => {
        try {
          this.onTick(thingId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log.warn(`${thingId}: periodic sync failed: ${message}`);
        }
      }, this.intervalMs);
      this.timers.set(thingId, timer);
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }

    this.timers.clear();
  }
}
