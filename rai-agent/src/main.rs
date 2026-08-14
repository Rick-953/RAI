mod audit;
mod config;
mod elevation;
mod install;
mod native;
mod policy;
mod tools;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "rai-agent", version, about = "RAI Local Agent")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    NativeHost {
        #[arg(long)]
        origin: Option<String>,
    },
    Install {
        #[arg(long)]
        chrome_id: Option<String>,
        #[arg(long)]
        edge_id: Option<String>,
        #[arg(long, default_value_t = true)]
        open_store: bool,
    },
    Doctor,
    Status,
    Logs {
        #[arg(long, default_value_t = 100)]
        limit: usize,
    },
    Permissions,
    Update,
    Rollback,
    #[command(hide = true)]
    ElevatedWorker {
        #[arg(long)]
        request: std::path::PathBuf,
        #[arg(long)]
        response: std::path::PathBuf,
        #[arg(long)]
        config: std::path::PathBuf,
    },
    Uninstall {
        #[arg(long)]
        purge: bool,
    },
}

fn main() {
    if let Err(error) = run() {
        eprintln!("rai-agent: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let arguments = std::env::args().collect::<Vec<_>>();
    if arguments
        .get(1)
        .is_some_and(|value| value.starts_with("chrome-extension://"))
    {
        return native::NativeHost::new(arguments.get(1).map(String::as_str))?.run();
    }
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Status) {
        Command::NativeHost { origin } => native::NativeHost::new(origin.as_deref())?.run(),
        Command::Install {
            chrome_id,
            edge_id,
            open_store,
        } => {
            let paths = install::install(chrome_id.as_deref(), edge_id.as_deref(), open_store)?;
            println!(
                "{}",
                serde_json::to_string_pretty(
                    &serde_json::json!({ "installed": true, "manifests": paths })
                )?
            );
            Ok(())
        }
        Command::Doctor | Command::Status => {
            println!("{}", serde_json::to_string_pretty(&install::doctor()?)?);
            Ok(())
        }
        Command::Logs { limit } => {
            let config = config::AgentConfig::load_or_create()?;
            let audit = audit::AuditLog::open(&config)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&audit.recent(limit.clamp(1, 500))?)?
            );
            Ok(())
        }
        Command::Permissions => {
            let config = config::AgentConfig::load_or_create()?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "roots": config.grants,
                    "sensitiveMode": config.sensitive_mode,
                    "shellAlwaysRoots": config.shell_always_roots
                }))?
            );
            Ok(())
        }
        Command::Uninstall { purge } => {
            println!(
                "{}",
                serde_json::to_string_pretty(
                    &serde_json::json!({ "removed": install::uninstall(purge)? })
                )?
            );
            Ok(())
        }
        Command::Update => install::update(),
        Command::Rollback => {
            println!("{}", serde_json::to_string_pretty(&install::rollback()?)?);
            Ok(())
        }
        Command::ElevatedWorker {
            request,
            response,
            config,
        } => elevation::run_worker(&request, &response, &config),
    }
}
