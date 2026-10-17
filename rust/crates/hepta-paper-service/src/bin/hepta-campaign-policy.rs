//! Pure JSON campaign-decision CLI. No legacy process or state writer is invoked.
use hepta_paper_service::campaign_policy::{CampaignPolicyRequestV1, evaluate_campaign_policy_v1};
use std::io::{self, Read, Write};
fn run() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args_os().len() != 1 {
        return Err("no arguments accepted".into());
    }
    let mut bytes = Vec::new();
    io::stdin()
        .lock()
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("request exceeds limit".into());
    }
    let request: CampaignPolicyRequestV1 = serde_json::from_slice(&bytes)?;
    let output = evaluate_campaign_policy_v1(request)?;
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &output)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}
fn main() {
    if run().is_err() {
        eprintln!("campaign policy request rejected");
        std::process::exit(1);
    }
}
