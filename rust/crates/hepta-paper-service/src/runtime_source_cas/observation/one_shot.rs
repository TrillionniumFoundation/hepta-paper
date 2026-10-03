//! The incumbent historical journal has a fixed 256 MiB domain. This narrow
//! accessor uses the existing held descriptor/read budget, not the inventory
//! document API or a pathname reopened by SQLite.
use super::*;

const JOURNAL_MAXIMUM_BYTES: u64 = 256 * 1024 * 1024;

impl SourceObservation<'_> {
    pub(crate) fn one_shot_private_directory_v1(
        &mut self,
        relative: &Path,
    ) -> Result<bool, String> {
        let Some(metadata) = self.inventory_probe(relative)? else {
            return Ok(false);
        };
        let path = self.root.join(relative);
        let pin = self.pins.get(&path).ok_or_else(|| CHANGED.to_owned())?;
        if !metadata.directory
            || pin.before.uid() != nix::unistd::Uid::current().as_raw()
            || pin.before.mode() & 0o777 != 0o700
        {
            return Err("campaign_one_shot_attempt_control_root_invalid".into());
        }
        pin.assert_current(&path)?;
        self.require_active()?;
        Ok(true)
    }

    pub(crate) fn one_shot_journal_present_v1(&mut self, relative: &Path) -> Result<bool, String> {
        let Some(metadata) = self.inventory_probe(relative)? else {
            return Ok(false);
        };
        let path = self.root.join(relative);
        let pin = self.pins.get(&path).ok_or_else(|| CHANGED.to_owned())?;
        if metadata.directory
            || pin.before.uid() != nix::unistd::Uid::current().as_raw()
            || pin.before.mode() & 0o777 != 0o600
            || metadata.size > JOURNAL_MAXIMUM_BYTES
        {
            return Err("campaign_one_shot_attempt_journal_file_invalid".into());
        }
        pin.assert_current(&path)?;
        self.require_active()?;
        Ok(true)
    }

    pub(crate) fn one_shot_journal_bytes_v1(
        &mut self,
        relative: &Path,
    ) -> Result<Option<Vec<u8>>, String> {
        if !self.one_shot_journal_present_v1(relative)? {
            return Ok(None);
        }
        self.read(relative, JOURNAL_MAXIMUM_BYTES, true)
            .map(|value| Some(value.0))
    }
}
