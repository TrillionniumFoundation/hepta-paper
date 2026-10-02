//! Pre-allocation composition bounds, independent of submission authority.
use super::*;
use std::io::{self, Write};
const MAX_RETAINED_RESULT_BYTES: usize = 8 * 1024 * 1024;
struct Count<'a> {
    bytes: usize,
    cancelled: &'a AtomicBool,
    deadline: Instant,
}
impl Write for Count<'_> {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        check(self.cancelled, self.deadline).map_err(io::Error::other)?;
        let next = self
            .bytes
            .checked_add(b.len())
            .filter(|v| *v <= MAX_RETAINED_RESULT_BYTES)
            .ok_or_else(|| io::Error::other("native_batch_operator_result_budget_v1"))?;
        self.bytes = next;
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn length(value: &Value, cancelled: &AtomicBool, deadline: Instant) -> Result<usize, String> {
    let mut counter = Count {
        bytes: 0,
        cancelled,
        deadline,
    };
    serde_json::to_writer(&mut counter, value).map_err(|e| e.to_string())?;
    Ok(counter.bytes)
}
pub(super) struct ResultsBudgetV1 {
    reserved: usize,
}
impl ResultsBudgetV1 {
    pub(super) fn new(
        scan: &Value,
        target: &Value,
        cancelled: &AtomicBool,
        deadline: Instant,
    ) -> Result<Self, String> {
        check(cancelled, deadline)?;
        let rows = scan["rows"]
            .as_array()
            .ok_or("native_batch_operator_inventory_shape_invalid")?;
        let commands = if target["status"] == "target_scope_verified" {
            rows.iter()
                .filter(|r| r["sourceDir"].as_str().is_some_and(|s| !s.is_empty()))
                .count()
        } else {
            0
        };
        // This repeated subset is present in each actual command subject. Reject its
        // aggregate before cloning the target receipt into any command input. The
        // full result reservation below charges all command/plan/task/state bytes.
        let scope_bytes = length(&target["selectedPaperIds"], cancelled, deadline)?
            .checked_add(length(&target["requestedPaperIds"], cancelled, deadline)?)
            .ok_or("native_batch_operator_result_budget_v1")?;
        if scope_bytes
            .checked_mul(commands)
            .is_none_or(|b| b > MAX_RETAINED_RESULT_BYTES)
        {
            return Err("native_batch_operator_result_budget_v1".into());
        }
        Ok(Self { reserved: 0 })
    }
    pub(super) fn reserve_before_result_clone(
        &mut self,
        row: &Value,
        command: Option<&Value>,
        cancelled: &AtomicBool,
        deadline: Instant,
    ) -> Result<(), String> {
        check(cancelled, deadline)?;
        let row_bytes = length(&row["task"], cancelled, deadline)?
            .checked_add(length(&row["state"], cancelled, deadline)?)
            .ok_or("native_batch_operator_result_budget_v1")?;
        let command = command.unwrap_or(&Value::Null);
        let command_bytes = length(command, cancelled, deadline)?
            .checked_add(length(&command["campaignPlan"], cancelled, deadline)?)
            .ok_or("native_batch_operator_result_budget_v1")?;
        // Queue/lineage/status/hash/row projections contain only fixed keys plus
        // identifiers from the same task/state. Charge an explicit conservative
        // allowance before their creation, rather than allocate then truncate.
        let charge = row_bytes
            .checked_mul(2)
            .and_then(|v| v.checked_add(command_bytes))
            .and_then(|v| v.checked_add(16 * 1024))
            .ok_or("native_batch_operator_result_budget_v1")?;
        let next = self
            .reserved
            .checked_add(charge)
            .filter(|v| *v <= MAX_RETAINED_RESULT_BYTES)
            .ok_or("native_batch_operator_result_budget_v1")?;
        self.reserved = next;
        Ok(())
    }
}
