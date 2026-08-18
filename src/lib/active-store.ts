export function activeStorePreferenceKey(profileId: string) {
  return `dealershot.active-store.${profileId}`;
}

export function chooseAuthorizedStoreId(
  authorizedStoreIds: readonly string[],
  persistedStoreId: string | null | undefined,
  primaryStoreId: string | null | undefined,
) {
  const authorized = new Set(authorizedStoreIds);
  if (persistedStoreId && authorized.has(persistedStoreId)) return persistedStoreId;
  if (primaryStoreId && authorized.has(primaryStoreId)) return primaryStoreId;
  return authorizedStoreIds[0] ?? null;
}

export function isStoreSwitchLocked(pathname: string) {
  return (
    /^\/vehicles\/(?!new(?:\/|$))[^/]+/.test(pathname) || /^\/bulk-photos\/[^/]+/.test(pathname)
  );
}
