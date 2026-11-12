// Renderer entry of the reference app's main window (#15; PLT-002).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReferenceApp } from './reference-app';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('index.html must hold an element with id "root"');

createRoot(rootElement).render(
  <StrictMode>
    <ReferenceApp />
  </StrictMode>,
);
