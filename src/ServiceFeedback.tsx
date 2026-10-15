import type { Bootstrap } from './api';
import { configurationFeedback, connectionFeedback, type ServiceFeedback, type ServiceObservation } from './service-feedback';
import './service-feedback.css';

function Observation({ feedback }: { feedback: ServiceFeedback }) {
  return <div className={`service-feedback-item ${feedback.tone}`}><strong>{feedback.title}</strong><p>{feedback.detail}</p>{feedback.time && <p className="service-feedback-time">{feedback.timeLabel}: <time dateTime={feedback.time.iso} title={feedback.time.iso}>{feedback.time.age}</time></p>}</div>;
}
export function WorkspaceServiceFeedback({ bootstrap, configuration, connection, now }: { bootstrap: Bootstrap | null; configuration: ServiceObservation; connection: ServiceObservation; now: number }) {
  // Polling timestamps remain readable without announcing every countdown tick.
  return <section className="workspace-service-feedback" aria-label="Configuration and app connection"><Observation feedback={configurationFeedback(bootstrap, configuration, now)}/><Observation feedback={connectionFeedback(bootstrap, connection, now)}/></section>;
}
