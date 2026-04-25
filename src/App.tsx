/**
 * App — root component. Owns the session model and wires the three panes
 * (file tree / editor / terminal) together.
 *
 * Sessions
 * --------
 * A "session" is one editing context. The first session ("main") points at
 * the repo root itself; additional sessions each get their own git worktree
 * on a fresh branch, created via `git_worktree_add` on the Rust side. Each
 * session carries its own folder, file tree, change list, active file,
 * editor buffer (saved + live), and view mode — see the `Session` type.
 *
 * Only one session is active at a time. Switching sessions captures the
 * outgoing editor's live buffer back into its session record before unmount
 * (see `switchSession`), so unsaved edits survive the swap.
 *
 * Editor buffer model
 * -------------------
 * `savedContent` is what's on disk; `liveContent` is what's in the editor.
 * `dirty` is just `live !== saved`. Saving writes the file and collapses
 * both back to the same value. The 5s tick (`refreshActiveFile`) pulls in
 * external edits (e.g. Claude wrote to the open file) only when the buffer
 * is clean — never clobbers unsaved work.
 *
 * Reloading the same path
 * -----------------------
 * `loadKey` includes a `loadNonce` that bumps on every `loadFile` call, so
 * clicking an already-open file in the Changes panel still forces the
 * editor to remount with fresh disk content. The dirty-prompt only gates
 * switches to a *different* path; same-path reloads on a clean buffer go
 * through immediately.
 *
 * Hooks server / status
 * ---------------------
 * `install_session_hooks` registers Claude Code hooks for the session;
 * the Rust side emits `session:status` events that drive the colored dot
 * in the tab strip (fresh / running / done / error).
 *
 * Repo gating
 * -----------
 * Multi-session only works in a git repo (worktrees need it). Picking a
 * non-repo folder shows `RepoInitPrompt` — the user can `git init`, open
 * single-session without git, or cancel.
 */
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
  ChangeEntry,
  LineChange,
  RepoInfo,
  Session,
  SessionStatus,
  TreeNode,
  ViewMode,
  WorktreeInfo,
} from "./types";
import { listen } from "@tauri-apps/api/event";
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
    changes: [],
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
  const [loadNonce, setLoadNonce] = useState(0);
  const [lineChanges, setLineChanges] = useState<LineChange[]>([]);
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

  const refreshSessionChanges = useCallback(
    async (sessionId: string, folder: string) => {
      try {
        const c = await invoke<ChangeEntry[]>("git_status", { path: folder });
        updateSession(sessionId, { changes: c });
      } catch {
        updateSession(sessionId, { changes: [] });
      }
    },
    [updateSession],
  );

  // Auto-refetch line-level diff for the editor's gutter whenever the
  // active file changes (open / switch session / save / disk pull-in).
  // Saves bump savedContent → refresh; refreshActiveFile picking up
  // Claude's writes also bumps savedContent → refresh.
  useEffect(() => {
    if (!activeSession?.activePath) {
      setLineChanges([]);
      return;
    }
    let cancelled = false;
    const folder = activeSession.folder;
    const abs = activeSession.activePath;
    const rel = abs.startsWith(folder + "/")
      ? abs.slice(folder.length + 1)
      : abs;
    void invoke<LineChange[]>("git_diff_for_file", {
      folder,
      baseSha: activeSession.baseSha ?? null,
      file: rel,
    })
      .then((lc) => {
        if (!cancelled) setLineChanges(lc);
      })
      .catch(() => {
        if (!cancelled) setLineChanges([]);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeSession?.id,
    activeSession?.activePath,
    activeSession?.savedContent,
    activeSession?.folder,
    activeSession?.baseSha,
  ]);

  // If the active file has been modified on disk (e.g. by Claude) and
  // the buffer isn't dirty, pull the new content into the editor.
  const refreshActiveFile = useCallback(async () => {
    if (!activeSession || !activeSession.activePath) return;
    if (activeSession.liveContent !== activeSession.savedContent) return;
    try {
      const text = await invoke<string>("read_file_text", {
        path: activeSession.activePath,
      });
      if (text !== activeSession.savedContent) {
        updateSession(activeSession.id, {
          savedContent: text,
          liveContent: text,
        });
        editorRef.current?.setContent(text);
      }
    } catch {
      // file may have been deleted; ignore
    }
  }, [activeSession, updateSession]);

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
      void refreshSessionChanges(main.id, root);
      void invoke("install_session_hooks", {
        folder: root,
        sessionId: main.id,
      }).catch(() => {});
    },
    [refreshSessionTree, refreshSessionChanges],
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
        void invoke("install_session_hooks", {
          folder,
          sessionId: main.id,
        }).catch(() => {});
      }
    },
    [pendingFolderInit, adoptFolder, refreshSessionTree],
  );

  // Refresh changes + active file content for the active session every 5s
  useEffect(() => {
    if (!activeSession) return;
    const id = activeSession.id;
    const folder = activeSession.folder;
    const tick = () => {
      void refreshSessionChanges(id, folder);
      void refreshActiveFile();
    };
    const handle = window.setInterval(tick, 5000);
    return () => window.clearInterval(handle);
  }, [
    activeSession?.id,
    activeSession?.folder,
    refreshSessionChanges,
    refreshActiveFile,
  ]);

  // Restore last-opened folder on mount
  useEffect(() => {
    const saved = localStorage.getItem(LAST_FOLDER_KEY);
    if (saved) void adoptFolder(saved, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for status updates emitted by the Rust hooks server.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      const fn = await listen<{ sessionId: string; status: SessionStatus }>(
        "session:status",
        (event) => {
          if (cancelled) return;
          const { sessionId, status } = event.payload;
          setSessions((prev) =>
            prev.map((s) => (s.id === sessionId ? { ...s, status } : s)),
          );
        },
      );
      if (cancelled) fn();
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
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
      // Bump the load nonce so the editor's loadKey changes even when the
      // user clicks the already-open file (e.g. in the Changes panel after
      // Claude wrote to it).
      setLoadNonce((n) => n + 1);
      editorRef.current?.setContent(text);
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
      void refreshSessionChanges(activeSession.id, activeSession.folder);
    },
    [activeSession, updateSession, refreshSessionChanges],
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
      // Note: we deliberately don't short-circuit when next === activePath,
      // since the user often clicks an already-open file in the Changes panel
      // specifically to pull in fresh content (e.g. after Claude wrote to it).
      // Dirty-check still gates a destructive reload.
      if (dirty && next !== activePath) {
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
          changes: [],
          activePath: null,
          savedContent: "",
          liveContent: "",
          viewMode: "preview",
        } as Session,
      ];
    });
    setActiveSessionId(id);
    void refreshSessionTree(id, info.path);
    void refreshSessionChanges(id, info.path);
  }, [repoRoot, isRepo, refreshSessionTree, refreshSessionChanges]);

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
      if (incoming) {
        if (incoming.tree.length === 0) {
          void refreshSessionTree(id, incoming.folder);
        }
        // Always refresh on focus — Claude may have written files since.
        void refreshSessionChanges(id, incoming.folder);
      }
    },
    [
      activeSessionId,
      sessions,
      updateSession,
      refreshSessionTree,
      refreshSessionChanges,
    ],
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
      loadKey={`${activeSession?.id ?? ""}::${activePath ?? ""}::${loadNonce}`}
      path={activePath}
      initialContent={activeSession?.liveContent ?? ""}
      dirty={dirty}
      lineChanges={lineChanges}
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
            changes={activeSession?.changes ?? []}
            active={activePath}
            onOpenFolder={openFolder}
            onSelect={requestSwitch}
            onRefresh={() => {
              if (activeSession) {
                void refreshSessionTree(activeSession.id, activeSession.folder);
                void refreshSessionChanges(
                  activeSession.id,
                  activeSession.folder,
                );
                void refreshActiveFile();
              }
            }}
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
