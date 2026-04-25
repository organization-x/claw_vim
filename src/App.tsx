import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileTree } from "./components/FileTree";
import { Editor, type EditorHandle } from "./components/Editor";
import { Terminal } from "./components/Terminal";
import { DirtyPrompt } from "./components/DirtyPrompt";
import { FuzzyFinder } from "./components/FuzzyFinder";
import { MarkdownPreview } from "./components/MarkdownPreview";
import type { TreeNode } from "./types";
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

function App() {
  const [folder, setFolder] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState<string>("");
  const [liveContent, setLiveContent] = useState<string>("");
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [fuzzyOpen, setFuzzyOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"source" | "split" | "preview">(
    "preview",
  );
  const editorRef = useRef<EditorHandle>(null);

  const fileList = useMemo(() => flattenFiles(tree), [tree]);
  const dirty = liveContent !== savedContent;
  const md = isMarkdown(activePath);
  const effectiveMode: "source" | "split" | "preview" = md
    ? viewMode
    : "source";

  // Default to "preview" when a markdown file opens, "source" otherwise
  useEffect(() => {
    setViewMode(md ? "preview" : "source");
  }, [md, activePath]);

  const refreshTree = useCallback(async (root: string) => {
    const t = await invoke<TreeNode[]>("read_dir_tree", { path: root });
    setTree(t);
  }, []);

  const openFolder = useCallback(async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    setFolder(picked);
    setActivePath(null);
    setSavedContent("");
    setLiveContent("");
    await refreshTree(picked);
  }, [refreshTree]);

  const loadFile = useCallback(async (path: string) => {
    const text = await invoke<string>("read_file_text", { path });
    setActivePath(path);
    setSavedContent(text);
    setLiveContent(text);
  }, []);

  const saveCurrent = useCallback(
    async (text: string) => {
      if (!activePath) return;
      await invoke("write_file_text", { path: activePath, content: text });
      setSavedContent(text);
      setLiveContent(text);
    },
    [activePath],
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

  const viewModeButtons = md ? (
    <span className="view-modes">
      {(["source", "split", "preview"] as const).map((m) => (
        <button
          key={m}
          className={`header-btn ${viewMode === m ? "active" : ""}`}
          onClick={() => setViewMode(m)}
        >
          {m[0].toUpperCase() + m.slice(1)}
        </button>
      ))}
    </span>
  ) : null;

  const editorEl = (
    <Editor
      ref={editorRef}
      path={activePath}
      initialContent={savedContent}
      dirty={dirty}
      onSave={saveCurrent}
      onContentChange={setLiveContent}
      onEdit={onVimEdit}
      headerRight={viewModeButtons}
    />
  );

  const previewEl = (
    <div className="pane-inner">
      <div className="pane-header editor-header">
        <span>
          {activePath ?? "(no file)"} {dirty ? "● " : ""}— PREVIEW
        </span>
        {effectiveMode === "preview" && (
          <span className="header-right">{viewModeButtons}</span>
        )}
      </div>
      <div className="pane-body md-body">
        <MarkdownPreview source={liveContent} />
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
          <Terminal />
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
