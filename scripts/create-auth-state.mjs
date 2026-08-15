import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

const out = path.resolve('playwright/.auth/instagram.json');
fs.mkdirSync(path.dirname(out), { recursive: true });

const browser = await chromium.launch({
  headless: false
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 }
});
const page = await context.newPage();

await page.goto('https://www.instagram.com/accounts/login/', {
  waitUntil: 'domcontentloaded'
});

console.log('Log into Instagram in the opened browser. Complete 2FA if requested.');
console.log('Press Enter here after the account is fully logged in.');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});
await rl.question('');
rl.close();

await context.storageState({ path: out });
const b64 = Buffer.from(fs.readFileSync(out)).toString('base64');
console.log(`Saved storage state to ${out}`);
console.log(b64);

await browser.close();
