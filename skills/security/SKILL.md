---
name: security
description: Security review and hardening — injection, auth, secrets, path traversal, unsafe deserialisation, dependencies, permissions. Use when security matters or is asked about.
triggers: [security, secure, vulnerability, vulnerable, injection, sql injection, xss, csrf, auth, authentication, authorisation, authorization, secret, api key, token, password, credential, encrypt, sanitize, sanitise, owasp, cve, harden, unsafe, exploit, privilege, session, cors, ssrf, path traversal]
---

# Security skill

## Method

Trace **untrusted input** to every **sensitive sink**. That is the whole discipline.

1. **List the entry points:** HTTP handlers, CLI args, env vars, uploaded files,
   webhooks, message queues, DB rows written by other services, filenames, URLs.
2. **List the sinks:** SQL, shell commands, `eval`, file paths, HTML output,
   redirects, deserialisation, crypto, logging, outbound requests.
3. **For each path ask:** is the input validated? Is it encoded for *that* sink?
   Could an attacker reach it? What do they get if they do?

Search for the sinks instead of guessing:

```
search "exec|spawn|eval|Function\(|child_process"
search "query\(|execute\(|raw\(|\$queryRaw"
search "innerHTML|dangerouslySetInnerHTML|v-html|document.write"
search "readFile|writeFile|createReadStream|path.join"
search "password|secret|token|api[_-]?key|authorization"
search "redirect|location =|res.location"
search "JSON.parse|unserialize|pickle.loads|yaml.load"
```

## The checks

**Injection.** Never build SQL, shell, or HTML by string concatenation.
Parameterised queries only. Shell: pass an argument array, never a string.
HTML: escape on output for the right context (HTML body, attribute, JS, URL are
four different encodings). `eval`/`new Function`: delete.

**Path traversal.** `../../etc/passwd` and absolute paths. Resolve, then verify
the result is still inside the intended root — checking the raw string is not
enough. Also check null bytes, symlinks, and case-insensitive filesystems.

**AuthN / AuthZ.** Authentication is who you are; authorisation is what you may
do. The common bug is checking the first and forgetting the second.
- Every route that touches data needs an ownership check, not just a login check.
- **Check authorisation on the server.** Client-side hiding is UX, not security.
- Watch for IDOR: `/api/orders/123` where only the login is verified, so any user
  can read any order by changing `123`.
- Fail closed: if a permission check errors or is skipped, deny.

**Secrets.** Never in source, logs, error messages, URLs, or commit history.
- `search` for hardcoded keys; check `.env` is gitignored; check for `.env`
  already committed (`git log --all --full-history -- .env`).
- Redact before logging. A stack trace that prints a request body leaks tokens.
- Rotate anything that was ever committed — deleting it in a later commit does not
  remove it from history.

**Input validation.** Validate at the boundary with an allowlist: type, length,
range, format, allowed characters. Reject, do not sanitise-and-hope. Validate
*after* decoding, or an attacker encodes around you.

**Output & redirects.** Validate redirect targets against an allowlist of paths
or hosts — open redirects feed phishing and steal OAuth codes.

**Deserialisation.** Never deserialise untrusted data with a format that can
construct objects or run code (`pickle`, `yaml.load`, Java native, PHP
`unserialize`). Use JSON with an explicit schema.

**Dependencies.** `npm audit` / `pip-audit` / `cargo audit`. Pin versions, review
lockfile diffs, and be suspicious of new or typosquatted packages.

**Crypto.** Use the platform's library. Never write your own. No MD5/SHA1 for
passwords (use argon2/bcrypt/scrypt), no ECB mode, no reused IVs/nonces, no
hardcoded keys. Compare secrets with a constant-time function.

**Config & transport.** CORS `*` with credentials, missing security headers,
cookies without `HttpOnly`/`Secure`/`SameSite`, TLS verification disabled,
debug mode in production, directory listing on, default credentials.

**Denial of service.** Unbounded input size, unbounded loops over user data,
regex catastrophic backtracking (nested quantifiers like `(a+)+`), unpaginated
queries, decompression bombs, unrate-limited expensive endpoints.

## Rules for this task

- **Never weaken security to make something work.** If a test needs auth off, add
  a test-only flag, do not remove the check.
- **Never print a real secret** into output, logs, tests, fixtures, or commits.
  Use obviously-fake values (`sk-TEST-xxxx`).
- **Do not invent a CVE number or a severity score.** Report what you verified in
  this code, and label inference as inference.
- **Exploitability matters.** Say how hard it is to reach: unauthenticated remote,
  authenticated user, local only, requires a race.

## Report

Order by severity. For each finding:

```
HIGH — SQL injection in src/api/search.ts:42
  Input:   ?q= from the query string, unvalidated
  Sink:    db.query(`... WHERE name LIKE '%${q}%'`)
  Impact:  unauthenticated remote read of the whole database
  Fix:     parameterised query — db.query('... LIKE ?', [`%${q}%`])
  Verify:  add a test with q = "'; DROP TABLE users; --"
```

Then: what you checked and found clean, what you could not verify, and the one
thing to fix first.
