import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  folder: string | null;
}

interface PtyDataEvent {
  id: string;
  data: string;
}

interface PtyExitEvent {
  id: string;
}

const THEME = {
  background: "#0c0c0c",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  cursorAccent: "#0c0c0c",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#d4d4d4",
  brightBlack: "#5c6370",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
};

export function Terminal({ folder }: TerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Mount xterm once
  useEffect(() => {
    if (!hostRef.current) return;

    const term = new XTerm({
      fontFamily: '"SF Mono", Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: THEME,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    requestAnimationFrame(() => fit.fit());

    term.onData((data) => {
      const id = ptyIdRef.current;
      if (id) void invoke("pty_write", { id, data });
    });

    termRef.current = term;
    fitRef.current = fit;

    const ro = new ResizeObserver(() => {
      if (!fitRef.current || !termRef.current) return;
      try {
        fitRef.current.fit();
      } catch {
        return;
      }
      const id = ptyIdRef.current;
      if (id) {
        void invoke("pty_resize", {
          id,
          rows: termRef.current.rows,
          cols: termRef.current.cols,
        });
      }
    });
    ro.observe(hostRef.current);

    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Subscribe to pty:data and pty:exit
  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    void (async () => {
      const u1 = await listen<PtyDataEvent>("pty:data", (event) => {
        const { id, data } = event.payload;
        if (id === ptyIdRef.current && termRef.current) {
          termRef.current.write(data);
        }
      });
      unlisteners.push(u1);

      const u2 = await listen<PtyExitEvent>("pty:exit", (event) => {
        if (event.payload.id === ptyIdRef.current && termRef.current) {
          termRef.current.write("\r\n\x1b[33m[claude exited]\x1b[0m\r\n");
          ptyIdRef.current = null;
        }
      });
      unlisteners.push(u2);
    })();

    return () => {
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  const [restartTick, setRestartTick] = useState(0);

  // Spawn / re-spawn when folder changes (StrictMode-safe via cancellation)
  useEffect(() => {
    if (!folder) return;
    let cancelled = false;
    let mySpawnedId: string | null = null;
    setBusy(true);
    setError(null);

    void (async () => {
      // Kill any prior PTY (from a previous folder or restart)
      const oldId = ptyIdRef.current;
      ptyIdRef.current = null;
      if (oldId) {
        try {
          await invoke("pty_kill", { id: oldId });
        } catch {
          // ignore
        }
      }

      const term = termRef.current;
      const fit = fitRef.current;
      if (cancelled || !term || !fit) return;
      try {
        fit.fit();
      } catch {
        // ignore
      }
      term.clear();
      term.reset();

      try {
        const id = await invoke<string>("pty_spawn", {
          args: { cwd: folder, rows: term.rows, cols: term.cols },
        });
        if (cancelled) {
          // Effect was cleaned up while spawn was in-flight — kill it.
          await invoke("pty_kill", { id }).catch(() => {});
          return;
        }
        mySpawnedId = id;
        ptyIdRef.current = id;
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
      const id = mySpawnedId;
      mySpawnedId = null;
      if (id) {
        if (ptyIdRef.current === id) ptyIdRef.current = null;
        void invoke("pty_kill", { id }).catch(() => {});
      }
    };
  }, [folder, restartTick]);

  const onRestart = useCallback(() => {
    setRestartTick((t) => t + 1);
  }, []);

  return (
    <div className="pane-inner terminal">
      <div className="pane-header editor-header">
        <span>claude{folder ? ` — ${folder.split("/").pop()}` : ""}</span>
        <span className="header-right">
          <button
            className="header-btn"
            onClick={onRestart}
            disabled={!folder || busy}
            title="Restart claude"
          >
            Restart
          </button>
        </span>
      </div>
      {!folder && (
        <div className="empty-state">
          <p>Open a folder to start Claude.</p>
        </div>
      )}
      {error && (
        <div className="terminal-error">
          <strong>Failed to start claude:</strong>
          <pre>{error}</pre>
        </div>
      )}
      <div
        ref={hostRef}
        className="xterm-host"
        style={{ display: folder ? undefined : "none" }}
      />
    </div>
  );
}
