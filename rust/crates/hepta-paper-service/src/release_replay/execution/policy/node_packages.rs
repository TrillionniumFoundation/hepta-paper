//! Exact seven lock-bound Node observer packages. The file hashes derive from
//! official immutable archives whose SHA-512 integrity was actually verified.
//! These are differential inputs; no Node product implementation is claimed.
use super::{Owner, SourceGraph, digest, error};
use serde_json::{Value, json};
use std::collections::BTreeSet;
pub(super) const ROOTS: &[&str] = &[
    "node_modules/espree",
    "node_modules/acorn",
    "node_modules/acorn-jsx",
    "node_modules/eslint-visitor-keys",
    "node_modules/eslint-scope",
    "node_modules/esrecurse",
    "node_modules/estraverse",
];
const PACKAGES: &[(&str, &str, &str, &str)] = &[
    (
        "espree",
        "11.2.0",
        "https://registry.npmjs.org/espree/-/espree-11.2.0.tgz",
        "sha512-7p3DrVEIopW1B1avAGLuCSh1jubc01H2JHc8B4qqGblmg5gI9yumBgACjWo4JlIc04ufug4xJ3SQI8HkS/Rgzw==",
    ),
    (
        "acorn",
        "8.17.0",
        "https://registry.npmjs.org/acorn/-/acorn-8.17.0.tgz",
        "sha512-xRQbDb9BnwDafYNn6Vwl839DYVjqXYb1XVGtWAZ1kcDc6iwAL4hg3B1dZlRiuENFeO2H53gFG3in621AdERVAg==",
    ),
    (
        "acorn-jsx",
        "5.3.2",
        "https://registry.npmjs.org/acorn-jsx/-/acorn-jsx-5.3.2.tgz",
        "sha512-rq9s+JNhf0IChjtDXxllJ7g41oZk5SlXtp0LHwyA5cejwn7vKmKp4pPri6YEePv2PU65sAsegbXtIinmDFDXgQ==",
    ),
    (
        "eslint-visitor-keys",
        "5.0.1",
        "https://registry.npmjs.org/eslint-visitor-keys/-/eslint-visitor-keys-5.0.1.tgz",
        "sha512-tD40eHxA35h0PEIZNeIjkHoDR4YjjJp34biM0mDvplBe//mB+IHCqHDGV7pxF+7MklTvighcCPPZC7ynWyjdTA==",
    ),
    (
        "eslint-scope",
        "9.1.2",
        "https://registry.npmjs.org/eslint-scope/-/eslint-scope-9.1.2.tgz",
        "sha512-xS90H51cKw0jltxmvmHy2Iai1LIqrfbw57b79w/J7MfvDfkIkFZ+kj6zC3BjtUwh150HsSSdxXZcsuv72miDFQ==",
    ),
    (
        "esrecurse",
        "4.3.0",
        "https://registry.npmjs.org/esrecurse/-/esrecurse-4.3.0.tgz",
        "sha512-KmfKL3b6G+RXvP8N1vr3Tq1kL/oCFgn2NYXEtqP8/L3pKapUA4G8cFVaoF3SU323CD4XypR/ffioHmkti6/Tag==",
    ),
    (
        "estraverse",
        "5.3.0",
        "https://registry.npmjs.org/estraverse/-/estraverse-5.3.0.tgz",
        "sha512-MMdARuVEQziNTeJD8DgMqmhwR11BRQ/cBP+pLtYdSTnf3MIO8fFeiINEbX36ZdNlfU/7A9f3gUw49B3oQsvwBA==",
    ),
];
const FILES: &[(&str, &str)] = &[
    (
        "node_modules/acorn-jsx/LICENSE",
        "sha256:cfa72b62b9ae173078823a3796b25c027a9071046a263beddf966df67018ce06",
    ),
    (
        "node_modules/acorn-jsx/README.md",
        "sha256:719df4045e9d259909523bbca9885a6029a1f1bb244133095341c8c293c39346",
    ),
    (
        "node_modules/acorn-jsx/index.d.ts",
        "sha256:d6cafc03e244c41ef5a4cb90f72f98117ded1342f79269dc1fa330889f894e61",
    ),
    (
        "node_modules/acorn-jsx/index.js",
        "sha256:5ab23edca59b840bc26ba711131a5b649540b70da53d70ae1bbcdb13480c1aa1",
    ),
    (
        "node_modules/acorn-jsx/package.json",
        "sha256:5e123a5ee3b16fd10fe4b44ef70ff7885f05117fb9ae75f72a0d821f919d423d",
    ),
    (
        "node_modules/acorn-jsx/xhtml.js",
        "sha256:caf07cbe00acbbb762e60ee83dc6e1927fb2709c960bd6cca85d8a5cf77c2886",
    ),
    (
        "node_modules/acorn/CHANGELOG.md",
        "sha256:fd0adcc2f6b428b2e8ef1f50aaab2a48d56fcaa4d15ff47ffea5156b12339c40",
    ),
    (
        "node_modules/acorn/LICENSE",
        "sha256:76a876cf886ff9be2a8b5e2e86514fed06223c8c9f0c1e9ee9606e93841e00b7",
    ),
    (
        "node_modules/acorn/README.md",
        "sha256:397654c060a069536924ed22cac5abf6f4cfc782fb2c7520b79e34c68fb2b080",
    ),
    (
        "node_modules/acorn/bin/acorn",
        "sha256:4c3eb6f1d8932790dbff043839f8ee7686bc614a59ef577e96fed618a4a4b1b8",
    ),
    (
        "node_modules/acorn/dist/acorn.d.mts",
        "sha256:402b3b3436cdcf865edbef6af24bfcb27dba79865d680f6d103376449edf9f92",
    ),
    (
        "node_modules/acorn/dist/acorn.d.ts",
        "sha256:402b3b3436cdcf865edbef6af24bfcb27dba79865d680f6d103376449edf9f92",
    ),
    (
        "node_modules/acorn/dist/acorn.js",
        "sha256:b373ccd10e9deb63654289f73216eeefcaf0405d9ee24289aabf596b91b4c318",
    ),
    (
        "node_modules/acorn/dist/acorn.mjs",
        "sha256:1cbcbf252a5800e496dc505c706f309a9dd4e1789392e12963c77ae9497ff6f7",
    ),
    (
        "node_modules/acorn/dist/bin.js",
        "sha256:fffd9df1d9158c4580068ad17c3176c34fe46f59021b8cd5780454994764dc30",
    ),
    (
        "node_modules/acorn/package.json",
        "sha256:fa3612cc9493702b7520947eec276d7b4a73001dafd68c4a9dcb58791a4145c6",
    ),
    (
        "node_modules/eslint-scope/LICENSE",
        "sha256:d3a724e2ed749f172ff70b62a1d0631b7d4b0ea273782365a3464d4e2d6b6dbd",
    ),
    (
        "node_modules/eslint-scope/README.md",
        "sha256:7170e4eb9e7779758994e08532af053453bbface33fe0816a8185978f6fe51ad",
    ),
    (
        "node_modules/eslint-scope/dist/eslint-scope.cjs",
        "sha256:615c9351593f8d8d3a2700fad7c288b0e0d48188fe4ef70e98707887ac9b302b",
    ),
    (
        "node_modules/eslint-scope/lib/assert.js",
        "sha256:ee6a92ef1198f83af7dd766fce1ae1b86344200cb56c9f1b8311e25826bb6c96",
    ),
    (
        "node_modules/eslint-scope/lib/definition.js",
        "sha256:81e051d08b3cc83d4d15e5481c419b8bf9886e34ff8240bf61fcf2b08cc621d1",
    ),
    (
        "node_modules/eslint-scope/lib/index.d.cts",
        "sha256:14d05dc8f5c5321d463f44ea300208a9943e08c0d427ee857bcd174aa9d72f13",
    ),
    (
        "node_modules/eslint-scope/lib/index.d.ts",
        "sha256:cd448460641d289e06406ed5133ab50feac7edb00b8eab3170a7c5ea73feddee",
    ),
    (
        "node_modules/eslint-scope/lib/index.js",
        "sha256:522ad28c80b2749adc5d388703bc7f0dd919808fea20cbd84cdf473734d4748f",
    ),
    (
        "node_modules/eslint-scope/lib/pattern-visitor.js",
        "sha256:409803cc8d60e925ca366b6bad6f8e085690d9c531ada4d7393037c7d04931df",
    ),
    (
        "node_modules/eslint-scope/lib/reference.js",
        "sha256:d620dfb10ed0e848448da0720e53a0196bd5ffa61e5a2ce7d05a90e64c79de76",
    ),
    (
        "node_modules/eslint-scope/lib/referencer.js",
        "sha256:d8cc6d00d48bdc2de55c74289551d7edb4ff4a853ea5678a07a921620deba518",
    ),
    (
        "node_modules/eslint-scope/lib/scope-manager.js",
        "sha256:57e33cdbd881bd9035740cad7afd78341d164b5e268b4420738abe5802e5d17c",
    ),
    (
        "node_modules/eslint-scope/lib/scope.js",
        "sha256:13fbe9d3973b596bb2fafae272b5a6b80db69bb360894a117b31c7f4e93e48ed",
    ),
    (
        "node_modules/eslint-scope/lib/variable.js",
        "sha256:3a1b7e00e96fccb9a4c8985f34f6362fbbae91794f7e37cc6aa33be9866fee87",
    ),
    (
        "node_modules/eslint-scope/package.json",
        "sha256:00b69c8c78e79c01f844987acdf8cdd43c8647dd84c752cdc39dc9319bac241a",
    ),
    (
        "node_modules/eslint-visitor-keys/LICENSE",
        "sha256:d8bf34ff6d190640a01e7704ad78253fc181bc128949d71273fbbaa12f33c0b4",
    ),
    (
        "node_modules/eslint-visitor-keys/README.md",
        "sha256:3ab1da1d94726786fccee39d37e811a23cd88fbc97b50820ee0f3a66a9e0052f",
    ),
    (
        "node_modules/eslint-visitor-keys/dist/eslint-visitor-keys.cjs",
        "sha256:ae65d53f994f6caaa8bba35b190ef5ba209a2bc9d8dff86a45b0b68fa0700a86",
    ),
    (
        "node_modules/eslint-visitor-keys/dist/eslint-visitor-keys.d.cts",
        "sha256:f977ccd51967b32d13e701675bb0fbb223485d797709b38dbd2066f968808acb",
    ),
    (
        "node_modules/eslint-visitor-keys/dist/index.d.ts",
        "sha256:21ea0ff3ce74988c14fbfb2bcef2ac08e5ba066b766bd9f30495a171c33f03c2",
    ),
    (
        "node_modules/eslint-visitor-keys/dist/visitor-keys.d.ts",
        "sha256:620efe3c144b4ca973a744f604c0cde020ba9e1ccc7a6baaabd4b815953ab14b",
    ),
    (
        "node_modules/eslint-visitor-keys/lib/index.js",
        "sha256:8f83ce32c916cf2b7f5cf8d3b600956010d799f8ccac938edd5983b2c8cf93e7",
    ),
    (
        "node_modules/eslint-visitor-keys/lib/visitor-keys.js",
        "sha256:196eb3a1bfad41d47dcb16b0959222a1c457a845f1ec6b021192e4d7d14130d4",
    ),
    (
        "node_modules/eslint-visitor-keys/package.json",
        "sha256:13f8b0207958a2d504740826e8245bc2b023248136275550907a5569d8659242",
    ),
    (
        "node_modules/espree/LICENSE",
        "sha256:26c95937762a3dc17a3934a0a2773c70259ba4bf28dab713c225e4af8eb9d349",
    ),
    (
        "node_modules/espree/README.md",
        "sha256:dacdd0fce5f0e420517b024d409d2243119f3ad570618b60a45e37c0fecb824b",
    ),
    (
        "node_modules/espree/dist/espree.cjs",
        "sha256:00ad93bce4a8af52aeaab7b8198c1ed072c9cf1b5cbb2d44e3d2fdc00562c059",
    ),
    (
        "node_modules/espree/dist/espree.d.cts",
        "sha256:5d1dbce00c290f6ee4e551e38d02d8efa191ebe60e57372fc403435dc65971d2",
    ),
    (
        "node_modules/espree/dist/espree.d.cts.map",
        "sha256:5c30435dc586460f542389eef5798a364aaff3b20c8844620b641a6a5bf3a8a5",
    ),
    (
        "node_modules/espree/dist/espree.d.ts",
        "sha256:76e4b531a65aab96cb989875831eb07a1f265ec6c4a36f5f36bb7d83af3e1bee",
    ),
    (
        "node_modules/espree/dist/espree.d.ts.map",
        "sha256:df091372413ea53a6404e321c95a985467f2a4444f23780ee8ff68eef249eefb",
    ),
    (
        "node_modules/espree/espree.js",
        "sha256:9ef1d03ec22b9b5cc2dc1ef43310a2bbf30ae750eb882cec9868eb5bda7d9186",
    ),
    (
        "node_modules/espree/lib/espree.js",
        "sha256:713d844f758f5a947d703d50e7a50f16581bb19810e8c3f1f009b503ab1e12d5",
    ),
    (
        "node_modules/espree/lib/options.js",
        "sha256:86e94df5b303515174ab33b8b217f7f1f42b236cc92b66fb698b53055970bec5",
    ),
    (
        "node_modules/espree/lib/token-translator.js",
        "sha256:6006ebfc4914496d548389b0da2e58322bbae34827862fc40b9502c9970179d5",
    ),
    (
        "node_modules/espree/lib/types.js",
        "sha256:9ca649d8154ebd37ee86e6382c12bfbae29211706958e1abd409a339ff7e986e",
    ),
    (
        "node_modules/espree/package.json",
        "sha256:23ed9eb09d6076011884a14deb09ad608968eaa01f69344b91207c810a1bebd2",
    ),
    (
        "node_modules/esrecurse/.babelrc",
        "sha256:9b5fa5ccf91f15404f266f8595c85a005814efdecc3fd7c584630e6667fb5597",
    ),
    (
        "node_modules/esrecurse/README.md",
        "sha256:a7007c78c9d9da690ef6cdb0e7a3427d05832edb00abd1f5a9882700d73be4ad",
    ),
    (
        "node_modules/esrecurse/esrecurse.js",
        "sha256:aa99847033c240a621fe987f0e06b754f388f22abd11a05bdf9cdd00794b7350",
    ),
    (
        "node_modules/esrecurse/gulpfile.babel.js",
        "sha256:fb47567884ee5dddc084a93db85d940f0874dbb4a1863820c6c317a3a83e62b1",
    ),
    (
        "node_modules/esrecurse/package.json",
        "sha256:3bc67cb54672ec6957b53947613c23599371bf9222dbbe97275d20516a561a20",
    ),
    (
        "node_modules/estraverse/.jshintrc",
        "sha256:48460ff8874f6b68482ec068c01f7246ae406b891749f92f3d06180b3c70fc35",
    ),
    (
        "node_modules/estraverse/LICENSE.BSD",
        "sha256:0e74697a68cebdcd61502c30fe80ab7f9e341d995dcd452023654d57133534b1",
    ),
    (
        "node_modules/estraverse/README.md",
        "sha256:623a48ac487901c20b18ff241617efb3adf6a3b8c077073fccdddc770404c991",
    ),
    (
        "node_modules/estraverse/estraverse.js",
        "sha256:818578222a4686be24197cac7e9ea00a6b32a0312c86a2bb946ec4b7faeee93c",
    ),
    (
        "node_modules/estraverse/gulpfile.js",
        "sha256:02601a92111d2c67d2f9bc725a66c80aceb7e24a9e266a2ab5e83c5b9e01b27a",
    ),
    (
        "node_modules/estraverse/package.json",
        "sha256:133a5be160a0123ad20ab8f2bdaa9da2fd94ebf3403996bf4cb69606e6a84a65",
    ),
];
pub(super) fn validate_paths(paths: &BTreeSet<String>) -> Result<(), String> {
    let actual = paths
        .iter()
        .filter(|p| p.starts_with("node_modules/"))
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let expected = FILES.iter().map(|(p, _)| *p).collect::<BTreeSet<_>>();
    if actual != expected {
        return Err(error("policy_node_package_namespace_invalid"));
    }
    Ok(())
}
fn validate_lock(lock: &Value) -> Result<(), String> {
    for (name, version, resolved, integrity) in PACKAGES {
        let entry = &lock["packages"][format!("node_modules/{name}")];
        if entry["version"] != *version
            || entry["resolved"] != *resolved
            || entry["integrity"] != *integrity
        {
            return Err(error("policy_node_package_lock_invalid"));
        }
    }
    Ok(())
}
#[cfg(test)]
pub(super) fn fixture_files() -> &'static [(&'static str, &'static str)] {
    FILES
}
#[cfg(test)]
pub(super) fn validate_fixture_lock(lock: &Value) -> Result<(), String> {
    validate_lock(lock)
}
pub(super) fn inspect(owner: &mut Owner<'_>, graph: &mut SourceGraph) -> Result<Value, String> {
    let lock_bytes = graph.read_input(owner, "package-lock.json")?;
    let lock: Value = serde_json::from_slice(&lock_bytes)
        .map_err(|_| error("policy_node_package_lock_invalid"))?;
    validate_lock(&lock)?;
    let mut bytes = 0_u64;
    let mut files = Vec::new();
    for (path, sha) in FILES {
        let input = graph.read_input(owner, path)?;
        if digest(&input) != *sha {
            return Err(error("policy_node_package_bytes_invalid"));
        }
        bytes += input.len() as u64;
        files.push(json!({"path":path,"bytes":input.len(),"sha256":sha}));
    }
    Ok(
        json!({"version":2,"kind":"FixedLockBoundNodeObserverPackageInputs","packageLockSha256":digest(&lock_bytes),"packageCount":PACKAGES.len(),"fileCount":files.len(),"fileBytes":bytes,"files":files,"source":"seven_fixed_official_archive_sha512_verified_file_hash_sets","ambientNodePathAllowed":false,"fullNodeDependencyGraphClaimed":false,"productNodeImplementationClaimed":false}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_package_paths_and_lock_profile_refuse_replacement_or_added_namespace() {
        let mut paths = FILES
            .iter()
            .map(|(p, _)| (*p).to_owned())
            .collect::<BTreeSet<_>>();
        validate_paths(&paths).unwrap();
        paths.insert("node_modules/espree/node_modules/acorn/index.js".into());
        assert!(validate_paths(&paths).is_err());
        paths.remove("node_modules/espree/node_modules/acorn/index.js");
        paths.remove(FILES[0].0);
        assert!(validate_paths(&paths).is_err());
        let lock: Value =
            serde_json::from_slice(include_bytes!("../../../../../../../package-lock.json"))
                .unwrap();
        validate_lock(&lock).unwrap();
        for field in ["version", "resolved", "integrity"] {
            let mut changed = lock.clone();
            changed["packages"]["node_modules/espree"][field] = json!("caller_replacement");
            assert!(validate_lock(&changed).is_err());
        }
    }
}
