/**
 * Conditional-request cache for GitHub REST GETs. GitHub doesn't count 304 responses against the
 * rate limit, so polling with If-None-Match is nearly free.
 */
export class EtagCache {
  private readonly entries = new Map<string, { etag: string; response: unknown }>();

  constructor(private readonly maxEntries = 500) {}

  key(method: string, url: string): string | undefined {
    return method.toUpperCase() === "GET" ? url : undefined;
  }

  get(key: string): { etag: string; response: unknown } | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      // refresh LRU position
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, etag: string, response: unknown): void {
    this.entries.delete(key);
    this.entries.set(key, { etag, response });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
