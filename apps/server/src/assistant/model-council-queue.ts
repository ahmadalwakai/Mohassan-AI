type Release = () => void;
type Skip = 'load' | 'deadline';
type Admission = Release | Skip;
type Waiting = { owner: boolean; finish: (result: Admission) => void };
type Track = <T>(work: () => Promise<T>) => Promise<T>;
type Result<T> = { outcome: T } | { skipped: Skip };

/** One queue for the local runtime. Owner work goes first within the waiting limit. */
export function createModelCouncilQueue(limits: { concurrent: number; queued: number }) {
  let active = 0;
  const waiting: Waiting[] = [];

  function reserve(): Release {
    active++;
    return () => {
      active--;
      const next = waiting[0];
      if (next) next.finish(reserve());
    };
  }

  function admit(owner: boolean, signal: AbortSignal): Promise<Admission> {
    if (signal.aborted) return Promise.resolve('deadline');
    if (active < limits.concurrent) return Promise.resolve(reserve());
    if (waiting.length >= limits.queued) {
      const displaced = owner && waiting.findLast(entry => !entry.owner);
      if (!displaced) return Promise.resolve('load');
      displaced.finish('load');
    }

    return new Promise(resolve => {
      const entry: Waiting = {
        owner,
        finish(result) {
          waiting.splice(waiting.indexOf(entry), 1);
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
      };
      const onAbort = () => entry.finish('deadline');
      const firstMember = owner ? waiting.findIndex(turn => !turn.owner) : -1;
      waiting.splice(firstMember < 0 ? waiting.length : firstMember, 0, entry);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function run<T>(owner: boolean, turnSignal: AbortSignal, budgetMs: number,
    work: (signal: AbortSignal, track: Track) => Promise<T>): Promise<Result<T>> {
    if (turnSignal.aborted || budgetMs <= 0) return { skipped: 'deadline' };
    const deadline = performance.now() + budgetMs;
    const controller = new AbortController();
    const signal = AbortSignal.any([turnSignal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), budgetMs);
    const release = await admit(owner, signal);
    if (typeof release !== 'function' || signal.aborted || performance.now() >= deadline) {
      clearTimeout(timer);
      if (typeof release === 'function') release();
      return { skipped: typeof release === 'function' ? 'deadline' : release };
    }

    const pending = new Set<Promise<unknown>>();
    const track: Track = operation => {
      if (performance.now() >= deadline) controller.abort();
      signal.throwIfAborted();
      const started = operation();
      pending.add(started);
      const remove = () => { pending.delete(started); };
      void started.then(remove, remove);
      return started;
    };
    const task = Promise.resolve().then(() => track(() => work(signal, track)));
    let onAbort: () => void;
    const expired = new Promise<Result<T>>(resolve => {
      onAbort = () => resolve({ skipped: 'deadline' });
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const drain = async () => {
      await Promise.allSettled([...pending]);
      release();
    };
    try {
      const result = await Promise.race([task.then(outcome => ({ outcome })), expired]);
      return signal.aborted || performance.now() >= deadline ? { skipped: 'deadline' } : result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort!);
      controller.abort();
      // A model's stage can time out while its local process is still working.
      // Keep the slot occupied until those calls and the council itself settle.
      void task.then(drain, drain);
    }
  }

  return { run };
}
