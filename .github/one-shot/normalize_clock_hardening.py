#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[2]
source_path = root / "rust/crates/hepta-qualification-ingest/src/bin/hepta-qualification-closure.rs"
source = source_path.read_text(encoding="utf-8")

source = source.replace(
    "    time::{SystemTime, UNIX_EPOCH},\n",
    "    time::{Duration, SystemTime, UNIX_EPOCH},\n",
    1,
)
source = source.replace(
    "const MAXIMUM_CLOCK_SKEW_MS: u64 = 5 * 60 * 1000;\n",
    "",
    1,
)
source = source.replace(
    "    #[error(\"closure request time differs from the verifier clock beyond the allowed skew\")]\n"
    "    ClockMismatch,\n"
    "    #[error(\"verifier system clock is invalid\")]\n"
    "    SystemClockInvalid,\n",
    "",
    1,
)

clock_start = source.find("fn validate_wall_clock(")
if clock_start >= 0:
    clock_end = source.find("fn valid_git_hash(value: &str) -> bool {", clock_start)
    if clock_end < 0:
        raise SystemExit("clock helper end marker missing")
    source = source[:clock_start] + source[clock_end:]

clock_test_start = source.find(
    "    #[test]\n    fn request_time_is_bounded_to_the_verifier_clock() {"
)
if clock_test_start >= 0:
    clock_test_end = source.find(
        "    #[test]\n    fn help_is_read_only_and_succeeds() {",
        clock_test_start,
    )
    if clock_test_end < 0:
        raise SystemExit("clock test end marker missing")
    source = source[:clock_test_start] + source[clock_test_end:]

source_path.write_text(source, encoding="utf-8")
