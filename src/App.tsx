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
import { RepoInitPrompt } from "./components/RepoInitPrompt";
import type {
  RepoInfo,
  Session,
  TreeNode,
  ViewMode,
  WorktreeInfo,
} from "./types";
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

function makeMainSession(folder: string, branch: string | null): Session {
  return {
    id: newId(),
    name: "main",
    isMain: true,
    status: "fresh",
    folder,
    branch,
    baseSha: null,
    tree: [],
    activePath: null,
    savedContent: "",
    liveContent: "",
    viewMode: "preview",
  };
}

const LAST_FOLDER_KEY = "claudevim:lastFolder";

function App() {
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [isRepo, setIsRepo] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [fuzzyOpen, setFuzzyOpen] = useState(false);
  const [pendingFolderInit, setPendingFolderInit] = useState<string | null>(
    null,
  );
  const editorRef = useRef<EditorHandle>(null);
  const terminalRefs = useRef<Map<string, TerminalHandle>>(new Map());

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );
  const activeFolder = activeSession?.folder ?? null;
  const activePath = activeSession?.activePath ?? null;
  const fileList = useMemo(
    () => (activeSession ? flattenFiles(activeSession.tree) : []),
    [activeSession],
  );
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

  // Normalize viewMode when active file's md-ness changes
  useEffect(() => {
    if (!activeSession) return;
    if (md && activeSession.viewMode === "source") {
      updateSession(activeSession.id, { viewMode: "preview" });
    } else if (!md && activeSession.viewMode !== "source") {
      updateSession(activeSession.id, { viewMode: "source" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [md, activeSession?.id, activeSession?.activePath]);

  const refreshSessionTree = useCallback(
    async (sessionId: string, folder: string) => {
      try {
        const t = await invoke<TreeNode[]>("read_dir_tree", { path: folder });
        updateSession(sessionId, { tree: t });
      } catch {
        updateSession(sessionId, { tree: [] });
      }
    },
    [updateSession],
  );

  const adoptFolder = useCallback(
    async (picked: string, opts: { silent?: boolean } = {}) => {
      let info: RepoInfo;
      try {
        info = await invoke<RepoInfo>("git_check_repo", { path: picked });
      } catch {
        info = { isRepo: false, root: null, head: null, branch: null };
      }

      if (!info.isRepo) {
        if (opts.silent) {
          // auto-restore: if folder is no longer a repo, don't reopen
          localStorage.removeItem(LAST_FOLDER_KEY);
          return;
        }
        setPendingFolderInit(picked);
        return;
      }

      const root = info.root ?? picked;
      setRepoRoot(root);
      setIsRepo(true);
      const main = makeMainSession(root, info.branch ?? null);
      setSessions([main]);
      setActiveSessionId(main.id);
      localStorage.setItem(LAST_FOLDER_KEY, root);
      void refreshSessionTree(main.id, root);
    },
    [refreshSessionTree],
  );

  const openFolder = useCallback(async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    await adoptFolder(picked);
  }, [adoptFolder]);

  const onRepoInitChoice = useCallback(
    async (action: "init" | "skip" | "cancel") => {
      const folder = pendingFolderInit;
      setPendingFolderInit(null);
      if (!folder || action === "cancel") return;
      if (action === "init") {
        try {
          await invoke("git_init", { path: folder });
        } catch (e) {
          alert(`git init failed: ${e instanceof Error ? e.message : e}`);
          return;
        }
        await adoptFolder(folder);
      } else if (action === "skip") {
        // Single-session mode: open without git, no worktree support
        setRepoRoot(folder);
        setIsRepo(false);
        const main = makeMainSession(folder, null);
        setSessions([main]);
        setActiveSessionId(main.id);
        localStorage.setItem(LAST_FOLDER_KEY, folder);
        void refreshSessionTree(main.id, folder);
      }
    },
    [pendingFolderInit, adoptFolder, refreshSessionTree],
  );

  // Restore last-opened folder on mount
  useEffect(() => {
    const saved = localStorage.getItem(LAST_FOLDER_KEY);
    if (saved) void adoptFolder(saved, { silent: true });
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

  // Session management
  const createSession = useCallback(async () => {
    if (!repoRoot || !isRepo) return;
    const id = newId();
    let info: WorktreeInfo;
    try {
      info = await invoke<WorktreeInfo>("git_worktree_add", {
        repo: repoRoot,
        sessionId: id,
      });
    } catch (e) {
      alert(`Failed to create worktree: ${e instanceof Error ? e.message : e}`);
      return;
    }

    setSessions((prev) => {
      const idx = prev.filter((s) => !s.isMain).length + 1;
      return [
        ...prev,
        {
          id,
          name: `session ${idx}`,
          isMain: false,
          status: "fresh",
          folder: info.path,
          branch: info.branch,
          baseSha: info.baseSha,
          tree: [],
          activePath: null,
          savedContent: "",
          liveContent: "",
          viewMode: "preview",
        } as Session,
      ];
    });
    setActiveSessionId(id);
    void refreshSessionTree(id, info.path);
  }, [repoRoot, isRepo, refreshSessionTree]);

  const closeSession = useCallback(
    async (id: string) => {
      const target = sessions.find((s) => s.id === id);
      const remaining = sessions.filter((s) => s.id !== id);
      setSessions(remaining);
      if (id === activeSessionId) {
        const fallback = remaining.find((s) => s.isMain) ?? remaining[0];
        setActiveSessionId(fallback?.id ?? null);
      }
      // Best-effort cleanup of the worktree
      if (target && !target.isMain && target.branch && repoRoot) {
        try {
          await invoke("git_worktree_remove", {
            repo: repoRoot,
            path: target.folder,
            branch: target.branch,
          });
        } catch {
          // ignore
        }
      }
    },
    [activeSessionId, sessions, repoRoot],
  );

  const switchSession = useCallback(
    (id: string) => {
      if (id === activeSessionId) return;
      // Capture current editor buffer into the outgoing session before unmount
      if (activeSessionId && editorRef.current) {
        const live = editorRef.current.getContent();
        updateSession(activeSessionId, { liveContent: live });
      }
      const incoming = sessions.find((s) => s.id === id);
      setActiveSessionId(id);
      // Lazy-load tree if the incoming session never finished loading
      if (incoming && incoming.tree.length === 0) {
        void refreshSessionTree(id, incoming.folder);
      }
    },
    [activeSessionId, sessions, updateSession, refreshSessionTree],
  );

  // Cmd/Ctrl+P → fuzzy finder
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "p" && activeFolder) {
        e.preventDefault();
        setFuzzyOpen(true);
      } else if (e.key === "Escape" && fuzzyOpen) {
        setFuzzyOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeFolder, fuzzyOpen]);

  const onFuzzyPick = useCallback(
    (path: string) => {
      setFuzzyOpen(false);
      requestSwitch(path);
    },
    [requestSwitch],
  );

  const onVimEdit = useCallback(
    (rel: string) => {
      if (!activeFolder) return;
      const abs = rel.startsWith("/") ? rel : `${activeFolder}/${rel}`;
      requestSwitch(abs);
    },
    [activeFolder, requestSwitch],
  );

  const sendActiveToClaude = useCallback(() => {
    if (!activeFolder || !activePath || !activeSessionId) return;
    const rel = activePath.startsWith(activeFolder + "/")
      ? activePath.slice(activeFolder.length + 1)
      : activePath;
    void terminalRefs.current.get(activeSessionId)?.send(`@${rel} `);
  }, [activeFolder, activePath, activeSessionId]);

  // Cmd/Ctrl+L → send @<relative-path> to Claude
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "l") {
        if (activeFolder && activePath) {
          e.preventDefault();
          sendActiveToClaude();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeFolder, activePath, sendActiveToClaude]);

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
      disabled={!activeFolder || !activePath}
      title="Send @path to Claude (⌘L)"
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
            folder={activeFolder}
            tree={activeSession?.tree ?? []}
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
                onCreate={isRepo ? createSession : () => {}}
                onClose={closeSession}
              />
            )}
            <div className="right-pane-body">
              {sessions.map((s) => (
                <Terminal
                  key={s.id}
                  ref={(handle) => {
                    if (handle) terminalRefs.current.set(s.id, handle);
                    else terminalRefs.current.delete(s.id);
                  }}
                  folder={s.folder}
                  visible={s.id === activeSessionId}
                />
              ))}
              {sessions.length === 0 && (
                <Terminal folder={null} visible={true} />
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
      {fuzzyOpen && activeFolder && (
        <FuzzyFinder
          files={fileList}
          folder={activeFolder}
          onPick={onFuzzyPick}
          onClose={() => setFuzzyOpen(false)}
        />
      )}
      {pendingFolderInit && (
        <RepoInitPrompt
          folder={pendingFolderInit}
          onChoice={onRepoInitChoice}
        />
      )}
    </div>
  );
}

export default App;
