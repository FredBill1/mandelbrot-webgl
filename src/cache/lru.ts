export class LruCache<K, V> {
  private entries = new Map<K, { value: V; bytes: number }>();
  private usedBytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly onEvict?: (key: K, value: V) => void
  ) {}

  get bytes(): number {
    return this.usedBytes;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, bytes: number): void {
    const existing = this.entries.get(key);
    if (existing) {
      this.usedBytes -= existing.bytes;
      this.entries.delete(key);
      this.onEvict?.(key, existing.value);
    }

    this.entries.set(key, { value, bytes });
    this.usedBytes += bytes;
    this.trim();
  }

  delete(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.usedBytes -= entry.bytes;
    this.onEvict?.(key, entry.value);
  }

  keys(): K[] {
    return [...this.entries.keys()];
  }

  private trim(): void {
    while (this.usedBytes > this.maxBytes && this.entries.size > 0) {
      const first = this.entries.entries().next().value as [K, { value: V; bytes: number }] | undefined;
      if (!first) break;
      const [key, entry] = first;
      this.entries.delete(key);
      this.usedBytes -= entry.bytes;
      this.onEvict?.(key, entry.value);
    }
  }
}
