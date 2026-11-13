/**
 * JSON fetch used by every Eastmoney-backed baker/panel.
 *
 * Two behaviours matter here and neither is safe to leave to the default
 * `fetch`:
 *
 *  1. **Redirects.** Eastmoney moved the quote APIs behind a redirect:
 *     `push2.eastmoney.com/api/qt/clist/get` answers `302` with a
 *     protocol-relative `Location: //push2delay.eastmoney.com/...`. A helper
 *     that treats any non-2xx as failure silently yields zero rows, which is
 *     exactly how theme board heat went empty for two days (boards=0).
 *     We follow redirects explicitly so the protocol-relative form and
 *     cross-host hops are handled the same way everywhere, and so the
 *     behaviour is stubbable in tests (default `fetch` redirect handling is
 *     invisible to a fake).
 *
 *  2. **Transient upstream 5xx.** The delay host answers `502 Bad Gateway`
 *     in bursts. One attempt per URL makes a whole bake look dead, so we
 *     retry with a short backoff and treat a non-JSON body (nginx error
 *     page) as a failed attempt rather than parsing it.
 *
 * Every failure path returns `null`: callers are fail-open by repo invariant.
 */

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Total attempts per URL (1 = no retry). */
  attempts?: number;
  /** Base backoff between attempts, multiplied by the attempt number. */
  retryDelayMs?: number;
  /** Max redirect hops before giving up. */
  maxRedirects?: number;
  /** Test seam; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam; defaults to a real timer. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const DEFAULT_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Resolve a `Location` header against the URL that produced it. Handles the
 * protocol-relative form (`//host/path`) that Eastmoney emits, which plain
 * `new URL(location, base)` also handles — kept explicit and exported so the
 * redirect contract is directly testable.
 */
export function resolveRedirectTarget(location: string, base: string): string {
  return new URL(location, base).toString();
}

/** True when a response looks like JSON rather than an HTML error page. */
export function looksLikeJson(body: string): boolean {
  const head = body.trimStart();
  return head.startsWith("{") || head.startsWith("[");
}

async function fetchOnce(
  url: string,
  opts: Required<
    Pick<FetchJsonOptions, "headers" | "timeoutMs" | "maxRedirects" | "fetchImpl">
  >,
): Promise<string | null> {
  let current = url;
  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const res = await opts.fetchImpl(current, {
      headers: opts.headers,
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      // Drain the body so the socket can be released.
      await res.text().catch(() => "");
      if (!location) return null;
      current = resolveRedirectTarget(location, current);
      continue;
    }

    if (!res.ok) {
      await res.text().catch(() => "");
      return null;
    }

    const body = await res.text();
    return looksLikeJson(body) ? body : null;
  }
  return null;
}

export async function fetchJson<T>(
  url: string | string[],
  options: FetchJsonOptions = {},
): Promise<T | null> {
  // Accept a list so a caller can offer the delay host as a fallback when the
  // primary is erroring. Eastmoney serves the same payload from `push2` and
  // `push2delay`, and either one can be unhealthy on its own.
  const urls = Array.isArray(url) ? url : [url];

  for (const candidate of urls) {
    const out = await fetchJsonFrom<T>(candidate, options);
    if (out !== null) return out;
  }
  return null;
}

async function fetchJsonFrom<T>(
  url: string,
  options: FetchJsonOptions,
): Promise<T | null> {
  const {
    headers = {},
    timeoutMs = 15_000,
    attempts = 3,
    retryDelayMs = 400,
    maxRedirects = 3,
    fetchImpl = fetch,
    sleepImpl = sleep,
  } = options;

  const resolved = {
    headers: { ...DEFAULT_HEADERS, ...headers },
    timeoutMs,
    maxRedirects,
    fetchImpl,
  };

  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    try {
      const body = await fetchOnce(url, resolved);
      if (body !== null) return JSON.parse(body) as T;
    } catch {
      /* transient — fall through to retry */
    }
    if (attempt < attempts) await sleepImpl(retryDelayMs * attempt);
  }
  return null;
}
