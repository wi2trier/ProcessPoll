import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../i18n';
import { Footer } from '../components/Layout';
import { ContactPage, ImprintPage, PrivacyPage } from './StaticPages';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

function renderWith(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('generic legal information pages', () => {
  it('shows operator-provided privacy information', () => {
    renderWith(<PrivacyPage />);
    expect(screen.getByTestId('privacy-page')).toHaveTextContent('Privacy information must be provided by the operator');
  });

  it('links to the privacy page from the footer', () => {
    renderWith(<Footer />);
    expect(screen.getByTestId('privacy-link')).toHaveAttribute('href', '/privacy');
  });

  it('shows operator-provided legal information', () => {
    renderWith(<ImprintPage />);
    expect(screen.getByText('Legal information must be provided by the operator of this installation.')).toBeInTheDocument();
  });

  it('shows a generic operator contact prompt', () => {
    renderWith(<ContactPage />);
    expect(screen.getByText('Contact information must be provided by the operator of this installation.')).toBeInTheDocument();
  });
});
