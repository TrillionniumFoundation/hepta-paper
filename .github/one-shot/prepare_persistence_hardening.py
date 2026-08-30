#!/usr/bin/env python3
from pathlib import Path

path = Path("rust/crates/hepta-qualification-ingest/src/bin/hepta-qualification-closure.rs")
text = path.read_text(encoding="utf-8")


def replace_exact(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    text = text.replace(old, new, 1)


replace_exact(
    "    process::ExitCode,\n    time::{SystemTime, UNIX_EPOCH},\n};\n",
    "    process::ExitCode,\n};\n",
    "pre-persistence time import",
)
replace_exact(
    "const MAXIMUM_CLOCK_SKEW_MS: u64 = 5 * 60 * 1000;\n",
    "",
    "pre-persistence clock constant",
)
replace_exact(
    "    #[error(\"closure request time differs from the verifier clock beyond the allowed skew\")]\n"
    "    ClockMismatch,\n"
    "    #[error(\"verifier system clock is invalid\")]\n"
    "    SystemClockInvalid,\n",
    "",
    "pre-persistence clock errors",
)

function_start = text.index("fn validate_wall_clock(")
function_end = text.index("fn valid_git_hash(", function_start)
text = text[:function_start] + text[function_end:]

clock_test_start = text.index(
    "    #[test]\n    fn request_time_is_bounded_to_the_verifier_clock() {"
)
clock_test_end = text.index(
    "    #[test]\n    fn help_is_read_only_and_succeeds() {",
    clock_test_start,
)
text = text[:clock_test_start] + text[clock_test_end:]

path.write_text(text, encoding="utf-8")
