import * as api from "../api";
import type { Host, SshConfigHost } from "../api";

export const NEW_HOST_EXTRAS = { jump_host_id: null, options: api.DEFAULT_HOST_OPTIONS };

export function jumpTarget(jump: string, hosts: Pick<Host, "id" | "name" | "hostname" | "port" | "username">[]): string | null {
  let spec = jump.trim();
  const at = spec.lastIndexOf("@");
  const user = at >= 0 ? spec.slice(0, at) : "";
  if (at >= 0) spec = spec.slice(at + 1);
  let port = 22;
  const v6 = /^\[(.+)\](?::(\d+))?$/.exec(spec);
  if (v6) {
    spec = v6[1];
    if (v6[2]) port = Number(v6[2]);
  } else if (/^[^:]+:\d+$/.test(spec)) {
    const [h, p] = spec.split(":");
    spec = h;
    port = Number(p);
  }
  const name = spec.toLowerCase();
  const byName = hosts.find((h) => h.name.trim().toLowerCase() === name);
  if (byName) return byName.id;
  const byAddr = hosts.find((h) => h.hostname.toLowerCase() === name && h.port === port && (!user || h.username === user));
  return byAddr?.id ?? null;
}

export async function linkProxyJumps(created: { host: Host; config: SshConfigHost }[]): Promise<string[]> {
  const pending = created.filter((c) => c.config.proxy_jump);
  if (pending.length === 0) return [];
  const all = await api.hostList();
  const problems: string[] = [];
  for (const c of pending) {
    const target = jumpTarget(c.config.proxy_jump!, all.filter((h) => h.id !== c.host.id));
    if (!target) {
      problems.push(`${c.host.name}: jump host ${c.config.proxy_jump} is not one of your hosts, so it connects directly`);
      continue;
    }
    const fresh = all.find((h) => h.id === c.host.id) ?? c.host;
    try {
      await api.hostUpdate({ ...fresh, jump_host_id: target });
    } catch (e) {
      problems.push(`${c.host.name}: ${String((e as { message?: string })?.message ?? e)}`);
    }
  }
  return problems;
}
