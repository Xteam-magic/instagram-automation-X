import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve('playwright/.auth/instagram.json');
fs.mkdirSync(path.dirname(out), { recursive: true });

const browser = await chromium.launch({
  headless: false,
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded' });
console.log('Log into Instagram in the opened browser. Complete 2FA if requested.');
console.log('After you reach the Instagram home page, press Enter in this terminal.');
process.stdin.setEncoding('utf8');
await new Promise(resolve => process.stdin.once('data', resolve));
await context.storageState({ path: out });
await browser.close();
console.log(`Saved: ${out}`);
console.log('\nCreate the GitHub secret INSTAGRAM_SESSION_B64 with:');
console.log(process.platform === 'win32'
  ? ` [IO.File]::ReadAllText('${out}') | Set-Content -NoNewline session.json; [Convert]::ToBase64String([IO.File]::ReadAllBytes('${out}'))`
  : ` base64 -w 0 '${out}'`);
