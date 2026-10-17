use super::*;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

pub const RUNTIME_IMAGE_REPRODUCIBILITY_USAGE: &str = "Usage: hepta-paper operator runtime-image-reproducibility -- --action status|request|verify|publish [options]\n\nActions:\n  status   Read and fully revalidate the persisted receipt; never invokes a verifier or writes.\n  request  Emit the current code/release/canonical-context-bound request; never invokes a verifier.\n  verify   Invoke both configured independent external verifiers and validate their Ed25519 attestations.\n  publish  Verify, then atomically publish only a fully valid and currently eligible receipt.\n\nOptions:\n  --config PATH        External verifier process/trust configuration.\n  --receipt PATH       Receipt location (default: isolated runtime root).\n  --runtime-root PATH  Isolated writable runtime root.\n  --root PATH          Repository root containing all canonical Docker contexts.\n\nAll three registered profiles are mandatory. Local Docker output and unsigned record hashes\nare diagnostic only and can never satisfy production readiness.";

#[derive(Debug)]
pub struct RuntimeImageReproducibilityOutputV1 {
    pub value: Value,
    pub text: Option<String>,
    pub exit_code: i32,
}

fn arguments(argv: &[String]) -> Result<BTreeMap<String, String>> {
    ensure(
        argv.len() <= 32
            && argv
                .iter()
                .try_fold(0usize, |sum, value| sum.checked_add(value.len()))
                .is_some_and(|sum| sum <= 64 * 1024),
        "runtime_reproducibility_argument_resource_limit",
    )?;
    let mut flags = BTreeMap::new();
    let mut i = 0;
    while i < argv.len() {
        let token = &argv[i];
        if token == "--" {
            return Err("unexpected_cli_argument_separator".into());
        }
        let raw = token
            .strip_prefix("--")
            .ok_or_else(|| Error(format!("unexpected_cli_positional:{token}")))?;
        let (key, inline) = raw
            .split_once('=')
            .map_or((raw, None), |(a, b)| (a, Some(b)));
        if key.is_empty() {
            return Err("empty_cli_option".into());
        }
        let value = if key == "help" {
            if inline.is_some() {
                return Err("boolean_cli_option_does_not_take_value:--help".into());
            }
            "true"
        } else {
            if !["action", "config", "receipt", "runtime-root", "root"].contains(&key) {
                return Err(Error(format!("unknown_cli_option:--{key}")));
            }
            let value = if let Some(value) = inline {
                value
            } else {
                i += 1;
                argv.get(i)
                    .filter(|value| !value.starts_with("--"))
                    .ok_or_else(|| Error(format!("missing_cli_option_value:--{key}")))?
            };
            if value.is_empty() {
                return Err(Error(format!("empty_cli_option_value:--{key}")));
            }
            value
        };
        if flags.insert(key.to_owned(), value.to_owned()).is_some() {
            return Err(Error(format!("duplicate_cli_option:--{key}")));
        }
        i += 1;
    }
    Ok(flags)
}

#[derive(Clone, Copy)]
enum Mode<'a> {
    Standalone,
    Normal(control::OperationControl<'a>),
}
impl<'a> Mode<'a> {
    fn control(self) -> Option<control::OperationControl<'a>> {
        match self {
            Self::Standalone => None,
            Self::Normal(control) => Some(control),
        }
    }
}
fn selected_path(base: &Path, value: &str) -> Result<PathBuf> {
    ensure(
        !value.is_empty() && value.len() <= 4096 && !value.contains('\0'),
        "runtime_reproducibility_path_not_canonical",
    )?;
    crate::native_workspace::resolve_native_workspace_root_v1(base, base, Some(Path::new(value)))
        .map_err(Error)
}
fn run(
    argv: &[String],
    environment: &BTreeMap<String, String>,
    mode: Mode<'_>,
) -> Result<RuntimeImageReproducibilityOutputV1> {
    control::check(mode.control())?;
    let flags = arguments(argv)?;
    if flags.contains_key("help") {
        return Ok(RuntimeImageReproducibilityOutputV1 {
            value: Value::Null,
            text: Some(RUNTIME_IMAGE_REPRODUCIBILITY_USAGE.into()),
            exit_code: 0,
        });
    }
    let action = flags.get("action").map_or("status", String::as_str);
    if !["status", "request", "verify", "publish"].contains(&action) {
        return Err(Error(format!(
            "runtime_reproducibility_action_invalid:{action}"
        )));
    }
    if matches!(mode, Mode::Normal(_))
        && ["verify", "publish"].contains(&action)
        && environment
            .get("HEPTA_PAPER_RUNTIME_ISOLATED")
            .is_some_and(|value| value == "1")
    {
        return Err("runtime_reproducibility_external_action_forbidden_in_isolated_runtime".into());
    }
    let cwd = std::env::current_dir()?;
    // The original ordinary Node wrapper selects cwd from its physical package
    // path. Its child never inherits the unrelated shell caller's directory.
    let base = match mode {
        Mode::Standalone => cwd.clone(),
        Mode::Normal(_) => crate::native_workspace::resolve_native_command_workspace_root_v1(
            &cwd,
            environment,
            None,
        )
        .map_err(Error)?,
    };
    let root = match flags.get("root") {
        Some(value) => selected_path(&base, value)?,
        None => base.clone(),
    };
    let runtime = if let Some(value) = flags.get("runtime-root").or_else(|| {
        environment
            .get("HEPTA_PAPER_RUNTIME_ROOT")
            .filter(|value| !value.is_empty())
    }) {
        selected_path(&base, value)?
    } else {
        let workspace = match mode {
            Mode::Normal(_) => base.clone(),
            Mode::Standalone => crate::native_workspace::resolve_native_command_workspace_root_v1(
                &cwd,
                environment,
                None,
            )
            .map_err(Error)?,
        };
        workspace
            .parent()
            .ok_or("native_workspace_root_invalid")?
            .join("hepta-paper-runtime/native-runtime")
    };
    let config = flags
        .get("config")
        .or_else(|| {
            environment
                .get("HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG")
                .filter(|value| !value.is_empty())
        })
        .map(|value| selected_path(&base, value))
        .transpose()?;
    let receipt = flags
        .get("receipt")
        .or_else(|| {
            environment
                .get("HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT")
                .filter(|value| !value.is_empty())
        })
        .map(|value| selected_path(&base, value))
        .transpose()?;
    control::check(mode.control())?;
    ensure(
        process::environment_entries_valid(
            environment.len(),
            environment
                .iter()
                .map(|(key, value)| (key.as_str(), Some(value.as_str()))),
        ),
        "runtime_reproducibility_environment_invalid",
    )?;
    let environment = serde_json::to_value(environment)
        .map_err(|_| Error("runtime_reproducibility_environment_invalid".into()))?;
    let options = json!({"action":action,"repositoryRoot":root,"runtimeRoot":runtime,
                         "configPath":config,"receiptPath":receipt,"environment":environment});
    let value = workflow::report_with_optional_control(
        &options,
        mode.control(),
        matches!(mode, Mode::Normal(_)),
    )?;
    control::check(mode.control())?;
    let exit_code = if action == "request" || value["ready"] == true {
        0
    } else {
        2
    };
    Ok(RuntimeImageReproducibilityOutputV1 {
        value,
        text: None,
        exit_code,
    })
}

/// Standalone compatibility retains the original configured verifier limits.
pub fn runtime_image_reproducibility_cli_v1(
    argv: &[String],
    environment: &BTreeMap<String, String>,
) -> Result<RuntimeImageReproducibilityOutputV1> {
    run(argv, environment, Mode::Standalone)
}
/// Ordinary source profile is bounded to the incumbent 120-second operation
/// framework. The same original flag and Instant cover both parallel verifiers.
/// Configured standalone four-hour verifier domains remain outside this profile.
pub fn runtime_image_reproducibility_cli_with_control_v1(
    argv: &[String],
    environment: &BTreeMap<String, String>,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<RuntimeImageReproducibilityOutputV1> {
    ensure(
        deadline.saturating_duration_since(Instant::now()) <= Duration::from_secs(120),
        "runtime_reproducibility_normal_deadline_exceeds_profile",
    )?;
    run(
        argv,
        environment,
        Mode::Normal(control::OperationControl::new(cancelled, deadline)),
    )
}
