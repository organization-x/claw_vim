import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileTree } from "./components/FileTree";
import { Editor, type EditorHandle } from "./components/Editor";
import { Terminal } from "./components/Terminal";
import { DirtyPrompt } from "./components/DirtyPrompt";
import { FuzzyFinder } from "./components/FuzzyFinder";
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

function App() {
  const [folder, setFolder] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [fuzzyOpen, setFuzzyOpen] = useState(false);
  const editorRef = useRef<EditorHandle>(null);

  const fileList = useMemo(() => flattenFiles(tree), [tree]);

  const refreshTree = useCallback(async (root: string) => {
    const t = await invoke<TreeNode[]>("read_dir_tree", { path: root });
    setTree(t);
  }, []);

  const openFolder = useCallback(async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    setFolder(picked);
    setActivePath(null);
    setContent("");
    setDirty(false);
    await refreshTree(picked);
  }, [refreshTree]);

  const loadFile = useCallback(async (path: string) => {
    const text = await invoke<string>("read_file_text", { path });
    setActivePath(path);
    setContent(text);
    setDirty(false);
  }, []);

  const saveCurrent = useCallback(
    async (text: string) => {
      if (!activePath) return;
      await invoke("write_file_text", { path: activePath, content: text });
      setContent(text);
      setDirty(false);
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

  // Cmd/Ctrl+P → open fuzzy finder (when a folder is open)
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
          <Editor
            ref={editorRef}
            path={activePath}
            initialContent={content}
            dirty={dirty}
            onSave={saveCurrent}
            onDirtyChange={setDirty}
            onEdit={onVimEdit}
          />
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
