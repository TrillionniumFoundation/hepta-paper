# Source transfer boundary

Any automation that imports repository-local source from an external bundle must verify the bundle hash, exact expected branch, clean checkout, allowed path manifest, absence of symlinks/special files, and exact resulting tree before committing. The import workflow grants no production authority.
