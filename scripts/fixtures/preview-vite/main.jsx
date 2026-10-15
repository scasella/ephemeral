import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './style.css';

const proof = document.getElementById('proof');
const documentId = document.createElement('p');
documentId.id = 'document-id';
documentId.textContent = `Document ID: ${crypto.randomUUID()}`;
const connection = document.createElement('p');
connection.id = 'hmr-connection';
connection.textContent = 'Vite HMR: awaiting an edit';
proof.append(documentId, connection);
if (import.meta.hot) {
  import.meta.hot.on('vite:ws:connect', () => { connection.textContent = 'Vite connection: connected'; });
  import.meta.hot.on('vite:ws:disconnect', () => { connection.textContent = 'Vite connection: disconnected'; });
  import.meta.hot.on('vite:afterUpdate', () => { connection.textContent = 'Vite HMR: update applied'; });
}
createRoot(document.getElementById('root')).render(<App/>);
