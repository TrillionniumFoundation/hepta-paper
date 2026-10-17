use super::{PluginAuthority, Result, ensure, parse, resolve_plugin_documents};
/// Verify exactly the retained bytes supplied by an FD observation owner. This
/// function performs no path reads and accepts no asserted verification receipt.
pub(crate) fn resolve_runtime_image_plugin_authority_from_observed_v1(
    bundle: Option<&[u8]>,
    trust: Option<&[u8]>,
    now: &str,
    cancelled: &std::sync::atomic::AtomicBool,
    deadline: std::time::Instant,
) -> Result<PluginAuthority> {
    let control = Some(super::super::control::OperationControl::new(
        cancelled, deadline,
    ));
    super::super::control::check(control)?;
    let resolved = match (bundle, trust) {
        (None, None) => resolve_plugin_documents(None, now, control)?,
        (Some(bundle), Some(trust)) => {
            ensure(
                !bundle.is_empty()
                    && bundle.len() <= 4 * 1024 * 1024
                    && !trust.is_empty()
                    && trust.len() <= 1024 * 1024,
                "immutable_signed_json_observed_input_limit_exceeded",
            )?;
            let bundle = parse(bundle)?;
            super::super::control::check(control)?;
            let trust = parse(trust)?;
            super::super::control::check(control)?;
            resolve_plugin_documents(Some((&bundle, &trust)), now, control)?
        }
        _ => return Err("immutable_signed_json_bundle_configuration_incomplete".into()),
    };
    super::super::control::check(control)?;
    Ok(resolved)
}
