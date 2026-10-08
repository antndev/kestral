import { invoke, Channel } from "@tauri-apps/api/core";

export type AiPolicy = "locked" | "confirm" | "free";
export type SecretKind = "password" | "private_key";

export type AuthMethod =
  | { kind: "password"; secret_id: string }
  | { kind: "key"; secret_id: string }
  | { kind: "agent" }
  | { kind: "identity"; identity_id: string };

export type ForwardKind = "local" | "remote" | "dynamic";

export interface EnvVar {
  name: string;
  value: string;
}

export interface HostOptions {
  keepalive_secs: number | null;
  connect_timeout_secs: number | null;
  terminal_theme: string;
  encoding: string;
  startup_command: string;
  env: EnvVar[];
}

export const DEFAULT_HOST_OPTIONS: HostOptions = {
  keepalive_secs: null,
  connect_timeout_secs: null,
  terminal_theme: "",
  encoding: "",
  startup_command: "",
  env: [],
};

export interface Identity {
  id: string;
  name: string;
  username: string;
  auth: Exclude<AuthMethod, { kind: "identity" }>;
}

export interface NewIdentity {
  name: string;
  username: string;
  auth: Exclude<AuthMethod, { kind: "identity" }>;
}

export interface PortForward {
  id: string;
  /** Human label shown in the Port forwarding table. Empty means "show listen port". */
  name: string;
  local_host: string;
  local_port: number;
  remote_host: string;
  remote_port: number;
  autostart: boolean;
  kind: ForwardKind;
  start_on_connect: boolean;
}

export interface Host {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  auth: AuthMethod;
  ai_policy: AiPolicy;
  ai_file_policy: AiPolicy;
  forward_agent: boolean;
  agent_keys: string[];
  forwards: PortForward[];
  /** Sidebar/card group name. Empty string means ungrouped. */
  group: string;
  tags: string[];
  jump_host_id: string | null;
  options: HostOptions;
}

export interface NewHost {
  name: string;
  hostname: string;
  port: number;
  username: string;
  auth: AuthMethod;
  ai_policy: AiPolicy;
  ai_file_policy: AiPolicy;
  forward_agent: boolean;
  agent_keys: string[];
  forwards: PortForward[];
  group: string;
  tags: string[];
  jump_host_id: string | null;
  options: HostOptions;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  mtime: number | null;
  permissions: number | null;
  hidden: boolean;
}

export interface AiStatus {
  active: boolean;
  expires_at: string | null;
  default_minutes: number;
}

export interface AiCaps {
  list_hosts: boolean;
  manage_hosts: boolean;
  list_snippets: boolean;
  manage_snippets: boolean;
  list_secrets: boolean;
  audit_log: boolean;
}

export interface McpInfo {
  url: string;
  token: string;
  running: boolean;
}

export interface SecretMeta {
  id: string;
  kind: SecretKind;
  created_at: string | null;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  host_id: string;
  host_name: string;
  command: string;
  decision: string;
  exit_status: number | null;
  success: boolean;
  detail: string | null;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
  exit_status: number | null;
}

export interface ApprovalRequest {
  id: string;
  host_id: string;
  host_name: string;
  command: string;
}

export const vaultExists = () => invoke<boolean>("vault_exists");
export const vaultStatus = () => invoke<boolean>("vault_status");
export const vaultCreate = (master: string) => invoke<void>("vault_create", { master });
export const vaultUnlock = (master: string) => invoke<void>("vault_unlock", { master });
export interface HelloStatus {
  supported: boolean;
  enabled: boolean;
  method: string;
}
export const helloStatus = () => invoke<HelloStatus>("hello_status");
export const helloEnable = () => invoke<void>("hello_enable");
export const helloDisable = () => invoke<void>("hello_disable");
export const helloUnlock = () => invoke<void>("hello_unlock");
export const vaultLock = () => invoke<void>("vault_lock");
export const vaultChangeMaster = (current: string, next: string) =>
  invoke<void>("vault_change_master", { current, new: next });

export interface ImportReport {
  hosts_added: number;
  hosts_skipped: number;
  secrets_added: number;
  secrets_skipped: number;
  snippets_added: number;
  snippets_skipped: number;
  identities_added: number;
  identities_skipped: number;
}
export const vaultExport = (path: string, password: string) =>
  invoke<void>("vault_export", { path, password });
export const vaultImport = (path: string, password: string) =>
  invoke<ImportReport>("vault_import", { path, password });

export interface AppSettings {
  minimizeToTray: boolean;
  onboarded: boolean;
}
export const settingsGet = () => invoke<AppSettings>("settings_get");
export const settingsSetMinimizeToTray = (enabled: boolean) =>
  invoke<void>("settings_set_minimize_to_tray", { enabled });
export const settingsSetOnboarded = () => invoke<void>("settings_set_onboarded");

export const secretPut = (id: string, kind: SecretKind, value: string) =>
  invoke<void>("secret_put", { id, kind, value });
export const secretList = () => invoke<SecretMeta[]>("secret_list");
export const secretDelete = (id: string) => invoke<void>("secret_delete", { id });
export const secretCopy = (from: string, to: string) => invoke<void>("secret_copy", { from, to });
export const secretReveal = (id: string) => invoke<string>("secret_reveal", { id });
export type KeyAlgorithm = "ed25519" | "ecdsa-p256" | "ecdsa-p384" | "ecdsa-p521" | "rsa-3072" | "rsa-4096" | "ecdsa" | "rsa";
export const generateKey = (algorithm: KeyAlgorithm, comment?: string) =>
  invoke<string>("generate_key", { algorithm, comment });

export interface PubkeyInfo {
  public_key: string;
  fingerprint: string;
  algorithm: string;
  bits: number | null;
  encrypted: boolean;
}
export const derivePubkey = (privateKey: string, passphrase?: string) =>
  invoke<PubkeyInfo>("derive_pubkey", { privateKey, passphrase });
export const decryptKey = (privateKey: string, passphrase: string) =>
  invoke<string>("decrypt_key", { privateKey, passphrase });
export const keySetComment = (id: string, comment: string) => invoke<void>("key_set_comment", { id, comment });
export const exportPrivateKey = (id: string, path: string, passphrase?: string) =>
  invoke<void>("export_private_key", { id, path, passphrase });
export const isPassphraseError = (e: unknown) => /passphrase/i.test(String((e as { message?: string })?.message ?? e));

export const identityList = () => invoke<Identity[]>("identity_list");
export const identityAdd = (identity: NewIdentity) => invoke<Identity>("identity_add", { identity });
export const identityUpdate = (identity: Identity) => invoke<void>("identity_update", { identity });
export const identityRemove = (id: string) => invoke<void>("identity_remove", { id });

export interface AgentKeyInfo {
  comment: string;
  algorithm: string;
  bits: number | null;
  fingerprint: string;
  public_key: string;
}
export interface LocalAgentInfo {
  agent: "openssh" | "pageant" | "unix" | null;
  keys: AgentKeyInfo[];
  error: string | null;
}
export const localAgentIdentities = () => invoke<LocalAgentInfo>("local_agent_identities");

export interface HostTestResult {
  ok: boolean;
  message: string;
  auth: string;
  elapsed_ms: number;
}
export const hostTest = (host: Host, password?: string) => invoke<HostTestResult>("host_test", { host, password });

export const hostList = () => invoke<Host[]>("host_list");
export const hostAdd = (host: NewHost) => invoke<Host>("host_add", { host });
export const hostUpdate = (host: Host) => invoke<void>("host_update", { host });
export const hostRemove = (id: string) => invoke<void>("host_remove", { id });
export const hostSetPolicy = (id: string, policy: AiPolicy) =>
  invoke<void>("host_set_policy", { id, policy });
export const hostSetFilePolicy = (id: string, policy: AiPolicy) =>
  invoke<void>("host_set_file_policy", { id, policy });

export const forwardStart = (hostId: string, forwardId: string) =>
  invoke<void>("forward_start", { hostId, forwardId });
export const forwardStop = (hostId: string, forwardId: string) =>
  invoke<void>("forward_stop", { hostId, forwardId });
export const forwardActive = () => invoke<string[]>("forward_active");
export const forwardStats = () => invoke<Record<string, number>>("forward_stats");
export interface ForwardFailed {
  host: string;
  name: string;
  error: string;
}

export const sftpOpen = (id: string, hostId: string) =>
  invoke<string>("sftp_open", { id, hostId });
export const sftpList = (id: string, path: string) =>
  invoke<FileEntry[]>("sftp_list", { id, path });
export const sftpDownload = (id: string, remote: string, local: string) =>
  invoke<number>("sftp_download", { id, remote, local });
export const sftpDownloadDir = (id: string, remote: string, local: string) =>
  invoke<number>("sftp_download_dir", { id, remote, local });
export const sftpUpload = (id: string, local: string, remote: string) =>
  invoke<number>("sftp_upload", { id, local, remote });
export const sftpUploadDir = (id: string, local: string, remote: string) =>
  invoke<number>("sftp_upload_dir", { id, local, remote });
export const sftpReadText = (id: string, path: string) =>
  invoke<string>("sftp_read_text", { id, path });
export const sftpWriteText = (id: string, path: string, content: string) =>
  invoke<void>("sftp_write_text", { id, path, content });
export const sftpMkdir = (id: string, path: string) =>
  invoke<void>("sftp_mkdir", { id, path });
export const sftpRemove = (id: string, path: string, isDir: boolean) =>
  invoke<void>("sftp_remove", { id, path, isDir });
export const sftpRename = (id: string, from: string, to: string) =>
  invoke<void>("sftp_rename", { id, from, to });
export const sftpClose = (id: string) => invoke<void>("sftp_close", { id });
export interface TransferProgress {
  done: number;
  total: number | null;
}
export const sftpTransfer = (
  id: string,
  transferId: string,
  upload: boolean,
  isDir: boolean,
  local: string,
  remote: string,
  onProgress: Channel<TransferProgress>,
) => invoke<number>("sftp_transfer", { id, transferId, upload, isDir, local, remote, onProgress });
export const sftpCopyRemote = (
  srcId: string,
  dstId: string,
  transferId: string,
  srcPath: string,
  dstPath: string,
  isDir: boolean,
  onProgress: Channel<TransferProgress>,
) => invoke<number>("sftp_copy_remote", { srcId, dstId, transferId, srcPath, dstPath, isDir, onProgress });
export const sftpCancel = (transferId: string) => invoke<void>("sftp_cancel", { transferId });

export const sshWriteBytes = (id: string, data: number[]) => invoke<void>("ssh_write_bytes", { id, data });
export const sshPing = (id: string) => invoke<number | null>("ssh_ping", { id });

export interface Snippet {
  id: string;
  label: string;
  script: string;
  target_host_ids: string[];
  /** Folder name for grouping in the list. Empty string means no folder. */
  folder: string;
  vars: Record<string, SnippetVar>;
  parallel: boolean;
  open_tabs: boolean;
}
export interface SnippetVar {
  value: string;
  ask: boolean;
}
export interface NewSnippet {
  label: string;
  script: string;
  target_host_ids: string[];
  folder: string;
  vars: Record<string, SnippetVar>;
  parallel: boolean;
  open_tabs: boolean;
}
export const snippetList = () => invoke<Snippet[]>("snippet_list");
export const snippetAdd = (snippet: NewSnippet) => invoke<Snippet>("snippet_add", { snippet });
export const snippetUpdate = (snippet: Snippet) => invoke<void>("snippet_update", { snippet });
export const snippetDelete = (id: string) => invoke<void>("snippet_delete", { id });
export const snippetFolderList = () => invoke<string[]>("snippet_folder_list");
export const snippetFolderAdd = (name: string) => invoke<string>("snippet_folder_add", { name });
export const snippetFolderRename = (from: string, to: string) => invoke<string>("snippet_folder_rename", { from, to });
export const snippetFolderRemove = (name: string) => invoke<number>("snippet_folder_remove", { name });
export const snippetFolderReorder = (order: string[]) => invoke<void>("snippet_folder_reorder", { order });

export const aiStatus = () => invoke<AiStatus>("ai_status");
export const aiEnable = (minutes?: number) => invoke<void>("ai_enable", { minutes });
export const aiDisable = () => invoke<void>("ai_disable");
export const aiCaps = () => invoke<AiCaps>("ai_caps");
export const aiSetCaps = (caps: AiCaps) => invoke<void>("ai_set_caps", { caps });
export const aiProtectedList = () => invoke<string[]>("ai_protected_list");
export const aiSetProtected = (paths: string[]) => invoke<void>("ai_set_protected", { paths });

export const approvalRespond = (id: string, approved: boolean) =>
  invoke<void>("approval_respond", { id, approved });

export const auditList = () => invoke<AuditEntry[]>("audit_list");
export const auditSince = (after: string | null, limit?: number) => invoke<{ full: boolean; entries: AuditEntry[] }>("audit_since", { after, limit });
export const auditUserCommand = (hostId: string, command: string) =>
  invoke<void>("audit_user_command", { hostId, command });

export const appChangelog = () => invoke<string>("app_changelog");
export const mcpInfo = () => invoke<McpInfo>("mcp_info");
export const dataWarnings = () => invoke<string[]>("data_warnings");
export interface RotateResult {
  info: McpInfo;
  reconnected: boolean;
  message: string;
}
export const mcpRotateToken = (name: string) =>
  invoke<RotateResult>("mcp_rotate_token", { name });
export interface ConnectResult {
  ok: boolean;
  message: string;
}
export const mcpConnectClaudeCode = (name: string) =>
  invoke<ConnectResult>("mcp_connect_claude_code", { name });

export interface InstallResult {
  skill_path: string;
  script_path: string;
  runtime: string;
  message: string;
}
export const installSkill = () => invoke<InstallResult>("install_skill");
export const uninstallSkill = () => invoke<string>("uninstall_skill");
export const skillInstalled = () => invoke<boolean>("skill_installed");

export interface Registration {
  name: string;
  url: string;
  connected: boolean;
  is_this_app: boolean;
}
export const mcpListRegistrations = () => invoke<Registration[]>("mcp_list_registrations");
export const mcpRemoveRegistration = (name: string) =>
  invoke<string>("mcp_remove_registration", { name });

// ---- Known hosts (~/.ssh/known_hosts) ----
export interface KnownHostEntry {
  /** 1-based line number in known_hosts; stable id for removal. */
  line: number;
  /** Raw host field as written (may be a comma list or a |1| hash). */
  hosts: string;
  /** First host name, unbracketed. Empty when the entry is hashed. */
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  hashed: boolean;
  /** When the key was added to the vault, RFC 3339. */
  added: string | null;
}
export const knownHostsList = () => invoke<KnownHostEntry[]>("known_hosts_list");
/**
 * Removes the given known_hosts lines. Pass the listed entries as `expected` so a
 * stale list fails with an error instead of deleting a different key. Returns the
 * number of removed lines.
 */
export const knownHostsRemove = (
  lines: number[],
  expected?: Pick<KnownHostEntry, "line" | "hosts" | "fingerprint">[],
) => invoke<number>("known_hosts_remove", { lines, expected });
/**
 * Removes every entry for host:port, including hashed and comma-list lines.
 * Rejects an empty host; remove hashed rows by line instead. Returns the count.
 */
export const knownHostsForget = (host: string, port: number) =>
  invoke<number>("known_hosts_forget", { host, port });
/**
 * Appends host entries from another known_hosts file, skipping duplicates and
 * @cert-authority/@revoked lines. Returns how many rows were added.
 */
export const knownHostsImport = (path: string) => invoke<number>("known_hosts_import", { path });
export const knownHostsExport = (path: string) => invoke<number>("known_hosts_export", { path });

export function addedLabel(at: string | null | undefined): string {
  if (!at) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Payload of the "hostkey-request" event: first contact with an unknown host. */
export interface HostKeyRequest {
  id: string;
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
}
/** Answer a "hostkey-request". accept=false refuses; save=false trusts only for this connection. */
export const hostkeyRespond = (id: string, accept: boolean, save: boolean) =>
  invoke<void>("hostkey_respond", { id, accept, save });
export const hostkeyPending = () => invoke<HostKeyRequest[]>("hostkey_pending");
export interface HostKeySaveFailed {
  host: string;
  port: number;
  error: string;
}
/** Payload of the "hostkey-changed" event: a known host presented a different key. */
export interface HostKeyChanged {
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  /** known_hosts entries that recorded a different key for this host (covers hashed and comma-list lines). */
  saved: KnownHostEntry[];
}
/** Event "hostkey-expired": payload is the request id; the 120 s answer window closed. */

// ---- Local filesystem (for the two-pane SFTP view and file imports) ----
export const localHome = () => invoke<string>("local_home");
export const dataDir = () => invoke<string>("data_dir");
export const localList = (path: string) => invoke<FileEntry[]>("local_list", { path });
export const localMkdir = (path: string) => invoke<void>("local_mkdir", { path });
export const localRemove = (path: string, isDir: boolean) =>
  invoke<void>("local_remove", { path, isDir });
export const localRename = (from: string, to: string) => invoke<void>("local_rename", { from, to });
/** Reads a UTF-8 text file up to 1 MiB. */
export const localReadText = (path: string) => invoke<string>("local_read_text", { path });
export const localWriteText = (path: string, content: string) =>
  invoke<void>("local_write_text", { path, content });

// ---- ~/.ssh/config import ----
export interface SshConfigHost {
  alias: string;
  hostname: string;
  port: number;
  user: string;
  identity_file: string | null;
  proxy_jump: string | null;
}
export const sshConfigHosts = () => invoke<SshConfigHost[]>("ssh_config_hosts");

export const runCommandUi = (hostId: string, command: string, pty = false) =>
  invoke<CommandOutput>("run_command_ui", { hostId, command, pty });

export interface StreamExit {
  exit_status: number | null;
  exit_signal: string | null;
}
export const runCommandStream = (
  hostId: string,
  command: string,
  onOutput: Channel<ArrayBuffer>,
) => invoke<StreamExit>("run_command_stream", { hostId, command, onOutput });
