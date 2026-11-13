/** Router state for a navigation that is still running, otherwise the history entry. */
export function navigationState(router: {
  getCurrentNavigation?: () => { extras?: { state?: unknown } } | null;
}): Record<string, unknown> | null {
  if (typeof router.getCurrentNavigation === 'function') {
    const navigation = router.getCurrentNavigation();
    if (navigation) {
      const state = navigation.extras?.state;
      return isRecord(state) ? state : null;
    }
  }
  if (typeof history !== 'undefined' && isRecord(history.state)) {
    return history.state;
  }
  return null;
}

/**
 * True while a navigation is running, for example a company switch waiting on its guard. A
 * late answer then must not navigate on top of it.
 */
export function navigationRunning(router: {
  currentNavigation?: () => unknown;
  getCurrentNavigation?: () => unknown;
}): boolean {
  if (typeof router.currentNavigation === 'function') {
    return router.currentNavigation() !== null;
  }
  return (
    typeof router.getCurrentNavigation === 'function' && router.getCurrentNavigation() !== null
  );
}

/** Drop a carried draft so a refresh loads the stored record. */
export function dropNavigationKey(
  state: Record<string, unknown> | null,
  key: 'carriedClient' | 'carriedInvoice',
): void {
  clearKey(state, key);
  if (
    typeof history === 'undefined' ||
    !isRecord(history.state) ||
    history.state === state ||
    !(key in history.state)
  ) {
    return;
  }
  history.replaceState(withoutKey(history.state, key), '');
}

function clearKey(
  state: Record<string, unknown> | null,
  key: 'carriedClient' | 'carriedInvoice',
): void {
  if (!state) {
    return;
  }
  if (key === 'carriedClient') {
    delete state['carriedClient'];
    return;
  }
  delete state['carriedInvoice'];
}

function withoutKey(
  record: Record<string, unknown>,
  key: 'carriedClient' | 'carriedInvoice',
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(record)) {
    if (name !== key) {
      next[name] = value;
    }
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
