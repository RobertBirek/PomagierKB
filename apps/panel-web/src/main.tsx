import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { initTheme } from './lib/theme';
import { ToastProvider } from './components/Toast';
import { router } from './router';
import './styles/app.css';
import './styles/theme.css';
import './styles/base.css';

initTheme(); // przed renderem — bez migotania motywu

const rootEl = document.getElementById('root');
if (rootEl === null) throw new Error('Brak elementu #root w index.html');

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
