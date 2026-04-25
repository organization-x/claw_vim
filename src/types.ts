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
  activePath: string | null;
  savedContent: string;
  liveContent: string;
  viewMode: ViewMode;
}
