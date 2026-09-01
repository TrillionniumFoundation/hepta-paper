# Qualification Subject V3 validation trigger

This marker is intentionally under `rust/**` so every manifest-bound Rust source
qualification producer executes on the final Qualification Subject V3 pull-request
head. It grants no production, provider, writer, release, submission, host, key,
or external-authority capability.

The marker may be removed only after all required producers have permanent
unfiltered pull-request triggers or an equivalent fail-closed producer-liveness
contract.
