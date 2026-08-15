import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

class BootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: "system-ui", background: "#111", color: "#f66", minHeight: "100vh" }}>
          <h2 style={{ color: "#fff" }}>Resonance Studio crashed</h2>
          <pre style={{ whiteSpace: "pre-wrap", color: "#faa" }}>{String(this.state.error?.message || this.state.error)}</pre>
          <button
            type="button"
            style={{ marginTop: 12, padding: "8px 14px" }}
            onClick={() => {
              try { localStorage.removeItem("ailexsi-resonance-studio-project-v0.1"); } catch { /* */ }
              location.reload();
            }}
          >
            Clear project & reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BootErrorBoundary>
      <App />
    </BootErrorBoundary>
  </React.StrictMode>
);
