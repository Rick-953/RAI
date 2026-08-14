use crate::config::{AgentConfig, config_path, set_owner_only};
use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, Signer, Verifier};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;
use uuid::Uuid;
use wait_timeout::ChildExt;

const REQUEST_TTL_SECONDS: i64 = 60;
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ElevatedRequest {
    schema: String,
    nonce: String,
    issued_at: i64,
    expires_at: i64,
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
    signature: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevatedResult {
    pub success: bool,
    pub output: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

pub fn run_with_os_confirmation(
    config: &AgentConfig,
    program: &str,
    args: &[String],
    cwd: &Path,
    timeout: Duration,
) -> Result<ElevatedResult> {
    let executable = std::env::current_exe()?.canonicalize()?;
    let config_file = config_path()?.canonicalize()?;
    let temp = tempfile::Builder::new().prefix("rai-elevated-").tempdir()?;
    set_owner_only(temp.path(), true)?;
    let request_path = temp.path().join("request.json");
    let response_path = temp.path().join("response.json");
    let now = chrono::Utc::now().timestamp();
    let mut request = ElevatedRequest {
        schema: "rai-elevated-request/v1".into(),
        nonce: Uuid::new_v4().to_string(),
        issued_at: now,
        expires_at: now + REQUEST_TTL_SECONDS,
        program: program.to_string(),
        args: args.to_vec(),
        cwd: cwd.to_path_buf(),
        signature: String::new(),
    };
    request.signature = STANDARD.encode(
        config
            .signing_key()?
            .sign(canonical_unsigned(&request)?.as_bytes())
            .to_bytes(),
    );
    write_new_owner_only(&request_path, &serde_json::to_vec(&request)?)?;
    write_new_owner_only(&response_path, &[])?;
    invoke_system_prompt(
        &executable,
        &request_path,
        &response_path,
        &config_file,
        timeout,
    )?;
    let bytes = fs::read(&response_path).context("elevated worker did not return a result")?;
    let result: ElevatedResult =
        serde_json::from_slice(&bytes).context("invalid elevated result")?;
    Ok(result)
}

pub fn run_worker(request_path: &Path, response_path: &Path, config_path: &Path) -> Result<()> {
    let config = AgentConfig::load_from(config_path)?;
    let bytes = fs::read(request_path).context("read elevated request")?;
    let request: ElevatedRequest =
        serde_json::from_slice(&bytes).context("parse elevated request")?;
    if request.schema != "rai-elevated-request/v1" || Uuid::parse_str(&request.nonce).is_err() {
        bail!("invalid_elevated_request");
    }
    let now = chrono::Utc::now().timestamp();
    if request.expires_at < now
        || request.issued_at > now + 5
        || request.expires_at - request.issued_at > REQUEST_TTL_SECONDS
    {
        bail!("elevated_request_expired");
    }
    let signature = Signature::from_slice(&STANDARD.decode(&request.signature)?)?;
    config
        .verifying_key()?
        .verify(canonical_unsigned(&request)?.as_bytes(), &signature)
        .context("elevated_request_signature_invalid")?;
    if !response_path.exists() || fs::metadata(response_path)?.len() != 0 {
        bail!("elevated_request_replayed");
    }
    let result = execute(&request);
    write_existing(response_path, &serde_json::to_vec(&result)?)?;
    Ok(())
}

fn execute(request: &ElevatedRequest) -> ElevatedResult {
    let outcome = Command::new(&request.program)
        .args(&request.args)
        .current_dir(&request.cwd)
        .env_remove("RAI_TOKEN")
        .env_remove("OPENAI_API_KEY")
        .env_remove("ANTHROPIC_API_KEY")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match outcome {
        Ok(child) => child,
        Err(error) => return failed(format!("start_elevated_command:{error}")),
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out = thread::spawn(move || stdout.map(read_pipe).unwrap_or_default());
    let err = thread::spawn(move || stderr.map(read_pipe).unwrap_or_default());
    let status = match child.wait_timeout(Duration::from_secs(300)) {
        Ok(Some(status)) => status,
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            return failed("elevated_command_timeout".into());
        }
        Err(error) => return failed(format!("elevated_wait_failed:{error}")),
    };
    let output = String::from_utf8_lossy(&out.join().unwrap_or_default()).to_string();
    let stderr = String::from_utf8_lossy(&err.join().unwrap_or_default()).to_string();
    ElevatedResult {
        success: status.success(),
        output,
        stderr,
        exit_code: status.code(),
        error: (!status.success())
            .then(|| format!("elevated_command_failed:{}", status.code().unwrap_or(-1))),
    }
}

fn invoke_system_prompt(
    executable: &Path,
    request: &Path,
    response: &Path,
    config: &Path,
    timeout: Duration,
) -> Result<()> {
    let args = vec![
        "elevated-worker".to_string(),
        "--request".to_string(),
        request.to_string_lossy().to_string(),
        "--response".to_string(),
        response.to_string_lossy().to_string(),
        "--config".to_string(),
        config.to_string_lossy().to_string(),
    ];

    #[cfg(target_os = "macos")]
    let mut child = {
        let command = std::iter::once(executable.to_string_lossy().to_string())
            .chain(args.clone())
            .map(|part| shell_quote(&part))
            .collect::<Vec<_>>()
            .join(" ");
        let script = format!(
            "do shell script \"{}\" with administrator privileges",
            apple_script_escape(&command)
        );
        Command::new("osascript").args(["-e", &script]).spawn()?
    };
    #[cfg(target_os = "linux")]
    let mut child = Command::new("pkexec").arg(executable).args(&args).spawn()?;
    #[cfg(target_os = "windows")]
    let mut child = {
        let argument_list = args
            .iter()
            .map(|part| format!("'{}'", part.replace('\'', "''")))
            .collect::<Vec<_>>()
            .join(",");
        let script = format!(
            "$p=Start-Process -FilePath '{}' -ArgumentList @({}) -Verb RunAs -Wait -PassThru; exit $p.ExitCode",
            executable.to_string_lossy().replace('\'', "''"),
            argument_list
        );
        Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .spawn()?
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    bail!("elevation_platform_unsupported");

    match child.wait_timeout(timeout + Duration::from_secs(70))? {
        Some(status) if status.success() => Ok(()),
        Some(_) => bail!("os_elevation_denied_or_failed"),
        None => {
            child.kill()?;
            child.wait()?;
            bail!("os_elevation_confirmation_timeout")
        }
    }
}

fn read_pipe(pipe: impl std::io::Read) -> Vec<u8> {
    let mut output = Vec::new();
    let _ = pipe.take(MAX_OUTPUT_BYTES as u64).read_to_end(&mut output);
    output
}

fn failed(error: String) -> ElevatedResult {
    ElevatedResult {
        success: false,
        output: String::new(),
        stderr: String::new(),
        exit_code: None,
        error: Some(error),
    }
}

fn write_new_owner_only(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    set_owner_only(path, false)?;
    Ok(())
}

fn write_existing(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new().write(true).truncate(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn canonical_unsigned(request: &ElevatedRequest) -> Result<String> {
    let mut value = serde_json::to_value(request)?;
    value
        .as_object_mut()
        .context("request must be object")?
        .remove("signature");
    Ok(serde_json::to_string(&canonicalize(&value))?)
}

fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        Value::Object(items) => Value::Object(
            items
                .iter()
                .map(|(key, value)| (key.clone(), canonicalize(value)))
                .collect::<std::collections::BTreeMap<_, _>>()
                .into_iter()
                .collect::<Map<_, _>>(),
        ),
        _ => value.clone(),
    }
}

#[cfg(unix)]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(target_os = "macos")]
fn apple_script_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}
