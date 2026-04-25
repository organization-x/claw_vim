interface RepoInitPromptProps {
  folder: string;
  onChoice: (action: "init" | "skip" | "cancel") => void;
}

export function RepoInitPrompt({ folder, onChoice }: RepoInitPromptProps) {
  return (
    <div className="modal-backdrop" onClick={() => onChoice("cancel")}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Not a git repository</div>
        <div className="modal-body">
          <p>
            <code>{folder}</code> is not a git repo.
          </p>
          <p style={{ marginTop: "8px", fontSize: "12px" }}>
            Multiple sessions need git worktrees. <strong>Initialize</strong> to
            enable sessions, or <strong>skip</strong> to use the folder
            single-session.
          </p>
        </div>
        <div className="modal-actions">
          <button onClick={() => onChoice("cancel")}>Cancel</button>
          <button onClick={() => onChoice("skip")}>Skip</button>
          <button className="primary" onClick={() => onChoice("init")}>
            Initialize git
          </button>
        </div>
      </div>
    </div>
  );
}
