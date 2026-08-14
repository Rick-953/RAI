use crate::config::{AgentConfig, Grant};
use anyhow::{Context, Result, bail};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Component, Path, PathBuf};

const SENSITIVE_COMPONENTS: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".azure",
    ".config/gcloud",
    "keychains",
    "login.keychain-db",
    "cookies",
    "login data",
    "credentials",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Risk {
    Low,
    Write,
    Destructive,
    Sensitive,
    Shell,
    Elevated,
    ExternalEffect,
}

#[derive(Debug)]
pub struct Decision {
    pub allowed: bool,
    pub requires_approval: bool,
    pub risk: Risk,
    pub reason: &'static str,
    pub resolved_path: Option<PathBuf>,
}

pub fn evaluate(config: &AgentConfig, tool: &str, params: &Value) -> Result<Decision> {
    if tool.starts_with("browser.") {
        let external = matches!(
            tool,
            "browser.navigate"
                | "browser.click"
                | "browser.type"
                | "browser.submit"
                | "browser.upload"
                | "browser.download"
                | "browser.permission"
        );
        return Ok(Decision {
            allowed: true,
            requires_approval: external,
            risk: if external {
                Risk::ExternalEffect
            } else {
                Risk::Low
            },
            reason: if external {
                "browser_external_effect"
            } else {
                "browser_session_trust"
            },
            resolved_path: None,
        });
    }

    if matches!(tool, "sandbox_exec" | "process.shell") {
        let elevated = params
            .get("elevated")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .map(resolve_candidate)
            .transpose()?
            .unwrap_or_else(|| {
                directories::UserDirs::new()
                    .map(|dirs| dirs.home_dir().to_path_buf())
                    .unwrap_or_default()
            });
        let trusted_here = config
            .shell_always_roots
            .iter()
            .any(|root| cwd.starts_with(root));
        return Ok(Decision {
            allowed: true,
            requires_approval: elevated || !trusted_here,
            risk: if elevated {
                Risk::Elevated
            } else {
                Risk::Shell
            },
            reason: if elevated {
                "os_elevation_required"
            } else {
                "unrestricted_shell"
            },
            resolved_path: Some(cwd),
        });
    }

    if matches!(tool, "process.exec" | "process_exec") {
        let elevated = params
            .get("elevated")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        return Ok(Decision {
            allowed: true,
            requires_approval: elevated || command_is_high_risk(params),
            risk: if elevated {
                Risk::Elevated
            } else if command_is_high_risk(params) {
                Risk::Destructive
            } else {
                Risk::Low
            },
            reason: if elevated {
                "os_elevation_required"
            } else if command_is_high_risk(params) {
                "high_risk_program"
            } else {
                "structured_program"
            },
            resolved_path: None,
        });
    }

    let raw_path = primary_path(tool, params).unwrap_or_default();
    let resolved = resolve_candidate(raw_path)?;
    let action = if matches!(tool, "read_file" | "list_files") {
        "read"
    } else {
        "write"
    };
    let within_grant = config
        .grants
        .iter()
        .any(|grant| grant_allows(grant, &resolved, action));
    let sensitive = is_sensitive(&resolved);
    let destructive = tool == "delete_file";
    Ok(Decision {
        allowed: within_grant,
        requires_approval: !within_grant || sensitive || destructive,
        risk: if sensitive {
            Risk::Sensitive
        } else if destructive {
            Risk::Destructive
        } else if action == "write" {
            Risk::Write
        } else {
            Risk::Low
        },
        reason: if !within_grant {
            "outside_granted_roots"
        } else if sensitive {
            "sensitive_path"
        } else if destructive {
            "destructive_file_action"
        } else {
            "granted_root"
        },
        resolved_path: Some(resolved),
    })
}

pub fn add_grant(config: &mut AgentConfig, root: &Path) -> Result<()> {
    let candidate = resolve_candidate(root)?;
    let resolved = if candidate.is_dir() {
        candidate
    } else {
        candidate
            .parent()
            .context("grant directory unavailable")?
            .to_path_buf()
    };
    if resolved.parent().is_none() || resolved == Path::new("/") {
        bail!("refusing broad filesystem root grant");
    }
    config.grants.retain(|grant| grant.root != resolved);
    config.grants.push(Grant {
        root: resolved,
        actions: vec!["read".into(), "write".into(), "execute".into()],
        created_at: chrono::Utc::now().timestamp(),
    });
    config.save()
}

pub fn add_shell_grant(config: &mut AgentConfig, root: &Path) -> Result<()> {
    let resolved = resolve_candidate(root)?;
    if resolved.parent().is_none() || resolved == Path::new("/") {
        bail!("refusing broad shell root grant");
    }
    config.shell_always_roots.retain(|item| item != &resolved);
    config.shell_always_roots.push(resolved);
    config.dangerous_shell_always = false;
    config.save()
}

pub fn resolve_candidate<P: AsRef<Path>>(path: P) -> Result<PathBuf> {
    let path = path.as_ref();
    let absolute = if path.as_os_str().is_empty() {
        directories::UserDirs::new()
            .context("home unavailable")?
            .home_dir()
            .to_path_buf()
    } else if path.is_absolute() {
        path.to_path_buf()
    } else {
        directories::UserDirs::new()
            .context("home unavailable")?
            .home_dir()
            .join(path)
    };
    if absolute
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        bail!("parent directory segments are not allowed");
    }
    if absolute.exists() {
        return fs::canonicalize(&absolute).context("resolve path");
    }
    let parent = absolute.parent().context("path parent unavailable")?;
    let canonical_parent = fs::canonicalize(parent).context("resolve parent path")?;
    let name = absolute.file_name().context("path name unavailable")?;
    Ok(canonical_parent.join(name))
}

pub fn is_within_any_grant(config: &AgentConfig, path: &Path, action: &str) -> bool {
    config
        .grants
        .iter()
        .any(|grant| grant_allows(grant, path, action))
}

fn grant_allows(grant: &Grant, path: &Path, action: &str) -> bool {
    let root = fs::canonicalize(&grant.root).unwrap_or_else(|_| grant.root.clone());
    path.starts_with(root) && grant.actions.iter().any(|item| item == action)
}

fn primary_path<'a>(tool: &str, params: &'a Value) -> Option<&'a str> {
    match tool {
        "copy_file" | "move_file" => params.get("from").and_then(Value::as_str),
        "list_files" => params.get("path").and_then(Value::as_str),
        "create_artifact" => params.get("file_name").and_then(Value::as_str),
        _ => params.get("file_id").and_then(Value::as_str),
    }
}

fn is_sensitive(path: &Path) -> bool {
    let text = path.to_string_lossy().to_lowercase().replace('\\', "/");
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case(".env"))
        || SENSITIVE_COMPONENTS.iter().any(|item| text.contains(item))
}

fn command_is_high_risk(params: &Value) -> bool {
    let program = params
        .get("program")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    matches!(
        program.as_str(),
        "rm" | "rmdir" | "del" | "format" | "diskpart" | "shutdown" | "reboot" | "sudo" | "pkexec"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_segments() {
        assert!(resolve_candidate("../secret").is_err());
    }

    #[test]
    fn classifies_shell_as_high_risk() {
        let config = AgentConfig {
            device_seed: String::new(),
            device_name: String::new(),
            sensitive_mode: "strict".into(),
            dangerous_shell_always: false,
            shell_always_roots: Vec::new(),
            allowed_origins: Vec::new(),
            grants: Vec::new(),
            trusted_servers: Vec::new(),
        };
        let decision = evaluate(
            &config,
            "process.shell",
            &serde_json::json!({"script":"pwd"}),
        )
        .unwrap();
        assert!(decision.requires_approval);
    }
}
