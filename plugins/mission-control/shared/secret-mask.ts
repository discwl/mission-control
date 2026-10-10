// Hides key-like strings in text Mission Control shows, such as an agent's last error. Providers echo part of a
// rejected key ("Incorrect API key provided: sk-svcac***…fvMA"), and even a partly masked key doesn't belong on screen.
// Shared by client and server code, so it imports nothing.

export const HIDDEN_KEY = "[key hidden]";

// Key characters plus the masks providers put inside keys: *, •, … and "...".
const BODY = String.raw`(?:[A-Za-z0-9_\-]|\*|•|…|\.\.\.)+`;
const MASKED = /\*|•|…|\.\.\./;
const NOT_AFTER_WORD = String.raw`(?<![A-Za-z0-9_\-])`;

/**
 * A token body worth hiding: six or more characters that are masked, hold a digit, or mix cases over `long` characters.
 * Keeps words and short values such as "sk-learn", "Bearer authentication", "basic 2" or "npm_config_user_agent".
 */
const keyLike = (body: string, long = 16) => body.length >= 6
  && (MASKED.test(body) || /\d/.test(body) || (body.length >= long && /[A-Z]/.test(body) && /[a-z]/.test(body)));

// Well-known key prefixes: OpenAI and Anthropic (sk-), Stripe (sk_, rk_), GitHub, Slack, GitLab, Hugging Face, npm, AWS, Google.
const PREFIXED = new RegExp(`${NOT_AFTER_WORD}(sk-|sk_|rk_|gh[pousr]_|github_pat_|xox[a-z]-|glpat-|hf_|npm_|AKIA|ASIA|AIza)(${BODY})`, "g");
const AUTH_SCHEME = /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/\-*•…]+=*)/gi;
const JWT = new RegExp(`${NOT_AFTER_WORD}eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*`, "g");
const NAMED = /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd)(\s*[:=]\s*)(["']?)([^\s"'`,;)\]}]+)/gi;
// A run may follow "=" or ":", so a key-like value is hidden whatever its parameter is called.
const LONG_RUN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/=_-])/g;

const kind = (char: string) => /[A-Z]/.test(char) ? 0 : /[a-z]/.test(char) ? 1 : /\d/.test(char) ? 2 : 3;

/** How often neighbouring characters switch between upper case, lower case, digit and symbol: about 0.6 for random base64, under 0.3 for words and paths. */
function mixing(value: string): number {
  let switches = 0;
  for (let index = 1; index < value.length; index++) if (kind(value[index]) !== kind(value[index - 1])) switches++;
  return switches / (value.length - 1);
}

/** 32+ hex characters, or 32+ base64 characters (slashes included) that mix upper case, lower case and digits the way random data does. */
function randomLooking(run: string): boolean {
  const bare = run.replace(/=+$/, "");
  if (bare.length < 32) return false;
  if (/^[0-9a-f]+$/i.test(bare)) return /\d/.test(bare);
  return /[A-Z]/.test(bare) && /[a-z]/.test(bare) && /\d/.test(bare) && mixing(bare) >= 0.35;
}

/**
 * A path or URL (its other segments read like words) keeps those segments and loses the key-like one.
 * Anything else that looks random, such as base64 containing slashes, is hidden whole.
 */
function hideRun(run: string): string {
  const segments = run.split("/");
  const keys = segments.map(randomLooking);
  const path = keys.includes(true) && segments.every((segment, index) => keys[index] || segment.length <= 3 || mixing(segment) < 0.35);
  if (path) return segments.map((segment, index) => keys[index] ? HIDDEN_KEY : segment).join("/");
  return randomLooking(run) ? HIDDEN_KEY : run;
}

// A legacy Azure DevOps personal access token: 52 lowercase base32 characters (a–z, 2–7), with no letters or digits around it.
const AZURE_DEVOPS_PAT = /(?<![A-Za-z0-9])[a-z2-7]{52}(?![A-Za-z0-9])/g;

/** Replaces key-like strings with "[key hidden]" and leaves the rest of the text as it was. */
export function hideSecrets(text: string): string {
  return text
    .replace(AZURE_DEVOPS_PAT, run => /[2-7]/.test(run) ? HIDDEN_KEY : run)
    .replace(AUTH_SCHEME, (match, scheme: string, space: string, token: string) => keyLike(token, 20) ? `${scheme}${space}${HIDDEN_KEY}` : match)
    .replace(JWT, HIDDEN_KEY)
    .replace(PREFIXED, (match, _prefix: string, body: string) => keyLike(body) ? HIDDEN_KEY : match)
    .replace(NAMED, (match, name: string, separator: string, quote: string, value: string) =>
      value !== "[key" && keyLike(value, 20) ? `${name}${separator}${quote}${HIDDEN_KEY}` : match)
    .replace(LONG_RUN, hideRun);
}

// The user name and password part of a URL, such as https://user:token@github.com/…
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

/** hideSecrets, and a URL's user name and password removed: for command output and errors that may echo a remote URL. */
export function hideCredentials(text: string): string {
  // URL credentials first: hideSecrets' "[key hidden]" has a space, which would hide the rest of the URL from this match.
  return hideSecrets(text.replace(URL_CREDENTIALS, "$1"));
}
