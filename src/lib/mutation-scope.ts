export interface MutationLease {
  controller: AbortController;
  generation: number;
}

/** Stops in-flight writes from updating an interface after its account has changed. */
export class MutationScope {
  private generation = 0;
  private pending = new Set<AbortController>();

  begin(): MutationLease {
    const controller = new AbortController();
    this.pending.add(controller);
    return { controller, generation: this.generation };
  }

  isCurrent(lease: MutationLease): boolean {
    return (
      lease.generation === this.generation && !lease.controller.signal.aborted
    );
  }

  finish(lease: MutationLease): void {
    this.pending.delete(lease.controller);
  }

  cancelAll(): void {
    this.generation += 1;
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
  }
}
