import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The last-resort screen, so a crash is never a blank page.
 *
 * React unmounts the whole tree when a render throws, and with nothing to catch it the
 * page is left with an empty `#root`. That is what a user reported against 1.1.0: "I get a
 * blank page when trying to enter the settings." A blank page is the worst possible
 * failure to receive a report about, because there is nothing on screen to quote, no hint
 * that anything went wrong rather than the extension being broken generally, and no reason
 * for the reporter to think of opening a developer console.
 *
 * **This component deliberately depends on nothing.** No `t()`, no settings, no theme
 * tokens, no logger, no storage. Everything it might reach for is a thing that could be
 * the very reason the page crashed, and a fallback that crashes is worse than none. That
 * is also why the text is English rather than translated: the message it shows is a
 * diagnostic that gets pasted into a bug report, the same reason the activity log stays
 * English.
 *
 * The error text is shown on purpose. It costs the reporter nothing and turns "the page is
 * blank" into something we can act on.
 */
interface Props {
  /** Which screen this is, so a report says where it happened. */
  surface: string;
  children: ReactNode;
}

interface State {
  message: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // console, not the audit log: writing to storage is itself something that can fail,
    // and this is the one place that must not throw a second time.
    console.error(`[Konode] ${this.props.surface} crashed`, error, info.componentStack);
  }

  render(): ReactNode {
    const { message } = this.state;
    if (message === null) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          margin: "40px auto",
          maxWidth: 560,
          padding: 24,
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
          fontSize: 14,
          lineHeight: 1.5,
          color: "#11151a",
          background: "#fff",
          border: "1px solid #e3e6ea",
          borderRadius: 12,
        }}
      >
        <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>Konode couldn&rsquo;t show this screen</h1>
        <p style={{ margin: "0 0 16px", color: "#5a6472" }}>
          Your synced data is untouched: this is the interface failing to draw, not the sync.
          Reloading often fixes it. If it doesn&rsquo;t, the text below is what we need to
          fix it properly.
        </p>
        <pre
          style={{
            margin: "0 0 16px",
            padding: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: 12,
            background: "#f5f6f8",
            border: "1px solid #e3e6ea",
            borderRadius: 8,
          }}
        >
          {this.props.surface}: {message}
        </pre>
        <button
          type="button"
          onClick={() => location.reload()}
          style={{
            padding: "10px 16px",
            fontSize: 14,
            fontWeight: 600,
            color: "#fff",
            background: "#12b76a",
            border: "none",
            borderRadius: 10,
            cursor: "pointer",
          }}
        >
          Reload
        </button>
        <p style={{ margin: "16px 0 0", fontSize: 12, color: "#5a6472" }}>
          Please report it at{" "}
          <a href="https://github.com/konabe-studio/konode/issues" target="_blank" rel="noreferrer">
            github.com/konabe-studio/konode/issues
          </a>
          , with the text above and which browser you use.
        </p>
      </div>
    );
  }
}
