//! Fixed incumbent OneShot business reads. This accepts no SQL, campaign ID,
//! resource policy or writer capability from its caller.
use crate::{ReadOnlyStoreError as Error, ReadOnlyStoreV1, node_receipts::NodeValue};
use rusqlite::{Connection, types::ValueRef};
use serde_json::value::RawValue;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

const PROTECTED: &str = "autonomous-research:local-auto-20260730-51";
const TARGET: &str = "autonomous-research:local-auto-20260730-57";
const MAX_ROWS: usize = 20_000;
const MAX_CELL: usize = 1024 * 1024;
const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_VM_STEPS: u64 = 20_000_000;

pub struct OneShotBusinessRowsV1 {
    pub protected_campaign: Option<Box<RawValue>>,
    pub nodes: Vec<Box<RawValue>>,
}

pub struct OneShotBusinessCountsV1 {
    pub resource_lease_count: u64,
    pub waiter_count: u64,
    pub submission_count: u64,
    pub outbox_count: u64,
    pub ledger_count: u64,
}

fn bound(value: ValueRef<'_>) -> Result<usize, Error> {
    let (size, multiplier) = match value {
        ValueRef::Text(bytes) => (bytes.len(), 6usize),
        ValueRef::Blob(bytes) => (bytes.len(), 16),
        _ => return Ok(32),
    };
    if size > MAX_CELL {
        return Err(Error::OrdinaryBudgetExceeded("one_shot_cell_bytes_v1"));
    }
    size.checked_mul(multiplier)
        .and_then(|n| n.checked_add(2))
        .ok_or(Error::NumericOverflow)
}
fn project(
    connection: &Connection,
    sql: &str,
    parameter: &str,
    remaining: &mut usize,
    control: &crate::ordinary::ReadControl,
) -> Result<Vec<Box<RawValue>>, Error> {
    control.check()?;
    let mut statement = connection.prepare(sql)?;
    let names = statement
        .column_names()
        .iter()
        .map(|s| (*s).to_owned())
        .collect::<Vec<_>>();
    let mut rows = statement.query([parameter])?;
    let mut output = Vec::new();
    while let Some(row) = rows.next()? {
        control.check()?;
        if output.len() >= MAX_ROWS {
            return Err(Error::OrdinaryBudgetExceeded("one_shot_rows_v1"));
        }
        // Measure borrowed SQLite cells before NodeValue can clone text/blob.
        let mut measured = 2usize;
        for (index, name) in names.iter().enumerate() {
            measured = measured
                .checked_add(bound(row.get_ref(index)?)?)
                .and_then(|n| n.checked_add(name.len() + 4))
                .ok_or(Error::NumericOverflow)?;
        }
        if measured > *remaining {
            return Err(Error::OrdinaryBudgetExceeded(
                "one_shot_preallocation_bytes_v1",
            ));
        }
        let mut raw = String::new();
        raw.push('{');
        for (index, name) in names.iter().enumerate() {
            control.check()?;
            if index != 0 {
                raw.push(',');
            }
            raw.push_str(&serde_json::to_string(name).map_err(|_| Error::Serialization)?);
            raw.push(':');
            raw.push_str(NodeValue::from_sql(row.get_ref(index)?, true)?.json());
        }
        raw.push('}');
        *remaining = remaining
            .checked_sub(raw.len() + 1)
            .ok_or(Error::OrdinaryBudgetExceeded("one_shot_output_bytes_v1"))?;
        output.push(RawValue::from_string(raw).map_err(|_| Error::Serialization)?);
    }
    Ok(output)
}
fn count_query(
    connection: &Connection,
    sql: &str,
    parameter: &str,
    control: &crate::ordinary::ReadControl,
) -> Result<u64, Error> {
    control.check()?;
    let n: i64 = connection.query_row(sql, [parameter], |r| r.get(0))?;
    if !(0..=9_007_199_254_740_991).contains(&n) {
        return Err(Error::NodeIntegerOutOfRange);
    }
    control.check()?;
    Ok(n as u64)
}
fn selected_rows(
    connection: &Connection,
    control: &crate::ordinary::ReadControl,
) -> Result<OneShotBusinessRowsV1, Error> {
    let mut remaining = MAX_BYTES - 4096;
    let protected_campaign = project(
        connection,
        "SELECT * FROM paper_campaigns WHERE campaign_id=? LIMIT 1",
        PROTECTED,
        &mut remaining,
        control,
    )?
    .pop();
    // The incumbent refuses the missing protected campaign before reading
    // nodes, count tables or the target campaign.
    if protected_campaign.is_none() {
        return Ok(OneShotBusinessRowsV1 {
            protected_campaign,
            nodes: Vec::new(),
        });
    }
    control.check()?;
    let count: i64 = connection.query_row(
        "SELECT count(*) FROM (SELECT 1 FROM campaign_nodes WHERE campaign_id=? LIMIT 20001)",
        [PROTECTED],
        |r| r.get(0),
    )?;
    if count > MAX_ROWS as i64 {
        return Err(Error::OrdinaryBudgetExceeded("one_shot_rows_v1"));
    }
    let nodes = project(
        connection,
        "SELECT * FROM campaign_nodes WHERE campaign_id=? ORDER BY priority,created_at,node_id",
        PROTECTED,
        &mut remaining,
        control,
    )?;
    Ok(OneShotBusinessRowsV1 {
        protected_campaign,
        nodes,
    })
}
fn selected_counts(
    connection: &Connection,
    control: &crate::ordinary::ReadControl,
) -> Result<OneShotBusinessCountsV1, Error> {
    // The service calls this only after the existing row mappers validated
    // campaign and nodes. Re-read the fixed paper scope from the same store;
    // a caller cannot select a different submission namespace.
    control.check()?;
    let mut statement = connection
        .prepare("SELECT paper_id FROM paper_campaigns WHERE campaign_id=?")
        .map_err(Error::from)?;
    let mut rows = statement.query([PROTECTED]).map_err(Error::from)?;
    let row = rows
        .next()
        .map_err(Error::from)?
        .ok_or(Error::Serialization)?;
    let ValueRef::Text(bytes) = row.get_ref(0).map_err(Error::from)? else {
        return Err(Error::Serialization);
    };
    if bytes.len() > MAX_CELL {
        return Err(Error::OrdinaryBudgetExceeded("one_shot_cell_bytes_v1"));
    }
    let paper = std::str::from_utf8(bytes).map_err(|_| Error::Serialization)?;
    Ok(OneShotBusinessCountsV1 {
        resource_lease_count: count_query(
            connection,
            "SELECT count(*) FROM automation_resource_leases WHERE campaign_id=?",
            PROTECTED,
            control,
        )?,
        waiter_count: count_query(
            connection,
            "SELECT count(*) FROM automation_resource_waiters WHERE campaign_id=?",
            PROTECTED,
            control,
        )?,
        submission_count: count_query(
            connection,
            "SELECT count(*) FROM submissions WHERE slug=?",
            paper,
            control,
        )?,
        outbox_count: count_query(
            connection,
            "SELECT count(*) FROM submission_outbox WHERE json_extract(payload_json,'$.paperId')=?",
            paper,
            control,
        )?,
        ledger_count: count_query(
            connection,
            "SELECT count(*) FROM receipt_ledger WHERE json_extract(receipt_json,'$.campaignId')=?",
            PROTECTED,
            control,
        )?,
    })
}

impl ReadOnlyStoreV1 {
    pub fn fixed_one_shot_business_rows_v1(&self) -> Result<OneShotBusinessRowsV1, Error> {
        self.fixed_one_shot_read(selected_rows)
    }
    pub fn fixed_one_shot_business_counts_v1(&self) -> Result<OneShotBusinessCountsV1, Error> {
        self.fixed_one_shot_read(selected_counts)
    }
    pub fn fixed_one_shot_target_campaign_v1(&self) -> Result<Option<Box<RawValue>>, Error> {
        self.fixed_one_shot_read(|connection, control| {
            let mut remaining = MAX_BYTES - 4096;
            Ok(project(
                connection,
                "SELECT * FROM paper_campaigns WHERE campaign_id=? LIMIT 1",
                TARGET,
                &mut remaining,
                control,
            )?
            .pop())
        })
    }
    fn fixed_one_shot_read<T>(
        &self,
        select: impl FnOnce(&Connection, &crate::ordinary::ReadControl) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let control = self.control.as_ref().ok_or(Error::OrdinaryBudgetExceeded(
            "one_shot_original_control_required_v1",
        ))?;
        control.check()?;
        self.verify_unchanged()?;
        let steps = Arc::new(AtomicU64::new(0));
        let observed = Arc::clone(&steps);
        let progress = control.clone();
        self.connection.progress_handler(
            1000,
            Some(move || {
                #[cfg(test)]
                if let Some(vm) = &progress.observed_sqlite_progress {
                    vm.store(true, Ordering::Release);
                }
                observed.fetch_add(1000, Ordering::Relaxed) >= MAX_VM_STEPS
                    || progress.check().is_err()
            }),
        )?;
        let result = select(&self.connection, control);
        // Restore the original stored control on success and refusal. Generic
        // and old None entrypoints never acquire this fixed projection policy.
        control.install_sqlite_progress(&self.connection)?;
        control.check()?;
        self.verify_unchanged()?;
        if steps.load(Ordering::Relaxed) > MAX_VM_STEPS {
            return Err(Error::OrdinaryBudgetExceeded("one_shot_vm_steps_v1"));
        }
        result.map_err(|error| control.map(error))
    }
}

#[cfg(test)]
pub(crate) fn assert_fixed_one_shot_vm_controls_for_test(path: &std::path::Path) {
    use std::{
        sync::atomic::AtomicBool,
        time::{Duration, Instant},
    };
    const QUERY: &str = "WITH RECURSIVE counted(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM counted WHERE n<1000000000000) SELECT count(*) FROM counted";
    let before = std::fs::read(path).unwrap();
    let flag = Arc::new(AtomicBool::new(false));
    let mut store = ReadOnlyStoreV1::open_known_installed_with_cancellation_v1(
        path,
        Arc::clone(&flag),
        Instant::now() + Duration::from_secs(3),
    )
    .unwrap();
    let entered = Arc::new(AtomicBool::new(false));
    store.control.as_mut().unwrap().observed_sqlite_progress = Some(Arc::clone(&entered));
    let sender_flag = Arc::clone(&flag);
    let sender_entered = Arc::clone(&entered);
    let sender = std::thread::spawn(move || {
        let limit = Instant::now() + Duration::from_secs(2);
        while !sender_entered.load(Ordering::Acquire) && Instant::now() < limit {
            std::thread::yield_now();
        }
        assert!(
            sender_entered.load(Ordering::Acquire),
            "actual fixed-read VM callback"
        );
        sender_flag.store(true, Ordering::Release);
    });
    let result = store.fixed_one_shot_read(|connection, _| {
        connection
            .query_row::<i64, _, _>(QUERY, [], |r| r.get(0))
            .map_err(Error::from)
    });
    sender.join().unwrap();
    assert!(matches!(result, Err(Error::OrdinaryCancelled)));
    drop(store);
    let flag = Arc::new(AtomicBool::new(false));
    let mut store = ReadOnlyStoreV1::open_known_installed_with_cancellation_v1(
        path,
        Arc::clone(&flag),
        Instant::now() + Duration::from_secs(3),
    )
    .unwrap();
    let entered = Arc::new(AtomicBool::new(false));
    let control = store.control.as_mut().unwrap();
    *control = crate::ordinary::ReadControl::new(
        Arc::clone(&flag),
        Instant::now() + Duration::from_millis(30),
    );
    control.observed_sqlite_progress = Some(Arc::clone(&entered));
    let result = store.fixed_one_shot_read(|connection, _| {
        connection
            .query_row::<i64, _, _>(QUERY, [], |r| r.get(0))
            .map_err(Error::from)
    });
    assert!(entered.load(Ordering::Acquire));
    assert!(matches!(result, Err(Error::OrdinaryDeadlineExceeded)));
    drop(store);
    let flag = Arc::new(AtomicBool::new(false));
    let store = ReadOnlyStoreV1::open_known_installed_with_cancellation_v1(
        path,
        flag,
        Instant::now() + Duration::from_secs(3),
    )
    .unwrap();
    let result = store.fixed_one_shot_read(|connection, _| {
        connection
            .query_row::<i64, _, _>(QUERY, [], |r| r.get(0))
            .map_err(Error::from)
    });
    assert!(matches!(
        result,
        Err(Error::OrdinaryBudgetExceeded("one_shot_vm_steps_v1"))
    ));
    drop(store);
    let store = ReadOnlyStoreV1::open_known_installed_with_cancellation_v1(
        path,
        Arc::new(AtomicBool::new(false)),
        Instant::now() + Duration::from_secs(3),
    )
    .unwrap();
    assert!(
        store
            .fixed_one_shot_business_rows_v1()
            .unwrap()
            .protected_campaign
            .is_none()
    );
    store.verify_unchanged().unwrap();
    drop(store);
    assert_eq!(before, std::fs::read(path).unwrap());
    for suffix in ["-wal", "-shm", "-journal"] {
        assert!(!crate::sidecar(path, suffix).exists());
    }
}
