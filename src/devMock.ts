// Dev-only Tauri IPC mock. Installed from main.tsx when the app runs in a plain
// browser (no Tauri runtime) so every screen can be exercised end to end without
// a backend. Never loaded inside the desktop app (Tauri present).
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const flags = new URLSearchParams(window.location.search);

const sleep = (ms: number) =>
  flags.has("fast")
    ? new Promise<void>((r) => {
        const c = new MessageChannel();
        c.port1.onmessage = () => r();
        c.port2.postMessage(null);
      })
    : new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- data
let unlocked = false;
let vaultExists = !flags.has("fresh");
let master = "test";
let helloOn = false;
let identities: Any[] = [];
let settings = { minimizeToTray: false, onboarded: !flags.has("onboarding") };

let folders: string[] = [];
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
function mergedNames(stored: string[], used: string[]): string[] {
  const out: string[] = [];
  for (const raw of [...stored, ...used]) {
    const n = raw.trim();
    if (n && !out.some((x) => sameName(x, n))) out.push(n);
  }
  return out;
}
function folderOp(op: string, p: Any, used: () => string[], move: (from: string, to: string) => number): unknown {
  const all = () => mergedNames(folders, used());
  if (op === "list") return all();
  if (op === "add") {
    const n = String(p.name ?? "").trim();
    if (!n) throw "Enter a name for the folder";
    if (all().some((x) => sameName(x, n))) throw `A folder named ${n} already exists`;
    folders = [...all(), n];
    return n;
  }
  if (op === "rename") {
    const to = String(p.to ?? "").trim();
    if (!to) throw "Enter a name for the folder";
    if (all().some((x) => sameName(x, to) && !sameName(x, p.from))) throw `A folder named ${to} already exists`;
    folders = all().map((x) => (sameName(x, p.from) ? to : x));
    move(p.from, to);
    return to;
  }
  if (op === "remove") {
    const n = move(p.name, "");
    folders = all().filter((x) => !sameName(x, p.name));
    return n;
  }
  const current = all();
  const next: string[] = [];
  for (const n of p.order as string[]) {
    const hit = current.find((x) => sameName(x, n));
    if (hit && !next.includes(hit)) next.push(hit);
  }
  for (const x of current) if (!next.includes(x)) next.push(x);
  folders = next;
  return null;
}

const hosts: Any[] = [
  { id: "h1", name: "web-01", hostname: "10.0.1.21", port: 22, username: "deploy", auth: { kind: "key", secret_id: "deploy-ed25519" }, ai_policy: "confirm", ai_file_policy: "locked", forward_agent: false, agent_keys: [], group: "Production", tags: ["web", "nginx"], forwards: [{ id: "f1", name: "Grafana", local_host: "127.0.0.1", local_port: 3000, remote_host: "10.0.1.50", remote_port: 3000, autostart: false, kind: "local", start_on_connect: false }, { id: "f3", name: "Webhook dev", local_host: "127.0.0.1", local_port: 3000, remote_host: "localhost", remote_port: 8080, autostart: false, kind: "remote", start_on_connect: true }], jump_host_id: null, options: { keepalive_secs: null, connect_timeout_secs: null, terminal_theme: "", encoding: "", startup_command: "", env: [] } },
  { id: "h2", name: "web-02", hostname: "10.0.1.22", port: 22, username: "deploy", auth: { kind: "key", secret_id: "deploy-ed25519" }, ai_policy: "locked", ai_file_policy: "locked", forward_agent: false, agent_keys: [], group: "Production", tags: ["web", "nginx"], forwards: [] },
  { id: "h3", name: "db-primary", hostname: "10.0.1.30", port: 22, username: "ops", auth: { kind: "key", secret_id: "github-ci" }, ai_policy: "locked", ai_file_policy: "locked", forward_agent: true, agent_keys: ["deploy-ed25519"], group: "Production", tags: ["postgres", "via bastion"], forwards: [{ id: "f2", name: "Postgres", local_host: "127.0.0.1", local_port: 5433, remote_host: "localhost", remote_port: 5432, autostart: true, kind: "local", start_on_connect: false }, { id: "f4", name: "SOCKS proxy", local_host: "127.0.0.1", local_port: 1080, remote_host: "localhost", remote_port: 1, autostart: false, kind: "dynamic", start_on_connect: false }], jump_host_id: "h5", options: { keepalive_secs: 30, connect_timeout_secs: 10, terminal_theme: "production", encoding: "", startup_command: "", env: [] } },
  { id: "h4", name: "stage-app", hostname: "10.0.2.10", port: 22, username: "deploy", auth: { kind: "password", secret_id: "pw-stage-app" }, ai_policy: "free", ai_file_policy: "confirm", forward_agent: false, agent_keys: [], group: "Staging", tags: ["app"], forwards: [] },
  { id: "h5", name: "nas", hostname: "192.168.1.10", port: 2222, username: "admin", auth: { kind: "agent" }, ai_policy: "locked", ai_file_policy: "locked", forward_agent: false, agent_keys: [], group: "Homelab", tags: ["storage"], forwards: [] },
  { id: "h6", name: "new-server", hostname: "10.0.2.40", port: 22, username: "root", auth: { kind: "agent" }, ai_policy: "locked", ai_file_policy: "locked", forward_agent: false, agent_keys: [], group: "", tags: [], forwards: [] },
];
const secrets: Any[] = [
  { id: "deploy-ed25519", kind: "private_key" },
  { id: "github-ci", kind: "private_key" },
  { id: "legacy-rsa", kind: "private_key" },
  { id: "pw-stage-app", kind: "password" },
];
const snippets: Any[] = [
  { id: "s1", label: "Restart stack", script: "cd /opt/{app}\ndocker compose pull\ndocker compose up -d\ndocker compose ps", target_host_ids: ["h1", "h2"], folder: "Docker" },
  { id: "s2", label: "Prune images", script: "docker image prune -af", target_host_ids: [], folder: "Docker" },
  { id: "s3", label: "Disk usage", script: "df -h", target_host_ids: ["h1", "h3"], folder: "System" },
  { id: "s4", label: "Tail nginx", script: "tail -n 20 /var/log/nginx/access.log", target_host_ids: ["h1"], folder: "Logs" },
];
if (flags.has("empty") || flags.has("fresh")) {
  hosts.length = 0;
  secrets.length = 0;
  snippets.length = 0;
}
const activeForwards = new Set<string>(hosts.length ? ["f2"] : []);
let knownHosts: Any[] = [
  { line: 1, hosts: "[192.168.1.10]:2222", host: "192.168.1.10", port: 2222, key_type: "ssh-ed25519", fingerprint: "SHA256:pX0mR4aZ1b2c3d4e5f6g7h8i9j0kL2aQ", hashed: false },
  { line: 2, hosts: "10.0.1.21", host: "10.0.1.21", port: 22, key_type: "ssh-ed25519", fingerprint: "SHA256:Xq3vH8c1nKp2Lw0sT9yQ4mZr7bE6dA5fG3jU1iO9fTk", hashed: false },
  { line: 3, hosts: "10.0.1.30", host: "10.0.1.30", port: 22, key_type: "ecdsa-sha2-nistp256", fingerprint: "SHA256:Kd9eW3abcdefghijklmnopqrstuvwxyz0123457hJs", hashed: false },
  { line: 4, hosts: "|1|abc=|def=", host: "", port: 22, key_type: "ssh-rsa", fingerprint: "SHA256:Hy2bF6abcdefghijklmnopqrstuvwxyz01230oPq", hashed: true },
];
let aiActive = false;
let aiExpires: string | null = null;
let aiCaps = { list_hosts: true, manage_hosts: false, list_snippets: true, manage_snippets: false, list_secrets: false, audit_log: true };
let protectedPaths = ["~/.ssh/authorized_keys", "~/.ssh/config"];
let skill = false;
let registrations = [{ name: "kestral", url: "http://127.0.0.1:4517/mcp", connected: true, is_this_app: true }];
const audit: Any[] = Array.from({ length: 14 }, (_, i) => ({
  id: uuid(),
  timestamp: new Date(Date.now() - (13 - i) * 3600_000).toISOString(),
  host_id: i % 2 ? "h1" : "h3",
  host_name: i % 2 ? "web-01" : "db-primary",
  command: ["uptime", "df -h", "docker ps", "systemctl status nginx", "cat /etc/os-release", "journalctl -p err -n 50", "ls -la /var/www"][i % 7],
  decision: ["allowed", "approved", "denied", "user"][i % 4],
  exit_status: i % 4 === 2 ? null : i % 5 === 0 ? 1 : 0,
  success: !(i % 4 === 2 || i % 5 === 0),
  detail: i % 4 === 2 ? "Denied by user" : null,
}));
const clipboard = { text: "" };
const sftpHost = new Map<string, string>();

// ---------------------------------------------------------------- filesystems
type Node = { name: string; dir: boolean; size: number; mtime: number; mode: number; children?: Node[]; text?: string };
const file = (name: string, size: number, text = ""): Node => ({ name, dir: false, size, mtime: now() - Math.floor(Math.random() * 400000), mode: 0o100644, text });
const dir = (name: string, children: Node[]): Node => ({ name, dir: true, size: 0, mtime: now() - 3600, mode: 0o040755, children });
const localRoot = dir("", [
  dir("C:", [dir("Users", [dir("anton", [
    dir(".ssh", [file("id_ed25519", 411, "-----BEGIN OPENSSH PRIVATE KEY-----\nMOCK\n-----END OPENSSH PRIVATE KEY-----\n"), file("id_ed25519.pub", 98, "ssh-ed25519 AAAA mock@pc"), file("config", 210, ""), file("known_hosts", 900, "")]),
    dir("Projects", [dir("site", [dir("dist", [dir("assets", [file("app.js", 88213), file("app.css", 12034)]), file("index.html", 4200, "<!doctype html>\n<h1>Hello</h1>\n"), file("about.html", 3100), file("robots.txt", 68, "User-agent: *\n"), file("sitemap.xml", 1400), file("favicon.ico", 15000)])])]),
    dir("Downloads", [file("backup-2026-10-02.tar.gz", 48_000_000)]),
    file(".gitconfig", 120, "[user]\n  name = anton\n"),
  ])])]),
]);
const remoteRoots = new Map<string, Node>();
function remoteRoot(hostId: string): Node {
  if (!remoteRoots.has(hostId)) {
    remoteRoots.set(hostId, dir("", [
      dir("var", [dir("www", [dir("site", [dir("assets", [file("app.js", 88000)]), dir("uploads", [file("photo.jpg", 230000)]), file("index.html", 4000, "<!doctype html>\n<h1>Live</h1>\n"), file("about.html", 3100), file("robots.txt", 68, "User-agent: *\n")])]), dir("log", [dir("nginx", [file("access.log", 120000, "10.0.0.5 GET /health 200\n")])])]),
      dir("home", [dir("deploy", [dir(".ssh", [file("authorized_keys", 400, "ssh-ed25519 AAAA old\n")]), file(".bashrc", 3800, "# bashrc\n"), file("notes.txt", 42, "remember to rotate keys\n")])]),
      dir("etc", [file("hostname", 7, "web-01\n"), file("os-release", 380, "NAME=Debian\n")]),
    ]));
  }
  return remoteRoots.get(hostId)!;
}
function split(path: string, local: boolean): string[] {
  const p = local ? path.replace(/\//g, "\\") : path;
  return (local ? p.split("\\") : p.split("/")).filter(Boolean);
}
function find(root: Node, parts: string[]): Node | null {
  let cur: Node | undefined = root;
  for (const p of parts) {
    cur = cur?.children?.find((c) => c.name.toLowerCase() === p.toLowerCase());
    if (!cur) return null;
  }
  return cur ?? null;
}
function join(base: string, name: string, local: boolean): string {
  const sep = local ? "\\" : "/";
  return base.endsWith(sep) ? base + name : base + sep + name;
}
function listNode(root: Node, path: string, local: boolean): Any[] {
  const n = find(root, split(path, local));
  if (!n || !n.dir) throw local ? `The system cannot find the path specified: ${path}` : `No such file or directory: ${path}`;
  const out = (n.children ?? []).map((c) => ({ name: c.name, path: join(path, c.name, local), is_dir: c.dir, is_symlink: false, size: c.dir ? 0 : c.size, mtime: c.mtime, permissions: local ? null : c.mode }));
  return out.sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.is_dir ? -1 : 1));
}
function parentAndName(root: Node, path: string, local: boolean): [Node, string] {
  const parts = split(path, local);
  const name = parts.pop()!;
  const parent = find(root, parts);
  if (!parent || !parent.dir) throw `Parent folder not found for ${path}`;
  return [parent, name];
}
function mkdirAt(root: Node, path: string, local: boolean) {
  const [parent, name] = parentAndName(root, path, local);
  if (parent.children!.some((c) => c.name === name)) throw `${name} already exists`;
  parent.children!.push(dir(name, []));
}
function removeAt(root: Node, path: string, local: boolean) {
  const [parent, name] = parentAndName(root, path, local);
  parent.children = parent.children!.filter((c) => c.name !== name);
}
function renameAt(root: Node, from: string, to: string, local: boolean) {
  const [p1, n1] = parentAndName(root, from, local);
  const node = p1.children!.find((c) => c.name === n1);
  if (!node) throw `Not found: ${from}`;
  const [p2, n2] = parentAndName(root, to, local);
  p1.children = p1.children!.filter((c) => c !== node);
  node.name = n2;
  p2.children!.push(node);
}
function copyInto(src: Node, destRoot: Node, destPath: string, local: boolean): number {
  const [parent, name] = parentAndName(destRoot, destPath, local);
  parent.children = parent.children!.filter((c) => c.name !== name);
  const clone: Node = JSON.parse(JSON.stringify(src));
  clone.name = name;
  clone.mtime = now();
  parent.children!.push(clone);
  const size = (n: Node): number => (n.dir ? (n.children ?? []).reduce((s, c) => s + size(c), 0) : n.size);
  return size(clone);
}

// ---------------------------------------------------------------- terminals
type Shell = { id: string; host: Any; channel: Any | null; idx: number; line: string; cwd: string };
const shells = new Map<string, Shell>();
const trusted = new Set<string>();
const pendingHostKey = new Map<string, (r: { accept: boolean; save: boolean }) => void>();
const enc = new TextEncoder();

function send(sh: Shell, text: string) {
  const bytes = enc.encode(text);
  if (!sh.channel) return;
  const index = sh.idx++;
  const channel = sh.channel;
  window.setTimeout(() => (window as Any).__TAURI_INTERNALS__.runCallback(channel.id, { index, message: bytes.buffer }), 0);
}
const prompt = (sh: Shell) => `\x1b[32m${sh.host.username}@${sh.host.name}\x1b[0m:\x1b[34m${sh.cwd}\x1b[0m$ `;
function runLine(sh: Shell, cmd: string): string {
  const c = cmd.trim();
  if (!c) return "";
  if (c === "clear") return "\x1b[2J\x1b[H";
  if (c === "whoami") return sh.host.username + "\r\n";
  if (c === "hostname") return sh.host.name + "\r\n";
  if (c.startsWith("echo ")) return c.slice(5) + "\r\n";
  if (c === "uptime") return " 14:02:11 up 3 days,  2:41,  1 user,  load average: 0.08, 0.05, 0.01\r\n";
  if (c === "ls" || c === "ls -la") return "\x1b[34massets\x1b[0m  \x1b[34muploads\x1b[0m  index.html  about.html  robots.txt\r\n";
  if (c.startsWith("cd ")) { sh.cwd = c.slice(3) || "~"; return ""; }
  if (c === "df -h") return "Filesystem      Size  Used Avail Use% Mounted on\r\n/dev/sda1        40G   12G   26G  32% /\r\n";
  if (c.startsWith("docker")) return "NAME      IMAGE              STATUS\r\napp       site/app:2.4.1     Up 3 days\r\nredis     redis:7-alpine     Up 3 days\r\n";
  return `bash: ${c.split(" ")[0]}: command not found\r\n`;
}

const canceled = new Set<string>();
const cancelledTransfers = new Set<string>();
async function simulateProgress(id: string, channel: Any, total: number) {
  let done = 0;
  let index = 0;
  while (done < total) {
    await sleep(200);
    if (cancelledTransfers.delete(id)) throw "Cancelled";
    done = Math.min(total, done + Math.round(total / 12));
    (window as Any).__TAURI_INTERNALS__.runCallback(channel.id, { index: index++, message: { done, total } });
  }
}
async function openShell(p: Any) {
  const host = hosts.find((h) => h.id === p.hostId);
  if (!host) throw "Host not found";
  const sid = p.id as string;
  const status = (stage: string, detail = "", data?: unknown) => emit("session-status", { id: sid, stage, detail, data });
  const pause = async (ms: number) => {
    await sleep(ms);
    if (canceled.delete(sid)) {
      await status("canceled");
      throw "Connection canceled";
    }
  };
  const jump = host.jump_host_id ? hosts.find((h) => h.id === host.jump_host_id) : null;
  if (jump) {
    await status("jumping", jump.name);
    await pause(400);
    await status("jumped", jump.name);
    await status("connecting", `${host.hostname}:${host.port}`);
  } else {
    await status("resolving", host.hostname);
    await pause(250);
    await status("resolved", /^[\d.]+$/.test(host.hostname) ? host.hostname : "10.0.9.17");
    await status("connecting", `${/^[\d.]+$/.test(host.hostname) ? host.hostname : "10.0.9.17"}:${host.port}`);
  }
  await pause(350);
  if (host.hostname === "192.168.1.10") {
    const saved = knownHosts.filter((k) => k.host === host.hostname && k.port === host.port);
    await emit("hostkey-changed", { host: host.hostname, port: host.port, key_type: "ssh-ed25519", fingerprint: "SHA256:Zt7cW1newkeynewkeynewkeynewkeyV3ke", saved });
    await status("error", `Host key changed for ${host.hostname}:${host.port}. Refused. If this is expected, remove the old key from known_hosts.`);
    throw `Host key changed for ${host.hostname}:${host.port}`;
  }
  const key = `${host.hostname}:${host.port}`;
  const known = trusted.has(key) || knownHosts.some((k) => k.host === host.hostname && k.port === host.port);
  if (!known) {
    const id = uuid();
    const answer = await new Promise<{ accept: boolean; save: boolean }>((resolve) => {
      pendingHostKey.set(id, resolve);
      emit("hostkey-request", { id, host: host.hostname, port: host.port, key_type: "ssh-ed25519", fingerprint: "SHA256:4fQm9Tz2Rk7Vd1Xc8Lp3Hs6Bn0Wy5Ju2Ge9Ka1Ot7Ii" });
    });
    if (!answer.accept) {
      await status("error", "Host key not trusted. Connection refused.");
      throw "Host key not trusted";
    }
    if (answer.save) knownHosts.push({ line: knownHosts.length + 1, hosts: host.hostname, host: host.hostname, port: host.port, key_type: "ssh-ed25519", fingerprint: "SHA256:4fQm9Tz2Rk7Vd1Xc8Lp3Hs6Bn0Wy5Ju2Ge9Ka1Ot7Ii", hashed: false });
    else trusted.add(key);
  }
  const method = p.password ? "password" : host.auth?.kind === "password" ? "password" : host.auth?.kind === "key" ? "key" : "agent";
  const credential = p.password ? "" : host.auth?.secret_id ?? "";
  await status("authenticating", p.password ? "the password you entered" : method === "key" ? credential : method === "password" ? `the password ${credential}` : "your SSH agent");
  await pause(600);
  if (host.name === "stage-app" && p.password !== "test") {
    await status("auth-failed", p.password ? "Permission denied (publickey,password)" : "Permission denied (publickey)", { user: host.username, method, credential });
    throw `Authentication failed for ${host.username}`;
  }
  await status("opening-shell");
  await pause(250);
  const sh: Shell = { id: sid, host, channel: p.onOutput, idx: 0, line: "", cwd: "~" };
  shells.set(sid, sh);
  await status("connected", p.password ? "Password" : method === "key" ? "ED25519 key" : method === "password" ? "Password" : "ED25519 via agent");
  window.setTimeout(() => void emit("session-info", { id: sid, shell: "bash" }), 80);
  send(sh, `Linux ${host.name} 6.1.0-21-amd64 x86_64\r\n\r\nLast login: Sat Oct  3 13:20:11 2026 from 10.0.0.5\r\n` + prompt(sh));
  return null;
}
function writeShell(p: Any) {
  const sh = shells.get(p.id);
  if (!sh) return null;
  const data: string = p.data;
  if (data.startsWith("\x1b[200~")) {
    const text = data.replace(/\x1b\[20[01]~/g, "");
    for (const ch of text) writeShell({ id: p.id, data: ch === "\n" ? "\r" : ch });
    return null;
  }
  for (const ch of data) {
    if (ch === "\r") {
      const cmd = sh.line.trim();
      sh.line = "";
      if (cmd === "exit" || cmd === "lostconn") {
        send(sh, cmd === "exit" ? "\r\nlogout\r\n" : "\r\n");
        shells.delete(sh.id);
        window.setTimeout(() => void emit("session-closed", { id: sh.id, exit_status: cmd === "exit" ? 0 : null, signal: null, lost: cmd === "lostconn" }), 120);
        return null;
      }
      const out = runLine(sh, cmd);
      send(sh, "\r\n" + out + prompt(sh));
    } else if (ch === "\x7f") {
      if (sh.line) { sh.line = sh.line.slice(0, -1); send(sh, "\b \b"); }
    } else if (ch === "\x03") {
      sh.line = "";
      send(sh, "^C\r\n" + prompt(sh));
    } else if (ch === "\x07") {
      send(sh, "\x07");
    } else if (ch >= " ") {
      sh.line += ch;
      send(sh, ch);
    }
  }
  return null;
}

async function streamCommand(p: Any) {
  const host = hosts.find((h) => h.id === p.hostId);
  const ch = p.onOutput;
  let idx = 0;
  const out = (t: string) => (window as Any).__TAURI_INTERNALS__.runCallback(ch.id, { index: idx++, message: enc.encode(t).buffer });
  const fake: Shell = { id: "", host: host ?? { username: "user", name: "host" }, channel: ch, idx: 0, line: "", cwd: "~" };
  for (const line of String(p.command).split("\n")) {
    await sleep(250);
    out(`$ ${line}\r\n` + runLine(fake, line));
  }
  return { exit_status: 0, exit_signal: null };
}

// ---------------------------------------------------------------- dispatcher
export function installDevMock() {
  mockWindows("main");
  mockIPC(async (cmd: string, payload?: unknown) => {
    const p = (payload ?? {}) as Any;
    switch (cmd) {
      // vault
      case "vault_exists": return vaultExists;
      case "vault_status": return unlocked;
      case "hello_status": return { supported: true, enabled: helloOn, method: "Windows Hello" };
      case "hello_enable": await sleep(600); helloOn = true; return null;
      case "hello_disable": helloOn = false; return null;
      case "hello_unlock": await sleep(500); if (!helloOn) throw "Windows Hello is not set up for this vault."; unlocked = true; return null;
      case "vault_unlock": if (p.master !== master && master) throw "Wrong master password"; unlocked = true; return null;
      case "vault_create": master = p.master; vaultExists = true; unlocked = true; return null;
      case "vault_lock": unlocked = false; shells.clear(); return null;
      case "vault_change_master": if (p.current !== master) throw "Current password is wrong"; master = p.new; return null;
      case "vault_export": await sleep(300); return null;
      case "vault_import": await sleep(300); return { hosts_added: 2, hosts_skipped: 1, secrets_added: 1, secrets_skipped: 0, snippets_added: 3, snippets_skipped: 0 };
      // settings
      case "settings_get": return settings;
      case "settings_set_minimize_to_tray": settings = { ...settings, minimizeToTray: p.enabled }; return null;
      case "settings_set_onboarded": settings = { ...settings, onboarded: true }; return null;
      // secrets
      case "secret_list": return JSON.parse(JSON.stringify(secrets));
      case "secret_put": { const i = secrets.findIndex((s) => s.id === p.id); if (i >= 0) secrets[i] = { id: p.id, kind: p.kind }; else secrets.push({ id: p.id, kind: p.kind }); return null; }
      case "secret_delete": { const i = secrets.findIndex((s) => s.id === p.id); if (i >= 0) secrets.splice(i, 1); return null; }
      case "secret_reveal": return secrets.find((s) => s.id === p.id)?.kind === "password" ? "hunter2" : `-----BEGIN OPENSSH PRIVATE KEY-----\nMOCK-${p.id}\n-----END OPENSSH PRIVATE KEY-----`;
      case "key_set_comment": return null;
      case "generate_key": return `-----BEGIN OPENSSH PRIVATE KEY-----\nGENERATED-${p.algorithm}\n-----END OPENSSH PRIVATE KEY-----`;
      case "derive_pubkey": {
        const algo = String(p.privateKey).includes("rsa") ? "ssh-rsa" : String(p.privateKey).includes("ecdsa") ? "ecdsa-sha2-nistp256" : "ssh-ed25519";
        const tag = String(p.privateKey).slice(40, 52).replace(/[^A-Za-z0-9]/g, "") || "key";
        return { public_key: `${algo} AAAAC3NzaC1lZDI1NTE5AAAAI${tag}K7vR2mXcQ8sLp4nW1bT6yH3jF9dZ0aE5uG2kM7oN4xQ deploy@workstation`, fingerprint: `SHA256:${tag}Xq3vH8c1nKp2Lw0sT9yQ4mZr7bE6dA5fG3jU1iO9fTk`.slice(0, 50) };
      }
      // hosts
      case "host_list": return JSON.parse(JSON.stringify(hosts));
      case "snippet_folder_list":
      case "snippet_folder_add":
      case "snippet_folder_rename":
      case "snippet_folder_remove":
      case "snippet_folder_reorder":
        return folderOp(cmd.slice(15), p, () => snippets.map((x) => x.folder ?? ""), (from, to) => {
          let n = 0;
          for (const x of snippets) if (x.folder && sameName(x.folder, from)) { x.folder = to; n++; }
          return n;
        });
      case "host_add": { const h = { id: uuid(), group: "", tags: [], forwards: [], ...p.host }; hosts.push(h); return h; }
      case "host_update": { const i = hosts.findIndex((h) => h.id === p.host.id); if (i < 0) throw "Host not found"; hosts[i] = p.host; return null; }
      case "host_remove": { const i = hosts.findIndex((h) => h.id === p.id); if (i >= 0) hosts.splice(i, 1); return null; }
      case "host_set_policy": { const h = hosts.find((x) => x.id === p.id); if (h) h.ai_policy = p.policy; return null; }
      case "host_set_file_policy": { const h = hosts.find((x) => x.id === p.id); if (h) h.ai_file_policy = p.policy; return null; }
      // forwards
      case "forward_active": return [...activeForwards];
      case "forward_start": { await sleep(200); const f = hosts.flatMap((h) => h.forwards).find((x: Any) => x.id === p.forwardId); if (f && f.local_port === 3000) throw "Address already in use (os error 10048)"; activeForwards.add(p.forwardId); return null; }
      case "forward_stop": activeForwards.delete(p.forwardId); return null;
      // sftp
      case "sftp_open": { await sleep(300); remoteRoot(p.hostId); sftpHost.set(p.id, p.hostId); return "/home/" + (hosts.find((h) => h.id === p.hostId)?.username ?? "user"); }
      case "sftp_list": { await sleep(120); const root = remoteRoot(sftpHost.get(p.id)!); const path = p.path.startsWith("/home/") && !find(root, split(p.path, false)) ? "/home/deploy" : p.path; return listNode(root, path, false); }
      case "sftp_mkdir": mkdirAt(remoteRoot(sftpHost.get(p.id)!), p.path, false); return null;
      case "sftp_remove": removeAt(remoteRoot(sftpHost.get(p.id)!), p.path, false); return null;
      case "sftp_rename": renameAt(remoteRoot(sftpHost.get(p.id)!), p.from, p.to, false); return null;
      case "sftp_read_text": { const n = find(remoteRoot(sftpHost.get(p.id)!), split(p.path, false)); if (!n || n.dir) throw "Not a file"; return n.text ?? ""; }
      case "sftp_write_text": { const root = remoteRoot(sftpHost.get(p.id)!); const n = find(root, split(p.path, false)); if (n) { n.text = p.content; n.size = p.content.length; n.mtime = now(); } else { const [par, name] = parentAndName(root, p.path, false); par.children!.push({ ...file(name, p.content.length, p.content), mtime: now() }); } return null; }
      case "sftp_upload": case "sftp_upload_dir": { await sleep(900); const src = find(localRoot, split(p.local, true)); if (!src) throw `Local file not found: ${p.local}`; return copyInto(src, remoteRoot(sftpHost.get(p.id)!), p.remote, false); }
      case "sftp_download": case "sftp_download_dir": { await sleep(900); const src = find(remoteRoot(sftpHost.get(p.id)!), split(p.remote, false)); if (!src) throw `Remote file not found: ${p.remote}`; return copyInto(src, localRoot, p.local, true); }
      case "sftp_transfer": {
        const remote = remoteRoot(sftpHost.get(p.id)!);
        const src = p.upload ? find(localRoot, split(p.local, true)) : find(remote, split(p.remote, false));
        if (!src) throw p.upload ? `Local file not found: ${p.local}` : `Remote file not found: ${p.remote}`;
        await simulateProgress(p.transferId, p.onProgress, src.dir ? 6_400_000 : Math.max(src.size ?? 0, 2_400_000));
        return p.upload ? copyInto(src, remote, p.remote, false) : copyInto(src, localRoot, p.local, true);
      }
      case "sftp_copy_remote": {
        const src = find(remoteRoot(sftpHost.get(p.srcId)!), split(p.srcPath, false));
        if (!src) throw `Remote file not found: ${p.srcPath}`;
        await simulateProgress(p.transferId, p.onProgress, src.dir ? 6_400_000 : Math.max(src.size ?? 0, 2_400_000));
        return copyInto(src, remoteRoot(sftpHost.get(p.dstId)!), p.dstPath, false);
      }
      case "sftp_cancel": cancelledTransfers.add(p.transferId); return null;
      case "sftp_close": sftpHost.delete(p.id); return null;
      // local fs
      case "local_home": return "C:\\Users\\anton";
      case "data_dir": return "C:\\Users\\anton\\.kestral";
      case "local_list": { await sleep(60); return listNode(localRoot, p.path, true); }
      case "local_mkdir": mkdirAt(localRoot, p.path, true); return null;
      case "local_remove": removeAt(localRoot, p.path, true); return null;
      case "local_rename": renameAt(localRoot, p.from, p.to, true); return null;
      case "local_read_text": { const n = find(localRoot, split(p.path, true)); if (!n || n.dir) throw "Not a file"; return n.text ?? ""; }
      case "local_write_text": { const n = find(localRoot, split(p.path, true)); if (n) { n.text = p.content; n.size = p.content.length; } else { const [par, name] = parentAndName(localRoot, p.path, true); par.children!.push(file(name, p.content.length, p.content)); } return null; }
      case "ssh_config_hosts": return [
        { alias: "homelab", hostname: "192.168.1.5", port: 22, user: "anton", identity_file: "C:\\Users\\anton\\.ssh\\id_ed25519" },
        { alias: "pi-kiosk", hostname: "192.168.1.40", port: 22, user: "pi", identity_file: null },
      ];
      // known hosts
      case "known_hosts_list": return knownHosts;
      case "known_hosts_remove": { const before = knownHosts.length; knownHosts = knownHosts.filter((k) => !p.lines.includes(k.line)); return before - knownHosts.length; }
      case "known_hosts_forget": { const before = knownHosts.length; knownHosts = knownHosts.filter((k) => !(k.host === p.host && k.port === p.port)); trusted.delete(`${p.host}:${p.port}`); return before - knownHosts.length; }
      case "known_hosts_import": knownHosts.push({ line: knownHosts.length + 1, hosts: "imported.example.com", host: "imported.example.com", port: 22, key_type: "ssh-ed25519", fingerprint: "SHA256:importedimportedimportedimportedimpo", hashed: false }); return 1;
      case "hostkey_respond": { const r = pendingHostKey.get(p.id); pendingHostKey.delete(p.id); r?.({ accept: p.accept, save: p.save }); return null; }
      // terminal
      case "ssh_open_shell": return openShell(p);
      case "ssh_write": return writeShell(p);
      case "ssh_resize": return null;
      case "ssh_close": if (!shells.delete(p.id)) canceled.add(p.id); return null;
      // snippets
      case "snippet_list": return JSON.parse(JSON.stringify(snippets));
      case "snippet_add": { const s = { id: uuid(), folder: "", ...p.snippet }; snippets.push(s); return s; }
      case "snippet_update": { const i = snippets.findIndex((s) => s.id === p.snippet.id); if (i >= 0) snippets[i] = p.snippet; return null; }
      case "snippet_delete": { const i = snippets.findIndex((s) => s.id === p.id); if (i >= 0) snippets.splice(i, 1); return null; }
      case "run_command_ui": { await sleep(400); const fake: Shell = { id: "", host: hosts.find((h) => h.id === p.hostId) ?? {}, channel: null, idx: 0, line: "", cwd: "~" }; return { stdout: String(p.command).split("\n").map((l: string) => runLine(fake, l)).join("").replace(/\r\n/g, "\n"), stderr: "", exit_status: 0 }; }
      case "run_command_stream": return streamCommand(p);
      // ai / mcp / audit
      case "ai_status": return { active: aiActive, expires_at: aiExpires, default_minutes: 30 };
      case "ai_enable": aiActive = true; aiExpires = p.minutes ? new Date(Date.now() + p.minutes * 60000).toISOString() : null; return null;
      case "ai_disable": aiActive = false; aiExpires = null; return null;
      case "ai_caps": return aiCaps;
      case "ai_set_caps": aiCaps = p.caps; return null;
      case "ai_protected_list": return protectedPaths;
      case "ai_set_protected": protectedPaths = p.paths; return null;
      case "approval_respond": return null;
      case "audit_list": return audit;
      case "audit_since": {
        const at = p.after ? audit.findIndex((e: Any) => e.id === p.after) : -1;
        return at < 0 ? { full: true, entries: p.limit ? audit.slice(-p.limit) : audit } : { full: false, entries: audit.slice(at + 1) };
      }
      case "audit_user_command": return null;
      case "app_changelog": return "## 0.1.56\n- New design\n\n## 0.1.55\n- AI file transfers can use any local path\n";
      case "mcp_info": return { url: "http://127.0.0.1:4517/mcp", token: "kst_9f2c4e7a1b3d5f6e8a0c2e4f6a8b0d1e", running: true };
      case "mcp_rotate_token": return { info: { url: "http://127.0.0.1:4517/mcp", token: "kst_" + uuid().replace(/-/g, ""), running: true }, reconnected: true, message: "Token rotated and Claude Code reconnected." };
      case "mcp_connect_claude_code": return { ok: true, message: "Claude Code is connected to Kestral." };
      case "mcp_list_registrations": return registrations;
      case "mcp_remove_registration": registrations = registrations.filter((r) => r.name !== p.name); return "Removed";
      case "install_skill": skill = true; return { skill_path: "C:\\Users\\anton\\.claude\\skills\\kestral\\SKILL.md", script_path: "C:\\Users\\anton\\.claude\\skills\\kestral\\kestral.py", runtime: "python", message: "Skill installed." };
      case "uninstall_skill": skill = false; return "Skill removed.";
      case "skill_installed": return skill;
      case "data_warnings": return flags.has("warnings") ? ["hosts.json could not be read and was moved to hosts.json.corrupt"] : [];
      case "drag_icon_path": return "";
      // plugins
      case "plugin:clipboard-manager|write_text": clipboard.text = p.text ?? p.data ?? ""; return null;
      case "plugin:clipboard-manager|read_text": return clipboard.text;
      case "plugin:dialog|open": return p.options?.directory ? "C:\\Users\\anton\\Downloads" : "C:\\Users\\anton\\.ssh\\id_ed25519";
      case "plugin:dialog|save": return "C:\\Users\\anton\\Downloads\\" + (p.options?.defaultPath ?? "export.txt");
      case "plugin:updater|check": return null;
      case "plugin:window|is_maximized": return false;
      case "identity_list": return JSON.parse(JSON.stringify(identities));
      case "identity_add": {
        const name = String(p.identity.name ?? "").trim();
        if (!name) throw "Give the identity a name";
        if (identities.some((i) => i.name.toLowerCase() === name.toLowerCase())) throw `An identity named ${name} already exists`;
        const it = { id: uuid(), name, username: String(p.identity.username ?? "").trim(), auth: p.identity.auth };
        identities.push(it);
        return it;
      }
      case "identity_update": { const i = identities.findIndex((x) => x.id === p.identity.id); if (i < 0) throw "Not found"; identities[i] = p.identity; return null; }
      case "identity_remove": {
        const users = hosts.filter((h) => h.auth?.kind === "identity" && h.auth.identity_id === p.id).map((h) => h.name);
        if (users.length) throw `Still used by ${users.join(", ")}. Pick another sign-in method there first.`;
        identities = identities.filter((x) => x.id !== p.id);
        return null;
      }
      case "local_agent_identities": return { agent: "openssh", keys: [], error: null };
      case "forward_stats": return Object.fromEntries([...activeForwards].map((id, i) => [id, (i + 2) % 3]));
      case "hostkey_pending": return [];
      case "ssh_ping": return 12;
      default:
        return null;
    }
  }, { shouldMockEvents: true });
}

