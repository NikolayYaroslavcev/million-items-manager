import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startApp } from './app/runtime.js';
import { App } from './ui/App.js';
import './styles.css';

startApp();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
