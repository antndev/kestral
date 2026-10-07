//! Reads concrete host aliases from the user's OpenSSH client config
//! (~/.ssh/config) so they can be imported as hosts.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, Result};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SshConfigHost {
    pub alias: String,
    pub hostname: String,
    pub port: u16,
    pub user: String,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
}

struct Block {
    /// None for a `Match` block, whose conditions we cannot evaluate.
    patterns: Option<Vec<String>>,
    settings: Vec<(String, String)>,
}

impl Block {
    fn applies_to(&self, alias: &str) -> bool {
        let Some(patterns) = &self.patterns else {
            return false;
        };
        let alias = alias.to_lowercase();
        let mut matched = false;
        for p in patterns {
            let (negated, pattern) = match p.strip_prefix('!') {
                Some(rest) => (true, rest),
                None => (false, p.as_str()),
            };
            if crate::util::glob_match(&pattern.to_lowercase(), &alias) {
                if negated {
                    return false;
                }
                matched = true;
            }
        }
        matched
    }
}

/// Splits "Key value", "Key=value" and "Key = value".
fn split_line(line: &str) -> Option<(String, &str)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line
        .find(|c: char| c.is_whitespace() || c == '=')
        .unwrap_or(line.len());
    let key = line[..end].to_ascii_lowercase();
    let rest = line[end..].trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest).trim();
    Some((key, rest))
}

fn words(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = value.trim();
    while !rest.is_empty() {
        if rest.starts_with('#') {
            break;
        }
        if let Some(stripped) = rest.strip_prefix('"') {
            let end = stripped.find('"').unwrap_or(stripped.len());
            out.push(stripped[..end].to_string());
            rest = stripped.get(end + 1..).unwrap_or("").trim_start();
        } else {
            let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            out.push(rest[..end].to_string());
            rest = rest[end..].trim_start();
        }
    }
    out
}

fn expand_home(value: &str, home: Option<&Path>) -> String {
    let Some(home) = home else {
        return value.to_string();
    };
    let home_str = home.to_string_lossy();
    if value == "~" {
        return home_str.into_owned();
    }
    if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        let rest = if cfg!(windows) { rest.replace('/', std::path::MAIN_SEPARATOR_STR) } else { rest.to_string() };
        return home.join(rest).to_string_lossy().into_owned();
    }
    value.replace("%d", &home_str)
}

/// OpenSSH refuses to nest Include deeper than this.
const MAX_INCLUDE_DEPTH: usize = 16;

/// Resolves one `Include` argument to the contents of the files it names.
pub type IncludeResolver<'a> = dyn FnMut(&str) -> Vec<String> + 'a;

struct Parser {
    blocks: Vec<Block>,
    aliases: Vec<String>,
}

impl Parser {
    fn new() -> Self {
        // Settings before the first Host line apply to every host.
        Self {
            blocks: vec![Block {
                patterns: Some(vec!["*".to_string()]),
                settings: Vec::new(),
            }],
            aliases: Vec::new(),
        }
    }

    fn feed(&mut self, content: &str, depth: usize, include: &mut IncludeResolver) {
        for line in content.lines() {
            let Some((key, value)) = split_line(line) else {
                continue;
            };
            match key.as_str() {
                "host" => {
                    let patterns = words(value);
                    for p in &patterns {
                        let concrete = !p.is_empty() && !p.contains(['*', '?', '!']);
                        if concrete && !self.aliases.iter().any(|a| a == p) {
                            self.aliases.push(p.clone());
                        }
                    }
                    self.blocks.push(Block {
                        patterns: Some(patterns),
                        settings: Vec::new(),
                    });
                }
                "match" => self.blocks.push(Block {
                    patterns: None,
                    settings: Vec::new(),
                }),
                "include" => {
                    if depth >= MAX_INCLUDE_DEPTH {
                        tracing::warn!("ssh config Include nested too deeply, ignored");
                        continue;
                    }
                    // Like OpenSSH, an included file starts in the enclosing block
                    // and the lines after the Include continue in it.
                    let outer = self.blocks.last().and_then(|b| b.patterns.clone());
                    let before = self.blocks.len();
                    for arg in words(value) {
                        for text in include(&arg) {
                            self.feed(&text, depth + 1, include);
                        }
                    }
                    if self.blocks.len() != before {
                        self.blocks.push(Block {
                            patterns: outer,
                            settings: Vec::new(),
                        });
                    }
                }
                _ => {
                    if let Some(block) = self.blocks.last_mut() {
                        let first = words(value).into_iter().next().unwrap_or_default();
                        block.settings.push((key, first));
                    }
                }
            }
        }
    }

    fn finish(self, home: Option<&Path>) -> Vec<SshConfigHost> {
        let blocks = self.blocks;
        self.aliases
            .into_iter()
            .map(|alias| {
                // OpenSSH semantics: the first value obtained for a key wins.
                let lookup = |name: &str| {
                    blocks
                        .iter()
                        .filter(|b| b.applies_to(&alias))
                        .flat_map(|b| b.settings.iter())
                        .find(|(k, _)| k == name)
                        .map(|(_, v)| v.clone())
                };
                let hostname = lookup("hostname")
                    .map(|h| h.replace("%h", &alias))
                    .filter(|h| !h.is_empty())
                    .unwrap_or_else(|| alias.clone());
                let port = lookup("port").and_then(|p| p.parse().ok()).unwrap_or(22);
                let local_user = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default();
                let user = lookup("user").filter(|u| !u.is_empty()).unwrap_or_else(|| local_user.clone());
                let configured = lookup("identityfile");
                let identity_file = match configured {
                    Some(f) if f.eq_ignore_ascii_case("none") => None,
                    Some(f) if !f.is_empty() => Some(
                        expand_home(&f, home)
                            .replace("%h", &hostname)
                            .replace("%r", &user)
                            .replace("%u", &local_user)
                            .replace("%%", "%"),
                    ),
                    _ => home.and_then(|h| {
                        ["id_ed25519", "id_ecdsa", "id_rsa", "id_ecdsa_sk", "id_ed25519_sk"]
                            .iter()
                            .map(|n| h.join(".ssh").join(n))
                            .find(|p| p.is_file())
                            .map(|p| p.to_string_lossy().into_owned())
                    }),
                };
                let proxy_jump = lookup("proxyjump")
                    .filter(|j| !j.is_empty() && !j.eq_ignore_ascii_case("none"))
                    .and_then(|j| j.split(',').next().map(|s| s.trim().to_string()))
                    .filter(|j| !j.is_empty());
                SshConfigHost {
                    alias,
                    hostname,
                    port,
                    user,
                    identity_file,
                    proxy_jump,
                }
            })
            .collect()
    }
}

pub fn parse_with(
    content: &str,
    home: Option<&Path>,
    include: &mut IncludeResolver,
) -> Vec<SshConfigHost> {
    let mut parser = Parser::new();
    parser.feed(content, 0, include);
    parser.finish(home)
}

fn has_wildcard(s: &str) -> bool {
    s.contains(['*', '?'])
}

fn name_matches(pattern: &str, name: &str) -> bool {
    // Like glob(3), a wildcard does not match a leading dot.
    if name.starts_with('.') && !pattern.starts_with('.') {
        return false;
    }
    if cfg!(windows) {
        crate::util::glob_match(&pattern.to_lowercase(), &name.to_lowercase())
    } else {
        crate::util::glob_match(pattern, name)
    }
}

/// Expands `*` and `?` in any path component, sorted like glob(3).
fn expand_glob(path: &Path) -> Vec<PathBuf> {
    let mut found = vec![PathBuf::new()];
    for comp in path.components() {
        let part = comp.as_os_str().to_string_lossy();
        if !has_wildcard(&part) {
            for p in &mut found {
                p.push(comp);
            }
            continue;
        }
        let mut next = Vec::new();
        for base in &found {
            let Ok(dir) = std::fs::read_dir(base) else {
                continue;
            };
            let mut names: Vec<_> = dir
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| name_matches(&part, n))
                .collect();
            names.sort();
            next.extend(names.into_iter().map(|n| base.join(n)));
        }
        found = next;
    }
    found.retain(|p| p.is_file());
    found
}

/// Files named by an `Include` argument: `~` is expanded and relative paths are
/// taken from ~/.ssh, as OpenSSH does for the user config.
fn include_paths(arg: &str, home: Option<&Path>) -> Vec<PathBuf> {
    let expanded = PathBuf::from(expand_home(arg, home));
    let full = if expanded.is_absolute() {
        expanded
    } else {
        match home {
            Some(h) => h.join(".ssh").join(expanded),
            None => return Vec::new(),
        }
    };
    if has_wildcard(&full.to_string_lossy()) {
        expand_glob(&full)
    } else if full.is_file() {
        vec![full]
    } else {
        Vec::new()
    }
}

fn read_lossy(path: &Path) -> std::io::Result<String> {
    std::fs::read(path).map(|b| {
        let text = String::from_utf8_lossy(&b).into_owned();
        text.strip_prefix('\u{feff}').map(str::to_owned).unwrap_or(text)
    })
}

pub fn read_hosts() -> Result<Vec<SshConfigHost>> {
    let home = crate::util::home_dir();
    let Some(path) = home.as_ref().map(|h| h.join(".ssh").join("config")) else {
        return Ok(Vec::new());
    };
    let content = match read_lossy(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(AppError::Other(format!(
                "Could not read {}: {e}",
                path.display()
            )))
        }
    };
    let mut include = |arg: &str| {
        include_paths(arg, home.as_deref())
            .iter()
            .filter_map(|p| match read_lossy(p) {
                Ok(text) => Some(text),
                Err(e) => {
                    tracing::warn!("ssh config Include {} unreadable: {e}", p.display());
                    None
                }
            })
            .collect()
    };
    Ok(parse_with(&content, home.as_deref(), &mut include))
}

#[tauri::command]
pub async fn ssh_config_hosts() -> Result<Vec<SshConfigHost>> {
    crate::util::blocking(read_hosts).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(content: &str, home: Option<&Path>) -> Vec<SshConfigHost> {
        parse_with(content, home, &mut |_| Vec::new())
    }

    #[test]
    fn parses_blocks_defaults_and_both_syntaxes() {
        let home = Path::new("/home/me");
        let cfg = "\
# global
User fallback

Host web prod-db
    HostName 10.0.0.5
    port 2222
    IdentityFile ~/.ssh/id_web

Host nas
  hostname=nas.lan
  User = admin
  IdentityFile \"%d/keys/nas key\"

Host *.internal !skip ?x
  User nope

Host bare

Match host foo
  User matched

Host *
  User star
  Port 2200
";
        let hosts = parse(cfg, Some(home));
        let aliases: Vec<_> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(aliases, vec!["web", "prod-db", "nas", "bare"]);

        let web = &hosts[0];
        assert_eq!(web.hostname, "10.0.0.5");
        assert_eq!(web.port, 2222);
        assert_eq!(web.user, "fallback");
        assert_eq!(
            web.identity_file.as_deref(),
            Some(home.join(".ssh").join("id_web").to_string_lossy().as_ref())
        );
        assert_eq!(hosts[1].hostname, "10.0.0.5");

        let nas = &hosts[2];
        assert_eq!(nas.hostname, "nas.lan");
        assert_eq!(nas.user, "fallback");
        assert_eq!(nas.port, 2200);
        assert_eq!(nas.identity_file.as_deref(), Some("/home/me/keys/nas key"));

        let bare = &hosts[3];
        assert_eq!(bare.hostname, "bare");
        assert_eq!(bare.port, 2200);
        assert_eq!(bare.identity_file, None);
    }

    #[test]
    fn without_globals_defaults_apply() {
        let hosts = parse("Host solo\n", None);
        assert_eq!(
            hosts,
            vec![SshConfigHost {
                alias: "solo".into(),
                hostname: "solo".into(),
                port: 22,
                user: std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default(),
                identity_file: None,
                proxy_jump: None,
            }]
        );
        assert!(parse("", None).is_empty());
        assert!(parse("Host *\n  User x\n", None).is_empty());
    }

    #[test]
    fn include_is_parsed_in_place_and_the_outer_block_resumes() {
        let cfg = "\
Include config.d/*
Host outer
  Include extra
  User outeruser
Host late
";
        let mut asked = Vec::new();
        let mut include = |arg: &str| {
            asked.push(arg.to_string());
            match arg {
                "config.d/*" => {
                    vec!["Host inc1\n  HostName 10.1.1.1\n  Include config.d/*\n".to_string()]
                }
                "extra" => vec!["Port 2022\nHost inner\n  User inneruser\n".to_string()],
                _ => Vec::new(),
            }
        };
        let hosts = parse_with(cfg, None, &mut include);
        let me = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default();
        let summary: Vec<_> = hosts
            .iter()
            .map(|h| {
                (
                    h.alias.as_str(),
                    h.hostname.as_str(),
                    h.port,
                    h.user.as_str(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                ("inc1", "10.1.1.1", 22, me.as_str()),
                ("outer", "outer", 2022, "outeruser"),
                ("inner", "inner", 22, "inneruser"),
                ("late", "late", 22, me.as_str()),
            ]
        );
        // The self-including file stops at the depth limit instead of looping.
        assert_eq!(
            asked.iter().filter(|a| *a == "config.d/*").count(),
            MAX_INCLUDE_DEPTH
        );
    }

    #[test]
    fn include_paths_resolve_relative_to_ssh_dir_with_globs() {
        let home = std::env::temp_dir().join(format!("kestral_cfg_{}", uuid::Uuid::new_v4()));
        let dir = home.join(".ssh").join("config.d");
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["b.conf", "a.conf", ".hidden", "notes.txt"] {
            std::fs::write(dir.join(name), "").unwrap();
        }

        let names = |arg: &str| -> Vec<String> {
            include_paths(arg, Some(&home))
                .iter()
                .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
                .collect()
        };
        assert_eq!(names("config.d/*.conf"), vec!["a.conf", "b.conf"]);
        assert_eq!(names("config.d/*"), vec!["a.conf", "b.conf", "notes.txt"]);
        assert_eq!(names("~/.ssh/config.d/a.conf"), vec!["a.conf"]);
        assert_eq!(names("con*/b.conf"), vec!["b.conf"]);
        assert!(names("missing").is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }
}
