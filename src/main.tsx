import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { Button } from './components/ui/button';
import './styles.css';

class WorkspaceErrorBoundary extends Component<{children:ReactNode},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){
    return this.state.failed?<main className="assigned"><section className="panel form-section" role="alert">
      <h1>Workspace could not open</h1>
      <p>Reload to reconnect. If the issue continues, note which section you were opening.</p>
      <Button onClick={()=>location.reload()}>Reload workspace</Button>
    </section></main>:this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(<WorkspaceErrorBoundary><App /></WorkspaceErrorBoundary>);
