use crate::config::{AgentConfig, data_dir, set_owner_only};
use aes_gcm::aead::{Aead, KeyInit, OsRng, rand_core::RngCore};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

const MAX_LOG_BYTES: u64 = 1024 * 1024 * 1024;
const RETENTION_SECONDS: i64 = 30 * 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub run_id: String,
    pub tool: String,
    pub timestamp: i64,
    pub duration_ms: u128,
    pub success: bool,
    pub input_summary: String,
    pub result: Value,
}

pub struct AuditLog {
    path: PathBuf,
    cipher: Aes256Gcm,
}

impl AuditLog {
    pub fn open(config: &AgentConfig) -> Result<Self> {
        let dir = data_dir()?.join("audit");
        fs::create_dir_all(&dir)?;
        set_owner_only(&dir, true)?;
        let seed = STANDARD.decode(&config.device_seed)?;
        let key = Sha256::digest([seed.as_slice(), b"rai-agent-audit-v1"].concat());
        let cipher = Aes256Gcm::new_from_slice(&key).expect("32 byte key");
        let log = Self {
            path: dir.join("activity.jsonl.enc"),
            cipher,
        };
        if log.path.exists() {
            set_owner_only(&log.path, false)?;
            log.compact_if_needed()?;
        }
        Ok(log)
    }

    pub fn append(&self, entry: &AuditEntry) -> Result<()> {
        let plaintext = serde_json::to_vec(entry)?;
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let ciphertext = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_slice())
            .map_err(|_| anyhow::anyhow!("audit encryption failed"))?;
        let line = serde_json::json!({
            "v": 1,
            "n": STANDARD.encode(nonce_bytes),
            "c": STANDARD.encode(ciphertext)
        });
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&self.path)?;
        writeln!(file, "{line}")?;
        file.flush()?;
        set_owner_only(&self.path, false)?;
        Ok(())
    }

    pub fn recent(&self, limit: usize) -> Result<Vec<AuditEntry>> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let cutoff = chrono::Utc::now().timestamp() - RETENTION_SECONDS;
        let file = fs::File::open(&self.path)?;
        let mut entries = BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter_map(|line| self.decrypt_line(&line).ok())
            .filter(|entry| entry.timestamp >= cutoff)
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.timestamp);
        if entries.len() > limit {
            entries.drain(..entries.len() - limit);
        }
        Ok(entries)
    }

    pub fn contains_run_id(&self, run_id: &str) -> Result<bool> {
        Ok(self
            .recent(10_000)?
            .iter()
            .any(|entry| entry.run_id == run_id))
    }

    fn decrypt_line(&self, line: &str) -> Result<AuditEntry> {
        let value: Value = serde_json::from_str(line)?;
        let nonce = STANDARD.decode(
            value
                .get("n")
                .and_then(Value::as_str)
                .context("audit nonce")?,
        )?;
        let ciphertext = STANDARD.decode(
            value
                .get("c")
                .and_then(Value::as_str)
                .context("audit ciphertext")?,
        )?;
        let plaintext = self
            .cipher
            .decrypt(Nonce::from_slice(&nonce), ciphertext.as_slice())
            .map_err(|_| anyhow::anyhow!("audit decryption failed"))?;
        Ok(serde_json::from_slice(&plaintext)?)
    }

    fn compact_if_needed(&self) -> Result<()> {
        if fs::metadata(&self.path)?.len() <= MAX_LOG_BYTES {
            return Ok(());
        }
        let entries = self.recent(10_000)?;
        let temporary = self.path.with_extension("compact");
        if temporary.exists() {
            fs::remove_file(&temporary)?;
        }
        let replacement = Self {
            path: temporary.clone(),
            cipher: self.cipher.clone(),
        };
        for entry in entries {
            replacement.append(&entry)?;
        }
        fs::rename(temporary, &self.path)?;
        Ok(())
    }
}
