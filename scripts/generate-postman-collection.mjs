import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backendSourcePath = resolve(root, "supabase/functions/api/index.ts");
const collectionPath = resolve(root, "postman/MetaGlasses API.postman_collection.json");

const hostedEnvironments = {
  Trial: {
    appEnv: "trial",
    supabaseUrl: "https://uitdzmwfqtsohgffhuom.supabase.co",
    redirectUrl: "glance-trial://auth/callback",
  },
  Production: {
    appEnv: "prod",
    supabaseUrl: "https://hxtdfghufjjmeltarffl.supabase.co",
    redirectUrl: "glance://auth/callback",
  },
};

const jsonHeader = { key: "Content-Type", value: "application/json", type: "text" };
const authHeader = {
  key: "Authorization",
  value: "Bearer {{access_token}}",
  type: "text",
};
const apiKeyHeader = {
  key: "apikey",
  value: "{{supabase_publishable_key}}",
  type: "text",
};

function testEvent(lines) {
  return [{ listen: "test", script: { type: "text/javascript", exec: lines } }];
}

function jsonBody(value) {
  return {
    mode: "raw",
    raw: JSON.stringify(value, null, 2),
    options: { raw: { language: "json" } },
  };
}

function request(name, method, url, options = {}) {
  return {
    name,
    ...(options.tests ? { event: testEvent(options.tests) } : {}),
    request: {
      method,
      header: options.headers ?? [],
      ...(options.body ? { body: options.body } : {}),
      url,
      ...(options.description ? { description: options.description } : {}),
    },
  };
}

const apiRequests = {
  "GET /healthz": request("Health check", "GET", "{{backend_url}}/healthz", {
    tests: [
      "pm.test('Status is 200', () => pm.response.to.have.status(200));",
      "pm.test('Environment matches the selected environment', () => {",
      "  pm.expect(pm.response.json().environment).to.eql(pm.environment.get('app_env'));",
      "});",
    ],
  }),
  "POST /v1/state": request(
    "Register pairing and set lens state",
    "POST",
    "{{backend_url}}/v1/state",
    {
      headers: [authHeader, jsonHeader],
      body: jsonBody({ pairingToken: "{{pairing_token}}", state: "listening" }),
      tests: ["pm.test('Status is 204', () => pm.response.to.have.status(204));"],
      description: "Run this before image upload or chat to register the pairing.",
    },
  ),
  "GET /v1/display": request(
    "Read paired lens display",
    "GET",
    "{{backend_url}}/v1/display?token={{pairing_token}}",
    {
      tests: ["pm.test('Status is 200', () => pm.response.to.have.status(200));"],
      description: "The pairing token is the lens capability credential. No bearer token is used.",
    },
  ),
  "POST /v1/chat": request(
    "Chat with uploaded image",
    "POST",
    "{{backend_url}}/v1/chat",
    {
      headers: [authHeader, jsonHeader],
      body: jsonBody({
        pairingToken: "{{pairing_token}}",
        messages: [{
          role: "user",
          content: "What am I looking at?",
          imageIds: ["{{image_id}}"],
        }],
      }),
      tests: [
        "pm.test('Status is 200', () => pm.response.to.have.status(200));",
        "pm.test('A model response was returned', () => {",
        "  const body = pm.response.json();",
        "  pm.expect(body.responseId).to.be.a('string').and.not.empty;",
        "  pm.expect(body.text).to.be.a('string').and.not.empty;",
        "});",
      ],
      description: "Upload an image first. The upload request saves image_id automatically.",
    },
  ),
  "POST /v1/images": request(
    "Upload pairing image",
    "POST",
    "{{backend_url}}/v1/images?pairingToken={{pairing_token}}",
    {
      headers: [authHeader, { key: "Content-Type", value: "image/jpeg", type: "text" }],
      body: { mode: "file", file: { src: "" } },
      tests: [
        "pm.test('Status is 201', () => pm.response.to.have.status(201));",
        "const body = pm.response.json();",
        "pm.test('An image ID was returned', () => pm.expect(body.imageId).to.be.a('string').and.not.empty);",
        "if (body.imageId) pm.environment.set('image_id', body.imageId);",
      ],
      description: "Select a JPEG file in Body. For PNG, change Content-Type to image/png.",
    },
  ),
  "DELETE /v1/images/:image_id": request(
    "Delete uploaded pairing image",
    "DELETE",
    "{{backend_url}}/v1/images/{{image_id}}?pairingToken={{pairing_token}}",
    {
      headers: [authHeader],
      tests: ["pm.test('Status is 204', () => pm.response.to.have.status(204));"],
    },
  ),
};

function discoverBackendRoutes(source) {
  const routes = new Set();
  const routeCondition = /request\.method === "(GET|POST|PUT|PATCH|DELETE)" && path === "([^"]+)"/g;
  for (const match of source.matchAll(routeCondition)) {
    routes.add(`${match[1]} ${match[2]}`);
  }
  if (
    source.includes("path.match(/^\\/v1\\/images\\/([^/]+)$/)") &&
    source.includes('request.method === "DELETE" && imageDelete')
  ) {
    routes.add("DELETE /v1/images/:image_id");
  }
  return routes;
}

function assertRequestCoverage(discoveredRoutes) {
  const configuredRoutes = new Set(Object.keys(apiRequests));
  const missing = [...discoveredRoutes].filter((route) => !configuredRoutes.has(route));
  const stale = [...configuredRoutes].filter((route) => !discoveredRoutes.has(route));
  if (missing.length || stale.length) {
    throw new Error([
      missing.length ? `Missing Postman templates: ${missing.join(", ")}` : "",
      stale.length ? `Stale Postman templates: ${stale.join(", ")}` : "",
    ].filter(Boolean).join("\n"));
  }
}

function authRequests() {
  return [
    request("Read enabled providers", "GET", "{{supabase_url}}/auth/v1/settings", {
      headers: [apiKeyHeader],
    }),
    request("Sign up with email and password", "POST", "{{supabase_url}}/auth/v1/signup", {
      headers: [apiKeyHeader, jsonHeader],
      body: jsonBody({ email: "{{test_email}}", password: "{{test_password}}" }),
      tests: [
        "const body = pm.response.json();",
        "if (body.access_token) pm.environment.set('access_token', body.access_token);",
        "if (body.refresh_token) pm.environment.set('refresh_token', body.refresh_token);",
      ],
    }),
    request(
      "Sign in and save bearer token",
      "POST",
      "{{supabase_url}}/auth/v1/token?grant_type=password",
      {
        headers: [apiKeyHeader, jsonHeader],
        body: jsonBody({ email: "{{test_email}}", password: "{{test_password}}" }),
        tests: [
          "const body = pm.response.json();",
          "pm.test('An access token was returned', () => pm.expect(body.access_token).to.be.a('string').and.not.empty);",
          "if (body.access_token) pm.environment.set('access_token', body.access_token);",
          "if (body.refresh_token) pm.environment.set('refresh_token', body.refresh_token);",
        ],
      },
    ),
    request("Get current user", "GET", "{{supabase_url}}/auth/v1/user", {
      headers: [apiKeyHeader, authHeader],
      tests: ["pm.test('Status is 200', () => pm.response.to.have.status(200));"],
    }),
    request(
      "Start Google OAuth",
      "GET",
      "{{supabase_url}}/auth/v1/authorize?provider=google&redirect_to={{app_redirect_url}}",
      { headers: [apiKeyHeader] },
    ),
    request(
      "Start Apple OAuth",
      "GET",
      "{{supabase_url}}/auth/v1/authorize?provider=apple&redirect_to={{app_redirect_url}}",
      { headers: [apiKeyHeader] },
    ),
  ];
}

function collection() {
  return {
    info: {
      name: "MetaGlasses API",
      description: "Generated from the Supabase Edge API routes. Select an example environment, duplicate it in Postman, then populate its publishable key and test-user credentials.",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [
      { name: "Supabase Auth", item: authRequests() },
      {
        name: "Supabase Edge API smoke flow",
        description: "Run in order: health, state, upload, chat, display, then delete.",
        item: [
          apiRequests["GET /healthz"],
          apiRequests["POST /v1/state"],
          apiRequests["POST /v1/images"],
          apiRequests["POST /v1/chat"],
          apiRequests["GET /v1/display"],
          apiRequests["DELETE /v1/images/:image_id"],
        ],
      },
    ],
  };
}

function environment(name, values) {
  const entries = {
    app_env: values.appEnv,
    supabase_url: values.supabaseUrl,
    backend_url: `${values.supabaseUrl}/functions/v1/api`,
    supabase_publishable_key: "",
    app_redirect_url: values.redirectUrl,
    test_email: "",
    test_password: "",
    access_token: "",
    refresh_token: "",
    pairing_token: "0123456789abcdef0123456789abcdef",
    image_id: "",
  };
  return {
    name: `MetaGlasses ${name} Example`,
    values: Object.entries(entries).map(([key, value]) => ({ key, value, enabled: true })),
    _postman_variable_scope: "environment",
    _postman_exported_using: "MetaGlasses collection generator",
  };
}

const backendSource = await readFile(backendSourcePath, "utf8");
assertRequestCoverage(discoverBackendRoutes(backendSource));
await mkdir(resolve(root, "postman"), { recursive: true });

const outputs = new Map([[collectionPath, collection()]]);
for (const [name, values] of Object.entries(hostedEnvironments)) {
  outputs.set(
    resolve(root, `postman/MetaGlasses ${name}.example.postman_environment.json`),
    environment(name, values),
  );
}

let drifted = false;
for (const [path, value] of outputs) {
  const expected = `${JSON.stringify(value, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    const actual = await readFile(path, "utf8").catch(() => "");
    if (actual !== expected) {
      console.error(`${path.replace(`${root}/`, "")} is not generated from the current API.`);
      drifted = true;
    }
  } else {
    await writeFile(path, expected);
    console.log(`Wrote ${path.replace(`${root}/`, "")}`);
  }
}

if (drifted) process.exitCode = 1;
