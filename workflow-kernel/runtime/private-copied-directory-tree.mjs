import fs from 'node:fs';
import path from 'node:path';

export function makePrivateCopiedDirectoryTreeWritable({
  root,
  expectedUid = process.getuid?.(),
  expectedGid = process.getgid?.(),
} = {}) {
  const selectedRoot = path.resolve(String(root || ''));
  if (!path.isAbsolute(String(root || '')) || selectedRoot === path.parse(selectedRoot).root
    || !Number.isSafeInteger(expectedUid) || !Number.isSafeInteger(expectedGid)) {
    throw new Error('private_copied_directory_tree_configuration_invalid');
  }
  const pending = [selectedRoot];
  let directoryCount = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || stat.uid !== expectedUid || stat.gid !== expectedGid) {
      throw new Error('private_copied_directory_tree_identity_invalid');
    }
    fs.chmodSync(current, 0o700);
    directoryCount += 1;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new Error('private_copied_directory_tree_symlink_forbidden');
      }
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
    }
  }
  return Object.freeze({ root: selectedRoot, directoryCount, mode: '0700' });
}
