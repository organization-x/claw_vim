export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
}

export type DirtyAction = "save" | "discard" | "cancel";
