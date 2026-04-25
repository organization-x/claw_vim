import { useState } from "react";
import type { TreeNode } from "../types";

interface FileTreeProps {
  folder: string | null;
  tree: TreeNode[];
  active: string | null;
  onOpenFolder: () => void;
  onSelect: (path: string) => void;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

interface NodeProps {
  node: TreeNode;
  active: string | null;
  onSelect: (path: string) => void;
  depth: number;
}

function Node({ node, active, onSelect, depth }: NodeProps) {
  const [open, setOpen] = useState(depth < 1);

  if (node.isDir) {
    return (
      <li>
        <div
          className="row dir"
          style={{ paddingLeft: depth * 12 + 8 }}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="chevron">{open ? "▾" : "▸"}</span>
          <span>{node.name}</span>
        </div>
        {open && node.children && (
          <ul className="tree-list">
            {node.children.map((c) => (
              <Node
                key={c.path}
                node={c}
                active={active}
                onSelect={onSelect}
                depth={depth + 1}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <li>
      <div
        className={`row file ${node.path === active ? "active" : ""}`}
        style={{ paddingLeft: depth * 12 + 20 }}
        onClick={() => onSelect(node.path)}
      >
        {node.name}
      </div>
    </li>
  );
}

export function FileTree({
  folder,
  tree,
  active,
  onOpenFolder,
  onSelect,
}: FileTreeProps) {
  return (
    <div className="pane-inner file-tree">
      <div className="pane-header tree-header">
        <span>{folder ? basename(folder) : "Files"}</span>
        <button className="open-btn" onClick={onOpenFolder}>
          Open…
        </button>
      </div>
      <div className="pane-body tree-body">
        {!folder && (
          <div className="empty-state">
            <p>No folder open.</p>
            <button onClick={onOpenFolder}>Open folder</button>
          </div>
        )}
        {folder && (
          <ul className="tree-list root">
            {tree.map((n) => (
              <Node
                key={n.path}
                node={n}
                active={active}
                onSelect={onSelect}
                depth={0}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
