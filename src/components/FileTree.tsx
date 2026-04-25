import { useMemo, useState } from "react";
import type { ChangeEntry, ChangeStatus, TreeNode } from "../types";

interface FileTreeProps {
  folder: string | null;
  tree: TreeNode[];
  changes: ChangeEntry[];
  active: string | null;
  onOpenFolder: () => void;
  onSelect: (path: string) => void;
  onRefresh: () => void;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function statusGlyph(status: ChangeStatus): string {
  switch (status) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "untracked":
      return "U";
  }
}

interface NodeProps {
  node: TreeNode;
  active: string | null;
  statusByPath: Map<string, ChangeStatus>;
  onSelect: (path: string) => void;
  depth: number;
}

function Node({ node, active, statusByPath, onSelect, depth }: NodeProps) {
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
                statusByPath={statusByPath}
                onSelect={onSelect}
                depth={depth + 1}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const status = statusByPath.get(node.path);

  return (
    <li>
      <div
        className={`row file ${node.path === active ? "active" : ""} ${status ? `change-${status}` : ""}`}
        style={{ paddingLeft: depth * 12 + 20 }}
        onClick={() => onSelect(node.path)}
      >
        <span className="file-name">{node.name}</span>
        {status && <span className={`change-dot change-${status}`} />}
      </div>
    </li>
  );
}

export function FileTree({
  folder,
  tree,
  changes,
  active,
  onOpenFolder,
  onSelect,
  onRefresh,
}: FileTreeProps) {
  // Build absolute-path → status lookup once per render
  const statusByPath = useMemo(() => {
    const m = new Map<string, ChangeStatus>();
    if (!folder) return m;
    for (const c of changes) {
      m.set(`${folder}/${c.path}`, c.status);
    }
    return m;
  }, [folder, changes]);

  return (
    <div className="pane-inner file-tree">
      <div className="pane-header tree-header">
        <span>{folder ? basename(folder) : "Files"}</span>
        <span className="header-right">
          {folder && (
            <button
              className="open-btn"
              onClick={onRefresh}
              title="Refresh"
            >
              ↻
            </button>
          )}
          <button className="open-btn" onClick={onOpenFolder}>
            Open…
          </button>
        </span>
      </div>
      <div className="pane-body tree-body">
        {!folder && (
          <div className="empty-state">
            <p>No folder open.</p>
            <button onClick={onOpenFolder}>Open folder</button>
          </div>
        )}
        {folder && changes.length > 0 && (
          <div className="changes-section">
            <div className="changes-header">Changes ({changes.length})</div>
            <ul className="tree-list changes-list">
              {changes.map((c) => {
                const abs = `${folder}/${c.path}`;
                return (
                  <li key={abs}>
                    <div
                      className={`row file change-${c.status} ${abs === active ? "active" : ""}`}
                      onClick={() => onSelect(abs)}
                      title={c.path}
                    >
                      <span className={`change-letter change-${c.status}`}>
                        {statusGlyph(c.status)}
                      </span>
                      <span className="file-name">{c.path}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {folder && (
          <ul className="tree-list root">
            {tree.map((n) => (
              <Node
                key={n.path}
                node={n}
                active={active}
                statusByPath={statusByPath}
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
