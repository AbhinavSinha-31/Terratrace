import { Component, type ReactNode } from 'react';
import { Panel, StateView } from '../design';

/** Isolates the map: a WebGL/map failure must not blank the rest of the interface. */
export class MapErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('TERRATRACE map error', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="tt-space absolute inset-0 grid place-items-center p-6">
        <Panel className="w-full max-w-md">
          <StateView kind="error" title="Map unavailable" onRetry={() => this.setState({ error: null })}>
            {/webgl/i.test(this.state.error.message)
              ? 'WebGL could not be initialised, so the map cannot render. Enable hardware acceleration in the browser settings and reload.'
              : import.meta.env.DEV ? `The map could not start: ${this.state.error.message.slice(0, 140)}` : 'The map could not start in this browser.'}{' '}
            Panels and data remain available.
          </StateView>
        </Panel>
      </div>
    );
  }
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('TERRATRACE UI error', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="tt-space grid h-full place-items-center p-6">
        <Panel className="w-full max-w-md">
          <StateView kind="error" title="Something went wrong" onRetry={() => window.location.reload()}>
            {/* Raw error text only in development builds; the public UI never shows internals. */}
            {import.meta.env.DEV ? this.state.error.message : 'TERRATRACE could not display this view. Reload to try again.'}
          </StateView>
        </Panel>
      </div>
    );
  }
}
