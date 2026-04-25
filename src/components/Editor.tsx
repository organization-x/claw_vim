import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
} from "react";
import {
  EditorState,
  Compartment,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { EditorView, gutter, GutterMarker, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { vim, Vim } from "@replit/codemirror-vim";
import { languageFor } from "../lang";
import type { LineChange } from "../types";

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: "added" | "modified") {
    super();
  }
  override toDOM() {
    const el = document.createElement("div");
    el.className = `cm-change-bar cm-change-${this.kind}`;
    return el;
  }
}

const setChangesEffect = StateEffect.define<RangeSet<ChangeMarker>>();

const changesField = StateField.define<RangeSet<ChangeMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setChangesEffect)) value = e.value;
    }
    return value;
  },
});

const changesGutter = gutter({
  class: "cm-changes-gutter",
  markers: (view) => view.state.field(changesField),
  initialSpacer: () => new ChangeMarker("modified"),
});

function buildChangeSet(
  view: EditorView,
  changes: LineChange[],
): RangeSet<ChangeMarker> {
  if (changes.length === 0) return RangeSet.empty;
  const sorted = [...changes].sort((a, b) => a.line - b.line);
  const builder = new RangeSetBuilder<ChangeMarker>();
  const totalLines = view.state.doc.lines;
  for (const c of sorted) {
    if (c.line < 1 || c.line > totalLines) continue;
    const line = view.state.doc.line(c.line);
    builder.add(line.from, line.from, new ChangeMarker(c.kind));
  }
  return builder.finish();
}

export interface EditorHandle {
  getContent: () => string;
  setContent: (text: string) => void;
}

interface EditorProps {
  loadKey: string;            // reload doc when this changes
  path: string | null;
  initialContent: string;
  dirty: boolean;
  lineChanges: LineChange[];
  onSave: (content: string) => void;
  onContentChange: (content: string) => void;
  onEdit: (relPath: string) => void;
  headerRight?: ReactNode;
}

export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(
  {
    loadKey,
    path,
    initialContent,
    dirty,
    lineChanges,
    onSave,
    onContentChange,
    onEdit,
    headerRight,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
  const onSaveRef = useRef(onSave);
  const onChangeRef = useRef(onContentChange);
  const onEditRef = useRef(onEdit);
  const initialContentRef = useRef(initialContent);

  onSaveRef.current = onSave;
  onChangeRef.current = onContentChange;
  onEditRef.current = onEdit;
  initialContentRef.current = initialContent;

  useImperativeHandle(ref, () => ({
    getContent: () => viewRef.current?.state.doc.toString() ?? "",
    setContent: (text: string) => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: text,
        },
      });
    },
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
        changesField,
        changesGutter,
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

  // When loadKey changes (session switch or different file in the same
  // session), reload the doc from the latest snapshot in
  // initialContentRef. We deliberately *don't* depend on initialContent
  // here — onContentChange writes the user's edits back to App state, which
  // would otherwise re-fire this effect on every keystroke and clobber the
  // editor doc in a feedback loop.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: initialContentRef.current,
      },
      effects: langCompartment.current.reconfigure(languageFor(path ?? "")),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  // Push the latest line-change set into the gutter via StateEffect.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const set = buildChangeSet(view, lineChanges);
    view.dispatch({ effects: setChangesEffect.of(set) });
  }, [lineChanges]);

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
