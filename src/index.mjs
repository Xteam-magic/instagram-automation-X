import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ARTIFACTS = path.resolve('artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

const env = process.env;
const MAX_SCAN_ROUNDS = Math.max(1, Number(env.INSTAGRAM_MAX_COMMENT_SCAN_ROUNDS || 160));
const SCROLL_STEP = Math.max(120, Number(env.INSTAGRAM_COMMENT_SCROLL_PIXELS || 520));
const SCROLL_WAIT = Math.max(100, Number(env.INSTAGRAM_COMMENT_SCROLL_WAIT_MS || 850));
const END_STABLE_ROUNDS = Math.max(1, Number(env.INSTAGRAM_COMMENT_END_STABLE_ROUNDS || 4));
const ROOT_TIMEOUT_MS = Math.max(3000, Number(env.INSTAGRAM_COMMENT_ROOT_TIMEOUT_MS || 12000));
const CLICK_TIMEOUT_MS = Math.max(1000, Number(env.INSTAGRAM_COMMENT_CLICK_TIMEOUT_MS || 8000));

function now() {
  return new Date().toISOString();
}

function required(name) {
  const v = env[name]?.trim();
  if (!v) throw new Error(`Missing required input: ${name}`);
  return v;
}

function parseList(v) {
  return String(v || '')
    .split(/\r?\n|,|،/)
    .map(x => x.trim())
    .filter(Boolean);
}

function parseBool(value, fallback = true) {
  if (value == null || String(value).trim() === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  return fallback;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('fa')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/ي/g, 'ی')
    .replace(/ى/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ۀە]/g, 'ه')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactText(value) {
  return normalizeText(value).replace(/\s+/g, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        cur[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }

  return prev[b.length];
}

function typoThreshold(term) {
  const n = normalizeText(term).length;
  if (n <= 3) return 0;
  if (n <= 5) return 1;
  if (n <= 8) return 2;
  if (n <= 12) return 3;
  return Math.max(3, Math.floor(n * 0.24));
}

function keywordMatch(text, keywords) {
  const normalized = normalizeText(text);
  const compact = compactText(text);
  const words = normalized.split(/\s+/).filter(Boolean);

  for (const raw of keywords) {
    const keyword = normalizeText(raw);
    if (!keyword) continue;

    const compactKeyword = compactText(keyword);

    if (normalized === keyword) {
      return { matched: true, keyword: raw, mode: 'exact', distance: 0 };
    }
    if (normalized.includes(keyword)) {
      return { matched: true, keyword: raw, mode: 'substring', distance: 0 };
    }
    if (compact.includes(compactKeyword)) {
      return { matched: true, keyword: raw, mode: 'compact', distance: 0 };
    }

    const targets = keyword.split(/\s+/).filter(Boolean);

    if (targets.length === 1) {
      const target = targets[0];
      const threshold = typoThreshold(target);
      if (threshold > 0) {
        for (const word of words) {
          const d = levenshtein(word, target);
          if (d <= threshold) {
            return { matched: true, keyword: raw, mode: 'typo', distance: d };
          }
          if (
            (word.includes(target) || target.includes(word)) &&
            Math.abs(word.length - target.length) <= threshold
          ) {
            return { matched: true, keyword: raw, mode: 'substring-typo', distance: Math.abs(word.length - target.length) };
          }
        }
      }
      continue;
    }

    for (let start = 0; start <= words.length - targets.length; start++) {
      let ok = true;
      let total = 0;
      for (let i = 0; i < targets.length; i++) {
        const word = words[start + i];
        const target = targets[i];
        if (!word) {
          ok = false;
          break;
        }
        if (word === target) continue;
        const d = levenshtein(word, target);
        if (d > typoThreshold(target)) {
          ok = false;
          break;
        }
        total += d;
      }
      if (ok) {
        return { matched: true, keyword: raw, mode: 'phrase-typo', distance: total };
      }
    }
  }

  return { matched: false };
}

function appendLog(message, data = {}) {
  const event = { time: now(), message, ...data };
  fs.appendFileSync(path.join(ARTIFACTS, 'automation.log'), JSON.stringify(event) + '\n', 'utf8');
  console.log(`[${event.time}] ${message}`, Object.keys(data).length ? data : '');
}

function writeJson(name, data) {
  fs.writeFileSync(path.join(ARTIFACTS, name), JSON.stringify(data, null, 2), 'utf8');
}

async function loadSession() {
  if (!env.INSTAGRAM_SESSION_B64?.trim()) return null;
  const raw = Buffer.from(env.INSTAGRAM_SESSION_B64.trim(), 'base64').toString('utf8');
  return JSON.parse(raw);
}

async function safeClick(locator, timeout = 3000) {
  try {
    await locator.first().click({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function dismissCommonPopups(page) {
  const texts = [
    'Not now', 'Not Now', 'Later', 'Cancel', 'Close', 'OK', 'Got it',
    'بعداً', 'اکنون نه', 'لغو', 'بستن', 'باشه'
  ];
  for (const text of texts) {
    await safeClick(page.getByText(text, { exact: true }), 600);
  }
}

async function login(page, context) {
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200);
  await dismissCommonPopups(page);

  if (page.url().includes('/accounts/login')) {
    if (!env.INSTAGRAM_USERNAME || !env.INSTAGRAM_PASSWORD) {
      throw new Error('Instagram session is unavailable. Provide INSTAGRAM_SESSION_B64 or username/password.');
    }

    await page.getByLabel(/Phone number, username, or email/i).fill(env.INSTAGRAM_USERNAME);
    await page.getByLabel(/Password/i).fill(env.INSTAGRAM_PASSWORD);
    await page.getByRole('button', { name: /Log in|ورود/i }).click({ timeout: 8000 });
    await page.waitForTimeout(4000);

    if (/challenge|two_factor|login/.test(page.url())) {
      throw new Error('Instagram requires interactive login/2FA.');
    }
  }

  await context.storageState({ path: path.join(ARTIFACTS, 'session-after-run.json') });
}

function validProfileHref(href) {
  const v = String(href || '');
  if (!/^\/[^/]+\/?$/.test(v)) return false;
  return !/^\/(explore|reels|reel|direct|accounts|stories|p|about|legal|privacy|help|api)\b/i.test(v);
}

async function inspectCommentButtonCandidates(page) {
  return page.evaluate(() => {
    const vw = innerWidth;
    const vh = innerHeight;
    return Array.from(document.querySelectorAll('button,[role="button"],a'))
      .map((el, index) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        const aria = el.getAttribute('aria-label') || '';
        const title = el.getAttribute('title') || '';
        const text = (el.innerText || '').trim().slice(0, 120);
        const label = `${aria} ${title} ${text}`.trim();

        if (
          s.display === 'none' ||
          s.visibility === 'hidden' ||
          r.width <= 0 ||
          r.height <= 0 ||
          r.left >= vw ||
          r.top >= vh ||
          r.right <= 0 ||
          r.bottom <= 0
        ) {
          return null;
        }

        const svgCount = el.querySelectorAll('svg').length;
        const buttonLike = el.matches('button,[role="button"],a');
        return {
          index,
          tag: el.tagName.toLowerCase(),
          href: el.getAttribute('href') || '',
          aria,
          title,
          text,
          label,
          svgCount,
          role: el.getAttribute('role') || '',
          rect: {
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height,
            centerX: r.left + r.width / 2,
            centerY: r.top + r.height / 2
          },
          buttonLike
        };
      })
      .filter(Boolean);
  });
}

async function findCommentButton(page) {
  const candidates = await inspectCommentButtonCandidates(page);
  if (!candidates.length) return null;

  const viewport = page.viewportSize() || { width: 1440, height: 1000 };
  const explicitMatch = candidates.find(c => {
    const label = `${c.aria} ${c.title} ${c.text} ${c.label}`;
    return /(^|\b)(comment|comments|نظر|دیدگاه|کامنت)(\b|$)/i.test(label);
  });
  if (explicitMatch) {
    return { ...explicitMatch, strategy: 'explicit-label' };
  }

  const bands = new Map();
  for (const c of candidates) {
    const inActionBarZone = c.rect.top > 180 && c.rect.top < viewport.height - 60;
    if (!inActionBarZone) continue;
    const bandKey = Math.round(c.rect.top / 26);
    const arr = bands.get(bandKey) || [];
    arr.push(c);
    bands.set(bandKey, arr);
  }

  const scoredBands = Array.from(bands.entries())
    .map(([bandKey, items]) => {
      const unique = items
        .sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top)
        .filter((item, index, array) => index === 0 || Math.abs(item.rect.left - array[index - 1].rect.left) > 4);

      const widthSum = unique.reduce((sum, c) => sum + c.rect.width, 0);
      const svgSum = unique.reduce((sum, c) => sum + c.svgCount, 0);
      const hrefPenalty = unique.reduce((sum, c) => sum + (c.href ? 1 : 0), 0);
      const buttonLikeCount = unique.filter(c => c.buttonLike).length;
      const tinyIconCount = unique.filter(c => c.rect.width <= 90 && c.rect.height <= 90).length;

      const score =
        unique.length * 18 +
        buttonLikeCount * 8 +
        svgSum * 5 +
        tinyIconCount * 6 -
        hrefPenalty * 10 -
        Math.max(0, Math.floor(widthSum / 250));

      return { bandKey, items: unique, score };
    })
    .filter(x => x.items.length >= 2)
    .sort((a, b) => b.score - a.score || a.bandKey - b.bandKey);

  if (scoredBands.length) {
    const bestBand = scoredBands[0];
    const ordered = bestBand.items.slice().sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top);
    const byHeuristic = ordered.find(c => {
      const label = `${c.aria} ${c.title} ${c.text} ${c.label}`;
      return /comment|comments|نظر|دیدگاه|کامنت/i.test(label);
    });
    if (byHeuristic) {
      return { ...byHeuristic, strategy: 'band-explicit' };
    }

    const preferredIndex = ordered.length >= 2 ? 1 : 0;
    const preferred = ordered[preferredIndex] || ordered[0];
    if (preferred) {
      return { ...preferred, strategy: ordered.length >= 2 ? 'band-second-button' : 'band-first-button' };
    }
  }

  let best = null;
  for (const c of candidates) {
    const label = `${c.aria} ${c.title} ${c.text} ${c.label}`;
    const looksLikeActionBar = c.rect.top > 200 && c.rect.top < viewport.height - 70 && c.rect.left > viewport.width * 0.25;
    const nearLikeBar = c.rect.width <= 90 && c.rect.height <= 90;
    const score = [
      /comment/i.test(c.aria) ? 40 : 0,
      /comment/i.test(c.title) ? 25 : 0,
      /comment/i.test(label) ? 20 : 0,
      c.svgCount > 0 ? 8 : 0,
      looksLikeActionBar ? 12 : 0,
      nearLikeBar ? 8 : 0,
      c.text.length <= 25 ? 5 : 0,
      /[^\w\s]/.test(c.text) && c.text.length <= 2 ? 2 : 0,
      c.href ? -12 : 0
    ].reduce((a, b) => a + b, 0);

    if (!best || score > best.score) {
      best = { ...c, score, strategy: 'heuristic' };
    }
  }

  if (!best || best.score < 22) return null;
  return best;
}

async function clickRealCommentButton(page) {
  const found = await findCommentButton(page);
  if (!found) throw new Error('REAL_COMMENT_ICON_NOT_FOUND');

  const handle = await page.evaluateHandle(({ index }) => {
    const nodes = Array.from(document.querySelectorAll('button,[role="button"],a'));
    return nodes[index] || null;
  }, { index: found.index });

  const button = handle.asElement();
  if (!button) throw new Error('REAL_COMMENT_ICON_NOT_FOUND');

  await button.scrollIntoViewIfNeeded().catch(() => {});
  await button.click({ timeout: CLICK_TIMEOUT_MS });
  await handle.dispose().catch(() => {});
  return found;
}

async function getCommentRootDescriptor(page) {
  return page.evaluate(() => {
    const validProfileHref = href => {
      const v = String(href || '');
      if (!/^\/[^/]+\/?$/.test(v)) return false;
      return !/^\/(explore|reels|reel|direct|accounts|stories|p|about|legal|privacy|help|api)\b/i.test(v);
    };

    const normalize = value => String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase('fa')
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/[ًٌٍَُِّْـ]/g, '')
      .replace(/ي/g, 'ی')
      .replace(/ى/g, 'ی')
      .replace(/ك/g, 'ک')
      .replace(/[ۀە]/g, 'ه')
      .replace(/[أإآ]/g, 'ا')
      .replace(/ؤ/g, 'و')
      .replace(/\s+/g, ' ')
      .trim();

    const scoreRoot = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (r.width < 220 || r.height < 140) return null;
      if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return null;

      const text = (el.innerText || '').trim();
      const profileLinks = Array.from(el.querySelectorAll('a[href^="/"]'))
        .filter(a => validProfileHref(a.getAttribute('href')));
      const profileCount = profileLinks.length;
      const timeCount = el.querySelectorAll('time').length;
      const replyCount = (text.match(/\bReply\b/gi) || []).length + (text.match(/پاسخ/g) || []).length;
      const addCommentCount = (text.match(/Add a comment/gi) || []).length + (text.match(/نظر خود را بنویسید|افزودن نظر/gi) || []).length;
      const moreCount = (text.match(/View more comments|Load more comments|View all \d+ comments|View all comments|نمایش نظرهای بیشتر|نمایش دیدگاه‌های بیشتر|مشاهده همه نظرات/gi) || []).length;

      let rowCount = 0;
      const seen = new Set();
      for (const link of profileLinks) {
        let node = link;
        for (let level = 0; level < 10 && node && node !== el; level++) {
          node = node.parentElement;
          if (!node) break;
          const t = normalize(node.innerText || '');
          if (!t || t.length > 900) continue;
          if (!t.includes(normalize(link.textContent || ''))) continue;
          if (!(node.querySelector('time') || /\bReply\b|پاسخ/i.test(t))) continue;
          const key = `${t.slice(0, 220)}|${normalize(link.textContent || '')}`;
          if (seen.has(key)) break;
          seen.add(key);
          rowCount++;
          break;
        }
      }

      const scrollable = /auto|scroll/i.test(s.overflowY) && el.scrollHeight > el.clientHeight + 80;
      const textLen = text.length;
      let score = 0;
      score += scrollable ? 30 : -10;
      score += Math.min(80, profileCount * 9);
      score += Math.min(35, timeCount * 10);
      score += Math.min(30, replyCount * 5);
      score += Math.min(80, rowCount * 18);
      score += Math.min(15, moreCount * 8);
      score -= Math.min(20, addCommentCount * 5);
      if (textLen > 9000) score -= 18;
      if (textLen < 150) score -= 18;
      if (profileCount < 2) score -= 30;
      if (rowCount < 1) score -= 40;
      if (!timeCount && !replyCount) score -= 16;

      if (score < 0) return null;
      return {
        score,
        profileCount,
        rowCount,
        timeCount,
        replyCount,
        addCommentCount,
        moreCount,
        scrollable,
        textLen,
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        tag: el.tagName.toLowerCase(),
        textPreview: text.slice(0, 180)
      };
    };

    const candidates = Array.from(document.querySelectorAll('body *'))
      .map(el => ({ el, info: scoreRoot(el) }))
      .filter(x => x.info && x.info.score >= 50)
      .sort((a, b) => b.info.score - a.info.score || b.info.rowCount - a.info.rowCount || b.info.profileCount - a.info.profileCount);

    if (!candidates.length) return null;

    const best = candidates[0];
    best.el.setAttribute('data-ig-comment-root', '1');
    return {
      index: candidates.findIndex(x => x.el === best.el),
      ...best.info
    };
  });
}

async function waitForCommentRoot(page) {
  const deadline = Date.now() + ROOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const root = await getCommentRootDescriptor(page);
    if (root && (root.rowCount >= 1 && (root.profileCount >= 2 || root.timeCount >= 1 || root.replyCount >= 1))) {
      return root;
    }
    await page.waitForTimeout(350);
  }
  return null;
}

async function markCommentRoot(page, descriptor) {
  // The descriptor is already marked inside getCommentRootDescriptor.
  return !!descriptor;
}

async function getRootLocator(page) {
  const locator = page.locator('[data-ig-comment-root="1"]').first();
  await locator.waitFor({ state: 'visible', timeout: 5000 });
  return locator;
}

async function extractVisibleComments(root) {
  return root.evaluate(rootEl => {
    const normalize = value => String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase('fa')
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/[ًٌٍَُِّْـ]/g, '')
      .replace(/ي/g, 'ی')
      .replace(/ى/g, 'ی')
      .replace(/ك/g, 'ک')
      .replace(/[ۀە]/g, 'ه')
      .replace(/[أإآ]/g, 'ا')
      .replace(/ؤ/g, 'و')
      .replace(/\s+/g, ' ')
      .trim();

    const validProfileHref = href => {
      const v = String(href || '');
      if (!/^\/[^/]+\/?$/.test(v)) return false;
      return !/^\/(explore|reels|reel|direct|accounts|stories|p|about|legal|privacy|help|api)\b/i.test(v);
    };

    const isNoiseLine = line => {
      const t = normalize(line);
      if (!t) return true;
      if (/^(reply|like|likes?)$/i.test(t)) return true;
      if (/^(add a comment|view insights|boost post|send message|message|send|post|cancel|close|ok|got it)$/i.test(t)) return true;
      if (/^\d+([smhdw])$/i.test(t)) return true;
      if (/^\d+([,.]\d+)*$/.test(t)) return true;
      if (/^\d{1,2}:\d{2}$/.test(t)) return true;
      return false;
    };

    const pickCommentText = (row, username, profilePath) => {
      const text = (row.innerText || '').trim();
      const lines = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
      const usernameNorm = normalize(username);
      const out = [];
      let seenUsername = false;
      for (const line of lines) {
        const n = normalize(line);
        if (!seenUsername && n === usernameNorm) {
          seenUsername = true;
          continue;
        }
        if (n === usernameNorm) continue;
        if (isNoiseLine(line)) continue;
        if (/^(reply|پاسخ|like|پسندیدن)$/i.test(n)) continue;
        out.push(line);
      }
      let commentText = out.join(' ').trim();
      if (!commentText) {
        const candidate = lines
          .filter(line => !isNoiseLine(line))
          .find(line => normalize(line) !== usernameNorm);
        commentText = candidate || '';
      }
      commentText = commentText
        .replace(/^[:\-–—]+/, '')
        .trim();
      if (commentText === username || normalize(commentText) === usernameNorm) return '';
      if (normalize(commentText) === normalize(profilePath)) return '';
      return commentText;
    };

    const rows = [];
    const seen = new Set();
    const links = Array.from(rootEl.querySelectorAll('a[href^="/"]')).filter(a => validProfileHref(a.getAttribute('href')));

    for (const link of links) {
      const username = (link.textContent || '').trim();
      if (!username) continue;
      const profilePath = link.getAttribute('href') || '';
      let node = link;
      let row = null;

      for (let level = 0; level < 10 && node && node !== rootEl; level++) {
        node = node.parentElement;
        if (!node) break;

        const txt = (node.innerText || '').trim();
        if (!txt || txt.length > 1200) continue;
        const ntext = normalize(txt);
        if (!ntext.includes(normalize(username))) continue;
        const hasSignals = node.querySelector('time') || /\bReply\b|پاسخ/i.test(ntext) || node.querySelector('button,[role="button"]');
        if (!hasSignals) continue;

        row = node;
        break;
      }

      if (!row) continue;

      const time = row.querySelector('time')?.textContent?.trim() || '';
      const commentText = pickCommentText(row, username, profilePath);
      const rowText = (row.innerText || '').trim();
      if (!commentText) continue;
      const key = `${compactText(profilePath)}|${compactText(username)}|${compactText(commentText)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      rows.push({
        username,
        profilePath,
        commentText,
        time,
        rowText,
        key,
        hasReply: /\bReply\b|پاسخ/i.test(normalize(rowText)),
        hasTime: !!row.querySelector('time'),
        hasControl: !!row.querySelector('button,[role="button"]')
      });
    }

    return rows;
  });
}

async function clickMoreComments(root) {
  return root.evaluate(rootEl => {
    const texts = [
      /^(View more comments|Load more comments|View all \d+ comments|View all comments|نمایش نظرهای بیشتر|نمایش دیدگاه‌های بیشتر|مشاهده همه نظرات)$/i,
      /^(More comments|Show more comments|Load more)$/i
    ];
    const els = Array.from(rootEl.querySelectorAll('button,[role="button"],a'));
    for (const el of els) {
      const text = `${el.innerText || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.trim();
      if (texts.some(rx => rx.test(text))) {
        (el).click();
        return true;
      }
    }
    return false;
  }).catch(() => false);
}

async function scrollRoot(root, amount) {
  return root.evaluate((el, step) => {
    const before = el.scrollTop;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.min(max, before + step);
    return {
      before,
      after: el.scrollTop,
      max,
      atBottom: el.scrollTop >= max - 2,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight
    };
  }, amount);
}

async function scanCommentList(page, root, postLog) {
  const map = new Map();
  let stable = 0;
  let lastSig = '';

  for (let round = 1; round <= MAX_SCAN_ROUNDS; round++) {
    const clickedMore = await clickMoreComments(root);
    if (clickedMore) await page.waitForTimeout(500);

    const visible = await extractVisibleComments(root);
    let added = 0;
    for (const comment of visible) {
      if (!map.has(comment.key)) {
        map.set(comment.key, comment);
        added++;
      }
    }

    const scroll = await scrollRoot(root, SCROLL_STEP);
    await page.waitForTimeout(SCROLL_WAIT);

    const sig = JSON.stringify({ count: map.size, after: scroll.after, max: scroll.max, height: scroll.scrollHeight, added, clickedMore });
    if (scroll.atBottom && added === 0 && !clickedMore && sig === lastSig) stable++; else stable = 0;
    lastSig = sig;

    postLog.commentsScanned = map.size;
    postLog.scanRounds = round;

    if (round === 1 || added > 0 || clickedMore || round % 5 === 0) {
      appendLog('COMMENT_SCAN_ROUND', {
        round,
        url: postLog.url,
        visible: visible.length,
        totalUnique: map.size,
        added,
        clickedMore,
        scrollTop: scroll.after,
        maxScrollTop: scroll.max,
        scrollHeight: scroll.scrollHeight
      });
    }

    if (stable >= END_STABLE_ROUNDS) {
      appendLog('COMMENT_SCAN_END_REACHED', {
        url: postLog.url,
        round,
        totalUnique: map.size,
        scrollTop: scroll.after,
        maxScrollTop: scroll.max,
        scrollHeight: scroll.scrollHeight
      });
      break;
    }
  }

  return Array.from(map.values());
}

async function saveCommentsScreenshot(root, postLog) {
  const screenshotPath = path.join(ARTIFACTS, 'comments-list.png');
  await root.screenshot({ path: screenshotPath });
  postLog.screenshot = screenshotPath;
  appendLog('COMMENTS_SCREENSHOT_SAVED', { url: postLog.url, screenshot: screenshotPath });
}

async function saveFailureScreenshot(page, postLog, stage, error) {
  const safeStage = String(stage || 'error')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'error';

  const screenshotPath = path.join(
    ARTIFACTS,
    `last-stop-post-${String(postLog.postIndex || 0).padStart(2, '0')}-${safeStage}.png`
  );

  try {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: screenshotPath, fullPage: false });
      postLog.failureScreenshot = screenshotPath;
      postLog.failureStage = stage;
      postLog.failureError = String(error?.message || error);
      appendLog('FAILURE_SCREENSHOT_SAVED', {
        url: postLog.url,
        postIndex: postLog.postIndex,
        stage,
        screenshot: screenshotPath,
        error: String(error?.message || error)
      });
      return screenshotPath;
    }
  } catch (screenshotError) {
    appendLog('FAILURE_SCREENSHOT_FAILED', {
      url: postLog.url,
      postIndex: postLog.postIndex,
      stage,
      error: String(screenshotError?.message || screenshotError)
    });
  }

  return null;
}

async function findCommentRow(root, target, page) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const handle = await root.evaluateHandle((rootEl, targetComment) => {
      const normalize = value => String(value || '')
        .normalize('NFKC')
        .toLocaleLowerCase('fa')
        .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
        .replace(/[ًٌٍَُِّْـ]/g, '')
        .replace(/ي/g, 'ی')
        .replace(/ى/g, 'ی')
        .replace(/ك/g, 'ک')
        .replace(/[ۀە]/g, 'ه')
        .replace(/[أإآ]/g, 'ا')
        .replace(/ؤ/g, 'و')
        .replace(/\s+/g, ' ')
        .trim();

      const validProfileHref = href => {
        const v = String(href || '');
        if (!/^\/[^/]+\/?$/.test(v)) return false;
        return !/^\/(explore|reels|reel|direct|accounts|stories|p|about|legal|privacy|help|api)\b/i.test(v);
      };

      const targetUsername = normalize(targetComment.username);
      const targetCommentText = normalize(targetComment.commentText);
      const targetProfilePath = targetComment.profilePath || '';

      const links = Array.from(rootEl.querySelectorAll('a[href^="/"]')).filter(a => validProfileHref(a.getAttribute('href')));
      const candidates = [];

      for (const link of links) {
        if (normalize(link.textContent || '') !== targetUsername) continue;
        if (targetProfilePath && (link.getAttribute('href') || '') !== targetProfilePath) continue;

        let node = link;
        for (let level = 0; level < 10 && node && node !== rootEl; level++) {
          node = node.parentElement;
          if (!node) break;
          const txt = normalize(node.innerText || '');
          if (!txt.includes(targetUsername)) continue;
          if (!txt.includes(targetCommentText)) continue;
          if (!node.querySelector('time') && !/\bReply\b|پاسخ/i.test(txt)) continue;
          candidates.push(node);
          break;
        }
      }

      if (!candidates.length) return null;
      const best = candidates.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
      best.setAttribute('data-ig-target-row', '1');
      return best;
    }, target);

    const row = handle.asElement();
    if (row) return row;
    await page.waitForTimeout(350);
  }

  throw new Error('COMMENT_ROW_NOT_FOUND_FOR_MATCH');
}

async function sendReply(page, row, replyText) {
  const clicked = await row.evaluate(node => {
    const controls = Array.from(node.querySelectorAll('button,[role="button"],span,div'));
    const reply = controls.find(el => {
      const t = `${el.innerText || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.trim();
      return /^(reply|پاسخ)$/i.test(t) || /\breply\b/i.test(t) || /پاسخ/i.test(t);
    });
    if (!reply) return false;
    reply.click();
    return true;
  });

  if (!clicked) throw new Error('REPLY_BUTTON_NOT_FOUND');

  await page.waitForTimeout(500);

  const inputs = [
    page.getByPlaceholder(/Reply|Add a comment|پاسخ|نظر/i).last(),
    page.locator('textarea').last(),
    page.locator('[contenteditable="true"]').last()
  ];

  let input = null;
  for (const candidate of inputs) {
    if (await candidate.isVisible().catch(() => false)) {
      input = candidate;
      break;
    }
  }

  if (!input) throw new Error('REPLY_INPUT_NOT_FOUND');

  if (await input.fill(replyText).catch(() => false) === false) {
    await input.click();
    await input.pressSequentially(replyText);
  }

  const sendButton = page.getByRole('button', { name: /Send|Post|ارسال|پست/i }).last();
  if (!(await safeClick(sendButton, 2500))) {
    await input.press('Enter');
  }

  await page.waitForTimeout(900);

  const stillThere = await input.inputValue().catch(() => '');
  if (String(stillThere).trim()) {
    await input.press('Enter');
    await page.waitForTimeout(700);
  }

  const normalizedReply = normalizeText(replyText);
  const verified = await page.waitForFunction(
    ({ selector, normalizedReplyText }) => {
      const normalize = value => String(value || '')
        .normalize('NFKC')
        .toLocaleLowerCase('fa')
        .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
        .replace(/[ًٌٍَُِّْـ]/g, '')
        .replace(/ي/g, 'ی')
        .replace(/ى/g, 'ی')
        .replace(/ك/g, 'ک')
        .replace(/[ۀە]/g, 'ه')
        .replace(/[أإآ]/g, 'ا')
        .replace(/ؤ/g, 'و')
        .replace(/\s+/g, ' ')
        .trim();
      const node = document.querySelector(selector);
      if (!node) return false;
      const text = normalize(node.innerText || '');
      const inputs = Array.from(node.querySelectorAll('textarea,[contenteditable="true"]'));
      const inputCleared = inputs.every(el => !(String(el.value || el.textContent || '').trim()));
      return text.includes(normalizedReplyText) || inputCleared;
    },
    { selector: '[data-ig-target-row="1"]', normalizedReplyText: normalizedReply },
    { timeout: 6000 }
  ).then(() => true).catch(() => false);

  if (!verified) {
    throw new Error('REPLY_NOT_CONFIRMED');
  }
}

async function sendDM(dmPage, profilePath, username, message) {
  const origin = new URL(dmPage.url()).origin;
  await dmPage.goto(new URL(profilePath, origin).href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await dmPage.waitForTimeout(1000);
  await dismissCommonPopups(dmPage);

  let opened = await safeClick(dmPage.getByRole('button', { name: /Message|Send message|پیام/i }).first(), 3500);
  if (!opened) {
    const more = dmPage.getByLabel(/More options|گزینه‌های بیشتر/i).first();
    if (await more.isVisible().catch(() => false)) {
      await safeClick(more, 2000);
      await dmPage.waitForTimeout(400);
      opened = await safeClick(dmPage.getByText(/Message|Send message|پیام/i).first(), 3000);
    }
  }

  if (!opened) throw new Error(`MESSAGE_BUTTON_NOT_FOUND:${username}`);
  await dmPage.waitForTimeout(700);

  const inputs = [
    dmPage.getByPlaceholder(/Message/i).last(),
    dmPage.getByPlaceholder(/پیام/i).last(),
    dmPage.locator('textarea').last(),
    dmPage.locator('[contenteditable="true"]').last()
  ];

  let input = null;
  for (const candidate of inputs) {
    if (await candidate.isVisible().catch(() => false)) {
      input = candidate;
      break;
    }
  }

  if (!input) throw new Error(`DM_INPUT_NOT_FOUND:${username}`);

  if (await input.fill(message).catch(() => false) === false) {
    await input.click();
    await input.pressSequentially(message);
  }

  const button = dmPage.getByRole('button', { name: /Send|ارسال/i }).last();
  if (!(await safeClick(button, 2500))) {
    await input.press('Enter');
  }

  await dmPage.waitForTimeout(900);

  let value = await input.inputValue().catch(() => '');
  if (String(value).trim()) {
    await input.press('Enter');
    await dmPage.waitForTimeout(800);
    value = await input.inputValue().catch(() => '');
  }

  const messageText = normalizeText(message);
  const verified = await dmPage.waitForFunction(
    ({ normalizedMessage }) => {
      const normalize = value => String(value || '')
        .normalize('NFKC')
        .toLocaleLowerCase('fa')
        .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
        .replace(/[ًٌٍَُِّْـ]/g, '')
        .replace(/ي/g, 'ی')
        .replace(/ى/g, 'ی')
        .replace(/ك/g, 'ک')
        .replace(/[ۀە]/g, 'ه')
        .replace(/[أإآ]/g, 'ا')
        .replace(/ؤ/g, 'و')
        .replace(/\s+/g, ' ')
        .trim();
      const text = normalize(document.body.innerText || '');
      const inputCleared = !Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).some(el => String(el.value || el.textContent || '').trim());
      return text.includes(normalizedMessage) || inputCleared;
    },
    { normalizedMessage: messageText },
    { timeout: 6000 }
  ).then(() => true).catch(() => false);

  if (!verified) throw new Error(`DM_NOT_CONFIRMED:${username}`);
}

async function processPost(page, dmPage, url, keywords, commentReply, dmReply, postIndex) {
  const postLog = {
    postIndex,
    url,
    startedAt: now(),
    screenshot: null,
    failureScreenshot: null,
    failureStage: null,
    failureError: null,
    commentClickStrategy: null,
    commentsScanned: 0,
    matchesFound: 0,
    matchesCompleted: 0,
    matchesFailed: 0,
    matchItems: [],
    scanRounds: 0
  };

  appendLog('OPEN_POST', { url, postIndex });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    await dismissCommonPopups(page);

    const clickInfo = await clickRealCommentButton(page);
    postLog.commentClickStrategy = clickInfo.strategy;
    appendLog('COMMENT_BUTTON_FOUND', { url, strategy: clickInfo.strategy });
    appendLog('COMMENT_BUTTON_CLICKED', { url, strategy: clickInfo.strategy });

    const descriptor = await waitForCommentRoot(page);
    if (!descriptor) throw new Error('COMMENT_UI_DID_NOT_OPEN');
    if (!descriptor.rowCount || descriptor.rowCount < 1) throw new Error('COMMENT_ROOT_NOT_FOUND');

    await markCommentRoot(page, descriptor);
    const root = await getRootLocator(page);

    await saveCommentsScreenshot(root, postLog);

    const comments = await scanCommentList(page, root, postLog);
    if (!comments.length) {
      throw new Error('REAL_COMMENT_LIST_OPENED_BUT_ZERO_COMMENTS_FOUND');
    }

    appendLog('COMMENT_SCAN_COMPLETE', { url, commentsScanned: comments.length, scanRounds: postLog.scanRounds });

    const processed = new Set();
    const matches = [];

    for (const comment of comments) {
      const match = keywordMatch(comment.commentText, keywords);
      if (!match.matched) continue;
      const key = `${comment.profilePath}|${compactText(comment.commentText)}|${match.keyword}`;
      if (processed.has(key)) continue;
      processed.add(key);
      matches.push({ comment, match });
    }

    postLog.matchesFound = matches.length;
    appendLog('MATCH_FOUND', { url, matchesFound: matches.length });

    for (const { comment, match } of matches) {
      const item = {
        username: comment.username,
        profile: comment.profilePath,
        comment: comment.commentText,
        keyword: match.keyword,
        mode: match.mode,
        distance: match.distance,
        reply: 'pending',
        dm: 'pending',
        status: 'pending'
      };

      appendLog('MATCH_FOUND', { url, username: comment.username, keyword: match.keyword, matchMode: match.mode, distance: match.distance });

      try {
        const row = await findCommentRow(root, comment, page);
        await sendReply(page, row, commentReply);
        item.reply = 'sent';
        appendLog('REPLY_SENT', { url, username: comment.username, keyword: match.keyword });

        await sendDM(dmPage, comment.profilePath, comment.username, dmReply);
        item.dm = 'sent';
        item.status = 'done';
        postLog.matchesCompleted++;
        appendLog('DM_SENT', { url, username: comment.username });
        appendLog('MATCH_COMPLETED', { url, username: comment.username, keyword: match.keyword });
      } catch (error) {
        item.status = 'error';
        item.error = String(error?.message || error);
        postLog.matchesFailed++;
        appendLog('MATCH_FAILED', { url, username: comment.username, comment: comment.commentText, error: item.error });
      }

      postLog.matchItems.push(item);
    }

    postLog.commentsScanned = comments.length;
    postLog.finishedAt = now();
    appendLog('POST_FINISHED', {
      url,
      commentsScanned: postLog.commentsScanned,
      matchesFound: postLog.matchesFound,
      matchesCompleted: postLog.matchesCompleted,
      matchesFailed: postLog.matchesFailed,
      screenshot: postLog.screenshot,
      failureScreenshot: postLog.failureScreenshot
    });

    return postLog;
  } catch (error) {
    postLog.finishedAt = now();
    postLog.failureError = String(error?.message || error);
    const stage = postLog.screenshot ? 'after-comments-screenshot' : 'post-error';
    await saveFailureScreenshot(page, postLog, stage, error);
    appendLog('POST_ERROR', {
      url,
      error: String(error?.message || error),
      failureScreenshot: postLog.failureScreenshot,
      failureStage: postLog.failureStage
    });
    throw error;
  }
}

async function main() {
  const postUrls = parseList(required('INSTAGRAM_POST_URLS'));
  const keywords = parseList(required('INSTAGRAM_KEYWORDS'));
  const commentReply = required('INSTAGRAM_COMMENT_REPLY');
  const dmReply = required('INSTAGRAM_DM_REPLY');
  const headless = parseBool(env.INSTAGRAM_HEADLESS, true);

  fs.writeFileSync(path.join(ARTIFACTS, 'automation.log'), '', 'utf8');

  const session = await loadSession();
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    storageState: session || undefined,
    viewport: { width: 1440, height: 1000 }
  });

  const page = await context.newPage();
  const dmPage = await context.newPage();

  const runLog = {
    startedAt: now(),
    finishedAt: null,
    keywords,
    postUrls,
    config: {
      engine: 'Instagram Web Desktop',
      headless,
      maxScanRounds: MAX_SCAN_ROUNDS,
      scrollStep: SCROLL_STEP,
      scrollWait: SCROLL_WAIT,
      endStableRounds: END_STABLE_ROUNDS
    },
    posts: [],
    errors: [],
    commentsScanned: 0,
    matchesFound: 0,
    matchesCompleted: 0,
    matchesFailed: 0
  };

  try {
    await login(page, context);
    appendLog('LOGIN_SUCCESS', {});

    for (let i = 0; i < postUrls.length; i++) {
      try {
        const postLog = await processPost(page, dmPage, postUrls[i], keywords, commentReply, dmReply, i + 1);
        runLog.posts.push(postLog);
        runLog.commentsScanned += postLog.commentsScanned;
        runLog.matchesFound += postLog.matchesFound;
        runLog.matchesCompleted += postLog.matchesCompleted;
        runLog.matchesFailed += postLog.matchesFailed;
      } catch (error) {
        const message = String(error?.message || error);
        runLog.errors.push({ url: postUrls[i], error: message });
        appendLog('POST_ERROR', { url: postUrls[i], error: message });
      }
    }
  } finally {
    runLog.finishedAt = now();
    writeJson('run-summary.json', runLog);
    await context.storageState({ path: path.join(ARTIFACTS, 'session-after-run.json') }).catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch(error => {
  appendLog('FATAL_ERROR', { error: String(error?.message || error) });
  writeJson('run-summary.json', {
    startedAt: now(),
    finishedAt: now(),
    error: String(error?.message || error)
  });
  process.exitCode = 1;
});
