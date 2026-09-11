import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { DataSourceProvider } from './data/DataSourceContext';
import { createDataSource } from './data';
import { AuthProvider } from './auth/AuthContext';
import { initTheme } from './lib/theme';
import './styles/tokens.css';
import './styles/global.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

const dataSource = createDataSource();

// Apply the stored theme before the first paint so the page never flashes the wrong palette.
initTheme();

// Vite's BASE_URL is '/' locally and '/<repo>/' on GitHub Pages.
const basename = import.meta.env.BASE_URL.replace(/\/$/, '');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <DataSourceProvider value={dataSource}>
        <AuthProvider>
          <BrowserRouter basename={basename}>
            <App />
          </BrowserRouter>
        </AuthProvider>
      </DataSourceProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
