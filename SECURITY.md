# Security

Kestral is pre-1.0 and moves fast. Only the latest `0.1.x` is supported.

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

- **Vault at rest.** Hosts, keys, snippets and the audit log are encrypted. The
  master password goes through Argon2id (v19, m=64 MiB, t=2, p=1, 32-byte key,
  16-byte random salt) to a key-encryption key, which wraps a random data key that
  encrypts everything else. A password change re-derives only the outer key.
- **MCP surface.** The server binds `127.0.0.1:4517` only, requires a bearer token
  (192 bits from the OS RNG, compared in constant time), and validates Host and
  Origin. It is not exposed to the network or to browsers.
- **AI is gated.** AI access is off by default and every host has a policy:
  `locked`, `confirm` (per-command approval) or `free`. Commands and file transfer
  have separate policies. If the AI repoints a host to a new address, port or user,
  its policies are reset to `locked`.
- **AI file transfer is not confined to a folder.** On a host whose file policy
  allows it, an AI upload can read and an AI download can write any local path your
  OS account can reach, for example `~/.aws/credentials` or a shell profile. The
  safety net is the protected path list (by default `.ssh/authorized_keys` and
  `.ssh/config`): any AI command or file transfer that touches a protected path, on
  the local or the remote side, is refused and turns AI access off completely until
  you turn it back on by hand. Keep the file policy at `locked` or `confirm` for
  hosts where that is too much.
- **Host keys.** Trusted host keys are kept encrypted in the vault; on first use the
  entries of `~/.ssh/known_hosts` are copied in. A new host is trusted only after
  you accept its SHA256 fingerprint. A **changed** host key is refused with a
  distinct error, never silently accepted, and a host key store that cannot be read
  refuses every connection.
- **Not defended:** an attacker who already has your unlocked machine or your OS
  account. Secret wiping in memory is best effort and does not defend against swap,
  hibernation or a core dump.
