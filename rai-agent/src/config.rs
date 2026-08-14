use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use directories::ProjectDirs;
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedServer {
    pub issuer: String,
    pub key_id: String,
    pub public_key_pem: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub root: PathBuf,
    pub actions: Vec<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub device_seed: String,
    pub device_name: String,
    pub sensitive_mode: String,
    pub dangerous_shell_always: bool,
    #[serde(default)]
    pub shell_always_roots: Vec<PathBuf>,
    #[serde(default)]
    pub allowed_origins: Vec<String>,
    pub grants: Vec<Grant>,
    pub trusted_servers: Vec<TrustedServer>,
}

impl AgentConfig {
    pub fn load_or_create() -> Result<Self> {
        let path = config_path()?;
        if path.exists() {
            return Self::load_from(&path);
        }

        let signing_key = SigningKey::generate(&mut OsRng);
        let home = directories::UserDirs::new()
            .map(|value| value.home_dir().to_path_buf())
            .context("home directory unavailable")?;
        let config = Self {
            device_seed: STANDARD.encode(signing_key.to_bytes()),
            device_name: default_device_name(),
            sensitive_mode: "strict".to_string(),
            dangerous_shell_always: false,
            shell_always_roots: Vec::new(),
            allowed_origins: Vec::new(),
            grants: vec![Grant {
                root: home,
                actions: vec!["read".into(), "write".into(), "execute".into()],
                created_at: chrono::Utc::now().timestamp(),
            }],
            trusted_servers: Vec::new(),
        };
        config.save()?;
        Ok(config)
    }

    pub fn load_from(path: &Path) -> Result<Self> {
        let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
        let config: Self = serde_json::from_slice(&bytes).context("parse agent config")?;
        config.signing_key()?;
        Ok(config)
    }

    pub fn save(&self) -> Result<()> {
        let path = config_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
            set_owner_only(parent, true)?;
        }
        let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
        let bytes = serde_json::to_vec_pretty(self)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, &path)?;
        set_owner_only(&path, false)?;
        Ok(())
    }

    pub fn signing_key(&self) -> Result<SigningKey> {
        let bytes = STANDARD
            .decode(&self.device_seed)
            .context("invalid device key")?;
        let seed: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid device seed length"))?;
        Ok(SigningKey::from_bytes(&seed))
    }

    pub fn verifying_key(&self) -> Result<VerifyingKey> {
        Ok(self.signing_key()?.verifying_key())
    }

    pub fn public_key_spki_base64(&self) -> Result<String> {
        let mut spki = hex::decode("302a300506032b6570032100")?;
        spki.extend_from_slice(self.verifying_key()?.as_bytes());
        Ok(STANDARD.encode(spki))
    }

    pub fn fingerprint(&self) -> Result<String> {
        let decoded = STANDARD.decode(self.public_key_spki_base64()?)?;
        Ok(hex::encode(Sha256::digest(decoded)))
    }

    pub fn trust_server(&mut self, server: TrustedServer) -> Result<()> {
        if !server.issuer.starts_with("https://") && !server.issuer.starts_with("http://localhost")
        {
            bail!("untrusted server issuer");
        }
        self.trusted_servers
            .retain(|item| item.issuer != server.issuer && item.key_id != server.key_id);
        self.trusted_servers.push(server);
        self.save()
    }
}

pub fn project_dirs() -> Result<ProjectDirs> {
    ProjectDirs::from("sarl", "RAI", "RAI Agent").context("application data directory unavailable")
}

pub fn config_path() -> Result<PathBuf> {
    Ok(project_dirs()?.config_dir().join("config.json"))
}

pub fn data_dir() -> Result<PathBuf> {
    Ok(project_dirs()?.data_dir().to_path_buf())
}

pub fn set_owner_only(path: &Path, directory: bool) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
        )?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, directory);
    }
    Ok(())
}

fn default_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "RAI Agent".to_string())
        .chars()
        .take(100)
        .collect()
}
