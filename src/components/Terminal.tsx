export function Terminal() {
  return (
    <div className="pane-inner terminal">
      <div className="pane-header">claude</div>
      <div className="pane-body terminal-body">
        <pre>{`$ claude
> placeholder — M5 will hook up xterm.js + PTY
`}</pre>
      </div>
    </div>
  );
}
