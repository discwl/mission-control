import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { HIDDEN_KEY, hideCredentials, hideSecrets } = require("./secret-mask.ts");

// Token-shaped values are assembled here so no literal in this file looks like a real provider key to secret scanners.
const token = (prefix, length) => prefix + "Fx7kQ2".repeat(Math.ceil(length / 6)).slice(0, length);

test("OpenAI's 401 message loses the partly masked key and keeps the rest", () => {
  const message = `Incorrect API key provided: ${"sk-"}svcac***…fvMA. You can find your API key at https://platform.openai.com/account/api-keys.`;
  assert.equal(hideSecrets(message), `Incorrect API key provided: ${HIDDEN_KEY}. You can find your API key at https://platform.openai.com/account/api-keys.`);
  assert.equal(hideSecrets(`key ${"sk-"}proj-${"*".repeat(40)}hRkA rejected`), `key ${HIDDEN_KEY} rejected`);
  assert.equal(hideSecrets(`key ${token("sk-ant-api03-", 40)} rejected`), `key ${HIDDEN_KEY} rejected`);
});

test("GitHub tokens are hidden, masked or whole", () => {
  for (const prefix of ["gh" + "p_", "gh" + "o_", "gh" + "s_", "github" + "_pat_"]) {
    assert.equal(hideSecrets(`Bad credentials for ${token(prefix, 36)}: 401`), `Bad credentials for ${HIDDEN_KEY}: 401`, prefix);
  }
  assert.equal(hideSecrets(`token ${"gh" + "p_"}ab12…wxyz expired`), `token ${HIDDEN_KEY} expired`);
});

test("a Bearer header keeps its scheme and loses its token", () => {
  assert.equal(hideSecrets(`Request failed with Authorization: Bearer ${token("", 40)}`), `Request failed with Authorization: Bearer ${HIDDEN_KEY}`);
  assert.equal(hideSecrets("authorization: bearer abc.DEF-123_x"), `authorization: bearer ${HIDDEN_KEY}`);
});

test("JWTs, named values and long hex or base64 runs are hidden", () => {
  const jwt = ["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJ" + "zdWIiOiIxMjM0In0", "c2lnbmF0dXJlLXZhbHVl"].join(".");
  assert.equal(hideSecrets(`session ${jwt} expired`), `session ${HIDDEN_KEY} expired`);
  assert.equal(hideSecrets("api_key=abc123def456, retrying"), `api_key=${HIDDEN_KEY}, retrying`);
  assert.equal(hideSecrets('password: "hunter2"'), `password: "${HIDDEN_KEY}"`);
  assert.equal(hideSecrets(`hex ${"0123456789abcdef".repeat(2)} end`), `hex ${HIDDEN_KEY} end`);
  assert.equal(hideSecrets(`b64 ${token("", 40)}== end`), `b64 ${HIDDEN_KEY} end`);
  assert.equal(hideSecrets(`https://api.example/v1/${token("", 40)}/items`), `https://api.example/v1/${HIDDEN_KEY}/items`);
});

test("a key-like value is hidden after = or :, whatever its parameter is called", () => {
  const hex = "0123456789abcdef".repeat(4);
  const url = `https://bucket.s3.example/report.csv?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=${hex}`;
  assert.equal(hideSecrets(url), `https://bucket.s3.example/report.csv?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=${HIDDEN_KEY}`);
  // Base64 with slashes and a plus, built from fixed bytes so it's the same every run.
  const base64 = Buffer.from(Array.from({ length: 48 }, (_, index) => (index * 73 + 41) % 256)).toString("base64");
  assert.match(base64, /\/.*\//);
  assert.equal(hideSecrets(`sig=${base64}&x=1`), `sig=${HIDDEN_KEY}&x=1`);
  assert.equal(hideSecrets(`signature:${base64}`), `signature:${HIDDEN_KEY}`);
  assert.equal(hideSecrets(`checksum ${base64} failed`), `checksum ${HIDDEN_KEY} failed`);
});

test("text without secrets comes back unchanged", () => {
  for (const message of [
    "The agent stopped: the provider is unavailable (HTTP 503). Retry later.",
    "Incorrect API key provided. You can find your API key at https://platform.openai.com/account/api-keys.",
    "ENOENT: no such file or directory, open 'C:/Users/n_var/.paseo/worktrees/3hh8n6fv/29804a04-18-small-follow-ups-hidden-keys-in-error/plugins/mission-control/package.json'",
    "Task task_29804a04-53dd-4004-a7fa-2d84a40ee0ed and task-18 use sk-learn and Bearer authentication.",
    "token: invalid; password is required; Basic auth failed",
    "/home/Developer/Projects/MissionControl2/client/components/WorkspaceFilterBar.tsx:42",
    "basic 2",
    "password: 8 characters",
    "npm_config_user_agent is not set",
    "MissionControlWorkspace/FilterBarComponentTest2 failed",
    "",
  ]) assert.equal(hideSecrets(message), message);
});

test("hiding twice changes nothing more", () => {
  const once = hideSecrets(`Bearer ${token("", 30)} and ${"sk-"}svcac***…fvMA and api_key=${HIDDEN_KEY}`);
  assert.equal(hideSecrets(once), once);
  assert.doesNotMatch(once, /Fx7k|svcac/);
});

test("a legacy Azure DevOps personal access token (52 base32 characters) is hidden, and ordinary long words aren't", () => {
  const pat = "k2x7mq4w5b3c5v6n2z2p4r6t3y3u5i7o5a2s4d6f4g3h5j7l2q4w";
  assert.equal(hideSecrets(`az: TF400813: token ${pat} is not authorized`), `az: TF400813: token ${HIDDEN_KEY} is not authorized`);
  const letters = "a".repeat(52);
  assert.equal(hideSecrets(`word ${letters}`), `word ${letters}`, "no base32 digit, so not a token");
  assert.equal(hideSecrets(`id ${pat}x9`), `id ${pat}x9`, "part of a longer run");
});

test("hideCredentials also removes a URL's user name and password", () => {
  assert.equal(hideCredentials("fatal: unable to access 'https://user:s3cret-value@github.com/acme/widgets.git/': 403"), "fatal: unable to access 'https://github.com/acme/widgets.git/': 403");
  assert.equal(hideCredentials("remote: https://contoso@dev.azure.com/contoso/p/_git/api"), "remote: https://dev.azure.com/contoso/p/_git/api");
  assert.equal(hideCredentials("see https://github.com/acme/widgets"), "see https://github.com/acme/widgets");
  assert.equal(hideCredentials(`https://me:${"gh" + "p_"}Fx7kQ2Fx7kQ2Fx7kQ2Fx7kQ2Fx7kQ2Fx7kQ2@github.com/a/b`), "https://github.com/a/b");
});
