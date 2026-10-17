//! Explicit diagnostic harness; the product CLI composes this same owner.
use hepta_readonly_store::OrdinaryReadOnlyStoreV1;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args_os()
        .nth(1)
        .ok_or("absolute database path required")?;
    let store = OrdinaryReadOnlyStoreV1::open(path)?;
    let report = store.node_logical_integrity_report()?;
    serde_json::to_writer(std::io::stdout().lock(), &report)?;
    store.verify_unchanged()?;
    Ok(())
}
