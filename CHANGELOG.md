# Changelog

All notable changes to Kestral are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com) and semantic versioning.

## 0.2.9 - 2026-10-10

### Changed
- Buttons on the right of a screen header line up with the window chrome: the close button on Windows, the lock on macOS.

## 0.2.8 - 2026-10-10

### Changed
- The update dialog shows what is new in the version, taken from this changelog, and stays compact when there is nothing to show.

## 0.2.7 - 2026-10-10

### Security
- A host the AI created or redirected is marked and asks for confirmation (address and sign-in shown) before you connect; until then every connection to it, also over a jump host, is refused.
- The AI can no longer bind a secret of the wrong kind to a host; a private key is never sent as a password.
- The data folder guard can no longer be bypassed with UNC or device paths, and AI tools stop at once while the vault is locked.
- Protected paths also catch Windows forms like a trailing dot, alternate streams and 8.3 short names.
- A retried AI command checks the policy again first, and a jump host change locks its dependents in the same step.
- Repeated denied AI calls no longer flood the audit log.
- Imported snippets need a review before they run and only target imported hosts; an import cannot add a second key for a known host.
- Snippets keep their AI review mark until you review or edit them; the review dialog shows the targets, focuses Cancel and arms after a moment.
- Pasting with Shift+Insert or the macOS Edit menu is filtered too; terminal links open only with Ctrl or Cmd and only for http(s).
- Hidden characters are marked in approvals, logs and SFTP file names; long commands must be scrolled to the end before Approve.
- Approval and host key dialogs re-arm when the window loses focus.
- Release builds no longer see the signing key; signatures are verified before a release goes live.

### Fixed
- A failed master password change can no longer leave the vault encrypted with the new password.
- Unreadable host or snippet data is never overwritten by the next save.
- Stop also works while a snippet run is still connecting, and locking stops running snippet runs.
- Closing a terminal no longer hangs after a huge paste.
- Interrupted SFTP uploads, copies, downloads and editor saves never destroy the original file.
- Port forwards survive fast start, stop and start, and one slow client no longer stalls the others.
- The connection test no longer stores the typed password, and exporting no longer clobbers a file next to the target.
- Locking asks about an unsaved host and saves pending snippet edits; Close other tabs asks once for all unsaved tabs.
- Forwards autostart after a retried load, the update progress survives leaving Settings, and a few drag and timer leaks are gone.

## 0.2.6 - 2026-10-08

### Fixed
- macOS: the traffic lights are now exactly on the title bar centre line (0.2.4 put them a point too low).

## 0.2.4 - 2026-10-08

### Fixed
- macOS: the traffic lights sit on the same centre line as the rest of the title bar.

## 0.2.3 - 2026-10-08

### Fixed
- The Windows taskbar shows the current app icon. Kestral now sets the large window icon itself, so Windows no longer falls back to an old cached one.
- Check for updates shows Checking for at least half a second instead of flickering.

## 0.2.2 - 2026-10-08

### Changed
- Stop really stops a snippet run: running commands end and waiting hosts are skipped. Clear only clears the output of a finished run.
- Snippets: Duplicate in the more menu, a shorter Paste to terminal button, and no second run button in the list.
- The new tab palette offers SFTP for every host (Shift+Enter).
- Everything in the title bar shares one centre line, and the tab close and new tab buttons use the very same cross.
- Dragging a host onto the tab strip no longer opens a tab; use the palette or Move to new tab instead.
- Releases build Windows and macOS in parallel with a shared cache.

## 0.2.1 - 2026-10-08

### Security
- Imported known hosts can no longer contain wildcard patterns, and an exact host key always wins over a wildcard entry, so one line cannot vouch for every server.
- Replacing a changed host key no longer removes wildcard lines that cover other hosts.
- Host names and user names are checked: no spaces, commas, wildcards or shell characters.
- When the AI changes the address or sign-in of a jump host, AI access is locked for every host that connects through it too.
- Importing a vault export never carries over AI permissions, agent forwarding or autostarting forwards, never binds an imported host to one of your own credentials or identities, and drops jump hosts that were not part of the import.
- The approval dialog shows every line of a command with line numbers, marks hidden characters, shows user@host:port, names uploads and downloads, and keeps Approve disabled for a moment after each new request.
- Snippets the AI created or changed are marked and show a full preview before they run or get pasted.
- Pasting into the terminal strips escape and control characters.
- Exported private keys are created readable only by you, even when they replace an existing file.

### Fixed
- A server can no longer flood memory while Kestral detects its shell.

## 0.2.0 - 2026-10-08

### Changed
- New look: the sidebar on the left, Chrome style tabs on top and the content below, split by two full length lines. Tabs can be dragged to reorder, the terminal starts right under the tabs, and address, state and latency live in the status bar.
- SFTP opens as its own tab, and Settings sits at the bottom of the sidebar.
- Hosts, snippets, port forwarding and keys show a calm read only view first. Edit switches the same pane into a form, no more popups.
- The start mode of a port forward (manually, when Kestral opens, when the host connects) can be changed right in the rule view.
- Calmer lock screen with the original dot background. Windows Hello can prompt automatically.
- AI commands reuse one SSH connection per host instead of reconnecting every time.
- Faster unlock and faster log loading.
- New app icon.

### Security
- If the AI changes how a host signs in, AI access to that host is locked again, just like a change of address.
- authorized_keys2 and the Windows administrators_authorized_keys file are protected paths too. Existing lists get them once.
- SFTP refuses remote file names that would escape the target folder.
- Release builds pin every workflow action to a fixed commit.

### Fixed
- A timed out AI command is stopped on the server instead of running on.
- Audit entries recorded while the vault is locked are kept and written after the next unlock, and the log can no longer be emptied by accident.
- Locking cancels running SFTP transfers.
- Port forwards whose connection dropped no longer show as running.
- SFTP tabs no longer freeze and ignore clicks.
- Several leaks and stale states in SFTP, logs, the host editor and tab dragging.

## 0.1.55 - 2026-09-02

### Changed
- AI file transfers can use any local path. Protected paths still stop AI access when a transfer touches one, locally or on the server.

## 0.1.54 - 2026-08-30

### Fixed
- Collapsing a script log no longer crashes the view.

## 0.1.53 - 2026-08-30

### Changed
- Back to the original neutral palette.

## 0.1.52 - 2026-08-25

### Changed
- Lighter, neutral background for the main window and the login screen.

## 0.1.51 - 2026-08-25

### Changed
- A near-neutral palette replaces the blue tint.

## 0.1.50 - 2026-08-25

### Changed
- Cooler palette and a calmer animation-speed control.

## 0.1.49 - 2026-08-22

### Added
- Vault export and import as an encrypted file with its own password. Import merges into the current vault.

### Changed
- The Claude Code skill is the single way for an AI to use Kestral.

## 0.1.48 - 2026-08-22

### Fixed
- The macOS build is ad-hoc signed, so it opens with right-click Open.

## 0.1.47 - 2026-08-21

### Added
- A macOS (Apple Silicon) build alongside Windows.

## 0.1.46 - 2026-08-19

### Changed
- The loading window matches the system light or dark theme.

## 0.1.45 - 2026-08-19

### Fixed
- The tray shows the new AI access state as soon as it is toggled.

## 0.1.44 - 2026-08-19

### Changed
- Shorter tray menu labels, with the AI status line on top.

## 0.1.43 - 2026-08-19

### Added
- The tray menu shows whether AI access is on.

## 0.1.42 - 2026-08-19

### Changed
- AI file operations follow the host's file policy. Free no longer asks for approval.

## 0.1.41 - 2026-08-19

### Added
- Closing the window can keep Kestral running in the tray, so tunnels and AI access stay up. You choose once, and can change it in Settings.

## 0.1.40 - 2026-08-19

### Fixed
- No more crash when a terminal reconnects or a terminal tab closes.

## 0.1.39 - 2026-08-14

### Fixed
- The terminal is sharp again. A dependency change had removed the WebGL renderer and moved xterm to a version without a stable one, so the terminal had fallen back to the blurry software renderer. Pinned back to the known-good xterm + WebGL stack, in both the interactive terminal and the script output.

## 0.1.38 - 2026-08-12

### Changed
- If an in-app update ever fails to download, the update dialog and the Settings panel now offer "Get it from GitHub", which opens the release page in your browser, plus "Try again", so you are never stuck. The error message and dialog layout are tidied up.

## 0.1.37 - 2026-08-12

### Fixed
- The "Update ready" dot in the sidebar no longer blinks far too fast when the animation-speed setting is turned up; it is now excluded from that scaling like the terminal cursor.

## 0.1.36 - 2026-08-12

### Changed
- The updater now retries a failed download a few times with a short backoff. GitHub's release CDN and some antivirus scanners drop the connection intermittently ("error sending request"), and a retry usually gets through.

## 0.1.35 - 2026-08-12

### Changed
- Update errors are now shown as short, friendly messages instead of the raw request error and URL. A failed download can be retried in place with a "Try again" button, and common causes (no connection, blocked by antivirus, not published yet) are named.

## 0.1.34 - 2026-08-12

### Changed
- Streamed script runs are bounded like one-shot commands now: a run times out after 30 minutes and the kept output is capped, so a stray runaway command such as `yes` cannot stream forever or exhaust memory.

## 0.1.33 - 2026-08-12

Security hardening pass from a full whole-app audit.

### Security
- Host-key verification: a known host that presents a key of a different algorithm is now refused as a suspected man-in-the-middle / downgrade, instead of being silently trusted on first use.
- AI SFTP uploads from outside the AI transfer directory now require explicit approval that shows the real local path, even on Free hosts, so the AI cannot silently read an arbitrary local file (such as a private key) and send it out.
- The command kill switch normalises paths like the SFTP guard, so `.ssh//authorized_keys` or `.ssh/./authorized_keys` variants can no longer slip a protected path past it, and listing a protected directory is now blocked too.
- What the AI may list is now saved to disk, so narrowing it is no longer silently reverted to the permissive defaults on restart.
- Command output (16 MB) and SFTP downloads (2 GiB) are capped and commands time out after 5 minutes, so a runaway or hostile command cannot exhaust memory and crash the app.
- Batch downloads use only the server file's base name, so a hostile server filename cannot write outside the chosen folder.
- Command auditing in the terminal suppresses a much broader set of secret prompts (tokens, OTP/2FA, keys, PINs), erring toward not logging.
- On Windows the data directory (vault, audit log, MCP token) is locked to the current user.
- The audit log's disk writes are serialised so an entry cannot be lost during compaction.

## 0.1.32 - 2026-08-12

### Fixed
- Running `clear` (or Ctrl+L) now drops the scrollback too, so you can no longer scroll back to the output from before the clear. Full-screen apps like vim or less are left alone.
- The terminal no longer occasionally drops characters or garbles the prompt. It uses the reliable renderer again and no longer resizes the remote terminal to a tiny size while its tab is hidden.
- When a session disconnects, the overlay now sits above the terminal, so the Reconnect button is clickable and the terminal can no longer be scrolled behind it.

## 0.1.31 - 2026-08-11

### Changed
- Script output is a live terminal now: it streams as the command runs, not only when it finishes, and looks exactly like a normal session (same font, colours and GPU rendering). Each host's log expands on click with a chevron instead of on hover.
- The AI can upload from any local file, not only from the AI transfer directory. Downloads still land in that directory, and uploads remain gated by the per-host file policy and audited.

## 0.1.30 - 2026-08-09

Hardening pass from a full code review.

### Fixed
- Security: the protected-paths guard now canonicalises paths the way the SSH server does, so variants like `.ssh//authorized_keys` or `.ssh/./authorized_keys` no longer slip past it. Protected paths are off-limits to the AI for reads (SFTP download) as well as writes. Repointing a host to a new address now also clears its agent-forwarding config, so the AI cannot redirect the vault keys to another server.
- AI access time limits are stored as an absolute expiry, so restarting the app no longer resets the countdown or silently re-enables access after the window has elapsed.
- Port forwards free their local port and stop tracking when their SSH session dies (a host reboot), and are stopped when their host is deleted, instead of leaking.
- Autostart forwards start once per unlocked session, not every time you revisit the Hosts view, so a tunnel you stopped by hand stays stopped.
- The host grid no longer renders empty gutter columns when you have only a few hosts.
- Keyboard access: hover-only controls now also reveal on focus, and the "AI access stopped" dialog is a proper alert dialog with focus, Escape and a screen-reader role.
- The on-disk audit log is trimmed during long sessions, not only at startup. RSA keys are refused by the vault agent, which cannot sign them correctly, instead of failing silently.

## 0.1.29 - 2026-08-09

### Fixed
- The AI duration selector laid out its options so a wider label like "No limit" overflowed its slot, which meant clicking it could land on the neighbouring option (so "No limit" ended up as 4h) and the highlight looked off. Options now size to their labels, so the click, the selection and the highlight all match, and "No limit" really turns off the time limit.

## 0.1.28 - 2026-08-09

### Changed
- Host cards now flow in independent columns. Expanding a card's tunnels on hover pushes down only the cards below it in the same column, not the whole row, so the neighbours no longer show gaps.
- Script output stays put when you switch to another section and come back.
- In script output, each host's log opens on hover so a run across many hosts stays compact, and the log now looks like the normal terminal.

## 0.1.27 - 2026-08-08

### Fixed
- Hovering a host card that has port forwards no longer stretches its grid row, so the other cards in that row no longer show empty gaps. The tunnel controls float in as an overlay attached below the card instead.

## 0.1.26 - 2026-08-08

### Fixed
- The segmented selectors (like the AI duration) now line up their highlight with the selected option even when options have different widths, so "No limit" no longer leaves the highlight hanging over its neighbour.

## 0.1.25 - 2026-08-08

### Changed
- The whole port-forward row on a host card now slides in only when you hover the card, so cards stay clean at rest.

## 0.1.24 - 2026-08-08

### Added
- AI access can stay on with no automatic time limit. Pick "No limit" as the duration and it stays on until you turn it off.

### Changed
- The keychain shows keys and passwords in separate, clearly labelled sections.
- The script editor is a proper multi-line field instead of a single line.
- Run several scripts at once: each run gets its own output panel and they run side by side.
- Crisper terminal text via GPU rendering where available, with proper line spacing so the bottom row is no longer clipped. Command output uses the same spacing.
- Port-forward start and stop buttons on a host card now appear on hover, keeping the card tidy.

### Fixed
- Reconnecting a terminal after a drop or a reboot is cleaner, with a clear "Connection lost" notice and a refit once it is back.

## 0.1.23 - 2026-08-04

### Added
- Protected paths: files the AI may never change, with `~/.ssh/authorized_keys` and the SSH client config protected by default. If the AI tries to write one over SFTP, or runs a command that names one, AI access is switched off immediately and you have to turn it back on yourself, so it cannot look for another way in. The list is editable in Settings under the AI section, matched by trailing path so a single entry covers every home directory.

## 0.1.22 - 2026-08-04

### Fixed
- No white flash on startup anymore. The window paints the dark theme background before the app finishes loading.

### Changed
- Faster startup: the terminal engine loads on demand when a session or command output is first shown, rather than at launch. That cuts the initial load by about a third.

## 0.1.21 - 2026-07-29

### Fixed
- Starting or stopping a port forward no longer changes the host card's size. The open-in-browser button keeps its space when the tunnel is off, and the start/stop button has a fixed width.

## 0.1.20 - 2026-07-29

### Changed
- Clearer error when a port forward's local bind address does not belong to this machine. Instead of a raw OS error, it explains that the left side is where Kestral listens here (use 127.0.0.1 or 0.0.0.0) and the remote target belongs on the right side.

## 0.1.19 - 2026-07-28

### Changed
- Faster release builds (build configuration only), no change in behaviour: the desktop build no longer produces the unused mobile library outputs, and CI caches npm.

## 0.1.18 - 2026-07-28

### Changed
- Internal code cleanup, no change in behaviour.

## 0.1.17 - 2026-07-28

### Fixed
- A port forward bound to "localhost" no longer shows the "reachable from your network" warning. localhost and ::1 count as loopback, just like 127.0.0.1, so the tunnel stays on this machine.

## 0.1.16 - 2026-07-28

### Added
- Port forwards can bind to a chosen local address, not just loopback. Leave it at 127.0.0.1 to keep a tunnel on this machine, or set 0.0.0.0 or a LAN address so other devices on your network can reach it, for example to tunnel a remote service and open it from your phone. A warning shows when a forward is exposed beyond this machine.

## 0.1.15 - 2026-07-28

### Fixed
- Starting a port forward no longer trips over "address already in use" when autostart and a manual start race, or when a tunnel is stopped and immediately started again. Stopping now waits until the local port is actually released, starting reserves the slot so it cannot run twice, and if another program really holds the port the message says so plainly.

## 0.1.14 - 2026-07-28

### Fixed
- Host cards no longer stretch to match the tallest card in their row, so a card with port forwards no longer leaves empty space at the bottom of its neighbours.

## 0.1.13 - 2026-07-28

### Added
- Local port forwarding per host, like `ssh -L`. Configure forwards on a host (local port to a remote host and port, usually localhost) and start or stop each one from the host card, with a live status dot and a one-click open in the browser. Reach a service that only listens locally on the remote, for example a web UI on 127.0.0.1. Listens on the loopback interface only, and optional autostart brings a tunnel up after unlock.

### Changed
- Agent forwarding now signs from the vault instead of your operating system's SSH agent. Pick which vault keys a host may use; Kestral answers the remote's sign requests itself, so the private key never reaches the host, and every signature is written to the audit log. The AI can never turn this on, but a session on a host where you enabled it can use the forwarded keys.

## 0.1.12 - 2026-07-28

### Fixed
- SSH connections stay alive during idle periods. Keepalives run every 15 seconds and short interruptions are tolerated, so a session no longer drops just because the window was in the background for a while.
- The terminal cursor blinks at a normal rate again instead of racing when the animation-speed setting is changed.

## 0.1.11 - 2026-07-28

### Added
- Per-host SSH agent forwarding (ForwardAgent). Off by default. When enabled, commands on that host can authenticate with the keys in your local SSH agent, for example git push to another server, without putting a private key on the host. Only enable it for hosts you trust.

## 0.1.10 - 2026-07-25

### Changed
- App icon is just the feather now, with no background.

## 0.1.9 - 2026-07-25

### Fixed
- AI access remembers its on or off state on disk and restores it after a restart or update. Only turning it off yourself keeps it off.

## 0.1.8 - 2026-07-25

### Changed
- Lighter blue app icon background.
- The window title bar shows the feather alone, without the badge.

## 0.1.7 - 2026-07-25

### Added
- Settings shows the current version and a polished in-app changelog.

## 0.1.6 - 2026-07-25

### Fixed
- Release builds now publish reliably, so self-update always finds the latest version.

## 0.1.5 - 2026-07-24

### Changed
- AI access turns on immediately after an update when "on by default" is set, with no lag.
- Calmer check-for-updates animation with the status on the right.

## 0.1.4 - 2026-07-24

### Changed
- New app icon: a white feather on a bluish-black badge.

## 0.1.3 - 2026-07-24

### Added
- Update dialog on launch offering "Update now" or "Later".
- Sidebar button that appears when an update is available.

## 0.1.2 - 2026-07-24

### Added
- Application icon.

## 0.1.1 - 2026-07-24

### Added
- Self-update through GitHub releases with signed installers.
- Updates panel in Settings.

## 0.1.0 - 2026-07-24

### Added
- SSH client with a real terminal and multiple sessions per host.
- SFTP file browser and transfers.
- Encrypted vault for keys and passwords (Argon2id, XChaCha20-Poly1305) with a change-master-password option.
- Built-in MCP server for controlled AI access: off by default, per-host policy (locked, confirm, free), approval dialogs and a full audit log.
- Runnable scripts across hosts with an embedded terminal.
- Ed25519 key generation and credential reveal in the keychain.
