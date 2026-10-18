import { ReactElement, ReactNode } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";

/** A QueryClient for tests: no retries, so a failed request shows its error right away. */
export function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

/**
 * Renders `ui` inside a fresh QueryClient and a MemoryRouter starting at `route`.
 * Returns the render result plus the QueryClient.
 */
export function renderWithProviders(
  ui: ReactElement,
  {
    route = "/",
    queryClient = testQueryClient(),
  }: { route?: string | { pathname: string; state?: unknown }; queryClient?: QueryClient } = {}
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return { ...render(ui, { wrapper }), queryClient };
}

/** Prints the router location into the DOM, so tests can assert where the app navigated. */
export function LocationProbe() {
  const { pathname, search } = useLocation();
  return <output data-testid="location">{pathname + search}</output>;
}
