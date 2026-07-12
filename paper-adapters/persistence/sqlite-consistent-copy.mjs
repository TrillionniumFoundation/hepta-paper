import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

export async function copySqliteDatabase({ sourcePath, destinationPath } = {}) {
  if (!sourcePath || !destinationPath || !fs.existsSync(sourcePath)) throw new Error('existing SQLite source and destination paths are required');
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.rmSync(destinationPath, { force: true });
  const database = new DatabaseSync(path.resolve(sourcePath), { readOnly: true });
  try {
    await backup(database, path.resolve(destinationPath));
  } finally {
    database.close();
  }
  return destinationPath;
}
