import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const FILES_ZVEC = "files.zvec";
const ENTITIES_ZVEC = "index.zvec";

type WorkspaceIndexStoragePaths = {
  storagePath: string;
  filesPath: string;
  indexPath: string;
};

export function resolveWorkspaceIndexStoragePaths(
  storagePath: string,
): WorkspaceIndexStoragePaths {
  const resolvedStoragePath = resolve(storagePath);
  return {
    storagePath: resolvedStoragePath,
    filesPath: join(resolvedStoragePath, FILES_ZVEC),
    indexPath: join(resolvedStoragePath, ENTITIES_ZVEC),
  };
}

export function hasWorkspaceIndexStorage(storagePath: string): boolean {
  const paths = resolveWorkspaceIndexStoragePaths(storagePath);
  return existsSync(paths.filesPath) && existsSync(paths.indexPath);
}

export function workspaceIndexPath(storagePath: string): string {
  return resolveWorkspaceIndexStoragePaths(storagePath).indexPath;
}
