import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Uncaught error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div style={{ padding: 40, fontFamily: "system-ui, sans-serif", color: "#c00" }}>
        <h2 style={{ fontSize: 18, marginBottom: 8 }}>Something went wrong</h2>
        <pre style={{ fontSize: 13, whiteSpace: "pre-wrap", color: "#666" }}>
          {error.message}
          {"\n"}
          {error.stack}
        </pre>
      </div>
    );
  }
}
