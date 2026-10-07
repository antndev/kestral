export type Target = { username: string; hostname: string; port: number };

export interface QuickConnect extends Target {
  /** "" = default identity, a private_key secret id, "agent" or "password". */
  identity: string;
}

/** Parses "user@host", "user@host:port", "user@[v6]:port", "ssh://user@host:port" and a pasted "ssh user@host -p port". */
export function parseTarget(raw: string): { ok: true; value: Target } | { ok: false; error: string } {
  let s = raw.trim();
  s = /^ssh:\/\//i.test(s) ? s.slice(6).replace(/\/+$/, "") : s.replace(/^ssh\s+/i, "");
  let port: number | null = null;
  const pFlag = s.match(/(?:^|\s)-p\s*(\S+)/);
  if (pFlag) {
    if (!/^\d+$/.test(pFlag[1])) return { ok: false, error: "Port must be a number from 1 to 65535" };
    port = Number(pFlag[1]);
    s = s.replace(pFlag[0], " ").trim();
  }
  if (!s) return { ok: false, error: "Enter user@host or user@host:port" };
  if (/\s/.test(s)) return { ok: false, error: "Use the form user@host:port" };
  const at = s.lastIndexOf("@");
  if (at <= 0) return { ok: false, error: "Add a user name, for example root@host" };
  const username = s.slice(0, at);
  let rest = s.slice(at + 1);
  let hostname: string;
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close < 0) return { ok: false, error: "Close the IPv6 address with ]" };
    hostname = rest.slice(1, close);
    rest = rest.slice(close + 1);
    if (rest && !rest.startsWith(":")) return { ok: false, error: "Use the form user@[address]:port" };
    if (rest) {
      if (port !== null) return { ok: false, error: "Give the port only once" };
      if (!/^\d+$/.test(rest.slice(1))) return { ok: false, error: "Port must be a number from 1 to 65535" };
      port = Number(rest.slice(1));
    }
  } else {
    const colons = rest.split(":").length - 1;
    if (colons === 1) {
      const [h, p] = rest.split(":");
      if (port !== null) return { ok: false, error: "Give the port only once" };
      if (!/^\d+$/.test(p)) return { ok: false, error: "Port must be a number from 1 to 65535" };
      hostname = h;
      port = Number(p);
    } else {
      hostname = rest;
    }
  }
  if (!hostname) return { ok: false, error: "Add a host after the @" };
  const finalPort = port ?? 22;
  if (!Number.isInteger(finalPort) || finalPort < 1 || finalPort > 65535) return { ok: false, error: "Port must be a number from 1 to 65535" };
  return { ok: true, value: { username, hostname, port: finalPort } };
}
