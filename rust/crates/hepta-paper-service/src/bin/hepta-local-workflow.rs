//! Explicit local-only workflow command surface; never a production launcher.
use hepta_paper_service::workflow::{
    LocalWorkflowV1, WorkflowActionV1, WorkflowAmendmentV1, amend_local_workflow_v1,
    initialize_local_workflow_v1, operate_local_workflow_v1,
};
use nix::fcntl::OFlag;
use std::{env, fs::OpenOptions, io::Read, os::unix::fs::OpenOptionsExt, path::Path};

fn execute() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
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
        return Err("usage: init DEFINITION | status STATE HASH | advance STATE HASH THROUGH NOW | pause|resume|cancel STATE HASH REVISION NOW | amend STATE HASH REQUEST NOW".into());
    }
    let definition_hash = args[2].parse()?;
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
