# Frozen production collation data

`node22-en-us-unihan.postcard` contains the native ICU4X data used for the
`node22.23.1-icu78.2-cldr48-en-US-v1` compatibility profile. The accompanying
`production-collation-provenance.json` records exact official source URLs,
archive digests, generator identity, marker selection, output digest and licenses.
The blob is read from the compiled Rust executable; no Node process or network
request is needed to encode/hash production data.

The ordinary ICU4X compiled data uses an **implicit Han** root to reduce size.
That changes the order of extended CJK keys relative to actual Node ICU's full
**Unihan radical/stroke** root. For example, the default root compares `𠆈` after
`佁`, while the production Node source compares it before `佁`. Reusing the
ordinary compiled root would silently change record hashes. The matching Jamo
data also differs; the complete collation and NFD marker set is therefore
exported together from the same ICU input.

To build the source-enabled generator:

```sh
cargo install icu4x-datagen --version 2.1.1 --no-default-features \
  --features provider,blob_exporter,networking
```

Download the exact ICU and CLDR archives from the official URLs in the manifest,
then reproduce and verify the frozen output (supply local absolute paths):

```sh
python3 tools/regenerate-production-collation.py \
  --datagen /path/to/icu4x-datagen \
  --icu-export /path/to/icu4x-icuexportdata-78.2.zip \
  --cldr /path/to/cldr-48.0.0-json-full.zip
```

The script verifies both source archive hashes, requires the recorded generator
version, uses only the supplied local archives, and requires the generated blob
to match the committed output hash. `--write` replaces the checked-in blob only
after that verification. An output mismatch requires a new profile and renewed
production-source qualification; never update the digest just to silence a test.

The generator's recorded binary SHA binds the actual generating executable.
Rebuilding its source can resolve different transitive patches or use a different
compiler; the generated-output hash remains the reproducibility gate. No claim is
made that a reconstructed dependency lock reproduces the original tool binary.

`ICU78.2-LICENSE` and `CLDR48-LICENSE` retain the upstream Unicode licenses and
third-party notices. The data is derived from those projects, not authored
collation tables. The Rust source verifies the blob digest before constructing
the collator. Differential tests compare bytes and hashes to the real production
Node exports, including extended Han and Hangul keys and the full Unicode corpus.
