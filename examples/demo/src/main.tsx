import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { askServer } from '@xgen-aegis/core';
import { AegisApp } from '@xgen-aegis/react';
import '@xgen-aegis/react/aegis.css';
import { adapter, seed } from '../host.ts';
import { RULES } from '../rules.ts';

// The stand-in host runs in the page; a real host is reached through its own APIs.
const host = adapter(seed());
// ?server=http://localhost:7842 answers through the Aegis server (LLM tool calling); without it, from the graph alone
const server = new URLSearchParams(location.search).get('server');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AegisApp adapter={host} rules={RULES} title="Aegis demo" ask={server ? (q, aegis, findings) => askServer(server, aegis, findings, q, { labels: host.labels }) : undefined} />
  </StrictMode>,
);
