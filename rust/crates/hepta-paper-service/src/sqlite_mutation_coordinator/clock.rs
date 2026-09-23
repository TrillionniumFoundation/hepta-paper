use super::*;
pub trait MutationClockV1 {
    fn now_millis(&mut self) -> Result<i64>;
}
impl<F: FnMut() -> Result<i64>> MutationClockV1 for F {
    fn now_millis(&mut self) -> Result<i64> {
        self()
    }
}
pub struct SystemMutationClockV1;
impl MutationClockV1 for SystemMutationClockV1 {
    fn now_millis(&mut self) -> Result<i64> {
        let duration = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| error("externally_fenced_sqlite_mutation_clock_invalid"))?;
        i64::try_from(duration.as_millis())
            .map_err(|_| error("externally_fenced_sqlite_mutation_clock_invalid"))
    }
}
pub(super) fn observe(clock: &mut dyn MutationClockV1) -> Result<(i64, String)> {
    let value = clock.now_millis()?;
    Ok((value, iso(value)?))
}
pub fn iso(value: i64) -> Result<String> {
    if !(-8_640_000_000_000_000..=8_640_000_000_000_000).contains(&value) {
        return Err(error("externally_fenced_sqlite_mutation_clock_invalid"));
    }
    let day = value.div_euclid(86_400_000);
    let time = value.rem_euclid(86_400_000);
    let z = day + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let year = if (0..10000).contains(&year) {
        format!("{year:04}")
    } else {
        format!(
            "{}{abs:06}",
            if year < 0 { "-" } else { "+" },
            abs = year.abs()
        )
    };
    Ok(format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        time / 3_600_000,
        (time / 60_000) % 60,
        (time / 1000) % 60,
        time % 1000
    ))
}
pub(super) fn nonce(prefix: &str) -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| error("externally_fenced_sqlite_mutation_randomness_unavailable"))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let s = hex::encode(bytes);
    Ok(format!(
        "{prefix}:{}-{}-{}-{}-{}",
        &s[..8],
        &s[8..12],
        &s[12..16],
        &s[16..20],
        &s[20..]
    ))
}
