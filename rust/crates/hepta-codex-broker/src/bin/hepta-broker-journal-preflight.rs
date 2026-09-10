use std::{path::Path, process};

use hepta_codex_broker::{BrokerJournalPolicyV1, BrokerJournalStoreV1};

fn main() {
    if let Err(error) = run() {
        eprintln!("hepta broker journal preflight failed: {error}");
        process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let arguments = std::env::args().collect::<Vec<_>>();
    if arguments.len() != 3 {
        return Err("usage: hepta-broker-journal-preflight <database-path> <owner-uid>".to_owned());
    }
    let owner_uid = arguments[2]
        .parse::<u32>()
        .map_err(|_| "owner UID is not a valid unsigned integer".to_owned())?;
    let store = BrokerJournalStoreV1::open(
        Path::new(&arguments[1]),
        BrokerJournalPolicyV1::strict(owner_uid),
    )
    .map_err(|error| error.to_string())?;
    store
        .validate_integrity()
        .map_err(|error| error.to_string())?;
    let operation_count = store.operation_count().map_err(|error| error.to_string())?;
    println!(
        "broker_journal_verified path={} operation_count={operation_count}",
        store.path().display(),
    );
    Ok(())
}
