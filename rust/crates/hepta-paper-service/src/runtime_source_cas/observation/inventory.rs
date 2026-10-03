//! Additive bounded accessors for the ordinary inventory adapter. These reuse
//! the CAS observer's retained descriptors, content guards and cancellation;
//! they do not grant source publication or installed authority.
use super::*;

#[derive(Clone, Debug)]
pub(crate) struct ObservedSourceMetadataV1 {
    pub directory: bool,
    pub device: u64,
    pub inode: u64,
    pub mode: u32,
    pub size: u64,
    pub mtime_seconds: i64,
    pub mtime_nanoseconds: i64,
    pub link_count: u64,
}
impl From<&Metadata> for ObservedSourceMetadataV1 {
    fn from(value: &Metadata) -> Self {
        Self {
            directory: value.is_dir(),
            device: value.dev(),
            inode: value.ino(),
            mode: value.mode(),
            size: value.len(),
            mtime_seconds: value.mtime(),
            mtime_nanoseconds: value.mtime_nsec(),
            link_count: value.nlink(),
        }
    }
}
#[derive(Clone, Debug)]
pub(crate) struct ObservedSourceEntryV1 {
    pub name: String,
    pub directory: bool,
    pub regular: bool,
    pub symlink: bool,
}

/// Fixed pre-read reservation shared by the two ordinary inventory observations.
/// Original CAS observations keep their independent default budget unchanged.
pub(crate) struct SharedInventoryReadBudgetV1(Arc<SharedInventoryCounters>);
impl SharedInventoryReadBudgetV1 {
    pub(crate) fn new() -> Self {
        Self(Arc::new(SharedInventoryCounters {
            bytes: AtomicU64::new(0),
            entries: AtomicUsize::new(0),
        }))
    }
    pub(crate) fn attach(&self, source: &mut SourceObservation<'_>) -> Result<(), String> {
        source.require_active()?;
        if source.budget.bytes != 0
            || source.inventory_entry_count != 0
            || source.budget.shared_inventory.is_some()
        {
            return Err(BOUND.to_owned());
        }
        source.budget.shared_inventory = Some(Arc::clone(&self.0));
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn with_prior_entries(entries: usize) -> Self {
        assert!(entries <= MAX_SEED_ENTRIES);
        Self(Arc::new(SharedInventoryCounters {
            bytes: AtomicU64::new(0),
            entries: AtomicUsize::new(entries),
        }))
    }
    #[cfg(test)]
    pub(crate) fn with_prior_reservations(bytes: u64) -> Self {
        assert!(bytes <= MAX_TOTAL_BYTES);
        Self(Arc::new(SharedInventoryCounters {
            bytes: AtomicU64::new(bytes),
            entries: AtomicUsize::new(0),
        }))
    }
}
impl SourceObservation<'_> {
    pub(crate) fn inventory_read_bytes(&self) -> Result<u64, String> {
        self.require_active()?;
        Ok(self.budget.bytes)
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn inventory_document(
        &mut self,
        relative: &Path,
        maximum: u64,
    ) -> Result<Vec<u8>, String> {
        if maximum > MAX_DOCUMENT_BYTES {
            return Err(BOUND.to_owned());
        }
        self.read(relative, maximum, true).map(|value| value.0)
    }

    /// Read a host-only document against the same retained file descriptor.
    /// This checks the opened owner and private mode before reading any bytes;
    /// it grants no authority and keeps the incumbent observation controls.
    pub(crate) fn inventory_private_document(
        &mut self,
        relative: &Path,
        maximum: u64,
    ) -> Result<Vec<u8>, String> {
        self.require_active()?;
        if maximum > MAX_DOCUMENT_BYTES {
            return Err(BOUND.to_owned());
        }
        let path = self.relative(relative, false)?;
        let pin = self.pins.get(&path).ok_or_else(|| INVALID.to_owned())?;
        pin.assert_current(&path)?;
        if pin.before.uid() != nix::unistd::Uid::effective().as_raw()
            || pin.before.mode() & 0o077 != 0
            || pin.before.nlink() != 1
        {
            return Err("native_private_input_identity_invalid".into());
        }
        let value = self.read(relative, maximum, true)?.0;
        self.assert_current()?;
        Ok(value)
    }

    /// Retain the first genuinely missing edge, including its held parent
    /// namespace. A subsequent creation is refused by both named absence and
    /// the existing complete namespace guard; absence is never an I/O fallback.
    pub(crate) fn inventory_probe(
        &mut self,
        relative: &Path,
    ) -> Result<Option<ObservedSourceMetadataV1>, String> {
        self.require_active()?;
        if relative.is_absolute()
            || relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(INVALID.to_owned());
        }
        let parts: Vec<_> = relative.components().collect();
        if parts.len() > MAX_SEED_DEPTH {
            return Err(BOUND.to_owned());
        }
        let mut parent = self.root.clone();
        for (index, part) in parts.iter().enumerate() {
            let Component::Normal(name) = part else {
                return Err(INVALID.to_owned());
            };
            let parent_pin = self.pins.get(&parent).ok_or_else(|| INVALID.to_owned())?;
            parent_pin.assert_current(&parent)?;
            let probe = match openat(
                parent_pin.held.as_fd(),
                Path::new(name),
                OFlag::O_PATH | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
                Mode::empty(),
            ) {
                Ok(descriptor) => File::from(descriptor),
                Err(nix::errno::Errno::ENOENT) => {
                    let pin = self
                        .pins
                        .get_mut(&parent)
                        .ok_or_else(|| INVALID.to_owned())?;
                    if !pin.enumerated {
                        pin.before = pin.held.metadata().map_err(|_| INVALID.to_owned())?;
                        pin.enumerated = true;
                    }
                    pin.assert_current(&parent)?;
                    let missing = parent.join(name);
                    match fs::symlink_metadata(&missing) {
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        _ => return Err(CHANGED.to_owned()),
                    }
                    if self.absent.len() >= MAX_SEED_ENTRIES {
                        return Err(BOUND.to_owned());
                    }
                    self.absent.insert(missing);
                    return Ok(None);
                }
                Err(error) => return Err(format!("r_runtime_source_cas_unavailable:{error}")),
            };
            let metadata = probe.metadata().map_err(|_| INVALID.to_owned())?;
            if (!metadata.is_file() && !metadata.is_dir())
                || (index + 1 < parts.len() && !metadata.is_dir())
            {
                return Err(INVALID.to_owned());
            }
            let child = self.child(&parent, Path::new(name), metadata.is_dir())?;
            let retained = self.pins.get(&child).ok_or_else(|| CHANGED.to_owned())?;
            if !content_identity(&metadata, &retained.before) {
                return Err(CHANGED.to_owned());
            }
            parent = child;
        }
        let pin = self.pins.get(&parent).ok_or_else(|| INVALID.to_owned())?;
        pin.assert_current(&parent)?;
        self.require_active()?;
        Ok(Some(ObservedSourceMetadataV1::from(&pin.before)))
    }

    /// One retained shallow enumeration. The ordinary Node filesystem reader
    /// sorts directory names by the underlying UTF-8 byte order; the adapter's
    /// depth-first walks consume this same order without a second filesystem
    /// observer. Symlink and special entries remain visible as unwalked names.
    pub(crate) fn inventory_entries(
        &mut self,
        relative: &Path,
    ) -> Result<Vec<ObservedSourceEntryV1>, String> {
        self.require_active()?;
        let Some(metadata) = self.inventory_probe(relative)? else {
            return Ok(Vec::new());
        };
        if !metadata.directory {
            return Err(INVALID.to_owned());
        }
        let path = self.root.join(relative);
        if let Some(entries) = self.inventories.get(&path) {
            self.pins
                .get(&path)
                .ok_or_else(|| INVALID.to_owned())?
                .assert_current(&path)?;
            return Ok(entries.clone());
        }
        let pin = self.pins.get_mut(&path).ok_or_else(|| INVALID.to_owned())?;
        if !pin.enumerated {
            pin.before = pin.held.metadata().map_err(|_| INVALID.to_owned())?;
            pin.enumerated = true;
        }
        pin.assert_current(&path)?;
        let mut directory = Dir::openat(
            pin.held.as_fd(),
            Path::new("."),
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| INVALID.to_owned())?;
        let mut entries = Vec::new();
        for entry in directory.iter() {
            require_observation_active(self.cancelled, self.deadline)?;
            let entry = entry.map_err(|_| INVALID.to_owned())?;
            let name = entry.file_name().to_bytes();
            if name == b"." || name == b".." {
                continue;
            }
            self.inventory_entry_count = self
                .inventory_entry_count
                .checked_add(1)
                .filter(|value| *value <= MAX_SEED_ENTRIES)
                .ok_or_else(|| BOUND.to_owned())?;
            if let Some(shared) = &self.budget.shared_inventory {
                shared
                    .entries
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                        used.checked_add(1).filter(|n| *n <= MAX_SEED_ENTRIES)
                    })
                    .map_err(|_| BOUND.to_owned())?;
            }
            let name = std::str::from_utf8(name).map_err(|_| INVALID.to_owned())?;
            let held = File::from(
                openat(
                    pin.held.as_fd(),
                    Path::new(name),
                    OFlag::O_PATH | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| CHANGED.to_owned())?,
            );
            let metadata = held.metadata().map_err(|_| INVALID.to_owned())?;
            entries.push(ObservedSourceEntryV1 {
                name: name.to_owned(),
                directory: metadata.is_dir(),
                regular: metadata.is_file(),
                symlink: metadata.file_type().is_symlink(),
            });
        }
        pin.assert_current(&path)?;
        entries.sort_by(|left, right| left.name.as_bytes().cmp(right.name.as_bytes()));
        self.inventories.insert(path, entries.clone());
        self.require_active()?;
        Ok(entries)
    }
}
