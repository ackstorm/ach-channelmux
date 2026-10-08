// Daemon identity: the token a daemon presents as its Slack token is sent to an
// external endpoint, which answers with JSON holding the owner's email.

import { createHash } from "node:crypto";

export interface ResolverConfig {
  /** Endpoint called with GET. */
  url: string;
  /** Request header that carries the daemon's token. */
  header: string;
  /** Dotted path to the email in the JSON reply, e.g. "data.email". */
  emailField: string;
}

/**
 * 2xx with an email at emailField: that owner. 401, 403, or a reply without the
 * email: nobody. Anything else is an error, so an outage does not read as a
 * rejected token.
 */
export function tokenResolver({ url, header, emailField }: ResolverConfig, cacheMs = 5 * 60_000) {
  const path = emailField.split(".");
  // Keyed by a hash so raw tokens are not kept around longer than the request.
  const cache = new Map<string, { email: string | null; exp: number }>();

  return async (token: string): Promise<string | null> => {
    const key = createHash("sha256").update(token).digest("hex");
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.email;

    const res = await fetch(url, { headers: { [header]: token } });
    let email: string | null = null;
    if (res.ok) {
      const value = path.reduce<any>((v, k) => v?.[k], await res.json());
      email = typeof value === "string" && value ? value.toLowerCase() : null;
    } else if (res.status !== 401 && res.status !== 403) throw new Error(`auth resolver: ${res.status}`);

    if (cache.size > 10_000) cache.clear();
    cache.set(key, { email, exp: Date.now() + cacheMs });
    return email;
  };
}
