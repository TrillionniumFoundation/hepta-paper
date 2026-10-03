//! The incumbent preregistration design calculation, with the same ordered
//! floating-point operations and boundary refusal. This grants no authority.
pub(super) fn inverse_normal(probability: f64) -> f64 {
    if !(probability > 0.0 && probability < 1.0) {
        return f64::NAN;
    }
    let a = [
        -39.6968302866538,
        220.946098424521,
        -275.928510446969,
        138.357751867269,
        -30.6647980661472,
        2.50662827745924,
    ];
    let b = [
        -54.4760987982241,
        161.585836858041,
        -155.698979859887,
        66.8013118877197,
        -13.2806815528857,
    ];
    let c = [
        -0.00778489400243029,
        -0.322396458041136,
        -2.40075827716184,
        -2.54973253934373,
        4.37466414146497,
        2.93816398269878,
    ];
    let d = [
        0.00778469570904146,
        0.32246712907004,
        2.445134137143,
        3.75440866190742,
    ];
    if probability < 0.02425 {
        let q = (-2.0 * probability.ln()).sqrt();
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
            / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0);
    }
    if probability > 0.97575 {
        return -inverse_normal(1.0 - probability);
    }
    let q = probability - 0.5;
    let r = q * q;
    (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
        / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0)
}
pub(super) fn required_observations(
    alpha: f64,
    power: f64,
    effect: f64,
    hypotheses: usize,
) -> Option<u64> {
    if !(alpha > 0.0 && alpha < 1.0 && power > 0.5 && power < 1.0 && effect > 0.0)
        || hypotheses == 0
        || hypotheses > 9_007_199_254_740_991usize
    {
        return None;
    }
    let critical = inverse_normal(1.0 - alpha / (hypotheses as f64));
    let z = inverse_normal(power);
    let ratio = (critical + z) / effect;
    let count = (ratio * ratio).ceil();
    (count.is_finite() && (0.0..=9_007_199_254_740_991.0).contains(&count)).then_some(count as u64)
}
