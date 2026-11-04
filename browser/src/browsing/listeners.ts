export class Listeners<Args extends unknown[]> {
  private readonly listeners = new Set<(...args: Args) => void>();

  add(listener: (...args: Args) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(...args: Args) {
    for (const listener of [...this.listeners]) {
      try {
        listener(...args);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      }
    }
  }
}
