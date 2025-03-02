export class Channel<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waitingResolvers: ((result: IteratorResult<T, unknown>) => void)[] =
    [];
  private onCloseCallbacks: (() => void)[] = [];
  #onNewItemCallbacks: ((item: T) => void)[] = [];
  closed = false;

  send(value: T): void {
    if (this.closed) {
      throw new Error("Channel is closed");
    }
    for (const c of this.#onNewItemCallbacks) {
      c(value);
    }
    if (this.waitingResolvers.length > 0) {
      const resolver = this.waitingResolvers.shift();
      resolver && resolver({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  onNewItem(callback: (itme: T) => void) {
    this.#onNewItemCallbacks.push(callback);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }

  async next(): Promise<IteratorResult<T, unknown>> {
    const value = this.buffer.shift();
    if (value) {
      return { value, done: false };
    }
    if (this.closed) {
      return { value: undefined, done: true };
    }
    return await new Promise((resolve) => {
      this.waitingResolvers.push(resolve);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waitingResolvers.length) {
      const resolver = this.waitingResolvers.shift();
      resolver && resolver({ value: undefined, done: true });
    }
    for (const c of this.onCloseCallbacks) {
      c();
    }
  }

  onClose(callback: () => void): void {
    this.onCloseCallbacks.push(callback);
  }
}
