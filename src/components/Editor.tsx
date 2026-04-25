import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
} from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { vim, Vim } from "@replit/codemirror-vim";
import { languageFor } from "../lang";

export interface EditorHandle {
  getContent: () => string;
}

interface EditorProps {
  path: string | null;
  initialContent: string;
  dirty: boolean;
  onSave: (content: string) => void;
  onContentChange: (content: string) => void;
  onEdit: (relPath: string) => void;
  headerRight?: ReactNode;
}

export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(
  { path, initialContent, dirty, onSave, onContentChange, onEdit, headerRight },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
  const onSaveRef = useRef(onSave);
  const onChangeRef = useRef(onContentChange);
  const onEditRef = useRef(onEdit);

  onSaveRef.current = onSave;
  onChangeRef.current = onContentChange;
  onEditRef.current = onEdit;

  useImperativeHandle(ref, () => ({
    getContent: () => viewRef.current?.state.doc.toString() ?? "",
  }));

  // Mount once
  useEffect(() => {
    if (!hostRef.current) return;

    const saveCmd = () => {
      onSaveRef.current(viewRef.current?.state.doc.toString() ?? "");
      return true;
    };

    Vim.defineEx("write", "w", saveCmd);
    Vim.defineEx(
      "edit",
      "e",
      (_cm: unknown, params: { args?: string[] } | undefined) => {
        const rel = (params?.args ?? []).join(" ").trim();
        if (rel) onEditRef.current(rel);
        return true;
      },
    );

    const state = EditorState.create({
      doc: initialContent,
      extensions: [
        vim(),
        basicSetup,
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              saveCmd();
              return true;
            },
          },
        ]),
        langCompartment.current.of(languageFor(path ?? "")),
        oneDark,
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { fontFamily: '"SF Mono", Menlo, Monaco, monospace' },
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When path/content changes, swap language and content
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: initialContent },
      effects: langCompartment.current.reconfigure(languageFor(path ?? "")),
    });
  }, [path, initialContent]);

  return (
    <div className="pane-inner editor">
      <div className="pane-header editor-header">
        <span>
          {path ?? "(no file)"} {dirty ? "● " : ""}— VIM
        </span>
        {headerRight && <span className="header-right">{headerRight}</span>}
      </div>
      <div ref={hostRef} className="cm-host" />
    </div>
  );
});
