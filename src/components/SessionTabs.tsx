import type { Session } from "../types";

interface SessionTabsProps {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onClose: (id: string) => void;
}

export function SessionTabs({
  sessions,
  activeId,
  onSelect,
  onCreate,
  onClose,
}: SessionTabsProps) {
  return (
    <div className="session-tabs">
      {sessions.map((s) => (
        <div
          key={s.id}
          className={`session-tab ${s.id === activeId ? "active" : ""}`}
          onClick={() => onSelect(s.id)}
          title={s.name}
        >
          <span className={`status-dot status-${s.status}`} />
          <span className="session-name">{s.name}</span>
          {!s.isMain && (
            <button
              className="session-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(s.id);
              }}
              title="Close session"
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button
        className="session-add"
        onClick={onCreate}
        title="New session"
      >
        +
      </button>
    </div>
  );
}
