import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const androidRoot = join(root, 'android');
const nodeModulesRoot = join(androidRoot, 'node_modules');
const lockPath = join(androidRoot, 'package-lock.json');
const reportDirectory = join(androidRoot, 'build', 'reports', 'third-party');
const jsonPath = join(reportDirectory, 'npm-dependencies.json');
const markdownPath = join(reportDirectory, 'npm-dependencies.md');

function toPosix(path) {
  return path.split(sep).join('/');
}

function normalizeLicense(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    return value.map(item => normalizeLicense(item)).filter(Boolean).join(' OR ') || null;
  }
  if (value && typeof value === 'object') {
    return String(value.type || value.name || '').trim() || null;
  }
  return null;
}

function getRepositoryUrl(repository) {
  if (typeof repository === 'string') return repository;
  if (repository && typeof repository === 'object') {
    const value = repository.url || repository.directory;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

async function findLicenseFiles(packageDirectory) {
  const candidates = new Set([
    'license', 'license.md', 'license.txt', 'licence', 'licence.md',
    'licence.txt', 'copying', 'copying.md', 'notice', 'notice.md'
  ]);
  const matches = [];
  for (const entry of await readdir(packageDirectory, { withFileTypes: true })) {
    if (entry.isFile() && candidates.has(entry.name.toLowerCase())) matches.push(entry.name);
  }
  return matches.sort((a, b) => a.localeCompare(b));
}

const lock = JSON.parse(await readFile(lockPath, 'utf8'));
assert.equal(lock.lockfileVersion, 3, 'Expected the pinned npm v3 lockfile.');
assert.ok(lock.packages && lock.packages[''], 'The npm lockfile is missing its root package metadata.');
assert.ok(existsSync(nodeModulesRoot), 'Run the Android npm install before generating the dependency inventory.');

const rootLock = lock.packages[''];
const directDependencies = new Set([
  ...Object.keys(rootLock.dependencies || {}),
  ...Object.keys(rootLock.devDependencies || {})
]);
const lockByNameVersion = new Map();
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path || !entry?.name || !entry?.version) continue;
  const key = entry.name + '@' + entry.version;
  if (!lockByNameVersion.has(key)) lockByNameVersion.set(key, []);
  lockByNameVersion.get(key).push({ path, entry });
}

const packages = [];
const seenPackagePaths = new Set();

async function visitPackage(packageDirectory, lockPathKey) {
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
  } catch {
    return;
  }

  if (!packageJson.name || !packageJson.version) return;
  const packagePath = toPosix(relative(nodeModulesRoot, packageDirectory));
  if (seenPackagePaths.has(packagePath)) return;
  seenPackagePaths.add(packagePath);

  const fallback = (lockByNameVersion.get(packageJson.name + '@' + packageJson.version) || [])[0];
  const lockEntry = lock.packages[lockPathKey] || fallback?.entry;
  if (!lockEntry) {
    throw new Error('Installed npm package is missing from the pinned lockfile: ' + packageJson.name + '@' + packageJson.version);
  }

  const declaredLicense = normalizeLicense(packageJson.license ?? packageJson.licenses ?? lockEntry.license);
  const licenseFiles = await findLicenseFiles(packageDirectory);
  const repository = getRepositoryUrl(packageJson.repository);
  packages.push({
    name: packageJson.name,
    version: packageJson.version,
    purl: 'pkg:npm/' + packageJson.name.replace(/^@/, '%40') + '@' + packageJson.version,
    direct: directDependencies.has(packageJson.name),
    development: Boolean(lockEntry.dev),
    optional: Boolean(lockEntry.optional),
    licenseDeclared: declaredLicense,
    licenseFiles,
    licenseFileFound: licenseFiles.length > 0,
    repository,
    homepage: typeof packageJson.homepage === 'string' ? packageJson.homepage : null,
    resolved: lockEntry.resolved || null,
    integrity: lockEntry.integrity || null,
    lockfilePath: lockPathKey
  });

  const nestedNodeModules = join(packageDirectory, 'node_modules');
  if (existsSync(nestedNodeModules)) await scanNodeModules(nestedNodeModules, lockPathKey + '/node_modules');
}

async function scanNodeModules(modulesDirectory, lockPrefix) {
  const entries = await readdir(modulesDirectory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.bin') continue;
    const entryPath = join(modulesDirectory, entry.name);
    if (entry.name.startsWith('@')) {
      const scopeStat = await lstat(entryPath).catch(() => null);
      if (!scopeStat?.isDirectory()) continue;
      const scopedEntries = await readdir(entryPath, { withFileTypes: true });
      for (const scopedEntry of scopedEntries.sort((a, b) => a.name.localeCompare(b.name))) {
        const packageDirectory = join(entryPath, scopedEntry.name);
        const info = await lstat(packageDirectory).catch(() => null);
        if (!info || (!info.isDirectory() && !info.isSymbolicLink())) continue;
        await visitPackage(packageDirectory, lockPrefix + '/' + entry.name + '/' + scopedEntry.name);
      }
      continue;
    }

    const info = await lstat(entryPath).catch(() => null);
    if (!info || (!info.isDirectory() && !info.isSymbolicLink())) continue;
    await visitPackage(entryPath, lockPrefix + '/' + entry.name);
  }
}

await scanNodeModules(nodeModulesRoot, 'node_modules');
packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.lockfilePath.localeCompare(b.lockfilePath));
assert.ok(packages.length >= 100, 'Resolved Android npm dependency inventory is unexpectedly small: ' + packages.length);

const lockBytes = await readFile(lockPath);
const licenseCounts = {};
for (const item of packages) {
  const key = item.licenseDeclared || 'UNDECLARED';
  licenseCounts[key] = (licenseCounts[key] || 0) + 1;
}

const inventory = {
  schema: 'nexus-android-npm-dependency-inventory',
  schemaVersion: 1,
  project: 'Nexus: Spaced Repetition Tracker',
  packageManager: 'npm',
  lockfileVersion: lock.lockfileVersion,
  lockfileSha256: createHash('sha256').update(lockBytes).digest('hex'),
  sourceCommit: process.env.GITHUB_SHA || null,
  installMode: process.env.NEXUS_ANDROID_CLOUD_MODE === 'staging' ? 'F-Droid staging CI install' : 'Android npm install',
  packageCount: packages.length,
  licenceCounts: Object.fromEntries(Object.entries(licenseCounts).sort(([a], [b]) => a.localeCompare(b))),
  packages
};

const escapeTable = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const markdownRows = packages.map(item =>
  '| ' + [
    escapeTable(item.name + '@' + item.version),
    escapeTable(item.licenseDeclared || 'UNDECLARED'),
    escapeTable(item.licenseFiles.join(', ') || 'No conventional licence file found'),
    escapeTable(item.direct ? 'direct' : 'transitive'),
    escapeTable(item.repository || item.homepage || '')
  ].join(' | ') + ' |'
);
const markdown = [
  '# Android npm dependency inventory',
  '',
  '- Project: Nexus: Spaced Repetition Tracker',
  '- Package manager: npm',
  '- Lockfile version: ' + lock.lockfileVersion,
  '- Lockfile SHA-256: ' + inventory.lockfileSha256,
  '- Source commit: ' + (inventory.sourceCommit || 'not supplied'),
  '- Installed packages scanned: ' + packages.length,
  '',
  'This report inventories package metadata and conventional licence files from the installed, lockfile-pinned Android npm dependency tree. It is not a legal opinion, does not independently authenticate package provenance, and does not replace review of the complete Gradle/Maven graph or files distributed inside the APK.',
  '',
  '## Declared licence summary',
  '',
  ...Object.entries(inventory.licenceCounts).map(([license, count]) => '- ' + license + ': ' + count),
  '',
  '## Package inventory',
  '',
  '| Package | Declared licence | Licence file(s) | Relationship | Repository / homepage |',
  '|---|---|---|---|---|',
  ...markdownRows,
  ''
].join('\n');

await mkdir(reportDirectory, { recursive: true });
await writeFile(jsonPath, JSON.stringify(inventory, null, 2) + '\n', 'utf8');
await writeFile(markdownPath, markdown, 'utf8');
console.log('Wrote Android npm dependency inventory for ' + packages.length + ' installed packages.');
