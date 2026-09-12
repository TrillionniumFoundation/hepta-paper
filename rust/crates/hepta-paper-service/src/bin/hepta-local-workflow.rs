//! Explicit local-only workflow command surface; never a production launcher.
use hepta_paper_service::workflow::{
    LocalWorkflowV1, WorkflowActionV1, WorkflowAmendmentV1, WorkflowInspectionRequestV1,
    WorkflowListRequestV1, amend_local_workflow_v1, initialize_local_workflow_v1,
    inspect_local_workflow_v1, list_local_workflows_v1, operate_local_workflow_v1,
};
use nix::fcntl::OFlag;
use std::{env, fs::OpenOptions, io::Read, os::unix::fs::OpenOptionsExt, path::Path};

fn read_request<T: serde::de::DeserializeOwned>(
    path: &str,
) -> Result<T, Box<dyn std::error::Error>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags((OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK).bits())
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err("request must be a regular file".into());
    }
    let mut bytes = Vec::new();
    file.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("request exceeds bound".into());
    }
    Ok(serde_json::from_slice(&bytes)?)
}

fn execute() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() == 2 && args[0] == "list" {
        let request: WorkflowListRequestV1 = read_request(&args[1])?;
        println!(
            "{}",
            serde_json::to_string(&list_local_workflows_v1(request)?)?
        );
        return Ok(());
    }
    if args.len() == 2 && args[0] == "init" {
        let mut bytes = Vec::new();
        let file = OpenOptions::new()
            .read(true)
            .custom_flags((OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK).bits())
            .open(&args[1])?;
        if !file.metadata()?.is_file() {
            return Err("definition must be a regular file".into());
        }
        file.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("definition exceeds bound".into());
        }
        let definition: LocalWorkflowV1 = serde_json::from_slice(&bytes)?;
        println!("{}", initialize_local_workflow_v1(definition)?);
        return Ok(());
    }
    if args.len() < 3 {
        return Err("usage: init DEFINITION | status STATE HASH | advance STATE HASH THROUGH NOW | pause|resume|cancel STATE HASH REVISION NOW | amend STATE HASH REQUEST NOW | list REQUEST | events STATE HASH REQUEST | logs STATE HASH OFFSET LIMIT | slo STATE HASH".into());
    }
    let definition_hash = args[2].parse()?;
    let inspection = match args[0].as_str() {
        "events" if args.len() == 4 => {
            let request: WorkflowInspectionRequestV1 = read_request(&args[3])?;
            if !matches!(request, WorkflowInspectionRequestV1::Events { .. }) {
                return Err("wrong query kind".into());
            }
            Some(request)
        }
        "logs" if args.len() == 5 => Some(WorkflowInspectionRequestV1::Logs {
            offset: args[3].parse()?,
            limit: args[4].parse()?,
        }),
        "slo" if args.len() == 3 => Some(WorkflowInspectionRequestV1::Slo {}),
        _ => None,
    };
    if let Some(request) = inspection {
        println!(
            "{}",
            serde_json::to_string(&inspect_local_workflow_v1(
                Path::new(&args[1]),
                &definition_hash,
                request,
            )?)?
        );
        return Ok(());
    }
    if args[0] == "amend" && args.len() == 5 {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags((OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK).bits())
            .open(&args[3])?;
        if !file.metadata()?.is_file() {
            return Err("request must be a regular file".into());
        }
        let mut bytes = Vec::new();
        file.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("request exceeds bound".into());
        }
        let request: WorkflowAmendmentV1 = serde_json::from_slice(&bytes)?;
        let receipt = amend_local_workflow_v1(
            Path::new(&args[1]),
            &definition_hash,
            request,
            args[4].parse()?,
        )?;
        println!("{}", serde_json::to_string(&receipt)?);
        return Ok(());
    }

    let (action, now) = match args[0].as_str() {
        "status" if args.len() == 3 => (WorkflowActionV1::Status, 0),
        "advance" if args.len() == 5 => (
            WorkflowActionV1::Advance {
                through_steps: args[3].parse()?,
            },
            args[4].parse()?,
        ),
        "pause" if args.len() == 5 => (
            WorkflowActionV1::Pause {
                expected_revision: args[3].parse()?,
            },
            args[4].parse()?,
        ),
        "resume" if args.len() == 5 => (
            WorkflowActionV1::Resume {
                expected_revision: args[3].parse()?,
            },
            args[4].parse()?,
        ),
        "cancel" if args.len() == 5 => (
            WorkflowActionV1::Cancel {
                expected_revision: args[3].parse()?,
            },
            args[4].parse()?,
        ),
        _ => return Err("unsupported local workflow command or arguments".into()),
    };
    println!(
        "{}",
        serde_json::to_string(&operate_local_workflow_v1(
            Path::new(&args[1]),
            &definition_hash,
            action,
            now
        )?)?
    );
    Ok(())
}
fn main() {
    if execute().is_err() {
        // Parser diagnostics can contain user-supplied document text. Do not echo it.
        eprintln!("local workflow command rejected; inspect private retained state");
        std::process::exit(1);
    }
}
