# Plan v3 external qualification packets

This directory defines the only accepted envelope for evidence that cannot be manufactured by repository source or GitHub-hosted CI.

Every packet must bind:

- one fresh single-use challenge;
- the exact repository commit and Git tree under review;
- exact binary, configuration, service-unit and trust-store digests;
- the separately controlled issuer and its authority class;
- observation and expiry times;
- an attachment inventory with byte hashes;
- a content hash and Ed25519 signature;
- the evidence-kind-specific claims required by the schema.

The accepted evidence kinds are:

1. `independent_linux_review`;
2. `target_host_qualification`;
3. `storage_destructive_drill`;
4. `capability_key_owner_drill`;
5. `authenticated_codex_role_qualification`;
6. `campaign_writer_cutover_soak`;
7. `release_external_authority`.

A repository administrator, implementation author, fixture signer, GitHub runner or process sharing the implementation trust domain cannot issue an independent or external-authority packet. A structurally valid packet remains rejected until the Rust verifier authenticates its signature against the separately provisioned trust store and the challenge is consumed exactly once.

Use `prepare-external-challenge.py` to create a bounded challenge, run the corresponding target-host or authority harness, validate the packet shape with `validate-external-evidence.py`, then verify the signature and subject through the Rust qualification verifier. No command in this directory enables production activation by itself.
