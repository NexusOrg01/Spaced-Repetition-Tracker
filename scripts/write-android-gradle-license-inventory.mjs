import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const androidRoot = join(root, 'android');
const reportDirectory = join(androidRoot, 'build', 'reports', 'third-party');
const cacheRoot = resolve(process.env.GRADLE_USER_HOME || join(homedir(), '.gradle'));
const modulesCache = join(cacheRoot, 'caches', 'modules-2', 'files-2.1');
const sourceReports = [
  join(androidRoot, 'build', 'reports', 'fdroid-dependencies', 'fdroid-debug-runtime.txt'),
  join(androidRoot, 'build', 'reports', 'fdroid-dependencies', 'fdroid-release-runtime.txt')
];
const outputJson = join(reportDirectory, 'gradle-licenses.json');
const outputMarkdown = join(reportDirectory, 'gradle-licenses.md');

function escapeTable(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
function unescapeXml(value) {
  return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
function tagValue(xml, tag) {
  const match = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>').exec(xml);
  return match ? unescapeXml(match[1].replace(/<[^>]+>/g, '').trim()) : null;
}
function parsePomLicences(xml) {
  const licensesBlock = /<licenses(?:\s[^>]*)?>([\s\S]*?)<\/licenses>/.exec(xml)?.[1] || '';
  const records = [];
  for (const match of licensesBlock.matchAll(/<license(?:\s[^>]*)?>([\s\S]*?)<\/license>/g)) {
    const name = tagValue(match[1], 'name');
    const url = tagValue(match[1], 'url');
    const comments = tagValue(match[1], 'comments');
    if (name || url || comments) records.push({ name, url, comments });
  }
  return records;
}
function coordinateFromLine(line) {
  const match = /[+\\]---\s+(.*)$/.exec(line);
  if (!match) return null;
  let value = match[1].trim();
  if (/\s+\(c\)$/.test(value)) return null; // constraint, not a resolved dependency
  value = value.replace(/\s+\(\*\)$/, '');
  if (value.startsWith('project ')) return null;
  const arrow = value.lastIndexOf(' -> ');
  if (arrow >= 0) value = value.slice(arrow + 4).trim();
  value = value.split(/\s+/)[0];
  value = value.split('@')[0];
  const parts = value.split(':');
  if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  return { group: parts[0], artifact: parts[1], version: parts[2] };
}
async function listFiles(directory, maximumDepth = 3, currentDepth = 0) {
  if (currentDepth > maximumDepth) return [];
  const output = [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return output; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile()) output.push(path);
    else if (entry.isDirectory() && currentDepth < maximumDepth) {
      output.push(...await listFiles(path, maximumDepth, currentDepth + 1));
    }
  }
  return output;
}
function moduleCacheDirectory(module) {
  return join(modulesCache, module.group, module.artifact, module.version);
}
async function archiveLicenceEntries(archivePath) {
  try {
    const { stdout } = await execFileAsync('unzip', ['-Z1', archivePath], { maxBuffer: 8 * 1024 * 1024 });
    return stdout.split(/\r?\n/).filter(entry =>
      /(^|\/)(LICENSE|LICENCE|COPYING|NOTICE)(\.[^/]*)?$/i.test(entry)
    ).sort();
  } catch {
    return [];
  }
}
function likelySpdx(name) {
  const compact = String(name || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
  if (/apache.*2[.]?0/.test(compact)) return 'Apache-2.0';
  if (compact === 'mit' || compact === 'mit license') return 'MIT';
  if (/bsd.*3.*clause/.test(compact)) return 'BSD-3-Clause';
  if (/bsd.*2.*clause/.test(compact)) return 'BSD-2-Clause';
  if (/eclipse.*2[.]?0/.test(compact)) return 'EPL-2.0';
  if (/eclipse.*1[.]?0/.test(compact)) return 'EPL-1.0';
  if (/mozilla.*2[.]?0/.test(compact)) return 'MPL-2.0';
  return null;
}

async function fetchPublicPom(module) {
  const groupPath = module.group.replace(/\./g, '/');
  const filename = module.artifact + '-' + module.version + '.pom';
  const repositories = [
    'https://dl.google.com/dl/android/maven2/',
    'https://repo.maven.apache.org/maven2/',
    'https://repo1.maven.org/maven2/'
  ];
  for (const repository of repositories) {
    const url = repository + groupPath + '/' + module.artifact + '/' + module.version + '/' + filename;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) continue;
      const body = await response.text();
      if (!/<project(?:\s|>)/i.test(body) || !/<modelVersion>/i.test(body)) continue;
      return { xml: body, source: url };
    } catch {
      // Try the next configured public Maven repository.
    }
  }
  return null;
}

assert.ok(existsSync(modulesCache), 'Gradle module cache is unavailable; run the strict Android dependency resolution/build first.');
const coordinates = new Map();
for (const path of sourceReports) {
  assert.ok(existsSync(path), 'Missing resolved Gradle dependency report: ' + path);
  const content = await readFile(path, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const module = coordinateFromLine(line);
    if (!module) continue;
    const key = module.group + ':' + module.artifact + ':' + module.version;
    if (!coordinates.has(key)) coordinates.set(key, module);
  }
}
assert.ok(coordinates.size >= 25, 'Resolved Gradle inventory is unexpectedly small: ' + coordinates.size);

const modules = [];
for (const [coordinate, module] of [...coordinates.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const directory = moduleCacheDirectory(module);
  const cachedFiles = await listFiles(directory);
  const expectedPom = module.artifact + '-' + module.version + '.pom';
  const pomPath = cachedFiles.find(path => path.endsWith('/' + expectedPom)) ||
    cachedFiles.find(path => path.endsWith('.pom')) || null;
  let licenses = [];
  let projectUrl = null;
  let scmUrl = null;
  let pomSource = null;
  let pom = null;
  if (pomPath) {
    pom = await readFile(pomPath, 'utf8');
    pomSource = 'Gradle cache: ' + relative(cacheRoot, pomPath).split(sep).join('/');
  } else {
    const fetched = await fetchPublicPom(module);
    if (fetched) {
      pom = fetched.xml;
      pomSource = fetched.source;
    }
  }
  if (pom) {
    licenses = parsePomLicences(pom);
    projectUrl = tagValue(pom, 'url');
    const scm = /<scm(?:\s[^>]*)?>([\s\S]*?)<\/scm>/.exec(pom)?.[1] || '';
    scmUrl = tagValue(scm, 'url') || tagValue(scm, 'connection');
  }
  const archives = [];
  for (const file of cachedFiles.filter(path => /\.(aar|jar)$/i.test(path))) {
    const info = await stat(file);
    archives.push({
      file: relative(cacheRoot, file).split(sep).join('/'),
      sizeBytes: info.size,
      licenceEntries: await archiveLicenceEntries(file)
    });
  }
  modules.push({
    coordinate,
    purl: 'pkg:maven/' + module.group + '/' + module.artifact + '@' + module.version,
    pomFound: Boolean(pom),
    pomSource,
    licenses,
    spdxGuesses: licenses.map(item => ({ declaredName: item.name, likelySpdx: likelySpdx(item.name) })),
    projectUrl,
    scmUrl,
    archives,
    archiveLicenceEntryCount: archives.reduce((sum, item) => sum + item.licenceEntries.length, 0)
  });
}

const report = {
  schema: 'nexus-android-gradle-license-inventory',
  schemaVersion: 1,
  project: 'Nexus: Spaced Repetition Tracker',
  sourceCommit: process.env.GITHUB_SHA || null,
  gradleDependencyReports: sourceReports.map(path => relative(root, path).split(sep).join('/')),
  gradleVerificationMetadata: 'android/gradle/verification-metadata.xml',
  moduleCount: modules.length,
  pomFoundCount: modules.filter(item => item.pomFound).length,
  pomMissingCount: modules.filter(item => !item.pomFound).length,
  modulesWithDeclaredLicences: modules.filter(item => item.licenses.length).length,
  modulesWithoutDeclaredLicences: modules.filter(item => !item.licenses.length).length,
  archivesFoundCount: modules.reduce((sum, item) => sum + item.archives.length, 0),
  archivesWithLicenceEntries: modules.filter(item => item.archiveLicenceEntryCount > 0).length,
  modules
};

const rows = modules.map(item => {
  const names = item.licenses.map(license => license.name || license.url || 'Unnamed licence').join('; ');
  const archiveCount = item.archives.length;
  const licenceFiles = item.archiveLicenceEntryCount;
  return '| ' + [
    escapeTable(item.coordinate),
    escapeTable(item.pomFound ? (names || 'POM has no licence declaration') : 'POM not cached'),
    escapeTable(item.projectUrl || item.scmUrl || ''),
    escapeTable(archiveCount),
    escapeTable(licenceFiles)
  ].join(' | ') + ' |';
});
const markdown = [
  '# Android Gradle/Maven runtime dependency licence inventory',
  '',
  '- Source commit: ' + (report.sourceCommit || 'not supplied'),
  '- Runtime modules: ' + report.moduleCount,
  '- POM files found: ' + report.pomFoundCount,
  '- POM files missing: ' + report.pomMissingCount,
  '- Modules with declared POM licences: ' + report.modulesWithDeclaredLicences,
  '- Modules with no POM licence declaration: ' + report.modulesWithoutDeclaredLicences,
  '- Cached JAR/AAR archives: ' + report.archivesFoundCount,
  '- Archives containing conventional licence/notice entries: ' + report.archivesWithLicenceEntries,
  '',
  'This report reads the resolved F-Droid debug and release runtime dependency trees, matching cached Maven artifacts and exact-coordinate POM metadata fetched from the configured public Google Maven and Maven Central repositories when raw POMs are not retained in the Gradle cache. It records upstream licence declarations and licence/notice filenames found inside cached JAR/AAR archives. SPDX labels are only emitted as conservative name mappings; ambiguous names remain unclassified. This is an audit aid, not a legal opinion or proof that every distributed asset has been cleared.',
  '',
  '| Resolved module | POM licence declaration | Project / SCM URL | Cached archives | Archive licence/notice entries |',
  '|---|---|---|---:|---:|',
  ...rows,
  '',
  '## Review required',
  '',
  '- Check every module without a POM or a declared licence against its upstream source.',
  '- Check every archive with no embedded licence/notice file against its upstream project notices.',
  '- Include applicable third-party notices in the release package where required.',
  '- This runtime-only list does not include Gradle build plugins, test-only dependencies, SDK tools, Go build tools or npm dependencies; those are inventoried separately or must be reviewed separately.',
  ''
].join('\n');

await mkdir(reportDirectory, { recursive: true });
await writeFile(outputJson, JSON.stringify(report, null, 2) + '\n', 'utf8');
await writeFile(outputMarkdown, markdown, 'utf8');
console.log('Wrote Gradle/Maven licence inventory for ' + modules.length + ' resolved runtime modules (' +
  report.pomFoundCount + ' POMs found; ' + report.modulesWithoutDeclaredLicences + ' modules without declared licences).');
