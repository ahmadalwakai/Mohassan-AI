interface WaitingCall {
  cpu: number;
  heavy: boolean;
  serialId: string | undefined;
  reserve(): void;
}

/** Shares CPU slots and admits at most one heavy call at a time. */
export class ModelCallSlots {
  private readonly waiting = new Set<WaitingCall>();
  private readonly serialCalls = new Set<string>();
  private cpuUsed = 0;
  private heavyBusy = false;

  constructor(private readonly cpuConcurrency: number) {}

  acquire(cpu: number, heavy: boolean, serialId: string | undefined, signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => {
        this.waiting.delete(call);
        reject(signal.reason);
        this.drain();
      };
      const call: WaitingCall = {
        cpu, heavy, serialId,
        reserve: () => {
          this.waiting.delete(call);
          signal.removeEventListener('abort', abort);
          this.cpuUsed += cpu;
          if (heavy) this.heavyBusy = true;
          if (serialId !== undefined) this.serialCalls.add(serialId);
          resolve(() => {
            this.cpuUsed -= cpu;
            if (heavy) this.heavyBusy = false;
            if (serialId !== undefined) this.serialCalls.delete(serialId);
            this.drain();
          });
        },
      };
      signal.addEventListener('abort', abort, { once: true });
      this.waiting.add(call);
      this.drain();
    });
  }

  private drain(): void {
    for (const call of this.waiting) {
      // Calls with another reservation outstanding leave capacity for other models.
      if (call.heavy && this.heavyBusy) continue;
      if (call.serialId !== undefined && this.serialCalls.has(call.serialId)) continue;
      if (this.cpuUsed + call.cpu > this.cpuConcurrency) break;
      call.reserve();
    }
  }
}
