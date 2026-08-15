import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ARTIFACTS = path.resolve('artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

const env = process.env;

function required(name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required input: ${name}`);
  return value;
}

function parseList(value) {
  return value
    .split(/\r?\n|,/)
    .map(s => s.trim())
    .filter(Boolean);
}

function normalizeText(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLocaleLowerCase('fa')
    .replace(/[\u200c\u200d]/g, '')
    .replace(/[ًٌٍَُِّْ]/g, '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/\s+/g, ' ')
    .trim();
}

function distance(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        cur[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

function keywordMatch(text, keywords) {
  const n = normalizeText(text);
  for (const raw of keywords) {
    const k = normalizeText(raw);
    if (!k) continue;
    if (n.includes(k)) return { matched: true, keyword: raw, mode: 'contains' };
    const words = n.split(/\s+/).filter(Boolean);
    const targetWords = k.split(/\s+/).filter(Boolean);
    if (targetWords.length === 1) {
      const max = Math.max(1, Math.floor(targetWords[0].length * 0.22));
      if (words.some(w => distance(w, targetWords[0]) <= max)) {
        return { matched: true, keyword: raw, mode: 'typo' };
      }
    }
  }
  return { matched: false };
}

async function safeClick(locator, timeout = 4000) {
  try {
    await locator.first().click({ timeout });
    return true;
  } catch { return false; }
}

async function clickText(page, patterns, timeout = 3500) {
  for (const p of patterns) {
    const exact = page.getByRole('button', { name: p, exact: true });
    if (await safeClick(exact, timeout)) return true;
    const text = page.getByText(p, { exact: true });
    if (await safeClick(text, timeout)) return true;
  }
  return false;
}

async function dismissCommonPopups(page) {
  const patterns = [
    'Not now', 'Not Now', 'Later', 'Cancel', 'Close', 'OK', 'Got it',
    'بعداً', 'اکنون نه', 'لغو', 'بستن', 'باشه'
  ];
  for (const p of patterns) {
    await clickText(page, [p], 800);
  }
}

async function handleMessageCategory(page) {
  const candidates = [
    'Primary', 'PRIMARY', 'General', 'GENERAL', 'اصلی', 'عمومی', 'Requests', 'درخواست‌ها'
  ];
  for (const p of candidates) {
    if (await clickText(page, [p], 1000)) return true;
  }
  return false;
}

async function loadSession() {
  if (env.INSTAGRAM_SESSION_B64?.trim()) {
    const json = Buffer.from(env.INSTAGRAM_SESSION_B64.trim(), 'base64').toString('utf8');
    return JSON.parse(json);
  }
  return null;
}

async function login(page, context) {
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
  await dismissCommonPopups(page);
  if (page.url().includes('/accounts/login')) {
    if (!env.INSTAGRAM_USERNAME || !env.INSTAGRAM_PASSWORD) {
      throw new Error('Instagram session is unavailable and username/password fallback is not configured.');
    }
    await page.getByLabel(/Phone number, username, or email/i).fill(env.INSTAGRAM_USERNAME);
    await page.getByLabel(/Password/i).fill(env.INSTAGRAM_PASSWORD);
    await clickText(page, ['Log in', 'ورود'], 8000);
    await page.waitForTimeout(3000);
    if (/challenge|two_factor|login/.test(page.url())) {
      throw new Error('Instagram requires interactive login/2FA. Refresh INSTAGRAM_SESSION_B64 using scripts/create-auth-state.mjs.');
    }
  }
  await context.storageState({ path: path.join(ARTIFACTS, 'session-after-run.json') });
}

async function findCommentRows(page) {
  const selectors = [
    'article',
    'div[role="dialog"] ul > li',
    'div[role="dialog"] li'
  ];
  const rows = [];
  for (const sel of selectors) {
    const loc = page.locator(sel);
    const count = await loc.count();
    for (let i = 0; i < count; i++) {
      const row = loc.nth(i);
      const text = await row.innerText().catch(() => '');
      if (!text || text.length < 2) continue;
      if (/(reply|reply to|پاسخ)/i.test(text)) rows.push(row);
    }
    if (rows.length) break;
  }
  return rows;
}

async function loadAllComments(page) {
  let stableRounds = 0;
  let lastCount = 0;
  while (stableRounds < 4) {
    const more = page.getByText(/View more comments|Load more comments|نمایش نظرهای بیشتر|نمایش دیدگاه‌های بیشتر/i).first();
    if (await more.isVisible().catch(() => false)) await more.click().catch(() => {});
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(900);
    const count = (await findCommentRows(page)).length;
    if (count <= lastCount) stableRounds += 1; else stableRounds = 0;
    lastCount = count;
  }
}

async function openComments(page) {
  await dismissCommonPopups(page);
  const candidates = [
    page.getByLabel(/comment/i),
    page.getByRole('button', { name: /comment/i }),
    page.locator('svg').filter({ has: page.locator('title') })
  ];
  for (const c of candidates) {
    if (await safeClick(c, 2500)) {
      await page.waitForTimeout(1200);
      return;
    }
  }
  const svgButton = page.locator('div[role="button"]').filter({ has: page.locator('svg') });
  if (await safeClick(svgButton.nth(1), 2500)) {
    await page.waitForTimeout(1200);
    return;
  }
  throw new Error('Comment control was not found.');
}

async function replyToComment(page, row, replyText) {
  const reply = row.getByText(/^(Reply|reply|پاسخ)$/).first();
  if (!(await safeClick(reply, 3000))) {
    const button = row.getByRole('button', { name: /reply|پاسخ/i }).first();
    if (!(await safeClick(button, 3000))) throw new Error('Reply control was not found for comment.');
  }
  const inputs = [
    page.getByPlaceholder(/Add a comment|Reply|نظر|پاسخ/i).last(),
    page.locator('textarea').last(),
    page.locator('[contenteditable="true"]').last()
  ];
  for (const input of inputs) {
    if (await input.isVisible().catch(() => false)) {
      await input.fill(replyText);
      const sent = await clickText(page, ['Post', 'Reply', 'Send', 'ارسال', 'پاسخ'], 3000);
      if (!sent) await input.press('Enter');
      await page.waitForTimeout(800);
      return;
    }
  }
  throw new Error('Reply input was not found.');
}

async function getAuthorProfile(page, row) {
  const links = row.locator('a[href^="/"]').filter({ hasText: /./ });
  const count = await links.count();
  for (let i = 0; i < count; i++) {
    const href = await links.nth(i).getAttribute('href');
    if (href && /^\/[^/]+\/?$/.test(href) && !/^(\/explore|\/reels|\/direct)/.test(href)) return href;
  }
  const href = await row.locator('a').first().getAttribute('href').catch(() => null);
  return href || null;
}

async function sendDmToProfile(page, profilePath, dmText) {
  const origin = new URL(page.url()).origin;
  await page.goto(new URL(profilePath, origin).href, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await dismissCommonPopups(page);
  let messageFound = await clickText(page, ['Message', 'Send message', 'پیام'], 3000);
  if (!messageFound) {
    const more = page.getByLabel(/More options|گزینه‌های بیشتر/i).first();
    if (!(await safeClick(more, 2500))) {
      const dots = page.locator('[role="button"]').filter({ has: page.locator('svg') });
      await safeClick(dots.last(), 2500);
    }
    await page.waitForTimeout(500);
    await clickText(page, ['Message', 'Send message', 'پیام'], 3000);
  }
  await handleMessageCategory(page);
  const inputs = [
    page.getByPlaceholder(/Message/i).last(),
    page.getByPlaceholder(/پیام/i).last(),
    page.locator('textarea').last(),
    page.locator('[contenteditable="true"]').last()
  ];
  for (const input of inputs) {
    if (await input.isVisible().catch(() => false)) {
      await input.fill(dmText);
      if (!(await clickText(page, ['Send', 'ارسال'], 2500))) await input.press('Enter');
      await page.waitForTimeout(800);
      return;
    }
  }
  throw new Error('Direct-message input was not found.');
}

async function processPost(page, url, keywords, commentReply, dmReply, runLog) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await openComments(page);
  await loadAllComments(page);
  const rows = await findCommentRows(page);
  const snapshot = [];
  for (let index = 0; index < rows.length; index++) {
    const currentRows = await findCommentRows(page);
    const row = currentRows[index];
    if (!row) continue;
    const text = await row.innerText().catch(() => '');
    if (!text) continue;
    const match = keywordMatch(text, keywords);
    if (!match.matched) continue;
    const authorPath = await getAuthorProfile(page, row);
    const item = { url, index, keyword: match.keyword, matchMode: match.mode, comment: text, authorPath, status: 'pending' };
    try {
      await replyToComment(page, row, commentReply);
      if (!authorPath) throw new Error('Comment author profile link was not found.');
      item.commentReply = 'sent';
      await sendDmToProfile(page, authorPath, dmReply);
      item.dm = 'sent';
      item.status = 'done';
    } catch (error) {
      item.status = 'error';
      item.error = String(error?.message || error);
      const shot = path.join(ARTIFACTS, `error-${Date.now()}-comment-${index}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      item.screenshot = shot;
    }
    snapshot.push(item);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await openComments(page);
    await loadAllComments(page);
  }
  runLog.posts.push({ url, commentCountScanned: rows.length, matches: snapshot.length, items: snapshot });
}

async function main() {
  const postUrls = parseList(required('INSTAGRAM_POST_URLS'));
  const keywords = parseList(required('INSTAGRAM_KEYWORDS'));
  const commentReply = required('INSTAGRAM_COMMENT_REPLY');
  const dmReply = required('INSTAGRAM_DM_REPLY');
  const session = await loadSession();
  const browser = await chromium.launch({ headless: env.INSTAGRAM_HEADLESS !== 'false' });
  const context = await browser.newContext({ storageState: session || undefined, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const runLog = { startedAt: new Date().toISOString(), posts: [], errors: [] };
  try {
    await login(page, context);
    for (const url of postUrls) {
      try {
        await processPost(page, url, keywords, commentReply, dmReply, runLog);
      } catch (error) {
        const name = `error-${Date.now()}-post.png`;
        await page.screenshot({ path: path.join(ARTIFACTS, name), fullPage: true }).catch(() => {});
        runLog.errors.push({ url, error: String(error?.message || error), screenshot: name });
      }
    }
  } finally {
    runLog.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(ARTIFACTS, 'run-summary.json'), JSON.stringify(runLog, null, 2), 'utf8');
    await browser.close();
  }
  if (runLog.errors.length || runLog.posts.some(p => p.items.some(i => i.status === 'error'))) process.exitCode = 1;
}

main().catch(error => {
  fs.writeFileSync(path.join(ARTIFACTS, 'fatal-error.json'), JSON.stringify({ error: String(error?.stack || error) }, null, 2));
  process.exitCode = 1;
});
