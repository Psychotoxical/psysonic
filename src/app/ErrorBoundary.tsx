import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * App-level error boundary. A render-time throw used to blank the entire window
 * — no boundary existed (issue #382), so any thrown error during render took the
 * whole UI down. This catches it and shows a recoverable fallback while playback
 * (driven by the Rust audio engine, outside React) keeps going.
 *
 * Deliberately hook-free and English-only: the fallback has to render even when
 * i18n, the theme, or app state is exactly what broke, so it must not depend on
 * any of them. The CSS uses literal fallbacks in `var(...)` for the same reason.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[error-boundary]', error, info.componentStack);
  }

  private handleRetry = (): void => this.setState({ error: null });

  private handleReload = (): void => window.location.reload();

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="app-error-boundary" role="alert">
        <div className="app-error-boundary__card">
          <h1 className="app-error-boundary__title">Something went wrong</h1>
          <p className="app-error-boundary__text">
            This view hit an unexpected error and stopped rendering. Playback keeps going — try the
            view again, or reload the app.
          </p>
          <pre className="app-error-boundary__detail">{error.message}</pre>
          <div className="app-error-boundary__actions">
            <button type="button" className="btn btn-primary" onClick={this.handleRetry}>
              Try again
            </button>
            <button type="button" className="btn btn-surface" onClick={this.handleReload}>
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
