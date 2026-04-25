import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { vim } from "@replit/codemirror-vim";
import { languageFor } from "../lang";

interface EditorProps {
  path: string;
  initialContent: string;
}

export function Editor({ path, initialContent }: EditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());

  // Mount once
  useEffect(() => {
    if (!hostRef.current) return;

    const state = EditorState.create({
      doc: initialContent,
      extensions: [
        vim(),
        basicSetup,
        keymap.of([]),
        langCompartment.current.of(languageFor(path)),
        oneDark,
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { fontFamily: '"SF Mono", Menlo, Monaco, monospace' },
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

  // When the file path changes, swap language and content
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: initialContent },
      effects: langCompartment.current.reconfigure(languageFor(path)),
    });
  }, [path, initialContent]);

  return (
    <div className="pane-inner editor">
      <div className="pane-header">{path} — VIM</div>
      <div ref={hostRef} className="cm-host" />
    </div>
  );
}
