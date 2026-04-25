import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileTree } from "./components/FileTree";
import { Editor, type EditorHandle } from "./components/Editor";
import { Terminal, type TerminalHandle } from "./components/Terminal";
import { DirtyPrompt } from "./components/DirtyPrompt";
import { FuzzyFinder } from "./components/FuzzyFinder";
import { MarkdownPreview } from "./components/MarkdownPreview";
import { SessionTabs } from "./components/SessionTabs";
import type { Session, TreeNode, ViewMode } from "./types";
import "./App.css";

function flattenFiles(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: TreeNode[]) => {
    for (const n of ns) {
      if (n.isDir) {
        if (n.children) walk(n.children);
      } else {
        out.push(n.path);
      }
    }
  };
  walk(nodes);
  return out;
}

function isMarkdown(path: string | null): boolean {
  if (!path) return false;
  const ext = path.toLowerCase().split(".").pop();
  return ext === "md" || ext === "markdown";
}

function newId(): string {
  return `s-${Math.random().toString(36).slice(2, 10)}`;
}

function makeMainSession(): Session {
  return {
    id: newId(),
    name: "main",
    isMain: true,
    status: "fresh",
    activePath: null,
    savedContent: "",
    liveContent: "",
    viewMode: "preview",
  };
}

function makeWorktreeSession(id: string, index: number): Session {
  return {
    id,
    name: `session ${index}`,
    isMain: false,
    status: "fresh",
    activePath: null,
    savedContent: "",
    liveContent: "",
    viewMode: "preview",
  };
}

const LAST_FOLDER_KEY = "claudevim:lastFolder";

function App() {
  const [folder, setFolder] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [fuzzyOpen, setFuzzyOpen] = useState(false);
  const editorRef = useRef<EditorHandle>(null);
  const terminalRef = useRef<TerminalHandle>(null);

  const fileList = useMemo(() => flattenFiles(tree), [tree]);
  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );
  const activePath = activeSession?.activePath ?? null;
  const dirty = activeSession
    ? activeSession.liveContent !== activeSession.savedContent
    : false;
  const md = isMarkdown(activePath);
  const effectiveMode: ViewMode = md
    ? activeSession?.viewMode ?? "preview"
    : "source";

  const updateSession = useCallback(
    (id: string, patch: Partial<Session>) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      );
    },
    [],
  );

  // When the active file becomes/stops being markdown, normalize viewMode
  useEffect(() => {
    if (!activeSession) return;
    if (md && activeSession.viewMode === "source") {
      updateSession(activeSession.id, { viewMode: "preview" });
    } else if (!md && activeSession.viewMode !== "source") {
      updateSession(activeSession.id, { viewMode: "source" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [md, activeSession?.id, activeSession?.activePath]);

  const refreshTree = useCallback(async (root: string) => {
    const t = await invoke<TreeNode[]>("read_dir_tree", { path: root });
    setTree(t);
  }, []);

  const adoptFolder = useCallback(
    async (picked: string) => {
      setFolder(picked);
      try {
        await refreshTree(picked);
        localStorage.setItem(LAST_FOLDER_KEY, picked);
        // Always start with a single "main" session
        const main = makeMainSession();
        setSessions([main]);
        setActiveSessionId(main.id);
      } catch {
        localStorage.removeItem(LAST_FOLDER_KEY);
        setFolder(null);
        setTree([]);
        setSessions([]);
        setActiveSessionId(null);
      }
    },
    [refreshTree],
  );

  const openFolder = useCallback(async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    await adoptFolder(picked);
  }, [adoptFolder]);

  // Restore last-opened folder on mount
  useEffect(() => {
    const saved = localStorage.getItem(LAST_FOLDER_KEY);
    if (saved) void adoptFolder(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadFile = useCallback(
    async (path: string) => {
      if (!activeSessionId) return;
      const text = await invoke<string>("read_file_text", { path });
      updateSession(activeSessionId, {
        activePath: path,
        savedContent: text,
        liveContent: text,
      });
    },
    [activeSessionId, updateSession],
  );

  const saveCurrent = useCallback(
    async (text: string) => {
      if (!activeSession || !activeSession.activePath) return;
      await invoke("write_file_text", {
        path: activeSession.activePath,
        content: text,
      });
      updateSession(activeSession.id, {
        savedContent: text,
        liveContent: text,
      });
    },
    [activeSession, updateSession],
  );

  const onContentChange = useCallback(
    (text: string) => {
      if (!activeSessionId) return;
      updateSession(activeSessionId, { liveContent: text });
    },
    [activeSessionId, updateSession],
  );

  const requestSwitch = useCallback(
    (next: string) => {
      if (next === activePath) return;
      if (dirty) {
        setPendingPath(next);
        return;
      }
      void loadFile(next);
    },
    [activePath, dirty, loadFile],
  );

  const resolveDirty = useCallback(
    async (action: "save" | "discard" | "cancel") => {
      const target = pendingPath;
      setPendingPath(null);
      if (action === "cancel" || !target) return;
      if (action === "save") {
        const text = editorRef.current?.getContent() ?? "";
        await saveCurrent(text);
      }
      await loadFile(target);
    },
    [pendingPath, saveCurrent, loadFile],
  );

  // Session management — note: id is computed outside the setSessions updater
  // so StrictMode's purity-check double-run doesn't generate two ids.
  const createSession = useCallback(() => {
    const id = newId();
    setSessions((prev) => {
      const idx = prev.filter((s) => !s.isMain).length + 1;
      return [...prev, makeWorktreeSession(id, idx)];
    });
    setActiveSessionId(id);
  }, []);

  const closeSession = useCallback(
    (id: string) => {
      const remaining = sessions.filter((s) => s.id !== id);
      setSessions(remaining);
      if (id === activeSessionId) {
        const fallback = remaining.find((s) => s.isMain) ?? remaining[0];
        setActiveSessionId(fallback?.id ?? null);
      }
    },
    [activeSessionId, sessions],
  );

  const switchSession = useCallback(
    (id: string) => {
      if (id === activeSessionId) return;
      // Capture current editor buffer into the outgoing session before unmount
      if (activeSessionId && editorRef.current) {
        const live = editorRef.current.getContent();
        updateSession(activeSessionId, { liveContent: live });
      }
      setActiveSessionId(id);
    },
    [activeSessionId, updateSession],
  );

  // Cmd/Ctrl+P → fuzzy finder
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "p" && folder) {
        e.preventDefault();
        setFuzzyOpen(true);
      } else if (e.key === "Escape" && fuzzyOpen) {
        setFuzzyOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [folder, fuzzyOpen]);

  const onFuzzyPick = useCallback(
    (path: string) => {
      setFuzzyOpen(false);
      requestSwitch(path);
    },
    [requestSwitch],
  );

  const onVimEdit = useCallback(
    (rel: string) => {
      if (!folder) return;
      const abs = rel.startsWith("/") ? rel : `${folder}/${rel}`;
      requestSwitch(abs);
    },
    [folder, requestSwitch],
  );

  const sendActiveToClaude = useCallback(() => {
    if (!folder || !activePath) return;
    const rel = activePath.startsWith(folder + "/")
      ? activePath.slice(folder.length + 1)
      : activePath;
    void terminalRef.current?.send(`@${rel} `);
  }, [folder, activePath]);

  // Cmd/Ctrl+L → send @<relative-path> to Claude
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "l") {
        if (folder && activePath) {
          e.preventDefault();
          sendActiveToClaude();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [folder, activePath, sendActiveToClaude]);

  const setViewMode = useCallback(
    (m: ViewMode) => {
      if (!activeSessionId) return;
      updateSession(activeSessionId, { viewMode: m });
    },
    [activeSessionId, updateSession],
  );

  const viewModeButtons = md && activeSession ? (
    <span className="view-modes">
      {(["source", "split", "preview"] as const).map((m) => (
        <button
          key={m}
          className={`header-btn ${activeSession.viewMode === m ? "active" : ""}`}
          onClick={() => setViewMode(m)}
        >
          {m[0].toUpperCase() + m.slice(1)}
        </button>
      ))}
    </span>
  ) : null;

  const sendButton = (
    <button
      className="header-btn"
      onClick={sendActiveToClaude}
      disabled={!folder || !activePath || !activeSession?.isMain}
      title={
        activeSession?.isMain
          ? "Send @path to Claude (⌘L)"
          : "Worktree sessions wired up in M7.2"
      }
    >
      Send to Claude ⌘L
    </button>
  );

  const headerActions = (
    <>
      {viewModeButtons}
      {sendButton}
    </>
  );

  const editorEl = (
    <Editor
      ref={editorRef}
      key={activeSession?.id ?? "none"}
      path={activePath}
      initialContent={activeSession?.liveContent ?? ""}
      dirty={dirty}
      onSave={saveCurrent}
      onContentChange={onContentChange}
      onEdit={onVimEdit}
      headerRight={headerActions}
    />
  );

  const previewEl = (
    <div className="pane-inner">
      <div className="pane-header editor-header">
        <span>
          {activePath ?? "(no file)"} {dirty ? "● " : ""}— PREVIEW
        </span>
        {effectiveMode === "preview" && (
          <span className="header-right">{headerActions}</span>
        )}
      </div>
      <div className="pane-body md-body">
        <MarkdownPreview source={activeSession?.liveContent ?? ""} />
      </div>
    </div>
  );

  return (
    <div className="app">
      <Group orientation="horizontal">
        <Panel defaultSize={18} minSize={10} className="pane">
          <FileTree
            folder={folder}
            tree={tree}
            active={activePath}
            onOpenFolder={openFolder}
            onSelect={requestSwitch}
          />
        </Panel>
        <Separator className="resize-handle" />
        <Panel defaultSize={48} minSize={20} className="pane">
          {effectiveMode === "split" ? (
            <Group orientation="vertical">
              <Panel defaultSize={50} minSize={20}>
                {editorEl}
              </Panel>
              <Separator className="resize-handle horizontal" />
              <Panel defaultSize={50} minSize={20} className="pane">
                {previewEl}
              </Panel>
            </Group>
          ) : effectiveMode === "preview" ? (
            previewEl
          ) : (
            editorEl
          )}
        </Panel>
        <Separator className="resize-handle" />
        <Panel defaultSize={34} minSize={20} className="pane">
          <div className="right-pane">
            {sessions.length > 0 && (
              <SessionTabs
                sessions={sessions}
                activeId={activeSessionId}
                onSelect={switchSession}
                onCreate={createSession}
                onClose={closeSession}
              />
            )}
            <div className="right-pane-body">
              {/* Terminal stays mounted for the main session; hidden when a non-main tab is active */}
              <div
                className="terminal-mount"
                style={{
                  display:
                    activeSession?.isMain || sessions.length === 0
                      ? "flex"
                      : "none",
                }}
              >
                <Terminal ref={terminalRef} folder={folder} />
              </div>
              {activeSession && !activeSession.isMain && (
                <div className="pane-inner">
                  <div className="empty-state session-placeholder">
                    <p>
                      <strong>{activeSession.name}</strong>
                    </p>
                    <p>
                      Worktree-isolated sessions land in <code>M7.2</code>.
                    </p>
                    <p>Switch to <strong>main</strong> to use Claude.</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Panel>
      </Group>
      {pendingPath && activePath && (
        <DirtyPrompt
          fileName={activePath.split("/").pop() ?? activePath}
          onChoice={resolveDirty}
        />
      )}
      {fuzzyOpen && folder && (
        <FuzzyFinder
          files={fileList}
          folder={folder}
          onPick={onFuzzyPick}
          onClose={() => setFuzzyOpen(false)}
        />
      )}
    </div>
  );
}

export default App;
