import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface CheckResult {
  ok: boolean;
  path?: string | null;
  version?: string | null;
  error?: string | null;
}

export interface SystemCheckResult {
  claude: CheckResult;
  git: CheckResult;
}

interface SetupScreenProps {
  result: SystemCheckResult | null;
  checking: boolean;
  onRecheck: () => void;
}

interface InstallStep {
  command?: string;
  prose?: string;
  docsUrl?: string;
  docsLabel?: string;
}

function claudeInstall(): InstallStep[] {
  return [
    {
      prose:
        "Install the Claude Code CLI. The fastest path on macOS:",
      command: "npm install -g @anthropic-ai/claude-code",
    },
    {
      prose:
        "Verify it's on your PATH (in a terminal). If not, add the install location to your ~/.zshrc and reopen this app.",
      command: "which claude",
    },
    {
      docsUrl: "https://docs.claude.com/en/docs/claude-code/setup",
      docsLabel: "Claude Code install docs",
    },
  ];
}

function gitInstall(): InstallStep[] {
  return [
    {
      prose:
        "Git ships with macOS Command Line Tools. If missing:",
      command: "xcode-select --install",
    },
  ];
}

function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — user can still copy by selecting
    }
  };
  return (
    <div className="setup-cmd">
      <code>{command}</code>
      <button className="setup-copy" onClick={onCopy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

interface CheckRowProps {
  label: string;
  result: CheckResult;
  steps: InstallStep[];
}

function CheckRow({ label, result, steps }: CheckRowProps) {
  return (
    <div className={`setup-row ${result.ok ? "ok" : "missing"}`}>
      <div className="setup-row-head">
        <span className="setup-icon">{result.ok ? "✓" : "✗"}</span>
        <span className="setup-name">{label}</span>
        {result.version && (
          <span className="setup-version">{result.version}</span>
        )}
      </div>
      {!result.ok && (
        <div className="setup-row-body">
          {result.error && (
            <div className="setup-error">{result.error}</div>
          )}
          {steps.map((step, i) => (
            <div key={i} className="setup-step">
              {step.prose && <div className="setup-prose">{step.prose}</div>}
              {step.command && <CommandLine command={step.command} />}
              {step.docsUrl && (
                <button
                  className="setup-docs-link"
                  onClick={() => void openUrl(step.docsUrl!)}
                >
                  {step.docsLabel ?? step.docsUrl} ↗
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SetupScreen({ result, checking, onRecheck }: SetupScreenProps) {
  const claudeOk = result?.claude.ok ?? false;
  const gitOk = result?.git.ok ?? false;
  const allOk = claudeOk && gitOk;

  return (
    <div className="setup-root">
      <div className="setup-card">
        <h1 className="setup-title">claude-vim</h1>
        <p className="setup-subtitle">Setting things up…</p>

        {result ? (
          <>
            <CheckRow
              label="Claude CLI"
              result={result.claude}
              steps={claudeInstall()}
            />
            <CheckRow label="Git" result={result.git} steps={gitInstall()} />
          </>
        ) : (
          <div className="setup-spinner">Checking your system…</div>
        )}

        <div className="setup-actions">
          <button
            className="setup-btn primary"
            onClick={onRecheck}
            disabled={checking}
          >
            {checking ? "Checking…" : allOk ? "Continue" : "Recheck"}
          </button>
        </div>

        <p className="setup-fineprint">
          We re-resolve PATH from your login shell on each check, so you can
          install missing tools in another terminal and click Recheck — no
          need to restart the app.
        </p>
      </div>
    </div>
  );
}
