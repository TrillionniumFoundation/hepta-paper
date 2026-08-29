use std::{
    env,
    fs::{self, File},
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::ExitCode,
};

use hepta_qualification_evidence::{
    ChallengeLedgerV1, EvidenceKindV1, QualificationExpectationV1,
    QualificationTrustStoreV1, decode_evidence, verify_external_evidence,
};

const MAXIMUM_INPUT_BYTES: u64 = 16 * 1024 * 1024;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("qualification evidence rejected: {message}");
            ExitCode::from(1)
        }
    }
}

fn run() -> Result<(), String> {
    let arguments = env::args_os().skip(1).collect::<Vec<_>>();
    if arguments.len() != 11 {
        return Err(
            "usage: hepta-qualification-verify <evidence> <trust-store> <attachments-root> <ledger> <kind> <package-id> <commit> <tree> <challenge-id> <challenge-nonce> <now-unix-ms>"
                .to_owned(),
        );
    }
    let evidence_path = absolute(&arguments[0], "evidence")?;
    let trust_store_path = absolute(&arguments[1], "trust-store")?;
    let attachments_root = absolute(&arguments[2], "attachments-root")?;
    let ledger_path = absolute_unresolved(&arguments[3], "ledger")?;
    let kind_text = arguments[4]
        .to_str()
        .ok_or_else(|| "kind is not UTF-8".to_owned())?;
    let evidence_kind = parse_kind(kind_text)?;
    let package_id = text(&arguments[5], "package-id")?;
    let commit = text(&arguments[6], "commit")?;
    let tree = text(&arguments[7], "tree")?;
    let challenge_id = text(&arguments[8], "challenge-id")?;
    let challenge_nonce = text(&arguments[9], "challenge-nonce")?;
    let now_unix_ms = text(&arguments[10], "now-unix-ms")?
        .parse::<u64>()
        .map_err(|_| "now-unix-ms is invalid".to_owned())?;

    let evidence_bytes = read_bounded(&evidence_path)?;
    let trust_store_bytes = read_bounded(&trust_store_path)?;
    let trust_store = QualificationTrustStoreV1::from_json_bytes(&trust_store_bytes)
        .map_err(|error| error.to_string())?;
    let envelope = decode_evidence(&evidence_bytes).map_err(|error| error.to_string())?;
    let expectation = QualificationExpectationV1 {
        evidence_kind,
        package_id,
        repository: "TrillionniumFoundation/hepta-paper".to_owned(),
        commit,
        tree,
        challenge_id,
        challenge_nonce: challenge_nonce.clone(),
        now_unix_ms,
        trust_store_hash: trust_store.content_hash().to_owned(),
    };
    let verified = verify_external_evidence(
        &envelope,
        &trust_store,
        &expectation,
        &attachments_root,
    )
    .map_err(|error| error.to_string())?;
    let owner_uid = fs::metadata("/proc/self")
        .map_err(|error| error.to_string())?
        .uid();
    let mut ledger = ChallengeLedgerV1::open(&ledger_path, owner_uid)
        .map_err(|error| error.to_string())?;
    ledger
        .consume(&verified, &challenge_nonce, now_unix_ms)
        .map_err(|error| error.to_string())?;
    println!(
        "{{\"status\":\"external_evidence_verified_and_challenge_consumed\",\"packageId\":{},\"recordHash\":{},\"issuerAuthorityId\":{},\"attachmentCount\":{}}}",
        serde_json::to_string(&verified.package_id).map_err(|error| error.to_string())?,
        serde_json::to_string(&verified.record_hash).map_err(|error| error.to_string())?,
        serde_json::to_string(&verified.issuer_authority_id).map_err(|error| error.to_string())?,
        verified.attachment_count,
    );
    Ok(())
}

fn parse_kind(value: &str) -> Result<EvidenceKindV1, String> {
    match value {
        "independent_linux_review" => Ok(EvidenceKindV1::IndependentLinuxReview),
        "target_host_qualification" => Ok(EvidenceKindV1::TargetHostQualification),
        "storage_destructive_drill" => Ok(EvidenceKindV1::StorageDestructiveDrill),
        "capability_key_owner_drill" => Ok(EvidenceKindV1::CapabilityKeyOwnerDrill),
        "authenticated_codex_role_qualification" => {
            Ok(EvidenceKindV1::AuthenticatedCodexRoleQualification)
        }
        "campaign_writer_cutover_soak" => Ok(EvidenceKindV1::CampaignWriterCutoverSoak),
        "release_external_authority" => Ok(EvidenceKindV1::ReleaseExternalAuthority),
        _ => Err("evidence kind is unsupported".to_owned()),
    }
}

fn text(value: &std::ffi::OsStr, subject: &str) -> Result<String, String> {
    value
        .to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("{subject} is not UTF-8"))
}

fn absolute(value: &std::ffi::OsStr, subject: &str) -> Result<PathBuf, String> {
    let selected = PathBuf::from(value);
    if !selected.is_absolute() {
        return Err(format!("{subject} is not absolute"));
    }
    let canonical = fs::canonicalize(&selected).map_err(|error| error.to_string())?;
    if canonical != selected {
        return Err(format!("{subject} is not canonical"));
    }
    Ok(selected)
}

fn absolute_unresolved(value: &std::ffi::OsStr, subject: &str) -> Result<PathBuf, String> {
    let selected = PathBuf::from(value);
    if !selected.is_absolute() || selected.file_name().is_none() {
        return Err(format!("{subject} path is invalid"));
    }
    let parent = selected
        .parent()
        .ok_or_else(|| format!("{subject} parent is absent"))?;
    let canonical_parent = fs::canonicalize(parent).map_err(|error| error.to_string())?;
    let expected = canonical_parent.join(
        selected
            .file_name()
            .ok_or_else(|| format!("{subject} file name is absent"))?,
    );
    if expected != selected {
        return Err(format!("{subject} path is noncanonical"));
    }
    Ok(selected)
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.size() == 0
        || metadata.size() > MAXIMUM_INPUT_BYTES
        || metadata.mode() & 0o022 != 0
    {
        return Err(format!("unsafe input file: {}", path.display()));
    }
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let opened = file.metadata().map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.size()).unwrap_or(0));
    file.read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let after = file.metadata().map_err(|error| error.to_string())?;
    if opened.dev() != after.dev()
        || opened.ino() != after.ino()
        || opened.mode() != after.mode()
        || opened.uid() != after.uid()
        || opened.gid() != after.gid()
        || opened.nlink() != after.nlink()
        || opened.size() != after.size()
        || bytes.len() != usize::try_from(metadata.size()).map_err(|_| "input size overflow")?
    {
        return Err(format!("input changed while reading: {}", path.display()));
    }
    Ok(bytes)
}
