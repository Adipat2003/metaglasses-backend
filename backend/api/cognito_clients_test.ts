import { configuredCognitoClientIds } from "./cognito_clients.ts";

Deno.test("configuredCognitoClientIds keeps the primary and configured OAuth clients", () => {
  const result = configuredCognitoClientIds(" mobile-client ", "postman-client, mobile-client, ");

  if (result.join(",") !== "mobile-client,postman-client") {
    throw new Error(`Unexpected Cognito client allowlist: ${result.join(",")}`);
  }
});

Deno.test("configuredCognitoClientIds omits empty additional client IDs", () => {
  const result = configuredCognitoClientIds("mobile-client");

  if (result.length !== 1 || result[0] !== "mobile-client") {
    throw new Error(`Unexpected Cognito client allowlist: ${result.join(",")}`);
  }
});
