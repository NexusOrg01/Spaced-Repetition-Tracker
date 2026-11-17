import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const requiredEnv = [
  'PHASE34_API_URL',
  'PHASE34_ANON_KEY',
  'PHASE34_EMAIL_A',
  'PHASE34_PASSWORD_A',
  'PHASE34_EMAIL_B',
  'PHASE34_PASSWORD_B'
];
for (const name of requiredEnv) {
  assert.ok(process.env[name], 'Missing required ephemeral local-test variable: ' + name);
}

const apiUrl = new URL(process.env.PHASE34_API_URL);
assert.equal(apiUrl.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(apiUrl.hostname));
assert.equal(apiUrl.port, '54321');

const browser = await chromium.launch({ headless: true });
const pageErrors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', error => pageErrors.push(String(error && error.message || error)));

  const origin = 'http://127.0.0.1:4173';
  const response = await page.goto(origin + '/staging-test/two-client.html', {
    waitUntil: 'domcontentloaded'
  });
  assert.equal(response && response.status(), 200, 'local harness page must load successfully');

  await page.locator('#supabaseUrl').fill(process.env.PHASE34_API_URL);
  await page.locator('#anonKey').fill(process.env.PHASE34_ANON_KEY);
  await page.locator('#emailA').fill(process.env.PHASE34_EMAIL_A);
  await page.locator('#passwordA').fill(process.env.PHASE34_PASSWORD_A);
  await page.locator('#emailB').fill(process.env.PHASE34_EMAIL_B);
  await page.locator('#passwordB').fill(process.env.PHASE34_PASSWORD_B);
  await page.locator('#runButton').click();

  await page.waitForFunction(() => {
    const status = document.querySelector('#status')?.textContent || '';
    return status.startsWith('PASS —') || status.startsWith('FAILED —');
  }, null, { timeout: 90000 });

  const status = await page.locator('#status').innerText();
  const log = await page.locator('#log').innerText();
  assert.match(status, /^PASS — 19 authenticated local integration assertions completed\.$/, log);

  // PASS is set before the async finally block finishes signing out. Wait for
  // the teardown before asserting that the credential fields have been cleared.
  await page.waitForFunction(() => {
    const value = id => document.querySelector('#' + id)?.value;
    return value('anonKey') === '' && value('passwordA') === '' && value('passwordB') === '';
  }, null, { timeout: 15000 });

  const expected = [
    'Three independent Auth sessions established',
    'A1 and A2 share owner A',
    'B has a distinct owner identity',
    'A1 and A2 have independent access tokens',
    'Both accounts begin in snapshot mode',
    'Only allowlisted owner A can enable Delta',
    'Allowlisted owner A publishes revision 1',
    'Unlisted owner B cannot publish Delta',
    'Concurrent A publication returns one winner and one revision conflict',
    'Losing operation retries at revision 3',
    'Same ID and payload replays original receipt',
    'Same ID with different payload is rejected',
    'A reads exactly its three contiguous revisions',
    'Unlisted B stays in snapshot mode and reads no Delta operations',
    'No cross-account operation IDs appear',
    'A table reads contain only owner A rows',
    'B table reads contain no Delta rows',
    'A cannot select B rows by guessing owner ID',
    'Direct operation-table write is denied',
    'Final heads remain isolated (A=3, B=0)'
  ];
  for (const assertion of expected) {
    assert.ok(log.includes('PASS  ' + assertion), 'missing authenticated assertion: ' + assertion + '\n' + log);
  }

  assert.equal(await page.locator('#anonKey').inputValue(), '', 'the local anon key must be cleared');
  assert.equal(await page.locator('#passwordA').inputValue(), '', 'password A must be cleared');
  assert.equal(await page.locator('#passwordB').inputValue(), '', 'password B must be cleared');
  assert.deepEqual(pageErrors, [], 'the browser must not report uncaught page errors');

  console.log(status);
  console.log(log);
} finally {
  await browser.close();
}
