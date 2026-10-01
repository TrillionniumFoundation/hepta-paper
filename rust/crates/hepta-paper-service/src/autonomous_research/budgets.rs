//! Incumbent CLI Number conversion followed by its local golden ceilings.
//! The existing durable request represents whole microUSD and milliseconds;
//! fractional units are explicit unimplemented precision, never rounded permits.

const MAXIMUM_NUMBER_TEXT_BYTES: usize = 64 * 1024;

fn number(text: &str, label: &'static str) -> Result<f64, String> {
    if text.len() > MAXIMUM_NUMBER_TEXT_BYTES {
        return Err(format!(
            "autonomous_research_budget_number_too_large:{label}"
        ));
    }
    let value = crate::automation_runtime_reconciliation::sqlite_number::string_number(text)
        .ok_or_else(|| format!("autonomous_research_launch_budget_invalid:{label}"))?;
    if !value.is_finite() || value < 0.0 {
        return Err(format!("autonomous_research_launch_budget_invalid:{label}"));
    }
    Ok(value)
}

fn whole(value: f64, label: &'static str) -> Result<u64, String> {
    if value.fract() != 0.0 {
        return Err(format!(
            "autonomous_research_budget_fractional_unit_not_supported:{label}"
        ));
    }
    // Callers have already applied the incumbent golden ceilings; the cast
    // cannot saturate and never increases a configured request ceiling.
    Ok(value as u64)
}

pub(super) fn cost_microusd(text: &str) -> Result<u64, String> {
    let usd = number(text, "maxCostUsd")?.min(100.0);
    let micros = (usd * 1_000_000.0).round();
    // Multiplication alone may introduce a binary tail for an exact whole
    // microUSD Number (e.g. 123 or 249). The inverse must recover precisely
    // the incumbent Number; rounding arbitrary fractional permits is refused.
    if usd != micros / 1_000_000.0 {
        return Err(
            "autonomous_research_budget_fractional_unit_not_supported:maxCostUsd".to_owned(),
        );
    }
    Ok(micros as u64)
}

pub(super) fn wall_ms(text: &str) -> Result<u64, String> {
    whole(
        number(text, "maxWallTimeMs")?.min(7_200_000.0),
        "maxWallTimeMs",
    )
}
