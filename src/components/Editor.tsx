export function Editor() {
  return (
    <div className="pane-inner editor">
      <div className="pane-header">App.tsx — NORMAL</div>
      <div className="pane-body editor-body">
        <pre>{`// editor placeholder
// M2 will replace this with CodeMirror + vim
function hello() {
  return "claude-vim";
}
`}</pre>
      </div>
    </div>
  );
}
