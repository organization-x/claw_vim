interface FileTreeProps {
  files: string[];
  active: string;
  onSelect: (path: string) => void;
}

export function FileTree({ files, active, onSelect }: FileTreeProps) {
  return (
    <div className="pane-inner file-tree">
      <div className="pane-header">Samples</div>
      <div className="pane-body">
        <ul className="tree-list">
          {files.map((f) => (
            <li
              key={f}
              className={f === active ? "active" : undefined}
              onClick={() => onSelect(f)}
            >
              {f}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
