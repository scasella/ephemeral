import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);
  const [text, setText] = useState('');
  const [access, setAccess] = useState('Not checked');
  async function checkRetainedAccess() {
    try { const response = await fetch('/', { credentials: 'same-origin', cache: 'no-store' }); setAccess(`Retained page access: HTTP ${response.status}`); }
    catch { setAccess('Retained page access: connection unavailable'); }
  }
  return <main>
    <h1>VITE_HMR_BEFORE</h1>
    <p>A real React component served through Ephemeral's private viewer.</p>
    <button onClick={() => setCount(value => value + 1)}>Counter: {count}</button>
    <label htmlFor="hmr-text">Text retained across component edits</label>
    <input id="hmr-text" value={text} onChange={event => setText(event.target.value)}/>
    <p>Keep this tab open. Edit the heading in App.jsx; the counter, input, and Document ID should stay the same.</p>
    <hr/>
    <h2>Retained document isolation</h2>
    <p>Keep this document open while replacing preview access or opening a fresh machine. New access must use a different hostname.</p>
    <button onClick={checkRetainedAccess}>Check retained page access</button>
    <p role="status">{access}</p>
    <p>After replacement, this retained document must report HTTP 401, even after another viewer opens.</p>
  </main>;
}
