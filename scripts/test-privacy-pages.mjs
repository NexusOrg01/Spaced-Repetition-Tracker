import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const privacy = readFileSync(new URL('../privacy.html', import.meta.url), 'utf8');
const deletion = readFileSync(new URL('../delete-account.html', import.meta.url), 'utf8');
const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

for (const [label, source] of [['privacy policy', privacy], ['deletion page', deletion]]) {
  assert.ok(source.includes('nexusorg.contact01@gmail.com'), label + ' must publish the approved support/privacy contact');
}
for (const phrase of [
  'Effective date: 3 November 2026',
  'offline',
  'IndexedDB',
  'Supabase',
  'Google',
  'Vercel',
  'jsDelivr',
  'local workspace',
  'cloud workspace',
  'retention',
  'Account and Data Deletion'
]) {
  assert.ok(privacy.toLowerCase().includes(phrase.toLowerCase()), 'privacy policy must cover: ' + phrase);
}
assert.ok(privacy.includes('./delete-account.html'), 'privacy policy must link to the account-deletion instructions');
assert.ok(privacy.includes('does not currently include in-app advertising'), 'privacy policy must disclose the current no-advertising position');
assert.ok(deletion.includes('Nexus account deletion request'), 'deletion page must state the email subject to use');
assert.ok(deletion.includes('manually'), 'deletion page must disclose that account deletion is manually processed');
assert.ok(deletion.includes('local') && deletion.includes('downloaded'), 'deletion page must explain local and downloaded copies are not remotely erased');
assert.ok(deletion.includes('Do not send your password'), 'deletion page must warn users not to send credentials');
assert.ok(index.includes('href="./privacy.html"') && index.includes('href="./delete-account.html"'),
  'the in-app Accounts & Backup view must link to both public legal pages');
assert.ok(readme.includes('privacy.html') && readme.includes('delete-account.html'),
  'README must link to both public legal pages');

console.log('Privacy and account-deletion page checks passed.');
