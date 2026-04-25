import { useEffect, useMemo, useRef, useState } from "react";
import Fuse from "fuse.js";

interface FuzzyFinderProps {
  files: string[];
  folder: string;
  onPick: (path: string) => void;
  onClose: () => void;
}

function relativeTo(folder: string, path: string): string {
  if (path.startsWith(folder + "/")) return path.slice(folder.length + 1);
  return path;
}

export function FuzzyFinder({
  files,
  folder,
  onPick,
  onClose,
}: FuzzyFinderProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const items = useMemo(
    () =>
      files.map((path) => ({ path, rel: relativeTo(folder, path) })),
    [files, folder],
  );

  const fuse = useMemo(
    () => new Fuse(items, { keys: ["rel"], threshold: 0.4 }),
    [items],
  );

  const results = useMemo(() => {
    if (!query.trim()) return items.slice(0, 50);
    return fuse.search(query, { limit: 50 }).map((r) => r.item);
  }, [query, fuse, items]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = results[selected];
      if (pick) onPick(pick.path);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal fuzzy"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="fuzzy-input"
          placeholder="Find file…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul className="fuzzy-list">
          {results.map((r, i) => (
            <li
              key={r.path}
              className={i === selected ? "selected" : ""}
              onMouseEnter={() => setSelected(i)}
              onClick={() => onPick(r.path)}
            >
              {r.rel}
            </li>
          ))}
          {results.length === 0 && <li className="empty">No matches</li>}
        </ul>
      </div>
    </div>
  );
}
