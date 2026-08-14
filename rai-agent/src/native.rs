use crate::audit::{AuditEntry, AuditLog};
use crate::config::{AgentConfig, TrustedServer};
use crate::policy;
use crate::tools::{self, ToolOutput};
use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ed25519_dalek::pkcs8::{DecodePublicKey, EncodePublicKey};
use ed25519_dalek::{Signature, Signer, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{self, Read, Write};
use std::path::PathBuf;

const MAX_NATIVE_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_TRANSPORT_RESULT_BYTES: usize = 512 * 1024;
const TRANSPORT_TEXT_BUDGET_BYTES: usize = 384 * 1024;
const TRANSPORT_TRUNCATION_MARKER: &str = "\n\n[RAI_LOCAL_OUTPUT_TRUNCATED_FOR_TRANSPORT]\n\n";

#[derive(Debug, Deserialize)]
struct Request {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: String,
    ok: bool,
    result: Value,
    error: Option<String>,
}

pub struct NativeHost {
    config: AgentConfig,
    audit: AuditLog,
    pending_browser: HashMap<String, Value>,
    active_runs: HashSet<String>,
}

impl NativeHost {
    pub fn new(origin: Option<&str>) -> Result<Self> {
        let config = AgentConfig::load_or_create()?;
        if let Some(origin) = origin {
            if !config.allowed_origins.is_empty()
                && !config.allowed_origins.iter().any(|item| item == origin)
            {
                bail!("native_origin_not_allowed");
            }
            if !origin.starts_with("chrome-extension://") || !origin.ends_with('/') {
                bail!("invalid_native_origin");
            }
        }
        let audit = AuditLog::open(&config)?;
        Ok(Self {
            config,
            audit,
            pending_browser: HashMap::new(),
            active_runs: HashSet::new(),
        })
    }

    pub fn run(mut self) -> Result<()> {
        let mut input = io::stdin().lock();
        let mut output = io::stdout().lock();
        loop {
            let Some(value) = read_message(&mut input)? else {
                break;
            };
            let request: Request = match serde_json::from_value(value) {
                Ok(request) => request,
                Err(error) => {
                    write_message(
                        &mut output,
                        &Response {
                            id: String::new(),
                            ok: false,
                            result: json!({}),
                            error: Some(format!("invalid_request:{error}")),
                        },
                    )?;
                    continue;
                }
            };
            let id = request.id.clone();
            let response = match self.handle(request) {
                Ok(result) => Response {
                    id,
                    ok: true,
                    result,
                    error: None,
                },
                Err(error) => Response {
                    id,
                    ok: false,
                    result: json!({}),
                    error: Some(format!("{error:#}")),
                },
            };
            write_message(&mut output, &response)?;
        }
        Ok(())
    }

    fn handle(&mut self, request: Request) -> Result<Value> {
        match request.kind.as_str() {
            "hello" | "device.info" => self.device_info(),
            "pair.sign" | "session.sign" => self.sign_challenge(&request.payload),
            "server.trust" => self.trust_server(&request.payload),
            "tool.execute" => self.execute_tool(&request.payload),
            "tool.reject" => self.reject_tool(&request.payload),
            "browser.complete" => self.complete_browser(&request.payload),
            "logs.recent" => {
                let limit = request
                    .payload
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(100)
                    .clamp(1, 500) as usize;
                Ok(json!({ "entries": self.audit.recent(limit)? }))
            }
            "permissions.list" => Ok(json!({
                "roots": self.config.grants,
                "sensitiveMode": self.config.sensitive_mode,
                "shellAlwaysRoots": self.config.shell_always_roots
            })),
            "permissions.revoke" => self.revoke_permission(&request.payload),
            _ => bail!("unsupported_native_request:{}", request.kind),
        }
    }

    fn device_info(&self) -> Result<Value> {
        Ok(json!({
            "protocolVersion": 1,
            "agentVersion": env!("CARGO_PKG_VERSION"),
            "name": self.config.device_name,
            "platform": platform_name(),
            "publicKey": self.config.public_key_spki_base64()?,
            "fingerprint": self.config.fingerprint()?,
            "capabilities": ["filesystem", "process", "browser", "audit"]
        }))
    }

    fn sign_challenge(&self, payload: &Value) -> Result<Value> {
        let challenge = payload
            .get("challenge")
            .and_then(Value::as_str)
            .context("challenge required")?;
        if challenge.len() < 16 || challenge.len() > 256 {
            bail!("invalid_challenge");
        }
        let signature = self.config.signing_key()?.sign(challenge.as_bytes());
        Ok(json!({ "challenge": challenge, "signature": STANDARD.encode(signature.to_bytes()) }))
    }

    fn trust_server(&mut self, payload: &Value) -> Result<Value> {
        if payload.get("confirmed").and_then(Value::as_bool) != Some(true) {
            bail!("server_trust_confirmation_required");
        }
        let issuer = payload
            .get("issuer")
            .and_then(Value::as_str)
            .context("issuer required")?;
        let key_id = payload
            .get("keyId")
            .and_then(Value::as_str)
            .context("keyId required")?;
        let public_key_pem = payload
            .get("publicKeyPem")
            .and_then(Value::as_str)
            .context("publicKeyPem required")?;
        let key = VerifyingKey::from_public_key_pem(public_key_pem)
            .context("invalid server public key")?;
        let der = key.to_public_key_der()?;
        let calculated = hex::encode(Sha256::digest(der.as_bytes()));
        if calculated != key_id {
            bail!("server_key_fingerprint_mismatch");
        }
        self.config.trust_server(TrustedServer {
            issuer: issuer.to_string(),
            key_id: key_id.to_string(),
            public_key_pem: public_key_pem.to_string(),
        })?;
        Ok(json!({ "trusted": true, "keyId": key_id }))
    }

    fn execute_tool(&mut self, payload: &Value) -> Result<Value> {
        let envelope = payload.get("envelope").context("envelope required")?;
        self.verify_envelope(envelope)?;
        let run_id = required_string(envelope, "runId")?;
        if self.active_runs.contains(run_id) || self.audit.contains_run_id(run_id)? {
            bail!("tool_envelope_replayed");
        }
        let tool = envelope
            .get("tool")
            .and_then(Value::as_str)
            .context("tool required")?;
        let params = envelope
            .get("parameters")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let decision = policy::evaluate(&self.config, tool, &params)?;
        let approval = payload
            .get("approval")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if (!decision.allowed || decision.requires_approval)
            && !matches!(approval, "once" | "always")
        {
            return Ok(json!({
                "status": "approval_required",
                "risk": decision.risk,
                "reason": decision.reason,
                "path": decision.resolved_path,
                "tool": tool,
                "parameters": params
            }));
        }
        if approval == "always" {
            if matches!(tool, "sandbox_exec" | "process.shell") {
                let cwd = params
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        self.config
                            .grants
                            .first()
                            .map(|grant| grant.root.clone())
                            .unwrap_or_else(|| PathBuf::from("."))
                    });
                policy::add_shell_grant(&mut self.config, &cwd)?;
            } else if let Some(root) = payload.get("grantRoot").and_then(Value::as_str) {
                policy::add_grant(&mut self.config, &PathBuf::from(root))?;
            }
        }
        if tool.starts_with("browser.") {
            let token = browser_token(envelope, &self.config.device_seed);
            self.active_runs.insert(run_id.to_string());
            self.pending_browser.insert(token.clone(), envelope.clone());
            return Ok(
                json!({ "status": "browser_authorized", "authorizationToken": token, "tool": tool, "parameters": params }),
            );
        }
        let result = tools::execute(&self.config, tool, &params);
        self.finish_local(envelope, tool, &params, result)
    }

    fn complete_browser(&mut self, payload: &Value) -> Result<Value> {
        let token = payload
            .get("authorizationToken")
            .and_then(Value::as_str)
            .context("authorizationToken required")?;
        let envelope = self
            .pending_browser
            .remove(token)
            .context("browser_authorization_expired")?;
        let result_value = payload
            .get("result")
            .cloned()
            .unwrap_or_else(|| json!({ "success": false, "error": "browser_result_missing" }));
        let output = ToolOutput {
            success: result_value
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            output: result_value
                .get("output")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            stderr: result_value
                .get("stderr")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            exit_code: result_value
                .get("exit_code")
                .and_then(Value::as_i64)
                .map(|value| value as i32),
            error: result_value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string),
            full_output_available: true,
            truncated: false,
            output_sha256: hex::encode(Sha256::digest(canonical_json(&result_value).as_bytes())),
            duration_ms: result_value
                .get("duration_ms")
                .and_then(Value::as_u64)
                .unwrap_or(0) as u128,
            extra: json!({}),
        };
        let tool = envelope
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or("browser.unknown")
            .to_string();
        let params = envelope
            .get("parameters")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let run_id = required_string(&envelope, "runId")?.to_string();
        let result = self.finish_local(&envelope, &tool, &params, output);
        self.active_runs.remove(&run_id);
        result
    }

    fn reject_tool(&self, payload: &Value) -> Result<Value> {
        let envelope = payload.get("envelope").context("envelope required")?;
        self.verify_envelope(envelope)?;
        if self
            .audit
            .contains_run_id(required_string(envelope, "runId")?)?
        {
            bail!("tool_envelope_replayed");
        }
        let tool = required_string(envelope, "tool")?;
        let params = envelope
            .get("parameters")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let error = payload
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("user_rejected_local_action");
        let result = ToolOutput {
            success: false,
            output: String::new(),
            stderr: String::new(),
            exit_code: None,
            error: Some(error.to_string()),
            full_output_available: true,
            truncated: false,
            output_sha256: hex::encode(Sha256::digest(error.as_bytes())),
            duration_ms: 0,
            extra: json!({}),
        };
        self.finish_local(envelope, tool, &params, result)
    }

    fn finish_local(
        &self,
        envelope: &Value,
        tool: &str,
        params: &Value,
        result: ToolOutput,
    ) -> Result<Value> {
        let run_id = required_string(envelope, "runId")?;
        let audit_result = serde_json::to_value(&result)?;
        self.audit.append(&AuditEntry {
            run_id: run_id.to_string(),
            tool: tool.to_string(),
            timestamp: chrono::Utc::now().timestamp(),
            duration_ms: result.duration_ms,
            success: result.success,
            input_summary: redact(&canonical_json(params)),
            result: audit_result.clone(),
        })?;
        let result_value = transport_result(audit_result)?;
        let receipt = self.sign_receipt(envelope, &result_value)?;
        Ok(
            json!({ "status": "complete", "runId": run_id, "receipt": receipt, "result": result_value }),
        )
    }

    fn sign_receipt(&self, envelope: &Value, result: &Value) -> Result<Value> {
        let mut receipt = json!({
            "schema": "rai-local-agent-result/v1",
            "runId": required_string(envelope, "runId")?,
            "agentSessionId": required_string(envelope, "agentSessionId")?,
            "deviceId": required_string(envelope, "deviceId")?,
            "toolCallId": required_string(envelope, "toolCallId")?,
            "sequence": envelope.get("sequence").and_then(Value::as_u64).context("sequence required")?,
            "completedAt": chrono::Utc::now().timestamp(),
            "resultSha256": hex::encode(Sha256::digest(canonical_json(result).as_bytes()))
        });
        let signature = self
            .config
            .signing_key()?
            .sign(canonical_json(&receipt).as_bytes());
        receipt["signature"] = Value::String(STANDARD.encode(signature.to_bytes()));
        Ok(receipt)
    }

    fn verify_envelope(&self, envelope: &Value) -> Result<()> {
        if envelope.get("schema").and_then(Value::as_str) != Some("rai-local-agent-tool/v1") {
            bail!("invalid_tool_envelope_schema");
        }
        if envelope.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
            bail!("unsupported_tool_protocol");
        }
        let expires_at = envelope
            .get("expiresAt")
            .and_then(Value::as_i64)
            .context("expiresAt required")?;
        if expires_at < chrono::Utc::now().timestamp() {
            bail!("tool_envelope_expired");
        }
        let key_id = required_string(envelope, "keyId")?;
        let issuer = required_string(envelope, "issuer")?;
        let trusted = self
            .config
            .trusted_servers
            .iter()
            .find(|item| item.key_id == key_id && item.issuer == issuer)
            .context("server_key_not_trusted")?;
        let signature_text = required_string(envelope, "signature")?;
        let signature_bytes = STANDARD.decode(signature_text)?;
        let signature = Signature::from_slice(&signature_bytes)?;
        let mut unsigned = envelope.clone();
        unsigned
            .as_object_mut()
            .context("envelope must be object")?
            .remove("signature");
        let key = VerifyingKey::from_public_key_pem(&trusted.public_key_pem)?;
        key.verify(canonical_json(&unsigned).as_bytes(), &signature)
            .context("tool_envelope_signature_invalid")?;
        Ok(())
    }

    fn revoke_permission(&mut self, payload: &Value) -> Result<Value> {
        if payload.get("dangerousShell").and_then(Value::as_bool) == Some(true) {
            self.config.dangerous_shell_always = false;
            self.config.shell_always_roots.clear();
        }
        if let Some(root) = payload.get("root").and_then(Value::as_str) {
            let root = policy::resolve_candidate(root)?;
            self.config.grants.retain(|grant| grant.root != root);
        }
        self.config.save()?;
        Ok(json!({ "revoked": true }))
    }
}

fn read_message(reader: &mut impl Read) -> Result<Option<Value>> {
    let mut length = [0u8; 4];
    match reader.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_NATIVE_MESSAGE_BYTES {
        bail!("native_message_size_invalid");
    }
    let mut buffer = vec![0u8; length];
    reader.read_exact(&mut buffer)?;
    Ok(Some(serde_json::from_slice(&buffer)?))
}

fn write_message(writer: &mut impl Write, response: &Response) -> Result<()> {
    let bytes = serde_json::to_vec(response)?;
    if bytes.len() > MAX_NATIVE_MESSAGE_BYTES {
        bail!("native_response_too_large");
    }
    writer.write_all(&(bytes.len() as u32).to_le_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()?;
    Ok(())
}

fn transport_result(mut result: Value) -> Result<Value> {
    if serde_json::to_vec(&result)?.len() <= MAX_TRANSPORT_RESULT_BYTES {
        return Ok(result);
    }
    let output = result
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let stderr = result
        .get("stderr")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let error = result
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let error_budget = error.len().min(16 * 1024);
    let remaining = TRANSPORT_TEXT_BUDGET_BYTES.saturating_sub(error_budget);
    let stderr_budget = if output.len() <= remaining * 3 / 4 {
        remaining.saturating_sub(output.len())
    } else {
        stderr.len().min(remaining / 4)
    };
    let output_budget = remaining.saturating_sub(stderr_budget);
    result["output"] = Value::String(truncate_utf8_middle(&output, output_budget));
    result["stderr"] = Value::String(truncate_utf8_middle(&stderr, stderr_budget));
    if !error.is_empty() {
        result["error"] = Value::String(truncate_utf8_middle(&error, error_budget));
    }
    result["truncated"] = Value::Bool(true);

    while serde_json::to_vec(&result)?.len() > MAX_TRANSPORT_RESULT_BYTES {
        let current = result
            .get("output")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let next_budget = current.len().saturating_mul(3) / 4;
        if next_budget == 0 {
            break;
        }
        result["output"] = Value::String(truncate_utf8_middle(&current, next_budget));
    }
    if serde_json::to_vec(&result)?.len() > MAX_TRANSPORT_RESULT_BYTES {
        result["stderr"] = Value::String(String::new());
        result["error"] = Value::String(truncate_utf8_middle(&error, 4096));
        result["extra"] = json!({ "transportMetadataOmitted": true });
    }
    if serde_json::to_vec(&result)?.len() > MAX_TRANSPORT_RESULT_BYTES {
        bail!("native_transport_result_too_large");
    }
    Ok(result)
}

fn truncate_utf8_middle(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    if max_bytes <= TRANSPORT_TRUNCATION_MARKER.len() {
        return String::new();
    }
    let content_budget = max_bytes - TRANSPORT_TRUNCATION_MARKER.len();
    let head_budget = content_budget / 2;
    let tail_budget = content_budget - head_budget;
    let mut head_end = head_budget.min(value.len());
    while head_end > 0 && !value.is_char_boundary(head_end) {
        head_end -= 1;
    }
    let mut tail_start = value.len().saturating_sub(tail_budget);
    while tail_start < value.len() && !value.is_char_boundary(tail_start) {
        tail_start += 1;
    }
    format!(
        "{}{}{}",
        &value[..head_end],
        TRANSPORT_TRUNCATION_MARKER,
        &value[tail_start..]
    )
}

fn canonical_json(value: &Value) -> String {
    serde_json::to_string(&canonicalize(value)).expect("serialize canonical json")
}

fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        Value::Object(items) => {
            let sorted = items
                .iter()
                .map(|(key, value)| (key.clone(), canonicalize(value)))
                .collect::<BTreeMap<_, _>>();
            Value::Object(sorted.into_iter().collect::<Map<_, _>>())
        }
        _ => value.clone(),
    }
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("{key} required"))
}

fn browser_token(envelope: &Value, secret: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(canonical_json(envelope));
    hasher.update(secret.as_bytes());
    hex::encode(hasher.finalize())
}

fn redact(value: &str) -> String {
    let mut result = value.to_string();
    for label in [
        "token",
        "secret",
        "password",
        "authorization",
        "api_key",
        "apiKey",
    ] {
        if let Some(index) = result.to_lowercase().find(label) {
            let end = (index + 160).min(result.len());
            result.replace_range(index..end, "[REDACTED]");
        }
    }
    result.chars().take(4096).collect()
}

fn platform_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        "unsupported"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_json_sorts_nested_keys() {
        assert_eq!(
            canonical_json(&json!({"z":1,"a":{"y":2,"b":3}})),
            "{\"a\":{\"b\":3,\"y\":2},\"z\":1}"
        );
    }

    #[test]
    fn transport_result_stays_below_native_message_limit_and_marks_truncation() {
        let original = "引号\\\"\n".repeat(200_000);
        let result = json!({
            "success": true,
            "output": original,
            "stderr": "warning".repeat(20_000),
            "error": null,
            "fullOutputAvailable": true,
            "truncated": false,
            "extra": {}
        });
        let transported = transport_result(result).unwrap();
        assert!(serde_json::to_vec(&transported).unwrap().len() <= MAX_TRANSPORT_RESULT_BYTES);
        assert_eq!(transported["truncated"], true);
        assert!(
            transported["output"]
                .as_str()
                .unwrap()
                .contains(TRANSPORT_TRUNCATION_MARKER)
        );
    }

    #[test]
    fn transport_result_preserves_small_results() {
        let result = json!({"success": true, "output": "hello", "stderr": ""});
        assert_eq!(transport_result(result.clone()).unwrap(), result);
    }
}
