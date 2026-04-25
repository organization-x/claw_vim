export function FileTree() {
  return (
    <div className="pane-inner file-tree">
      <div className="pane-header">Files</div>
      <div className="pane-body">
        <ul className="tree-list">
          <li>src/</li>
          <li className="indent">App.tsx</li>
          <li className="indent">main.tsx</li>
          <li>PLAN.md</li>
          <li>package.json</li>
        </ul>
      </div>
    </div>
  );
}
