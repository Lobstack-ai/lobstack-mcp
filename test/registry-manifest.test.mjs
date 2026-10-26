/**
 * server.json is the document the Official MCP Registry publishes, and
 * package.json mcpName is the string it looks up inside the npm tarball to
 * decide the package is ours. They are two files and one claim. A release
 * that bumps one of them publishes metadata the registry rejects, or worse,
 * metadata for a version the tarball is not.
 */
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const REGISTRY_NAME = 'io.github.Lobstack-ai/lobstack-mcp';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));

test('mcpName is the GitHub namespace the registry will accept', () => {
  assert.equal(pkg.mcpName, REGISTRY_NAME);
  assert.equal(server.name, REGISTRY_NAME);
  assert.equal(server.name, pkg.mcpName);
  assert.match(server.name, /^io\.github\.Lobstack-ai\/[a-z0-9._-]+$/);
});

test('server.json describes this package, this version, over stdio', () => {
  assert.equal(server.version, pkg.version);
  assert.equal(server.description, pkg.description);
  assert.ok(server.description.length <= 100, 'the registry rejects a description over 100 characters');

  assert.equal(server.repository.url, 'https://github.com/Lobstack-ai/lobstack-mcp');
  assert.equal(server.repository.source, 'github');

  assert.equal(server.packages.length, 1);
  const entry = server.packages[0];
  assert.equal(entry.registryType, 'npm');
  assert.equal(entry.registryBaseUrl, 'https://registry.npmjs.org');
  assert.equal(entry.identifier, '@lobstack-ai/mcp');
  assert.equal(entry.identifier, pkg.name);
  assert.equal(entry.version, pkg.version);
  assert.equal(entry.runtimeHint, 'npx');
  assert.equal(entry.transport.type, 'stdio');

  const yes = entry.runtimeArguments.find((arg) => arg.type === 'positional' && arg.value === '-y');
  assert.ok(yes, 'the install command is npx -y @lobstack-ai/mcp');
});

test('LOBSTACK_API_KEY is optional and secret', () => {
  const entry = server.packages[0];
  const key = entry.environmentVariables.find((v) => v.name === 'LOBSTACK_API_KEY');
  assert.ok(key, 'LOBSTACK_API_KEY must be declared');
  // route preview is unauthenticated. A required key would tell every client
  // the server cannot start without one, which is the opposite of what it does.
  assert.equal(key.isRequired, false);
  assert.equal(key.isSecret, true);

  const base = entry.environmentVariables.find((v) => v.name === 'LOBSTACK_BASE_URL');
  assert.ok(base);
  assert.equal(base.isRequired, false);
  assert.equal(base.isSecret, false);
});

test('the npm tarball includes server.json', () => {
  assert.ok(pkg.files.includes('server.json'), 'files is set, so an unlisted server.json never ships');
});
