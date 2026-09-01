# Qualification Subject V3 tools

Run the dependency-free hostile suite from the repository root:

```bash
python3 docs/rust/tools/test_qualification_subject_v3.py
```

Live collection requires a GitHub token with read access to pull requests,
Actions runs/jobs/artifacts, checks, and repository contents:

```bash
python3 docs/rust/tools/qualification_subject_v3.py --help
```

The collector never writes repository, provider, campaign, release, storage, or
submission state. It emits a non-activating evidence object only.
