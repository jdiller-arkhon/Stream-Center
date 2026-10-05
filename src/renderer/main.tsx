import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { StudioProvider } from './context';
import { DemoAdapter } from '../services/DemoAdapter';
import { DesktopAdapter } from '../services/DesktopAdapter';
import './styles.css';
import './theme-apple.css';
class ErrorBoundary extends Component<{
    children: ReactNode;
}, {
    message: string | null;
}> {
    state = { message: null as string | null };
    static getDerivedStateFromError(error: Error) { return { message: error.message }; }
    render() { return this.state.message ? <div className="boot-error"><h1>Workspace unavailable</h1><p>{this.state.message}</p><button onClick={() => location.reload()}>Reload workspace</button><p>No demo fallback is used for a desktop service failure.</p></div> : this.props.children; }
}
const root = createRoot(document.getElementById('root')!);
root.render(<div className="boot-error"><h1>Opening Drift Studio…</h1><p>Loading your workspace and adapter.</p></div>);
async function boot() { try {
    const service = window.drift ? new DesktopAdapter(window.drift) : new DemoAdapter();
    await service.initialize();
    window.addEventListener('pagehide', () => service.dispose(), { once: true });
    root.render(<ErrorBoundary><StudioProvider service={service}><App /></StudioProvider></ErrorBoundary>);
}
catch (e) {
    root.render(<div className="boot-error"><h1>Desktop connection unavailable</h1><p>{e instanceof Error ? e.message : 'Unable to initialize the workspace.'}</p><button onClick={() => location.reload()}>Retry connection</button><p>Check the preload bridge and protocol version. No demo fallback is used.</p></div>);
} }
void boot();
