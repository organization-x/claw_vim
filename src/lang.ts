import type { Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";

export function languageFor(path: string): Extension {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "ts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "js":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "py":
      return python();
    case "md":
    case "markdown":
      return markdown();
    default:
      return [];
  }
}
