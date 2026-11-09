import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { CrashFallback, DemoBanner, ErrorBoundary, SiteLayout } from './components/Layout';
import { Spinner } from './components/ui';
import JoinPage, { JoinRedirect } from './pages/JoinPage';
import ParticipantPage from './pages/ParticipantPage';
import HostNewPage from './pages/HostNewPage';
import HostListPage from './pages/HostListPage';
import { ContactPage, ImprintPage, NotFoundPage, PrivacyPage } from './pages/StaticPages';

const HostDashboardPage = lazy(() => import('./pages/HostDashboardPage'));
const DisplayPage = lazy(() => import('./pages/DisplayPage'));

export default function App() {
  return (
    <ErrorBoundary fallback={(reset) => <CrashFallback reset={reset} />}>
      <Suspense fallback={<Spinner />}>
        <div className="flex min-h-screen flex-col">
          <DemoBanner />
          <Routes>
            <Route path="/p/:code" element={<ParticipantPage />} />
            <Route path="/j/:code" element={<JoinRedirect />} />
            <Route path="/host/:code" element={<HostDashboardPage />} />
            <Route path="/host/:code/live" element={<HostDashboardPage />} />
            <Route path="/display/:code" element={<DisplayPage />} />
            <Route element={<SiteLayout />}>
              <Route path="/" element={<JoinPage />} />
              <Route path="/host" element={<HostListPage />} />
              <Route path="/host/new" element={<HostNewPage />} />
              <Route path="/privacy" element={<PrivacyPage />} />
              <Route path="/imprint" element={<ImprintPage />} />
              <Route path="/contact" element={<ContactPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </div>
      </Suspense>
    </ErrorBoundary>
  );
}
