import type { DirtyAction } from "../types";

interface DirtyPromptProps {
  fileName: string;
  onChoice: (action: DirtyAction) => void;
}

export function DirtyPrompt({ fileName, onChoice }: DirtyPromptProps) {
  return (
    <div className="modal-backdrop" onClick={() => onChoice("cancel")}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Unsaved changes</div>
        <div className="modal-body">
          <code>{fileName}</code> has unsaved changes.
        </div>
        <div className="modal-actions">
          <button onClick={() => onChoice("cancel")}>Cancel</button>
          <button onClick={() => onChoice("discard")}>Discard</button>
          <button className="primary" onClick={() => onChoice("save")}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
