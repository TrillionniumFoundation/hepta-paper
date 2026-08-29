# Import manifest requirements

A development source bundle must enumerate each path, kind, byte length and SHA-256 hash; reject absolute paths, traversal, links and special nodes; and declare the intended parent commit. Import must fail on any extra or missing entry.
