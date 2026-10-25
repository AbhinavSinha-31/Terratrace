import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StateView } from '../design';
import { ErrorBoundary, MapErrorBoundary } from './ErrorBoundary';

let fail = true;
function Boom({ message = 'internal detail /srv/backend/.env' }: { message?: string }) {
  if (fail) throw new Error(message);
  return <p>recovered</p>;
}

afterEach(() => { cleanup(); fail = true; });

describe('ErrorBoundary', () => {
  it('replaces a crashed view with a public error and a retry', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('DEV', false);
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/could not display this view/);
    expect(alert.textContent).not.toMatch(/internal detail|\.env/);
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
});

describe('MapErrorBoundary', () => {
  it('isolates a map failure: the rest of the interface keeps working, and Retry remounts the map', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<div><MapErrorBoundary><Boom message="WebGL context lost" /></MapErrorBoundary><p>header still here</p></div>);
    expect(screen.getByText('header still here')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/WebGL could not be initialised/);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(screen.getByText('recovered')).toBeTruthy();
  });
});

describe('StateView', () => {
  it('announces failures as alerts and other states as status', () => {
    render(<><StateView kind="service-unavailable" /><StateView kind="empty" compact /></>);
    expect(screen.getByRole('alert').textContent).toMatch(/Earth-observation service unavailable/);
    expect(screen.getByRole('status').textContent).toMatch(/Nothing to show yet/);
  });

  it('offers Retry only when it can retry', () => {
    const retry = vi.fn();
    const { rerender } = render(<StateView kind="error" />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<StateView kind="error" onRetry={retry} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
