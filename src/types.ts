export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
}

export type DirtyAction = "save" | "discard" | "cancel";

export type SessionStatus =
  | "fresh"
  | "idle"
  | "working"
  | "blocked"
  | "error";

export type ViewMode = "source" | "split" | "preview";

export interface Session {
  id: string;
  name: string;
  isMain: boolean;
  status: SessionStatus;
  folder: string;          // working directory: repo root for main, worktree path otherwise
  branch: string | null;   // null for main (uses checked-out branch); non-null for worktree sessions
  baseSha: string | null;  // commit the worktree branched from (null for main)
  tree: TreeNode[];
  activePath: string | null;
  savedContent: string;
  liveContent: string;
  viewMode: ViewMode;
}

export interface RepoInfo {
  isRepo: boolean;
  root: string | null;
  head: string | null;
  branch: string | null;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseSha: string;
}
