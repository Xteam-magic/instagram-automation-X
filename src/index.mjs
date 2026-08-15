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

async function dismissTransientOverlay(page) {
  if (!page || page.isClosed()) return;

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(250).catch(() => {});

  const closeCandidates = [
    page.getByRole('button', { name: /Close|Dismiss|Back|بستن|بازگشت/i }).first(),
    page.locator('button[aria-label*="Close"],button[aria-label*="بستن"],button[title*="Close"],button[title*="بستن"]').first()
  ];

  for (const candidate of closeCandidates) {
    if (await candidate.isVisible().catch(() => false)) {
      await safeClick(candidate, 700);
      await page.waitForTimeout(200).catch(() => {});
    }
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

function scoreCommentButtonCandidate(candidate, viewport) {
  const label = `${candidate.aria} ${candidate.title} ${candidate.text} ${candidate.label}`.trim();
  const normalized = normalizeText(label);

  const inActionRail =
    candidate.rect.left > viewport.width * 0.70 &&
    candidate.rect.top > 120 &&
    candidate.rect.top < viewport.height - 70;

  const rightSide = candidate.rect.left > viewport.width * 0.55;
  const smallIcon = candidate.rect.width <= 100 && candidate.rect.height <= 100;
  const explicitComment = /(^|\b)(comment|comments|نظر|دیدگاه|کامنت)(\b|$)/i.test(label);
  const commentCountLabel =
    /\b\d+\s*(comments?|نظر(ها)?|دیدگاه(ها)?|کامنت(?:ها)?)\b/i.test(label) ||
    /\bcomments?\b/i.test(normalized) ||
    /\bنظر(ها)?\b/i.test(normalized) ||
    /\bدیدگاه(ها)?\b/i.test(normalized);

  const strongExclude = /\b(message|send message|send|share|repost|forward|like|save|bookmark|follow|close|back|next|previous|menu|options|more options|open chat|direct|dm)\b/i.test(normalized);
  const weakExclude = /\b(profile|visit profile|view profile|open profile)\b/i.test(normalized);

  let score = 0;
  score += explicitComment ? 90 : 0;
  score += commentCountLabel ? 35 : 0;
  score += inActionRail ? 32 : 0;
  score += rightSide ? 12 : 0;
  score += smallIcon ? 12 : 0;
  score += candidate.svgCount > 0 ? 6 : 0;
  score += candidate.buttonLike ? 4 : 0;
  score += /^\d+$/.test(candidate.text) ? 4 : 0;
  score += candidate.text.length <= 4 && /[\p{P}\p{S}]/u.test(candidate.text) ? 3 : 0;
  score -= candidate.href ? 10 : 0;
  score -= strongExclude ? 60 : 0;
  score -= weakExclude ? 22 : 0;
  score -= candidate.rect.width > 220 || candidate.rect.height > 180 ? 20 : 0;
  score -= candidate.text.length > 40 ? 10 : 0;

  const strategy = explicitComment
    ? 'explicit-label'
    : commentCountLabel
      ? 'count-label'
      : inActionRail
        ? 'action-rail'
        : rightSide
          ? 'right-side'
          : 'heuristic';

  return { ...candidate, score, strategy, label };
}

async function inspectCommentButtonCandidates(page) {
  return page.evaluate(() => {
    const vw = innerWidth;
    const vh = innerHeight;
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
          normalizedLabel: normalize(label),
          normalizedText: normalize(text),
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

async function rankCommentButtonCandidates(page) {
  const viewport = page.viewportSize() || { width: 1440, height: 1000 };
  const candidates = await inspectCommentButtonCandidates(page);
  return candidates
    .map(candidate => scoreCommentButtonCandidate(candidate, viewport))
    .sort((a, b) => b.score - a.score || a.rect.top - b.rect.top || a.rect.left - b.rect.left);
}

async function findCommentButton(page) {
  const ranked = await rankCommentButtonCandidates(page);
  if (!ranked.length) return null;
  return ranked[0];
}

async function clickRealCommentButton(page) {
  const ranked = await rankCommentButtonCandidates(page);
  if (!ranked.length) throw new Error('REAL_COMMENT_ICON_NOT_FOUND');

  let sawAnyCandidate = false;

  for (const candidate of ranked.slice(0, 8)) {
    sawAnyCandidate = true;
    appendLog('COMMENT_BUTTON_ATTEMPT', {
      strategy: candidate.strategy,
      score: candidate.score,
      label: candidate.label,
      rect: candidate.rect
    });

    const locator = page.locator('button,[role="button"],a').nth(candidate.index);
    if (!(await locator.isVisible().catch(() => false))) {
      appendLog('COMMENT_BUTTON_SKIP_INVISIBLE', { strategy: candidate.strategy, score: candidate.score });
      continue;
    }

    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click({ timeout: CLICK_TIMEOUT_MS }).catch(async error => {
      appendLog('COMMENT_BUTTON_CLICK_FAILED', {
        strategy: candidate.strategy,
        score: candidate.score,
        error: String(error?.message || error)
      });
    });

    const verified = await waitForCommentRoot(page, Math.min(ROOT_TIMEOUT_MS, 6000));
    if (verified) {
      appendLog('COMMENT_UI_VERIFIED', {
        strategy: candidate.strategy,
        score: candidate.score,
        label: candidate.label
      });
      return candidate;
    }

    appendLog('COMMENT_BUTTON_VERIFY_FAILED', {
      strategy: candidate.strategy,
      score: candidate.score
    });

    await dismissTransientOverlay(page);
    await page.waitForTimeout(300);
  }

  if (!sawAnyCandidate) throw new Error('REAL_COMMENT_ICON_NOT_FOUND');
  throw new Error('COMMENT_UI_DID_NOT_OPEN');
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
      const messageCount = (text.match(/Message|Send message|پیام|ارسال پیام/gi) || []).length;
      const sendCount = (text.match(/\bSend\b|ارسال/gi) || []).length;

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
      score -= Math.min(25, messageCount * 6);
      score -= Math.min(15, sendCount * 2);
      if (textLen > 9000) score -= 18;
      if (textLen < 150) score -= 18;
      if (profileCount < 1) score -= 30;
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

async function waitForCommentRoot(page, timeoutMs = ROOT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const root = await getCommentRootDescriptor(page);
    if (
      root &&
      root.rowCount >= 1 &&
      (
        root.profileCount >= 2 ||
        root.timeCount >= 1 ||
        root.replyCount >= 1 ||
        root.moreCount >= 1 ||
        (root.profileCount >= 1 && root.scrollable)
      )
    ) {
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

    const compact = value => normalize(value).replace(/\s+/g, '');

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
      if (/^(view all \d+ replies|view hidden comments|load more comments|view more comments|view all comments)$/i.test(t)) return true;
      if (/^\d+([smhdw])$/i.test(t)) return true;
      if (/^\d+([,.]\d+)*$/.test(t)) return true;
      if (/^\d{1,2}:\d{2}$/.test(t)) return true;
      return false;
    };

    const commonCommentSignals = txt => {
      const n = normalize(txt);
      return (
        /\bReply\b|پاسخ/i.test(n) ||
        /\bLike\b|پسندیدن/i.test(n) ||
        /\bview all \d+ replies\b/i.test(n) ||
        /\bview hidden comments\b/i.test(n) ||
        /\bmore replies\b/i.test(n)
      );
    };

    const profileCountFor = el => Array.from(el.querySelectorAll('a[href^="/"]'))
      .filter(a => validProfileHref(a.getAttribute('href'))).length;

    const parseRow = (row, usernameHint = '', profilePathHint = '') => {
      const rowText = (row.innerText || '').trim();
      const lines = rowText.split(/\n+/).map(x => x.trim()).filter(Boolean);
      const usernameNorm = normalize(usernameHint);
      const profileNorm = normalize(profilePathHint.replace(/^\//, ''));

      const profileLinks = Array.from(row.querySelectorAll('a[href^="/"]'))
        .filter(a => validProfileHref(a.getAttribute('href')));
      const profileCount = profileLinks.length;
      const timeCount = row.querySelectorAll('time').length;

      let username = usernameHint || '';
      let started = !usernameNorm;
      const content = [];
      const rowControlText = normalize(rowText);

      for (const line of lines) {
        const n = normalize(line);
        if (!started) {
          if (n === usernameNorm || n === profileNorm) {
            started = true;
          }
          continue;
        }
        if (isNoiseLine(line)) continue;
        if (/^(reply|پاسخ|like|پسندیدن)$/i.test(n)) continue;
        if (!username && line.length <= 40 && !/\s/.test(line) && !/^[\d:./-]+$/.test(line)) {
          username = line;
          continue;
        }
        content.push(line);
      }

      if (!username) {
        const headerLine = lines.find(line => !isNoiseLine(line) && line.length <= 40 && !/\s/.test(line));
        if (headerLine) username = headerLine;
      }

      let commentText = content.join(' ').trim();
      if (!commentText) {
        const candidate = lines
          .filter(line => !isNoiseLine(line))
          .find(line => normalize(line) !== normalize(username));
        commentText = candidate || '';
      }

      commentText = commentText.replace(/^[:\-–—]+/, '').trim();
      return {
        username,
        time: row.querySelector('time')?.textContent?.trim() || '',
        rowText,
        commentText,
        lineCount: lines.length,
        profileCount,
        timeCount,
        hasReply: commonCommentSignals(rowControlText),
        hasTime: !!row.querySelector('time'),
        hasControl: !!row.querySelector('button,[role="button"]')
      };
    };

    const rows = [];
    const seen = new Set();

    const pushRow = (row, username, profilePath, source) => {
      const parsed = parseRow(row, username, profilePath);
      const cleanUsername = normalize(parsed.username);
      const cleanComment = normalize(parsed.commentText);
      const controlText = normalize(parsed.rowText);

      if (!cleanUsername || !cleanComment) return false;
      if (parsed.profileCount !== 1) return false;
      if (parsed.timeCount < 1) return false;
      if (parsed.lineCount < 2 || parsed.lineCount > 15) return false;
      if (parsed.rowText.length < 18 || parsed.rowText.length > 900) return false;
      if (/^(reply|پاسخ|like|پسندیدن|view all|view hidden comments|load more comments|view more comments)$/i.test(cleanComment)) return false;
      if (/these comments were hidden/i.test(controlText)) return false;
      const key = `${compact(profilePath)}|${compact(cleanUsername)}|${compact(cleanComment)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      rows.push({
        username: parsed.username,
        profilePath,
        commentText: parsed.commentText,
        time: parsed.time,
        rowText: parsed.rowText,
        lineCount: parsed.lineCount,
        profileCount: parsed.profileCount,
        timeCount: parsed.timeCount,
        key,
        source,
        hasReply: parsed.hasReply,
        hasTime: parsed.hasTime,
        hasControl: parsed.hasControl
      });
      return true;
    };

    // Pass 1: profile-link anchored extraction.
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
        if (!txt || txt.length > 900) continue;
        const ntext = normalize(txt);
        if (!ntext.includes(normalize(username))) continue;

        const profileCount = profileCountFor(node);
        const timeCount = node.querySelectorAll('time').length;
        if (profileCount !== 1 || timeCount < 1) continue;
        if (!commonCommentSignals(ntext) && !node.querySelector('time')) continue;

        row = node;
        break;
      }

      if (!row) continue;
      pushRow(row, username, profilePath, 'anchor');
    }

    if (rows.length >= 1) return rows;

    // Pass 2: structural fallback for desktop comments where links are not usable.
    const descendants = Array.from(rootEl.querySelectorAll('article, li, [role="article"], [data-testid], div'))
      .filter(el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        if (
          s.display === 'none' ||
          s.visibility === 'hidden' ||
          r.width <= 0 ||
          r.height <= 0 ||
          r.right <= 0 ||
          r.bottom <= 0 ||
          r.left >= innerWidth ||
          r.top >= innerHeight
        ) {
          return false;
        }

        const text = (el.innerText || '').trim();
        if (text.length < 12 || text.length > 900) return false;
        if (/^(reply|like|save|share|view all|view hidden comments|add a comment)$/i.test(normalize(text))) return false;

        const profileCount = profileCountFor(el);
        const timeCount = el.querySelectorAll('time').length;
        const lineCount = text.split(/\n+/).map(x => x.trim()).filter(Boolean).length;
        if (profileCount !== 1 || timeCount < 1 || lineCount < 2 || lineCount > 15) return false;

        return commonCommentSignals(text) || !!el.querySelector('time') || !!el.querySelector('a[href^="/"]');
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.height - br.height || ar.width - br.width;
      });

    for (const el of descendants) {
      const text = (el.innerText || '').trim();
      const lines = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
      if (!lines.length) continue;

      const profileLink = Array.from(el.querySelectorAll('a[href^="/"]')).find(a => validProfileHref(a.getAttribute('href')));
      const username = profileLink?.textContent?.trim() || lines.find(line => {
        const n = normalize(line);
        return !isNoiseLine(line) && line.length <= 40 && !/\s/.test(line) && !/^\d/.test(n);
      }) || '';

      const profilePath = profileLink?.getAttribute('href') || '';
      const parsed = parseRow(el, username, profilePath);
      if (!username || !parsed.commentText) continue;
      if (parsed.profileCount !== 1 || parsed.timeCount < 1 || parsed.lineCount < 2 || parsed.lineCount > 15) continue;
      if (normalize(parsed.commentText) === normalize(username)) continue;
      if (normalize(parsed.commentText) === normalize(profilePath)) continue;

      pushRow(el, username, profilePath, 'fallback');
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

      const profileCountFor = el => Array.from(el.querySelectorAll('a[href^="/"]'))
        .filter(a => validProfileHref(a.getAttribute('href'))).length;

      const isNoiseLine = line => {
        const t = normalize(line);
        if (!t) return true;
        if (/^(reply|like|likes?)$/i.test(t)) return true;
        if (/^(add a comment|view insights|boost post|send message|message|send|post|cancel|close|ok|got it)$/i.test(t)) return true;
        if (/^(view all \d+ replies|view hidden comments|load more comments|view more comments|view all comments)$/i.test(t)) return true;
        if (/^\d+([smhdw])$/i.test(t)) return true;
        if (/^\d+([,.]\d+)*$/.test(t)) return true;
        if (/^\d{1,2}:\d{2}$/.test(t)) return true;
        return false;
      };

      const targetUsername = normalize(targetComment.username);
      const targetCommentText = normalize(targetComment.commentText);
      const targetProfilePath = targetComment.profilePath || '';

      const scoreRow = row => {
        const txt = normalize(row.innerText || '');
        if (!txt || txt.length > 1200) return null;
        if (!txt.includes(targetUsername) || !txt.includes(targetCommentText)) return null;

        const profileLinks = Array.from(row.querySelectorAll('a[href^="/"]'))
          .filter(a => validProfileHref(a.getAttribute('href')));
        if (profileLinks.length !== 1) return null;

        const profileLink = profileLinks[0];
        if (targetProfilePath && (profileLink.getAttribute('href') || '') !== targetProfilePath) return null;

        const timeCount = row.querySelectorAll('time').length;
        const lineCount = (row.innerText || '').split(/\n+/).map(x => x.trim()).filter(Boolean).length;
        if (timeCount < 1 || lineCount < 2 || lineCount > 15) return null;

        const hasSignals = row.querySelector('time') || /\bReply\b|پاسخ/i.test(txt) || row.querySelector('button,[role="button"]');
        if (!hasSignals) return null;

        let score = 0;
        score += row.querySelector('time') ? 20 : 0;
        score += /\bReply\b|پاسخ/i.test(txt) ? 18 : 0;
        score += row.querySelector('button,[role="button"]') ? 10 : 0;
        score += Math.max(0, 60 - txt.length / 18);
        score -= isNoiseLine(txt) ? 30 : 0;
        return { row, score };
      };

      const candidates = [];

      const links = Array.from(rootEl.querySelectorAll('a[href^="/"]')).filter(a => validProfileHref(a.getAttribute('href')));
      for (const link of links) {
        if (normalize(link.textContent || '') !== targetUsername) continue;
        if (targetProfilePath && (link.getAttribute('href') || '') !== targetProfilePath) continue;

        let node = link;
        for (let level = 0; level < 10 && node && node !== rootEl; level++) {
          node = node.parentElement;
          if (!node) break;
          const txt = (node.innerText || '').trim();
          if (!txt || txt.length > 1200) continue;
          const ntext = normalize(txt);
          if (!ntext.includes(targetUsername) || !ntext.includes(targetCommentText)) continue;
          const scored = scoreRow(node);
          if (scored) {
            candidates.push(scored);
            break;
          }
        }
      }

      if (!candidates.length) {
        for (const el of Array.from(rootEl.querySelectorAll('article, li, [role="article"], [data-testid], div'))) {
          const scored = scoreRow(el);
          if (scored) candidates.push(scored);
        }
      }

      if (!candidates.length) return null;
      const best = candidates.sort((a, b) => b.score - a.score || (a.row.innerText || '').length - (b.row.innerText || '').length)[0].row;
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
  if (!row) throw new Error('COMMENT_ROW_NOT_FOUND_FOR_MATCH');

  await row.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(250);

  const replyTarget = await row.evaluate((rowEl) => {
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

    const isVisible = el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return (
        s.display !== 'none' &&
        s.visibility !== 'hidden' &&
        r.width > 0 &&
        r.height > 0 &&
        r.right > 0 &&
        r.bottom > 0 &&
        r.left < innerWidth &&
        r.top < innerHeight
      );
    };

    const textFor = el => `${el.innerText || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.trim();
    const isReplyLabel = el => {
      const t = normalize(textFor(el));
      return /^(reply|پاسخ)$/i.test(t) || /\breply\b/i.test(t) || /پاسخ/i.test(t);
    };

    const rowRect = rowEl.getBoundingClientRect();
    const collected = [];

    const scoreCandidate = (el, source) => {
      if (!isVisible(el) || !isReplyLabel(el)) return;
      const r = el.getBoundingClientRect();
      const text = normalize(textFor(el));
      let score = 0;
      score += /^(reply|پاسخ)$/i.test(text) ? 25 : 0;
      score += /button|role="button"/i.test(`${el.tagName} ${el.getAttribute('role') || ''}`) ? 10 : 0;
      score += Math.max(0, 180 - Math.abs((r.top + r.height / 2) - (rowRect.bottom + 18)));
      score += r.left < rowRect.left + 220 ? 18 : 0;
      score += source === 'descendant' ? 8 : 0;
      score += source === 'ancestor' ? 4 : 0;
      collected.push({
        el,
        score,
        text,
        source,
        rect: {
          left: r.left,
          top: r.top,
          width: r.width,
          height: r.height,
          centerX: r.left + r.width / 2,
          centerY: r.top + r.height / 2
        }
      });
    };

    let scope = rowEl;
    for (let depth = 0; depth < 5 && scope; depth++) {
      for (const el of Array.from(scope.querySelectorAll('button,[role="button"],a,span,div'))) {
        scoreCandidate(el, depth === 0 ? 'descendant' : 'ancestor');
      }
      scope = scope.parentElement;
    }

    if (!collected.length) {
      for (const el of Array.from(document.querySelectorAll('button,[role="button"],a,span,div'))) {
        if (!isVisible(el) || !isReplyLabel(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.bottom < rowRect.top - 40 || r.top > rowRect.bottom + 240) continue;
        scoreCandidate(el, 'global');
      }
    }

    if (!collected.length) return null;
    collected.sort((a, b) => b.score - a.score || a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const best = collected[0];
    best.el.setAttribute('data-ig-reply-target', '1');
    return {
      score: best.score,
      source: best.source,
      text: best.text,
      rect: best.rect
    };
  });

  if (!replyTarget) throw new Error('REPLY_BUTTON_NOT_FOUND');

  const replyLocator = page.locator('[data-ig-reply-target="1"]').last();
  await replyLocator.click({ timeout: CLICK_TIMEOUT_MS }).catch(async () => {
    await replyLocator.evaluate(el => el.click()).catch(() => {});
  });
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
