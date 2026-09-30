use crate::config::{AgentConfig, set_owner_only};
use anyhow::{Context, Result, bail};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const HOST_NAME: &str = "com.rai.agent";

pub fn install(
    chrome_id: Option<&str>,
    edge_id: Option<&str>,
    open_store: bool,
) -> Result<Vec<PathBuf>> {
    let mut origins = Vec::new();
    if let Some(id) = chrome_id.filter(|id| valid_extension_id(id)) {
        origins.push(format!("chrome-extension://{id}/"));
    }
    if let Some(id) = edge_id.filter(|id| valid_extension_id(id)) {
        let origin = format!("chrome-extension://{id}/");
        if !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    if origins.is_empty() {
        bail!("at least one valid Chrome or Edge extension id is required");
    }
    let executable = std::env::current_exe()?.canonicalize()?;
    let manifest = json!({
        "name": HOST_NAME,
        "description": "RAI Local Agent",
        "path": executable,
        "type": "stdio",
        "allowed_origins": origins
    });
    let bytes = serde_json::to_vec_pretty(&manifest)?;
    let mut written = Vec::new();

    #[cfg(target_os = "macos")]
    {
        let home = directories::UserDirs::new()
            .context("home unavailable")?
            .home_dir()
            .to_path_buf();
        for relative in [
            "Library/Application Support/Google/Chrome/NativeMessagingHosts",
            "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
        ] {
            let path = home.join(relative).join(format!("{HOST_NAME}.json"));
            write_manifest(&path, &bytes)?;
            written.push(path);
        }
    }

    #[cfg(target_os = "linux")]
    {
        let home = directories::UserDirs::new()
            .context("home unavailable")?
            .home_dir()
            .to_path_buf();
        for relative in [
            ".config/google-chrome/NativeMessagingHosts",
            ".config/microsoft-edge/NativeMessagingHosts",
        ] {
            let path = home.join(relative).join(format!("{HOST_NAME}.json"));
            write_manifest(&path, &bytes)?;
            written.push(path);
        }
    }

    #[cfg(windows)]
    {
        use winreg::RegKey;
        use winreg::enums::HKEY_CURRENT_USER;
        let app_data = directories::BaseDirs::new()
            .context("base dirs unavailable")?
            .config_dir()
            .to_path_buf();
        let manifest_path = app_data
            .join("RAI")
            .join("Agent")
            .join(format!("{HOST_NAME}.json"));
        write_manifest(&manifest_path, &bytes)?;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for key in [
            format!(r"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"),
            format!(r"Software\Microsoft\Edge\NativeMessagingHosts\{HOST_NAME}"),
        ] {
            let (registry, _) = hkcu.create_subkey(key)?;
            registry.set_value("", &manifest_path.to_string_lossy().to_string())?;
        }
        written.push(manifest_path);
    }

    let mut config = AgentConfig::load_or_create()?;
    config.allowed_origins = origins;
    config.save()?;

    if open_store {
        if let Some(id) = chrome_id.filter(|id| valid_extension_id(id)) {
            let _ = webbrowser::open(&format!("https://chromewebstore.google.com/detail/{id}"));
        }
        if let Some(id) = edge_id.filter(|id| valid_extension_id(id)) {
            let _ = webbrowser::open(&format!(
                "https://microsoftedge.microsoft.com/addons/detail/{id}"
            ));
        }
        let _ = webbrowser::open("https://rai.rick.sarl/?local-agent=connect");
    }
    Ok(written)
}

pub fn uninstall(purge: bool) -> Result<Vec<PathBuf>> {
    let paths = manifest_paths()?;
    let mut removed = Vec::new();
    for path in paths {
        if path.exists() {
            fs::remove_file(&path)?;
            removed.push(path);
        }
    }
    #[cfg(windows)]
    {
        use winreg::RegKey;
        use winreg::enums::HKEY_CURRENT_USER;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for key in [
            format!(r"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"),
            format!(r"Software\Microsoft\Edge\NativeMessagingHosts\{HOST_NAME}"),
        ] {
            let _ = hkcu.delete_subkey_all(key);
        }
    }
    if purge {
        let project = crate::config::project_dirs()?;
        for path in [project.config_dir(), project.data_dir()] {
            if path.exists() {
                fs::remove_dir_all(path)?;
            }
        }
    }
    Ok(removed)
}

pub fn doctor() -> Result<serde_json::Value> {
    let config = AgentConfig::load_or_create()?;
    let executable = std::env::current_exe()?;
    let manifests = manifest_paths()?
        .into_iter()
        .map(|path| {
            json!({
                "path": path,
                "exists": path.exists()
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "ok": executable.exists() && !config.allowed_origins.is_empty(),
        "version": env!("CARGO_PKG_VERSION"),
        "executable": executable,
        "deviceFingerprint": config.fingerprint()?,
        "allowedOrigins": config.allowed_origins,
        "manifests": manifests
    }))
}

pub fn update() -> Result<()> {
    #[cfg(unix)]
    let status = Command::new("/bin/sh")
        .args([
            "-c",
            "curl --fail --location --proto '=https' --tlsv1.2 https://github.com/Rick-953/RAI/releases/latest/download/install.sh | /bin/sh",
        ])
        .status()?;
    #[cfg(windows)]
    let status = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-Command",
            "irm https://github.com/Rick-953/RAI/releases/latest/download/install.ps1 | iex",
        ])
        .status()?;
    #[cfg(not(any(unix, windows)))]
    bail!("update_platform_unsupported");
    if !status.success() {
        bail!("agent_update_failed");
    }
    Ok(())
}

pub fn rollback() -> Result<serde_json::Value> {
    let current = std::env::current_exe()?.canonicalize()?;
    let current_version_dir = current
        .parent()
        .context("current version directory unavailable")?;
    let versions = current_version_dir
        .parent()
        .context("versions directory unavailable")?;
    if versions.file_name().and_then(|value| value.to_str()) != Some("versions") {
        bail!("rollback_requires_managed_installation");
    }
    let mut candidates = fs::read_dir(versions)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && path != current_version_dir)
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.reverse();
    let selected = candidates.first().context("rollback_version_unavailable")?;
    let binary = selected.join(if cfg!(windows) {
        "rai-agent.exe"
    } else {
        "rai-agent"
    });
    if !binary.is_file() {
        bail!("rollback_binary_missing");
    }
    let install_root = versions.parent().context("installation root unavailable")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let temporary = install_root.join("current.rollback.tmp");
        if temporary.exists() {
            fs::remove_file(&temporary)?;
        }
        symlink(&binary, &temporary)?;
        fs::rename(&temporary, install_root.join("current"))?;
    }
    #[cfg(windows)]
    {
        let temporary = install_root.join("current.rollback.tmp");
        fs::write(&temporary, selected.to_string_lossy().as_bytes())?;
        replace_windows_file(&temporary, &install_root.join("current.txt"))?;
    }

    let config = AgentConfig::load_or_create()?;
    let ids = config
        .allowed_origins
        .iter()
        .filter_map(|origin| {
            origin
                .strip_prefix("chrome-extension://")
                .and_then(|value| value.strip_suffix('/'))
                .filter(|id| valid_extension_id(id))
                .map(str::to_string)
        })
        .collect::<Vec<_>>();
    let mut command = Command::new(&binary);
    command.arg("install");
    if let Some(id) = ids.first() {
        command.arg("--chrome-id").arg(id);
    }
    if let Some(id) = ids.get(1).or_else(|| ids.first()) {
        command.arg("--edge-id").arg(id);
    }
    if !command.status()?.success() {
        bail!("rollback_native_registration_failed");
    }
    Ok(json!({ "rolledBack": true, "binary": binary }))
}

#[cfg(windows)]
fn replace_windows_file(source: &Path, destination: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(std::io::Error::last_os_error()).context("replace current.txt");
    }
    Ok(())
}

fn write_manifest(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("manifest parent unavailable")?;
    fs::create_dir_all(parent)?;
    set_owner_only(parent, true)?;
    fs::write(path, bytes)?;
    set_owner_only(path, false)?;
    Ok(())
}

fn manifest_paths() -> Result<Vec<PathBuf>> {
    #[cfg(target_os = "macos")]
    {
        let home = directories::UserDirs::new()
            .context("home unavailable")?
            .home_dir()
            .to_path_buf();
        return Ok(vec![
            home.join("Library/Application Support/Google/Chrome/NativeMessagingHosts")
                .join(format!("{HOST_NAME}.json")),
            home.join("Library/Application Support/Microsoft Edge/NativeMessagingHosts")
                .join(format!("{HOST_NAME}.json")),
        ]);
    }
    #[cfg(target_os = "linux")]
    {
        let home = directories::UserDirs::new()
            .context("home unavailable")?
            .home_dir()
            .to_path_buf();
        return Ok(vec![
            home.join(".config/google-chrome/NativeMessagingHosts")
                .join(format!("{HOST_NAME}.json")),
            home.join(".config/microsoft-edge/NativeMessagingHosts")
                .join(format!("{HOST_NAME}.json")),
        ]);
    }
    #[cfg(windows)]
    {
        let app_data = directories::BaseDirs::new()
            .context("base dirs unavailable")?
            .config_dir()
            .to_path_buf();
        return Ok(vec![
            app_data
                .join("RAI")
                .join("Agent")
                .join(format!("{HOST_NAME}.json")),
        ]);
    }
    #[allow(unreachable_code)]
    Ok(Vec::new())
}

fn valid_extension_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}
