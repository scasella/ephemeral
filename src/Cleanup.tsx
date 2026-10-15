import type { Session } from './api';
import './ended-outcome.css';

export function Cleanup({ session }: { session: Session }) {
  const names: Record<keyof Session['cleanup'], string> = { vm: 'Sandbox destruction', github: 'GitHub token revocation', gateway: 'Git gateway access', codex: 'Local Codex credentials' };
  return <div className="cleanup-evidence">
    <p className="cleanup-observation">Last reported resource outcomes; each result is independent.</p>
    <div className="cleanup-list" aria-label="Independent cleanup results">
      {(Object.keys(names) as Array<keyof typeof names>).map(key => <div className="cleanup-row" key={key}><span>{names[key]}</span><span className={`cleanup-status ${session.cleanup[key]}`}><span className="status-dot"/>{session.cleanup[key].replace('_', ' ')}</span></div>)}
      <div className="cleanup-row remote-codex-result"><strong>Remote Codex revocation</strong><strong className="cleanup-status unverified"><span className="status-dot"/>Unverified</strong></div>
    </div>
    <p className="remote-codex-guidance">Remote revocation has not been verified. Deleting local credentials and destroying the sandbox do not confirm it. Review connected sessions in your Codex account.</p>
  </div>;
}
