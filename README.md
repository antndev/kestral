# Kestral

Self-hosted SSH client with a built-in MCP server, so an AI can work on your servers
under your control. The AI never sees a private key or password. It asks Kestral to run
a command, to list, upload or download files over SFTP, or to create and change hosts,
snippets and port forwards. You decide per host what needs your approval, and each kind
of change has its own switch in AI access.

## What it does

- SSH client with a real terminal (xterm), multiple sessions per host, SFTP, port
  forwarding and known-hosts TOFU.
- Encrypted vault for hosts, keys, passwords, identities, snippets, collections, known
  hosts and port forwards. Master password via Argon2id, payload via XChaCha20-Poly1305,
  optional Windows Hello unlock. You can reveal a stored secret in the app, but secrets
  never reach the AI.
- Built-in MCP server (loopback, bearer token) for an AI client like Claude Code, with
  `list_hosts`, `run_command`, `get_audit_log`, `list_snippets`, `list_secrets`,
  `create_host`, `update_host`, `create_snippet`, `update_snippet`, `delete_snippet`,
  `create_port_forward`, `update_port_forward`, `sftp_list`, `sftp_download` and
  `sftp_upload`. Kestral can also install a Claude Code skill that talks to the same
  server.
- AI access is off by default and turns itself off after the time you pick, or stays on
  with No limit. Every host has separate policies for commands and for files: Blocked
  (the AI cannot touch it), Ask (every action needs your approval) or Free. Listing hosts,
  snippets and credentials, reading the audit log, and changing hosts, snippets and port
  forwards each have their own switch.
- Changes made by the AI wait for you. A host the AI created or pointed somewhere else
  needs Confirm host before any connection, a snippet it changed needs a review before it
  runs, and a port forward it created or changed only starts after you review it. When
  the AI changes a host's target, its port forwards stay but need a review again.
- Full audit log separating your own commands from AI activity.

## Install

Grab the latest build from the [Releases page](https://github.com/antndev/kestral/releases/latest).

**Windows.** Download the `.exe` installer and run it.

**macOS (Apple Silicon).** Download the `.dmg`, open it, and drag Kestral into your
Applications folder. The build is not signed with a paid Apple Developer certificate, so
the first launch needs one manual approval:

1. Right-click Kestral in Applications and choose **Open**, then confirm **Open** in the
   dialog.
2. If macOS instead says the app "is damaged", it is not damaged, that is just Gatekeeper
   blocking the unsigned download. Clear the quarantine flag once in Terminal:
   ```sh
   xattr -cr /Applications/Kestral.app
   ```
   Then open it normally.

Either step is only needed once per downloaded version. Clearing the quarantine flag
targets just this app and leaves Gatekeeper otherwise untouched.

Updates come from signed GitHub releases. Kestral checks for them and offers them in
Settings > About.

## Stack

- Tauri v2 (Rust core, system WebView UI: WebView2 on Windows, WKWebView on macOS)
- russh (ring backend) for SSH
- rmcp + axum for the MCP server
- React 19 + Vite, styled inline with the design tokens in `src/tokens.css` (Tailwind v4
  only for the base reset), xterm.js with the WebGL renderer for terminals

## Development

```powershell
npm install
npm run tauri dev
```

Frontend-only build check:

```powershell
npm run build
```

`npm run dev` serves the UI alone in a browser with a mock backend (master password
`test`).

## Layout

- `src/` React UI (`main.tsx` loads `RealApp.tsx`, screens and dialogs under `ui/`,
  terminal in `SshTerminal.tsx`)
- `src-tauri/src/` Rust core (`ssh.rs`, `vault.rs`, `mcp.rs`, `policy.rs`, `audit.rs`,
  `sftp.rs`, `forward.rs`, ...)

## Security

- **Key hierarchy.** Master password to key-encryption key (KEK) via Argon2id
  (v19, m=64 MiB, t=2, p=1, 32-byte key, 16-byte random salt per vault). The KEK
  encrypts the whole vault as one XChaCha20-Poly1305 blob with the header as
  authenticated data. Inside sits a random 32-byte data key (DEK) that encrypts the
  audit log. A password change re-derives only the KEK, so the audit log does not have
  to be rewritten. Opening a vault written with weaker parameters transparently
  re-derives it at current strength. Windows Hello unlock, if you turn it on, wraps the
  KEK with a key derived from a Hello signature.
- **MCP server.** Loopback only (`127.0.0.1:4517`), bearer token (192 bits, constant
  time compare), Host and Origin both validated. No CORS layer, so no browser origin
  is ever granted access.
- **AI is gated.** Off by default. Each host has separate command and file policies
  (Blocked, Ask, Free). When the AI changes a host's address, port, user or sign-in,
  its AI policies go back to Blocked, also for hosts that connect through it, and agent
  forwarding is turned off; your own edits keep the policy. AI file transfer can name any
  local path (absolute or `~/`-relative, no network shares); a protected path on either
  the local or remote side is refused and trips the kill switch.
- **Host keys.** Trust-on-first-use with the SHA256 fingerprint logged; a changed key
  is refused with a distinct error. Entries live in the app's own store, encrypted in
  the vault; an unreadable store blocks every connection.

See [SECURITY.md](SECURITY.md) for the threat model and how to report issues.

## License

Kestral is source-available, not open source. It is free for personal and other
noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE): private
use, homelab, hobby projects, study, and use by nonprofits, schools and government
bodies. Any commercial use, including internal use inside a for-profit company,
requires a separate commercial license.

Commercial licensing: write to antonkonig691@gmail.com. Copyright 2026 Anton.
