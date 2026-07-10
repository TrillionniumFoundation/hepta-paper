# Semantic Visual Model Policy

`semantic-visual-model-policy` is the shared local policy for semantic visual
review model selection. It requires an explicit model before a channel may route
to a semantic visual referee, blocks known-disallowed model patterns and older
model floors by default, and returns deterministic blocker rows for
package-review gates.

The module is policy-only. It does not call providers or models, read channel
state, mutate lifecycle state, upload, submit, send IM, accept delivery, pay,
deploy, or grant execution permission. Channel adapters remain responsible for
their own environment variable names, approval packets, spend guards, and actual
provider invocation wrappers.

Exports:

- `SEMANTIC_VISUAL_MODEL_POLICY_VERSION`
- `SEMANTIC_VISUAL_MODEL_POLICY_SAFETY`
- `DEFAULT_SEMANTIC_VISUAL_MODEL_MINIMUM`
- `DISALLOWED_SEMANTIC_VISUAL_MODEL_RE`
- `DISALLOWED_SEMANTIC_VISUAL_MODEL_TIER_RE`
- `resolveSemanticVisualModel(args, options)`
- `semanticVisualModelBlockerCheck(error, options)`
- `semanticVisualModelPolicySelftest()`

`resolveSemanticVisualModel()` accepts channel-provided argument keys,
environment keys, and allow-override keys. A missing or empty model throws
`SEMANTIC_VISUAL_MODEL_REQUIRED`; a known-disallowed model such as a `gpt-5.4`
semantic route throws `SEMANTIC_VISUAL_MODEL_DISALLOWED`; mini/nano/small/lite
tiers throw `SEMANTIC_VISUAL_MODEL_TIER_DISALLOWED`; explicit GPT routes below
the local `gpt-5.5` semantic visual floor throw
`SEMANTIC_VISUAL_MODEL_BELOW_MINIMUM`; and unrecognized model strings throw
`SEMANTIC_VISUAL_MODEL_UNRECOGNIZED` unless the channel has an explicit current
allow override.
