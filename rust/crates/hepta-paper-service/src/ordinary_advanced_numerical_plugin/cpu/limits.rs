//! The signed descriptor limits accepted by this CPU adapter, without silent clamping.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct CpuExecutionLimits {
    pub timeout_ms: u64,
    pub memory_bytes: u64,
    pub cpu_seconds: u64,
    pub maximum_pids: u64,
    pub maximum_output_bytes: u64,
    pub maximum_captured_bytes: u64,
}
impl CpuExecutionLimits {
    pub(super) fn from_descriptor(descriptor: &Value) -> Result<Self, String> {
        let limits = &descriptor["limits"];
        let read = |key: &str| {
            limits[key]
                .as_u64()
                .filter(|n| *n > 0)
                .ok_or_else(|| "advanced_numerical_plugin_execution_limits_invalid".to_owned())
        };
        let value = Self {
            timeout_ms: read("timeoutMs")?,
            memory_bytes: read("memoryBytes")?,
            cpu_seconds: read("cpuSeconds")?,
            maximum_pids: read("maximumProcesses")?,
            maximum_output_bytes: read("maximumOutputBytes")?,
            maximum_captured_bytes: read("maximumCapturedBytes")?,
        };
        // The existing process owner supports six hours and a one-MiB tail.
        // Both stdout and the retained stderr must obey the same signed capture bound.
        // The existing held-FD document owner accepts at most four MiB per result.
        if value.timeout_ms > 6 * 60 * 60 * 1000
            || value.maximum_captured_bytes > 1024 * 1024
            || value.maximum_output_bytes > 4 * 1024 * 1024
            || value.maximum_captured_bytes > value.maximum_output_bytes
        {
            return Err(
                "advanced_numerical_plugin_cpu_execution_limits_domain_v1_unaccepted".into(),
            );
        }
        Ok(value)
    }
    pub(super) fn require_time_budget(self, c: &AtomicBool, d: Instant) -> Result<(), String> {
        check(c, d)?;
        let remaining = d
            .checked_duration_since(Instant::now())
            .ok_or("advanced_numerical_plugin_deadline_exceeded")?;
        if remaining < std::time::Duration::from_millis(self.timeout_ms) {
            return Err("advanced_numerical_plugin_cpu_signed_timeout_budget_unavailable".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn descriptor() -> Value {
        serde_json::json!({"limits":{"timeoutMs":30000,"memoryBytes":134217728,
            "cpuSeconds":30,"maximumProcesses":8192,"maximumOutputBytes":1048576,
            "maximumCapturedBytes":131072}})
    }
    #[test]
    fn signed_capture_limits_preserve_exact_values_and_reject_owner_overflow() {
        for cap in [1_u64, 1024, 131072, 1048576] {
            let mut d = descriptor();
            d["limits"]["maximumCapturedBytes"] = cap.into();
            assert_eq!(
                CpuExecutionLimits::from_descriptor(&d)
                    .unwrap()
                    .maximum_captured_bytes,
                cap
            );
        }
        for (key, value) in [
            ("maximumCapturedBytes", 1048577),
            ("maximumOutputBytes", 4194305),
            ("timeoutMs", 21600001),
            ("maximumCapturedBytes", 0),
            ("maximumOutputBytes", 0),
        ] {
            let mut d = descriptor();
            d["limits"][key] = value.into();
            assert!(
                CpuExecutionLimits::from_descriptor(&d).is_err(),
                "{key}={value}"
            );
        }
        let mut d = descriptor();
        d["limits"]["maximumCapturedBytes"] = 1025.into();
        d["limits"]["maximumOutputBytes"] = 1024.into();
        assert!(CpuExecutionLimits::from_descriptor(&d).is_err());
    }
    #[test]
    fn insufficient_deadline_or_cancel_refuses_before_process_without_changing_signed_timeout() {
        let limits = CpuExecutionLimits::from_descriptor(&descriptor()).unwrap();
        let c = AtomicBool::new(false);
        assert!(
            limits
                .require_time_budget(&c, Instant::now() + std::time::Duration::from_secs(1))
                .is_err()
        );
        assert_eq!(limits.timeout_ms, 30000);
        c.store(true, std::sync::atomic::Ordering::Release);
        assert!(
            limits
                .require_time_budget(&c, Instant::now() + std::time::Duration::from_secs(60))
                .is_err()
        );
        c.store(false, std::sync::atomic::Ordering::Release);
        assert!(
            limits
                .require_time_budget(&c, Instant::now() + std::time::Duration::from_secs(60))
                .is_ok()
        );
    }
}
