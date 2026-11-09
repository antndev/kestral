# Security

Kestral is pre-1.0 and moves fast. Only the latest release is supported.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately:

- GitHub: enable and use Private Vulnerability Reporting on this repository, or
- Email: antonkonig691@gmail.com

I aim to acknowledge within a few days. Please include what you found, how to
reproduce it, and the impact you see.

## Threat model

Kestral is a local desktop app. It holds SSH credentials in an encrypted vault and
runs a loopback MCP server so a local AI client can act on your servers under rules
you set. What it defends against, and what it does not:

- **Vault at rest.** Hosts, keys, passwords, identities, snippets, collections, known
  hosts and the audit log are encrypted. The master password goes through Argon2id
  (v19, m=64 MiB, t=2, p=1, 32-byte key, 16-byte random salt) to a key-encryption key
  that encrypts the vault. A random data key inside the vault encrypts the audit log.
  A password change re-derives only the outer key.
- **Windows Hello.** If you turn on Hello unlock, the vault key is wrapped with a key
  derived from a Windows Hello signature. Anyone who passes Windows Hello on your
  Windows account can unlock the vault.
- **MCP surface.** The server binds `127.0.0.1:4517` only, requires a bearer token
  (192 bits from the OS RNG, compared in constant time), and validates Host and
  Origin. It is not exposed to the network or to browsers. Secret values are never
  returned to the AI, only credential ids and kinds.
- **AI is gated.** AI access is off by default and turns itself off after the time you
  pick unless you choose No limit. Every host has a policy for commands and a separate
  one for files: Blocked, Ask (per action approval) or Free. Listing hosts, snippets and
  credentials, reading the audit log, and changing hosts, snippets and port forwards
  each have their own switch. If the AI repoints a host to a new address, port, user or
  sign-in, the policies of that host and of the hosts that connect through it are reset
  to Blocked and its agent forwarding is turned off.
- **AI changes are reviewed.** A host the AI created or repointed is refused on every
  connect path, also as a jump host, until you press Confirm host. A snippet the AI
  changed shows a review before it runs. A port forward the AI created or changed never
  starts, whether from the button, autostart or on connect, until you review it, and
  the AI cannot turn on autostart. When the AI repoints a host, its port forwards are
  marked for review again.
- **AI file transfer is not confined to a folder.** On a host whose file policy
  allows it, an AI upload can read and an AI download can write any local path your
  OS account can reach, for example `~/.aws/credentials` or a shell profile. Relative
  paths, network shares and device paths are refused. The safety net is the protected
  path list (by default `.ssh/authorized_keys` and `.ssh/config`): any AI command or
  file transfer that touches a protected path, on the local or the remote side, is
  refused and turns AI access off completely until you turn it back on by hand. Keep
  the file policy at Blocked or Ask for hosts where that is too much.
- **Agent forwarding.** Forwarding uses keys from the vault that you choose per host.
  The AI can never turn it on, but once you enabled it for a host, AI sessions on that
  host can use it too. Every signature is recorded in the audit log.
- **Host keys.** Trusted host keys are kept encrypted in the vault; on first use the
  entries of `~/.ssh/known_hosts` are copied in. A new host is trusted only after
  you accept its SHA256 fingerprint. A **changed** host key is refused with a
  distinct error, never silently accepted, and a host key store that cannot be read
  refuses every connection.
- **Not defended:** an attacker who already has your unlocked machine or your OS
  account. Secret wiping in memory is best effort and does not defend against swap,
  hibernation or a core dump.
