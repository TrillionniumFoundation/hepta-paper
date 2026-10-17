//! Original constructor order plus the actual verifier JSON.parse insertion
//! order. This is a wire projection only; receipt verification remains separate.
use super::*;
use hepta_legacy_compatibility::{
    ProductionJsonEncodingLimitsV1, ProductionJsonValue, parse_production_json_v1,
    production_json_pretty_resources_v1, production_json_pretty_with_limits_v1,
    production_json_resources_v1, production_json_stringify_v1,
    production_json_stringify_with_limits_v1,
};
use std::io::Write;

const RECEIPT: &[&str] = &[
    "version",
    "kind",
    "status",
    "request",
    "contextTarMetadataPolicyHashes",
    "responseHashes",
    "responses",
    "issuedAt",
    "expiresAt",
    "externalActionPerformed",
    "privateSigningKeyLoadedByController",
    "assurance",
    "runtimeImageReproducibilityReceiptHash",
];
const REQUEST: &[&str] = &[
    "version",
    "kind",
    "nonce",
    "requestedAt",
    "expiresAt",
    "configurationIdentityHash",
    "trustIdentityHash",
    "codeProvenanceHash",
    "releaseIdentityHash",
    "requiredProfiles",
    "empiricalFamilyPluginPackageHash",
    "empiricalFamilyPluginRegistryHash",
    "empiricalFamilyPluginStartupInspectionHash",
    "activeProductionProfileHashes",
    "runtimeImageReproducibilityActivePluginScopeHash",
    "inputs",
    "requestHash",
];
const INPUT: &[&str] = &[
    "version",
    "kind",
    "profile",
    "image",
    "registeredImageDigest",
    "contextPath",
    "contextManifest",
    "contextManifestHash",
    "contextTarMetadataPolicy",
    "contextTarMetadataPolicyHash",
    "definitionManifestHash",
    "dockerfile",
    "dockerfileContentHash",
    "dockerfileFrontend",
    "dockerfileFrontendDigest",
    "baseImageReferences",
    "platform",
    "buildArgs",
    "sourceDateEpoch",
    "cachePolicy",
    "networkPolicy",
    "outputFormat",
    "ociExporter",
    "reproducibleOciMetadataRequired",
    "runtimeImageCanonicalBuildInputClosureHash",
];
const TAR: &[&str] = &[
    "version",
    "kind",
    "archiveFormat",
    "entryOrder",
    "uid",
    "gid",
    "uname",
    "gname",
    "mtime",
    "xattrsIncluded",
    "deviceEntriesIncluded",
];
const EXPORTER: &[&str] = &["type", "rewriteTimestamp", "provenance", "sbom"];
const DIRECTORY: &[&str] = &["path", "type", "mode"];
const FILE: &[&str] = &["path", "type", "mode", "bytes", "contentHash"];
fn invalid() -> Error {
    Error("runtime_reproducibility_receipt_wire_invalid".into())
}
fn named<'a>(v: &'a mut ProductionJsonValue, field: &str) -> Result<&'a mut ProductionJsonValue> {
    let ProductionJsonValue::Object(fields) = v else {
        return Err(invalid());
    };
    fields
        .iter_mut()
        .find(|(key, _)| key.iter().copied().eq(field.encode_utf16()))
        .map(|(_, v)| v)
        .ok_or_else(invalid)
}
fn order(v: &mut ProductionJsonValue, keys: &[&str]) -> Result<()> {
    let ProductionJsonValue::Object(fields) = v else {
        return Err(invalid());
    };
    ensure(
        fields.len() == keys.len(),
        "runtime_reproducibility_receipt_wire_invalid",
    )?;
    let mut ordered = Vec::with_capacity(keys.len());
    for key in keys {
        let position = fields
            .iter()
            .position(|(name, _)| name.iter().copied().eq(key.encode_utf16()))
            .ok_or_else(invalid)?;
        ordered.push(fields.remove(position));
    }
    *fields = ordered;
    Ok(())
}
fn inputs(
    v: &mut ProductionJsonValue,
    control: Option<control::OperationControl<'_>>,
) -> Result<()> {
    let ProductionJsonValue::Array(values) = v else {
        return Err(invalid());
    };
    ensure(
        (1..=3).contains(&values.len()),
        "runtime_reproducibility_receipt_wire_invalid",
    )?;
    for input in values {
        control::check(control)?;
        order(input, INPUT)?;
        order(named(input, "contextTarMetadataPolicy")?, TAR)?;
        order(named(input, "ociExporter")?, EXPORTER)?;
        let ProductionJsonValue::Array(records) = named(input, "contextManifest")? else {
            return Err(invalid());
        };
        for record in records {
            control::check(control)?;
            let ProductionJsonValue::String(kind) = named(record, "type")? else {
                return Err(invalid());
            };
            let keys = if kind.iter().copied().eq("directory".encode_utf16()) {
                DIRECTORY
            } else if kind.iter().copied().eq("file".encode_utf16()) {
                FILE
            } else {
                return Err(invalid());
            };
            order(record, keys)?;
        }
    }
    Ok(())
}
struct Bounded<'a> {
    bytes: Vec<u8>,
    maximum: usize,
    control: Option<control::OperationControl<'a>>,
}
impl Write for Bounded<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        control::check(self.control).map_err(std::io::Error::other)?;
        if bytes.len() > self.maximum.saturating_sub(self.bytes.len()) {
            return Err(std::io::Error::other(
                "runtime_reproducibility_receipt_wire_limit",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn from_value(
    value: &Value,
    control: Option<control::OperationControl<'_>>,
) -> Result<ProductionJsonValue> {
    control::check(control)?;
    let mut source = Bounded {
        bytes: Vec::new(),
        maximum: ProductionJsonEncodingLimitsV1::default().maximum_bytes,
        control,
    };
    serde_json::to_writer(&mut source, value).map_err(|_| invalid())?;
    let wire = parse_production_json_v1(&source.bytes).map_err(|_| invalid())?;
    control::check(control)?;
    Ok(wire)
}
fn project_request(
    request: &mut ProductionJsonValue,
    control: Option<control::OperationControl<'_>>,
) -> Result<()> {
    order(request, REQUEST)?;
    inputs(named(request, "inputs")?, control)
}
/// The original process sends JSON.stringify of the constructed request. The
/// actual verifier may preserve this insertion order in its signed response.
/// This private projection is called only after request contract validation.
pub(super) fn request_bytes(
    request: &Value,
    control: Option<control::OperationControl<'_>>,
) -> Result<Vec<u8>> {
    let mut wire = from_value(request, control)?;
    project_request(&mut wire, control)?;
    let limits = ProductionJsonEncodingLimitsV1::default();
    let idle = std::sync::atomic::AtomicBool::new(false);
    let cancelled = control.map_or(&idle, control::OperationControl::cancelled);
    let resources =
        production_json_resources_v1(&wire, limits, cancelled).map_err(|_| invalid())?;
    ensure(
        resources.bytes < limits.maximum_bytes,
        "runtime_reproducibility_receipt_wire_limit",
    )?;
    control::check(control)?;
    let mut bytes = production_json_stringify_with_limits_v1(&wire, limits, cancelled)
        .map_err(|_| invalid())?;
    bytes.push(b'\n');
    control::check(control)?;
    Ok(bytes)
}
/// No caller-projected response ordering: only bytes captured by the pinned
/// executable FD owner are supplied by the private workflow composition.
pub(super) fn receipt_bytes(
    receipt: &Value,
    raw_responses: &[Vec<u8>],
    control: Option<control::OperationControl<'_>>,
) -> Result<Vec<u8>> {
    control::check(control)?;
    let limits = ProductionJsonEncodingLimitsV1::default();
    let mut wire = from_value(receipt, control)?;
    order(&mut wire, RECEIPT)?;
    let request = named(&mut wire, "request")?;
    project_request(request, control)?;
    let profiles: Vec<String> = array(&receipt["request"]["requiredProfiles"])
        .iter()
        .map(|v| v.as_str().map(str::to_owned).ok_or_else(invalid))
        .collect::<Result<_>>()?;
    let keys: Vec<&str> = profiles.iter().map(String::as_str).collect();
    order(named(&mut wire, "contextTarMetadataPolicyHashes")?, &keys)?;
    let ProductionJsonValue::Array(responses) = named(&mut wire, "responses")? else {
        return Err(invalid());
    };
    ensure(
        responses.len() == 2 && raw_responses.len() == 2,
        "runtime_reproducibility_receipt_wire_invalid",
    )?;
    for (index, (response, raw)) in responses.iter_mut().zip(raw_responses).enumerate() {
        control::check(control)?;
        let observed = parse_production_json_v1(raw).map_err(|_| invalid())?;
        let compact = production_json_stringify_v1(&observed).map_err(|_| invalid())?;
        let semantic = parse(&compact)?;
        ensure(
            semantic == receipt["responses"][index],
            "runtime_reproducibility_receipt_wire_response_drift",
        )?;
        *response = observed;
    }
    let idle = std::sync::atomic::AtomicBool::new(false);
    let cancelled = control.map_or(&idle, control::OperationControl::cancelled);
    // Reserve the final complete pretty wire before allocating it; shared
    // encoder limits remain 16MiB, never enlarged to the publisher's 32MiB cap.
    let resources =
        production_json_pretty_resources_v1(&wire, limits, cancelled).map_err(|_| invalid())?;
    ensure(
        resources.bytes < limits.maximum_bytes,
        "runtime_reproducibility_receipt_wire_limit",
    )?;
    control::check(control)?;
    let mut bytes =
        production_json_pretty_with_limits_v1(&wire, limits, cancelled).map_err(|_| invalid())?;
    bytes.push(b'\n');
    control::check(control)?;
    Ok(bytes)
}
