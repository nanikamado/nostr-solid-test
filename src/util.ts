export const normalizeUrl = (url: string) => {
  const u = new URL(url);
  const s = u.toString();
  if (u.pathname === "/" && s[s.length - 1] === "/") {
    return s.slice(0, -1);
  } else {
    return s;
  }
};

export class UrlMap<T> {
  urls: Map<string, T>;

  constructor() {
    this.urls = new Map();
  }
  get(url: string): T | undefined {
    return this.urls.get(normalizeUrl(url));
  }
  set(url: string, value: T) {
    this.urls.set(normalizeUrl(url), value);
  }
  [Symbol.iterator]() {
    return this.urls[Symbol.iterator]();
  }
  has(url: string) {
    return this.urls.has(normalizeUrl(url));
  }
  size() {
    return this.urls.size;
  }
}
