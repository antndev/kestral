
use std::path::PathBuf;

use crate::error::{AppError, Result};

const SCRIPT: &str = include_str!("skill_client.py");

const SKILL_TEMPLATE: &str = r#"---
name: kestral
description: Run commands on the user's own SSH servers through the Kestral desktop app, with per-host policy, approval dialogs and an audit log. Use whenever the user wants something checked, run or changed on a server, host, VPS, homelab or remote machine, or asks which hosts they have.
---

# Kestral

Kestral is an SSH client running on this machine. It holds the user's servers and
their credentials in an encrypted vault. You never see a password or a private
key, and you must never ask for one. You ask Kestral to act, and Kestral enforces
the rules the user configured.

## Which way to use

If tools whose names start with `mcp__kestral__` are already available in this
session, **use those directly**. They are typed, the arguments are checked, and
you get structured results. Do not use the script then.

Use the script below only when those tools are not there. That is the normal case
in a chat that was already open before Kestral was set up, because a running
session cannot load new tools. Both go to the same app and obey the same rules,
so nothing is lost either way.

## How to call it

```
{RUN} status                             Is the app reachable, is AI access on
{RUN} hosts                              List the hosts you are allowed to see
{RUN} run <host> <command...>            Run a command on a host
{RUN} ls <host> <path>                   List a remote directory
{RUN} upload <host> <local> <remote>     Copy a local file to the host
{RUN} download <host> <remote> <local>   Copy a file from the host
{RUN} audit                              Show what has been done
{RUN} tools                              List everything the app currently offers
{RUN} call <tool> <json>                 Call any tool directly
```

Add `--json` for machine readable output.

Use `upload` instead of writing files through shell heredocs. It avoids quoting
problems entirely and it is logged as a file transfer. If you need a tool that has
no shortcut above, run `tools` to see what exists and then use `call`.

For `upload` and `download` the LOCAL path is any path on this machine, absolute or
`~/`-relative. Name the file and location directly, no staging folder. The one
exception is a protected path (see below, e.g. `.ssh/authorized_keys`): naming it on
either side is refused and stops AI access.

## How to work

1. Run `status` first. If AI access is off, stop and ask the user to switch it on
   in the Kestral window. Do not try to work around it.
2. Run `hosts` to see what you may touch. If listing is switched off, ask the user
   to name the host.
3. Run commands with `run <host> "<command>"`. The host is its name or its id.
4. `tools` shows the full current tool list, including file transfer, if you need
   more than the shortcuts above.

## Rules that matter

- Each host has a policy. `free` runs straight away. `confirm` opens a dialog the
  user has to approve, so the call can take a moment, do not repeat it. `locked`
  is refused.
- File transfer has its OWN per-host policy, separate from commands. A host can
  allow commands and still refuse `ls`, `upload` and `download`. If file access is
  refused, say so and ask the user to change it in the Kestral window, do not fall
  back to writing files through the shell.
- A refusal is a decision by the user, not a bug. Do not retry it, do not look for
  another way in, and do not suggest switching the protection off. Say which host
  was refused and why.
- Never ask the user to paste a password or a key, and never read key files
  yourself. If a host is missing a credential, tell the user to add it in the
  Kestral window.
- Everything you run is written to an audit log the user can read.
- Prefer read only commands. Before anything destructive, deleting, overwriting,
  restarting a service, say plainly what you are about to run and why.
- If the app is unreachable the user probably closed it. Ask, do not fall back to
  ssh or other tools.
"#;

#[derive(serde::Serialize)]
pub struct InstallResult {
    pub skill_path: String,
    pub script_path: String,
    pub runtime: String,
    pub message: String,
}

pub fn install() -> Result<InstallResult> {
    let python = find_python().ok_or_else(|| {
        AppError::Other(
            "No Python found. Install Python 3 or keep using the \
             MCP registration."
                .into(),
        )
    })?;

    let dir = home()?.join(".claude").join("skills").join("kestral");
    std::fs::create_dir_all(&dir)?;

    let script_path = dir.join("kestral_client.py");
    crate::util::atomic_write(&script_path, SCRIPT.as_bytes())?;

    let run = format!("{} \"{}\"", python, script_path.display());
    let skill_path = dir.join("SKILL.md");
    crate::util::atomic_write(&skill_path, SKILL_TEMPLATE.replace("{RUN}", &run).as_bytes())?;

    Ok(InstallResult {
        skill_path: skill_path.display().to_string(),
        script_path: script_path.display().to_string(),
        runtime: python,
        message: "Installed.".into(),
    })
}

pub fn uninstall() -> Result<String> {
    let dir = home()?.join(".claude").join("skills").join("kestral");
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
        Ok(format!("Removed {}", dir.display()))
    } else {
        Ok("Nothing to remove.".into())
    }
}

pub fn installed() -> bool {
    home()
        .map(|h| {
            h.join(".claude")
                .join("skills")
                .join("kestral")
                .join("SKILL.md")
                .is_file()
        })
        .unwrap_or(false)
}

fn home() -> Result<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| AppError::Other("no home directory found".into()))
}

fn find_python() -> Option<String> {
    for cand in ["python3", "python", "py"] {
        let mut cmd = std::process::Command::new(cand);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        if let Ok(out) = cmd.arg("--version").output() {
            if out.status.success() {
                let v = String::from_utf8_lossy(&out.stdout).to_string()
                    + &String::from_utf8_lossy(&out.stderr);
                if v.contains("Python 3") {
                    return Some(cand.to_string());
                }
            }
        }
    }
    None
}
