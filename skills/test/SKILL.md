---
name: test
description: Write, fix or improve tests — unit, integration, or end-to-end. Use when asked to test something, raise coverage, or make a suite pass.
triggers: [unit test, integration test, test suite, write tests, add tests, tests for, test coverage, coverage, jest, vitest, pytest, mocha, assertion, fixture, e2e, playwright, cypress, make the tests pass, tdd]
---

# Test skill

## First, learn this project's conventions

Read two or three existing test files before writing one. Match their: framework,
file naming (`x.test.ts` vs `x.spec.ts`), location (`tests/` vs colocated),
assertion style, setup/teardown pattern, and how they build fixtures. A new test
that follows different conventions is worse than no test.

Find the command to run one file (`npx vitest run tests/x.test.ts`,
`pytest tests/x.py -k name`) — you will need it constantly.

## What to test

- **Behaviour, not implementation.** Assert what the code guarantees, not how it
  currently works internally. Tests coupled to implementation break on every
  refactor and teach nothing.
- **The edges are where bugs live:** empty, null/undefined, zero, one, negative,
  maximum, duplicate, already-exists, not-found, permission-denied, malformed
  input, unicode, very long, concurrent.
- **Error paths.** A function that throws should have a test asserting *what* it
  throws and *why*. "It doesn't crash" is not a test.
- **One logical assertion per test.** Several `expect`s checking one behaviour is
  fine; several unrelated behaviours in one test is not.

## Naming

The test name states the contract, so a failure reads as a sentence:

- `edit_file refuses an ambiguous match and reports the line numbers`
- `returns an empty list when the directory does not exist`

Not `test1`, not `works`, not `should be correct`.

## Structure

**Arrange — Act — Assert.** Keep the arrange block short; if it is long, extract a
helper or a factory. One glance should show what is being tested.

```ts
it('rejects a path outside the workspace', async () => {
  const ctx = await makeContext(dir);            // arrange
  const res = await writeFileTool.run({ path: '../evil.txt', content: 'x' }, ctx);  // act
  expect(res.isError).toBe(true);               // assert
  expect(res.content).toMatch(/outside the workspace/);
});
```

## Isolation

- **No test depends on another test's result.** They must pass in any order and alone.
- **Real filesystem/network only when it is the thing under test.** Use a temp dir
  (`mkdtemp`) and always clean up. Never write into the repo.
- **Mock at boundaries, not in the middle.** Mock the HTTP client, not the
  function two lines below the one you are testing. Over-mocking gives you a test
  that passes while the code is broken.
- **Deterministic:** inject the clock, avoid `Math.random`, do not depend on
  locale, timezone, or dictionary ordering.
- **Fast:** a unit test over ~10ms. If it is slow, it is an integration test — label it as one.

## Fixing a failing test

Decide first, and say which it is:

1. **The code is wrong** → fix the code.
2. **The test is wrong** (asserting outdated behaviour) → fix the test and explain why.
3. **The test is flaky** → find the shared state. Never "fix" flakiness with a
   retry, a longer timeout, or `.skip`.

**Never** weaken an assertion, add `.skip`, or delete a test just to get a green
run. If you believe the test should go, say so and let the user decide.

## Coverage

Coverage is a diagnostic, not a target. 100% coverage with no meaningful
assertions is worthless. Find untested *branches and error paths*, not untested lines.

## Report

Say: what you added, what each test protects against, how to run them, and the
result of running them.
