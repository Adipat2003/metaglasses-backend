export function configuredCognitoClientIds(
  primaryClientId: string,
  additionalClientIds = "",
): string[] {
  const clientIds = [
    primaryClientId.trim(),
    ...additionalClientIds.split(",").map((clientId) => clientId.trim()),
  ].filter(Boolean);

  return [...new Set(clientIds)];
}
