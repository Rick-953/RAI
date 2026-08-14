use crate::config::AgentConfig;
use crate::elevation;
use crate::policy::{self, is_within_any_grant};
use anyhow::{Context, Result, bail};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use wait_timeout::ChildExt;

const MAX_TEXT_BYTES: u64 = 10 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const CAPTURE_TRUNCATION_MARKER: &str = "\n[RAI_LOCAL_OUTPUT_TRUNCATED_AT_CAPTURE]";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutput {
    pub success: bool,
    pub output: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
    pub full_output_available: bool,
    pub truncated: bool,
    pub output_sha256: String,
    pub duration_ms: u128,
    pub extra: Value,
}

impl ToolOutput {
    fn success(output: String, started: Instant, extra: Value) -> Self {
        let digest = hex::encode(Sha256::digest(output.as_bytes()));
        let truncated = extra
            .get("outputTruncatedAtCapture")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Self {
            success: true,
            output,
            stderr: String::new(),
            exit_code: Some(0),
            error: None,
            full_output_available: !truncated,
            truncated,
            output_sha256: digest,
            duration_ms: started.elapsed().as_millis(),
            extra,
        }
    }

    fn failure(error: impl Into<String>, started: Instant) -> Self {
        let raw_error = error.into();
        let truncated = raw_error.ends_with(CAPTURE_TRUNCATION_MARKER);
        let error = raw_error
            .strip_suffix(CAPTURE_TRUNCATION_MARKER)
            .unwrap_or(&raw_error)
            .to_string();
        Self {
            success: false,
            output: String::new(),
            stderr: String::new(),
            exit_code: None,
            error: Some(error.clone()),
            full_output_available: !truncated,
            truncated,
            output_sha256: hex::encode(Sha256::digest(error.as_bytes())),
            duration_ms: started.elapsed().as_millis(),
            extra: json!({}),
        }
    }
}

pub fn execute(config: &AgentConfig, tool: &str, params: &Value) -> ToolOutput {
    let started = Instant::now();
    let result = match tool {
        "list_files" => list_files(config, params),
        "read_file" => read_file(config, params),
        "write_file" => write_file(config, params),
        "create_artifact" => create_artifact(config, params),
        "edit_file" => edit_file(config, params),
        "copy_file" => copy_file(config, params),
        "move_file" => move_file(config, params),
        "delete_file" => delete_file(config, params),
        "sandbox_exec" | "process.shell" => shell(config, params),
        "process.exec" | "process_exec" => process_exec(config, params),
        _ if tool.starts_with("browser.") => Ok((
            String::new(),
            json!({ "browserAction": { "tool": tool, "parameters": params } }),
        )),
        _ => Err(anyhow::anyhow!("unsupported_tool:{tool}")),
    };
    match result {
        Ok((output, extra)) => ToolOutput::success(output, started, extra),
        Err(error) => ToolOutput::failure(format!("{error:#}"), started),
    }
}

fn list_files(config: &AgentConfig, params: &Value) -> Result<(String, Value)> {
    let root = path_param(params, "path").unwrap_or_else(|| default_root(config));
    let root = policy::resolve_candidate(root)?;
    require_grant(config, &root, "read")?;
    let mut entries = fs::read_dir(&root)?
        .filter_map(Result::ok)
        .take(500)
        .map(|entry| {
            let metadata = entry.metadata().ok();
            json!({
                "name": entry.file_name().to_string_lossy(),
                "type": if metadata.as_ref().is_some_and(|item| item.is_dir()) { "directory" } else { "file" },
                "size": metadata.as_ref().map(|item| item.len()).unwrap_or(0)
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
    Ok((
        serde_json::to_string_pretty(&entries)?,
        json!({ "path": root, "entries": entries }),
    ))
}

fn read_file(config: &AgentConfig, params: &Value) -> Result<(String, Value)> {
    let path = required_path(params, "file_id")?;
    let path = policy::resolve_candidate(path)?;
    require_grant(config, &path, "read")?;
    let metadata = fs::metadata(&path)?;
    if params.get("mode").and_then(Value::as_str) == Some("metadata") {
        let value = json!({ "path": path, "size": metadata.len(), "readonly": metadata.permissions().readonly() });
        return Ok((serde_json::to_string_pretty(&value)?, value));
    }
    if metadata.len() > MAX_TEXT_BYTES {
        bail!("file_too_large");
    }
    let bytes = fs::read(&path)?;
    if bytes.iter().take(4096).any(|byte| *byte == 0) {
        bail!("binary_file_requires_explicit_upload");
    }
    let text = String::from_utf8(bytes).context("file is not valid UTF-8")?;
    Ok((text, json!({ "path": path, "size": metadata.len() })))
}

fn write_file(config: &AgentConfig, params: &Value) -> Result<(String, Value)> {
    let path = policy::resolve_candidate(required_path(params, "file_id")?)?;
    require_grant(config, &path, "write")?;
    let content = params
        .get("content")
        .and_then(Value::as_str)
        .context("content required")?;
    if content.len() as u64 > MAX_TEXT_BYTES {
        bail!("content_too_large");
    }
    write_atomic(&path, content.as_bytes())?;
    Ok((
        format!("wrote {} bytes to {}", content.len(), path.display()),
        json!({ "path": path, "size": content.len() }),
    ))
}

fn create_artifact(config: &AgentConfig, params: &Value) -> Result<(String, Value)> {
    let format = params
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or("text");
    if !matches!(format, "text" | "markdown" | "json" | "csv") {
        bail!("local_agent_artifact_format_not_supported:{format}");
    }
    let file_name = params
        .get("file_name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(format!(
                "rai-artifact-{}.{}",
                chrono::Utc::now().timestamp(),
                extension_for(format)
            ))
        });
    let mut clone = params.clone();
    clone["file_id"] = Value::String(file_name.to_string_lossy().to_string());
    write_file(config, &clone)
}

fn edit_file(config: &AgentConfig, params: &Value) -> Result<(String, Value)> {
    let path = policy::resolve_candidate(required_path(params, "file_id")?)?;
    require_grant(config, &path, "write")?;
    let mut content = fs::read_to_string(&path).context("edit supports UTF-8 text files")?;
    let replacements = params
        .get("replacements")
        .and_then(Value::as_array)
        .context("replacements required")?;
    if replacements.is_empty() || replacements.len() > 32 {
        bail!("invalid_replacement_count");
    }
    let mut applied = 0usize;
    for replacement in replacements {
        let old = replacement
            .get("old_text")
            .and_then(Value::as_str)
            .context("old_text required")?;
        let new = replacement
            .get("new_text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if old.is_empty() {
            bail!("empty_old_text");
        }
        let count = content.matches(old).count();
        if count == 0 {
            bail!("replacement_text_not_found");
        }
        content = content.replace(old, new);
        applied += count;
    }
    write_atomic(&path, content.as_bytes())?;
    Ok((
        format!("applied {applied} replacements to {}", path.display()),
        json!({ "path": path, "replacements": applied }),
    ))
}

fn copy_file(config: &AgentConfig, params: &Value) -> Result<(String, Value)> {
    let source = policy::resolve_candidate(required_path(params, "from")?)?;
    let target = policy::resolve_candidate(required_path(params, "to")?)?;
    require_grant(config, &source, "read")?;
    require_grant(config, &target, "write")?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(&source, &target)?;
    Ok((
        format!("copied {} to {}", source.display(), target.display()),
        json!({ "from": source, "to": target }),
    ))
}

fn move_file(config: &AgentConfig, params: &Value) -> Result<(String, Value)> {
    let source = policy::resolve_candidate(required_path(params, "from")?)?;
    let target = policy::resolve_candidate(required_path(params, "to")?)?;
    require_grant(config, &source, "write")?;
    require_grant(config, &target, "write")?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&source, &target)?;
    Ok((
        format!("moved {} to {}", source.display(), target.display()),
        json!({ "from": source, "to": target }),
    ))
}

fn delete_file(config: &AgentConfig, params: &Value) -> Result<(String, Value)> {
    let path = policy::resolve_candidate(required_path(params, "file_id")?)?;
    require_grant(config, &path, "write")?;
    if path.is_dir() {
        bail!("recursive_directory_delete_not_supported");
    }
    fs::remove_file(&path)?;
    Ok((
        format!("deleted {}", path.display()),
        json!({ "path": path }),
    ))
}

fn process_exec(config: &AgentConfig, params: &Value) -> Result<(String, Value)> {
    let program = params
        .get("program")
        .and_then(Value::as_str)
        .context("program required")?;
    let args = params
        .get("args")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    item.as_str()
                        .map(str::to_string)
                        .context("args must be strings")
                })
                .collect::<Result<Vec<_>>>()
        })
        .transpose()?
        .unwrap_or_default();
    let cwd = params
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| default_root(config));
    if params
        .get("elevated")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let result = elevation::run_with_os_confirmation(
            config,
            program,
            &args,
            &cwd,
            duration_param(params),
        )?;
        if !result.success {
            bail!(
                "{}\n{}",
                result.error.as_deref().unwrap_or("elevated_command_failed"),
                result.stderr
            );
        }
        return Ok((
            result.output,
            json!({
                "program": program,
                "cwd": cwd,
                "exitCode": result.exit_code,
                "elevated": true
            }),
        ));
    }
    run_command(config, program, &args, &cwd, duration_param(params))
}

fn shell(config: &AgentConfig, params: &Value) -> Result<(String, Value)> {
    let elevated = params
        .get("elevated")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let script = params
        .get("script")
        .and_then(Value::as_str)
        .context("script required")?;
    let cwd = params
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| default_root(config));
    #[cfg(windows)]
    let (program, args) = (
        "powershell.exe",
        vec![
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            script.into(),
        ],
    );
    #[cfg(not(windows))]
    let (program, args) = ("/bin/sh", vec!["-lc".into(), script.into()]);
    if elevated {
        let result = elevation::run_with_os_confirmation(
            config,
            program,
            &args,
            &cwd,
            duration_param(params),
        )?;
        if !result.success {
            bail!(
                "{}\n{}",
                result.error.as_deref().unwrap_or("elevated_command_failed"),
                result.stderr
            );
        }
        return Ok((
            result.output,
            json!({
                "program": program,
                "cwd": cwd,
                "exitCode": result.exit_code,
                "elevated": true
            }),
        ));
    }
    run_command(config, program, &args, &cwd, duration_param(params))
}

fn run_command(
    config: &AgentConfig,
    program: &str,
    args: &[String],
    cwd: &Path,
    timeout: Duration,
) -> Result<(String, Value)> {
    let cwd = policy::resolve_candidate(cwd)?;
    require_grant(config, &cwd, "execute")?;
    let mut child = Command::new(program)
        .args(args)
        .current_dir(&cwd)
        .env_remove("RAI_TOKEN")
        .env_remove("OPENAI_API_KEY")
        .env_remove("ANTHROPIC_API_KEY")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("start {program}"))?;
    let stdout = child.stdout.take().context("stdout pipe unavailable")?;
    let stderr = child.stderr.take().context("stderr pipe unavailable")?;
    let stdout_reader = thread::spawn(move || read_limited(stdout, MAX_PROCESS_OUTPUT_BYTES));
    let stderr_reader = thread::spawn(move || read_limited(stderr, MAX_PROCESS_OUTPUT_BYTES));
    let status = match child.wait_timeout(timeout)? {
        Some(status) => status,
        None => {
            child.kill()?;
            child.wait()?;
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            bail!("command_timeout");
        }
    };
    let (stdout, stdout_truncated) = stdout_reader
        .join()
        .map_err(|_| anyhow::anyhow!("stdout_reader_panicked"))??;
    let (stderr, stderr_truncated) = stderr_reader
        .join()
        .map_err(|_| anyhow::anyhow!("stderr_reader_panicked"))??;
    let stdout = String::from_utf8_lossy(&stdout).to_string();
    let stderr_text = String::from_utf8_lossy(&stderr).to_string();
    let combined = if stderr_text.is_empty() {
        stdout.clone()
    } else {
        format!("{stdout}\n[stderr]\n{stderr_text}")
    };
    if !status.success() {
        let mut error = format!(
            "command_failed:{}\n{}",
            status.code().unwrap_or(-1),
            combined
        );
        if stdout_truncated || stderr_truncated {
            error.push_str(CAPTURE_TRUNCATION_MARKER);
        }
        bail!("{error}");
    }
    Ok((
        combined,
        json!({
            "program": program,
            "cwd": cwd,
            "exitCode": status.code(),
            "outputTruncatedAtCapture": stdout_truncated || stderr_truncated
        }),
    ))
}

fn read_limited<R: Read>(mut reader: R, limit: usize) -> Result<(Vec<u8>, bool)> {
    let mut output = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0u8; 16 * 1024];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        if output.len() < limit {
            let remaining = limit - output.len();
            output.extend_from_slice(&buffer[..count.min(remaining)]);
            truncated |= count > remaining;
        } else {
            truncated = true;
        }
    }
    Ok((output, truncated))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("rai-agent-{}.tmp", std::process::id()));
    let mut file = fs::File::create(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn require_grant(config: &AgentConfig, path: &Path, action: &str) -> Result<()> {
    if !is_within_any_grant(config, path, action) {
        bail!("path_outside_granted_roots:{}", path.display());
    }
    Ok(())
}

fn required_path(params: &Value, key: &str) -> Result<PathBuf> {
    path_param(params, key).with_context(|| format!("{key} required"))
}

fn path_param(params: &Value, key: &str) -> Option<PathBuf> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
}

fn default_root(config: &AgentConfig) -> PathBuf {
    config
        .grants
        .first()
        .map(|grant| grant.root.clone())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn duration_param(params: &Value) -> Duration {
    Duration::from_secs(
        params
            .get("timeout_seconds")
            .and_then(Value::as_u64)
            .unwrap_or(60)
            .clamp(1, 300),
    )
}

fn extension_for(format: &str) -> &str {
    match format {
        "markdown" => "md",
        "json" => "json",
        "csv" => "csv",
        _ => "txt",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AgentConfig, Grant};
    use base64::Engine as _;

    fn config(root: PathBuf) -> AgentConfig {
        AgentConfig {
            device_seed: base64::engine::general_purpose::STANDARD.encode([7u8; 32]),
            device_name: "test".into(),
            sensitive_mode: "strict".into(),
            dangerous_shell_always: false,
            shell_always_roots: Vec::new(),
            allowed_origins: Vec::new(),
            grants: vec![Grant {
                root,
                actions: vec!["read".into(), "write".into(), "execute".into()],
                created_at: 0,
            }],
            trusted_servers: Vec::new(),
        }
    }

    #[test]
    fn writes_and_reads_text() {
        let temp = tempfile::tempdir().unwrap();
        let cfg = config(temp.path().to_path_buf());
        let written = execute(
            &cfg,
            "write_file",
            &json!({"file_id":temp.path().join("a.txt"),"content":"hello"}),
        );
        assert!(written.success, "{:?}", written.error);
        let read = execute(
            &cfg,
            "read_file",
            &json!({"file_id":temp.path().join("a.txt")}),
        );
        assert!(read.success);
        assert_eq!(read.output, "hello");
    }

    #[cfg(unix)]
    #[test]
    fn drains_large_process_output_without_pipe_deadlock() {
        let temp = tempfile::tempdir().unwrap();
        let cfg = config(temp.path().to_path_buf());
        let result = run_command(
            &cfg,
            "/bin/sh",
            &["-c".into(), "yes x | head -c 2097152".into()],
            temp.path(),
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(result.0.len(), 2 * 1024 * 1024);
    }

    #[test]
    fn failure_hides_capture_truncation_marker_from_user_output() {
        let result = ToolOutput::failure(
            format!("command_failed:1{CAPTURE_TRUNCATION_MARKER}"),
            Instant::now(),
        );
        assert!(result.truncated);
        assert!(!result.full_output_available);
        assert_eq!(result.error.as_deref(), Some("command_failed:1"));
    }
}
