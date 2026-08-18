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

async function dismissSaveModalIfPresent(page) {
  if (!page || page.isClosed()) return false;

  // Instagram can open a "Save" sheet immediately after the comment action.
  // It is a blocking UI layer, not the comments panel. Close ONLY that sheet
  // through its own X control so the rest of the existing comment/DM flow is
  // untouched.
  const saveText = page.getByText(/to save|save (this|the) post|save .*post|easy to find later/i).first();
  if (!(await saveText.isVisible().catch(() => false))) return false;

  const info = await page.evaluate(() => {
    const visible = el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return (
        s.display !== 'none' &&
        s.visibility !== 'hidden' &&
        s.opacity !== '0' &&
        r.width > 0 &&
        r.height > 0 &&
        r.right > 0 &&
        r.bottom > 0 &&
        r.left < innerWidth &&
        r.top < innerHeight
      );
    };

    const textNodes = Array.from(document.querySelectorAll('div,span,p')).filter(visible).filter(el => {
      const text = (el.innerText || '').trim();
      return /to save|save (this|the) post|save .*post|easy to find later/i.test(text);
    });

    let sheet = null;
    let bestArea = Infinity;
    for (const node of textNodes) {
      let current = node;
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        const r = current.getBoundingClientRect();
        const s = getComputedStyle(current);
        if (!visible(current)) continue;
        if (!/fixed|absolute|sticky/.test(s.position)) continue;
        if (r.width < 220 || r.height < 140) continue;
        const area = r.width * r.height;
        if (area < bestArea) {
          bestArea = area;
          sheet = current;
        }
      }
    }

    if (!sheet) return null;

    const sr = sheet.getBoundingClientRect();
    const controls = Array.from(sheet.querySelectorAll('button,[role="button"],a')).filter(visible);
    let best = null;

    for (const el of controls) {
      const r = el.getBoundingClientRect();
      if (r.width > 90 || r.height > 90) continue;

      const aria = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const text = (el.innerText || '').trim();
      const label = `${aria} ${title} ${text}`.trim();
      const isClose = /close|dismiss|cancel|بستن|لغو/i.test(label) || /^[×✕✖✗x]$/i.test(text);
      if (!isClose) continue;

      const nearTop = Math.abs(r.top - sr.top) <= 90;
      const nearRight = Math.abs((r.left + r.width) - sr.right) <= 90;
      if (!nearTop || !nearRight) continue;

      const token = `ig-save-modal-close-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      el.setAttribute('data-ig-save-modal-close', token);
      best = { token };
      break;
    }

    return best;
  }).catch(() => null);

  if (!info?.token) return false;

  const closeButton = page.locator(
    `[data-ig-save-modal-close="${String(info.token).replace(/"/g, '\\"')}"]`
  ).first();

  if (!(await closeButton.isVisible().catch(() => false))) return false;

  const closed = await safeClick(closeButton, 1500);
  if (closed) {
    await page.waitForTimeout(300).catch(() => {});
  }
  return closed;
}

async function dismissTransientOverlay(page) {
  if (!page || page.isClosed()) return false;

  let closed = false;

  // First try the browser-level Escape action. This is the least invasive
  // way to dismiss a transient sheet/dialog when Instagram supports it.
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(180).catch(() => {});

  const semanticCloseCandidates = [
    page.getByRole('button', { name: /Close|Dismiss|Cancel|بستن|لغو/i }).first(),
    page.locator(
      'button[aria-label*="Close" i],button[aria-label*="Dismiss" i],button[aria-label*="Cancel" i],button[aria-label*="بستن" i],button[aria-label*="لغو" i],button[title*="Close" i],button[title*="Dismiss" i],button[title*="Cancel" i],button[title*="بستن" i],button[title*="لغو" i]'
    ).first()
  ];

  for (const candidate of semanticCloseCandidates) {
    if (await candidate.isVisible().catch(() => false)) {
      if (await safeClick(candidate, 900)) {
        closed = true;
        await page.waitForTimeout(220).catch(() => {});
        break;
      }
    }
  }

  if (closed) return true;

  // Instagram sometimes renders a blocking sheet without a usable aria-label.
  // In that case the only reliable affordance is the small X at the sheet's
  // upper-right corner. Limit this heuristic to dialog/modal-like containers
  // so we never click an unrelated icon in the post action rail.
  const closeInfo = await page.evaluate(() => {
    const visible = el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return (
        s.display !== 'none' &&
        s.visibility !== 'hidden' &&
        s.opacity !== '0' &&
        r.width > 0 &&
        r.height > 0 &&
        r.right > 0 &&
        r.bottom > 0 &&
        r.left < innerWidth &&
        r.top < innerHeight
      );
    };

    const overlays = Array.from(document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], body > div, body > div > div'
    )).filter(visible).filter(el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const positionLikeModal = /fixed|absolute|sticky/.test(s.position);
      const largeEnough = r.width >= 220 && r.height >= 140;
      const z = Number.parseInt(s.zIndex || '0', 10);
      return largeEnough && positionLikeModal && (z >= 10 || el.matches('[role="dialog"],[aria-modal="true"]'));
    });

    let best = null;

    for (const overlay of overlays) {
      const or = overlay.getBoundingClientRect();
      const buttons = Array.from(overlay.querySelectorAll(
        'button,[role="button"],a'
      )).filter(visible);

      for (const el of buttons) {
        const r = el.getBoundingClientRect();
        if (r.width > 90 || r.height > 90) continue;

        const aria = el.getAttribute('aria-label') || '';
        const title = el.getAttribute('title') || '';
        const text = (el.innerText || '').trim();
        const label = `${aria} ${title} ${text}`.trim();
        const explicitClose = /close|dismiss|cancel|بستن|لغو/i.test(label);
        const xGlyph = /^[×✕✖✗x]$/i.test(text);
        const nearTop = Math.abs(r.top - or.top) <= 85;
        const nearRight = Math.abs((r.left + r.width) - or.right) <= 85;

        let score = 0;
        score += explicitClose ? 1000 : 0;
        score += xGlyph ? 950 : 0;
        score += nearTop ? 180 : 0;
        score += nearRight ? 220 : 0;
        score += el.querySelectorAll('svg').length ? 50 : 0;
        score += Math.max(0, 90 - r.width) + Math.max(0, 90 - r.height);

        if (!best || score > best.score) {
          const token = `ig-overlay-close-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          el.setAttribute('data-ig-overlay-close', token);
          best = { token, score };
        }
      }
    }

    return best;
  }).catch(() => null);

  if (closeInfo?.token) {
    const selector = `[data-ig-overlay-close="${String(closeInfo.token).replace(/"/g, '\\"')}"]`;
    const closeButton = page.locator(selector).first();
    if (await closeButton.isVisible().catch(() => false)) {
      closed = await safeClick(closeButton, 1200);
      if (closed) {
        await page.waitForTimeout(250).catch(() => {});
      }
    }
  }

  return closed;
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
  // A blocking sheet can already be open when the post is reached. Close it
  // before ranking the action rail so its buttons cannot intercept the click.
  await dismissTransientOverlay(page);

  let sawAnyCandidate = false;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const ranked = await rankCommentButtonCandidates(page);
    if (!ranked.length) break;

    const candidate = ranked[Math.min(attempt, ranked.length - 1)];
    sawAnyCandidate = true;

    appendLog('COMMENT_BUTTON_ATTEMPT', {
      strategy: candidate.strategy,
      score: candidate.score,
      label: candidate.label,
      rect: candidate.rect,
      attempt: attempt + 1
    });

    const locator = page.locator('button,[role="button"],a').nth(candidate.index);
    if (!(await locator.isVisible().catch(() => false))) {
      appendLog('COMMENT_BUTTON_SKIP_INVISIBLE', {
        strategy: candidate.strategy,
        score: candidate.score,
        attempt: attempt + 1
      });
      continue;
    }

    await locator.scrollIntoViewIfNeeded().catch(() => {});

    let clicked = false;
    try {
      await locator.click({ timeout: CLICK_TIMEOUT_MS });
      clicked = true;
    } catch (error) {
      appendLog('COMMENT_BUTTON_CLICK_FAILED', {
        strategy: candidate.strategy,
        score: candidate.score,
        attempt: attempt + 1,
        error: String(error?.message || error)
      });
    }

    // CRITICAL: never treat an existing/incorrect DOM subtree as proof that
    // the click worked. The previous version did exactly that after a
    // pointer-interception timeout and then selected a profile/overlay as the
    // "comment root".
    if (!clicked) {
      const closed = await dismissTransientOverlay(page);
      appendLog('COMMENT_BUTTON_BLOCKING_OVERLAY_HANDLED', {
        strategy: candidate.strategy,
        score: candidate.score,
        closed,
        attempt: attempt + 1
      });
      await page.waitForTimeout(300);
      continue;
    }

    await dismissSaveModalIfPresent(page);

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
      score: candidate.score,
      attempt: attempt + 1
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
      const desktopPanelLike = innerWidth < 900 || (r.left >= innerWidth * 0.42 && r.width <= innerWidth * 0.72);
      const dialogLike = el.matches('[role=\"dialog\"],[aria-modal=\"true\"]');
      const textLen = text.length;
      let score = 0;
      score += scrollable ? 30 : -10;
      score += Math.min(80, profileCount * 9);
      score += Math.min(35, timeCount * 10);
      score += Math.min(30, replyCount * 5);
      score += Math.min(80, rowCount * 18);
      score += Math.min(15, moreCount * 8);
      score += desktopPanelLike ? 24 : -45;
      score -= dialogLike ? 55 : 0;
      score -= Math.min(20, addCommentCount * 5);
      score -= Math.min(25, messageCount * 6);
      score -= Math.min(15, sendCount * 2);
      if (textLen > 9000) score -= 18;
      if (textLen < 150) score -= 18;
      if (profileCount < 1) score -= 30;
      if (rowCount < 1) score -= 40;
      if (!timeCount && !replyCount) score -= 16;

      // On desktop the actual comments pane is a right-side panel. A small
      // left-side profile/upsell sheet must never qualify as the root.
      if (!desktopPanelLike) return null;
      if (dialogLike && rowCount < 2 && timeCount < 1 && replyCount < 1) return null;
      if (score < 50) return null;
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

async function saveCommentsScreenshot(page, root, postLog) {
  const screenshotPath = path.join(ARTIFACTS, 'comments-list.png');
  try {
    await root.screenshot({ path: screenshotPath });
  } catch (rootScreenshotError) {
    // Keep the artifact contract even if the React/Instagram root is re-rendered
    // between verification and capture. A full-page capture is still preferable
    // to losing the diagnostic screenshot completely.
    await page.screenshot({ path: screenshotPath, fullPage: false });
    appendLog('COMMENTS_ROOT_SCREENSHOT_FALLBACK', {
      url: postLog.url,
      error: String(rootScreenshotError?.message || rootScreenshotError)
    });
  }
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
  const targetUsername = String(target?.username || '').trim();
  const targetComment = String(target?.commentText || '').trim();
  const targetProfilePath = String(target?.profilePath || '').trim();

  if (!targetUsername || !targetComment) {
    throw new Error('COMMENT_ROW_NOT_FOUND_FOR_MATCH');
  }

  await page.waitForTimeout(250);

  // The scanner leaves the virtualized list at the end. Rewind first so an
  // early match can be rebound to a real DOM row instead of relying on the
  // initial viewport.
  await root.evaluate(el => {
    el.scrollTop = 0;
  }).catch(() => {});
  await page.waitForTimeout(350);

  const maxAttempts = Math.max(24, Math.min(MAX_SCAN_ROUNDS, 160));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const descriptor = await root.evaluate((rootEl, targetComment) => {
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

      const targetUsername = normalize(targetComment.username);
      const targetCommentText = normalize(targetComment.commentText);
      const targetProfilePath = String(targetComment.profilePath || '').trim();

      const validHref = href => {
        const v = String(href || '');
        if (!/^\/[^/]+\/?$/.test(v)) return false;
        return !/^\/(explore|reels|reel|direct|accounts|stories|p|about|legal|privacy|help|api)\b/i.test(v);
      };

      const visible = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return (
          s.display !== 'none' &&
          s.visibility !== 'hidden' &&
          r.width > 0 &&
          r.height > 0 &&
          r.bottom > 0 &&
          r.right > 0 &&
          r.top < innerHeight &&
          r.left < innerWidth
        );
      };

      const hasTime = el => !!el.querySelector('time') || /(?:\b\d+\s*[smhdwmy]\b|\b\d+\s*(ثانیه|دقیقه|ساعت|روز|هفته|ماه|سال))/.test(normalize(el.innerText || ''));

      const isGlobalNoise = text => /^(add a comment|view insights|boost post|send message|message|send|post|cancel|close|ok|got it|reply|like|likes|پاسخ|نظر)$/i.test(normalize(text));

      const rowLike = el => {
        if (!visible(el)) return false;
        const text = String(el.innerText || '').trim();
        if (!text || text.length > 900) return false;
        const links = Array.from(el.querySelectorAll('a[href^="/"]')).filter(a => validHref(a.getAttribute('href')));
        if (links.length !== 1) return false;
        if (!hasTime(el)) return false;
        const lines = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
        if (lines.length < 2 || lines.length > 15) return false;
        if (isGlobalNoise(text)) return false;
        return true;
      };

      const candidates = [];
      const profileLinks = Array.from(rootEl.querySelectorAll('a[href^="/"]'))
        .filter(a => validHref(a.getAttribute('href')))
        .filter(a => normalize(a.textContent || '') === targetUsername)
        .filter(a => !targetProfilePath || (a.getAttribute('href') || '') === targetProfilePath);

      for (const link of profileLinks) {
        let node = link;
        for (let depth = 0; depth < 12 && node && node !== rootEl; depth += 1) {
          node = node.parentElement;
          if (!node || !rowLike(node)) continue;
          const links = Array.from(node.querySelectorAll('a[href^="/"]')).filter(a => validHref(a.getAttribute('href')));
          if (links.length !== 1) continue;
          const text = normalize(node.innerText || '');
          if (!text.includes(targetUsername) || !text.includes(targetCommentText)) continue;
          if (targetProfilePath && (links[0].getAttribute('href') || '') !== targetProfilePath) continue;

          const rect = node.getBoundingClientRect();
          const score =
            300 - depth * 12 +
            (node.querySelector('time') ? 35 : 0) +
            (/\bReply\b|پاسخ/i.test(text) ? 20 : 0) -
            Math.max(0, text.length - 420) / 18;
          candidates.push({ node, score, rect });
          break;
        }
      }

      if (!candidates.length) return null;

      candidates.sort((a, b) => {
        const aArea = a.rect.width * a.rect.height;
        const bArea = b.rect.width * b.rect.height;
        return b.score - a.score || aArea - bArea || a.rect.top - b.rect.top;
      });

      // Mark this exact row with a unique token. No "last()" selector is used.
      const row = candidates[0].node;
      const token = `ig-row-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      row.setAttribute('data-ig-target-row', token);

      return {
        token,
        top: candidates[0].rect.top,
        left: candidates[0].rect.left,
        width: candidates[0].rect.width,
        height: candidates[0].rect.height
      };
    }, {
      username: targetUsername,
      commentText: targetComment,
      profilePath: targetProfilePath
    }).catch(() => null);

    if (descriptor?.token) {
      const selector = `[data-ig-target-row="${String(descriptor.token).replace(/"/g, '\\"')}"]`;
      const row = page.locator(selector).first();
      if (await row.isVisible().catch(() => false)) {
        await row.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(250);
        return row;
      }
    }

    const state = await scrollRoot(root, SCROLL_STEP);
    await page.waitForTimeout(Math.max(350, Math.min(SCROLL_WAIT, 900)));

    if (state.atBottom) {
      // One extra pass after reaching bottom catches DOM rehydration/virtualized
      // comment rows that appear one tick later.
      await page.waitForTimeout(450);
      const retryState = await scrollRoot(root, 1);
      if (retryState.after === retryState.max && attempt > 2) break;
    }
  }

  throw new Error('COMMENT_ROW_NOT_FOUND_FOR_MATCH');
}


async function locateReplyControl(page, row, username) {
  const token = await row.getAttribute('data-ig-target-row');
  if (!token) throw new Error('COMMENT_ROW_NOT_FOUND_FOR_MATCH');

  const replyDescriptor = await row.evaluate(rowEl => {
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

    const visible = el => {
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

    const label = el => normalize(
      `${el.innerText || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`
    );

    const rowRect = rowEl.getBoundingClientRect();
    const candidates = [];

    // Instagram renders Reply as a small text control. Prefer the smallest
    // visible exact-text node instead of a large wrapper that contains Reply.
    const elements = Array.from(rowEl.querySelectorAll('a,button,[role="button"],span,div'));
    for (const el of elements) {
      if (!visible(el)) continue;
      const own = normalize(el.textContent || '');
      const full = label(el);
      if (!(own === 'reply' || own === 'پاسخ' || full === 'reply' || full === 'پاسخ')) continue;

      const childReply = Array.from(el.children).some(child => {
        const c = normalize(child.textContent || '');
        return c === 'reply' || c === 'پاسخ';
      });
      if (childReply) continue;

      const clickTarget = el.closest('button,[role="button"],a') || el;
      const r = clickTarget.getBoundingClientRect();
      if (r.top < rowRect.top) continue;
      if (r.top > rowRect.bottom + 100) continue;

      let score = 300;
      if (clickTarget.tagName === 'BUTTON' || clickTarget.getAttribute('role') === 'button' || clickTarget.tagName === 'A') score += 45;
      if (r.top >= rowRect.bottom - 25) score += 55;
      score -= Math.abs(r.left - rowRect.left) * 0.25;
      score -= Math.abs(r.top - (rowRect.bottom - 2)) * 0.7;

      candidates.push({ el: clickTarget, score, rect: r });
    }

    // Small fallback: scan immediate row siblings/ancestors only, never page-wide.
    let scope = rowEl.parentElement;
    for (let depth = 0; depth < 2 && scope; depth += 1) {
      for (const el of Array.from(scope.querySelectorAll('a,button,[role="button"],span,div'))) {
        if (!visible(el)) continue;
        const own = normalize(el.textContent || '');
        const full = label(el);
        if (!(own === 'reply' || own === 'پاسخ' || full === 'reply' || full === 'پاسخ')) continue;
        const clickTarget = el.closest('button,[role="button"],a') || el;
        const r = clickTarget.getBoundingClientRect();
        if (r.top < rowRect.top || r.top > rowRect.bottom + 100) continue;
        const siblingProfileLinks = Array.from(scope.querySelectorAll('a[href^="/"]')).filter(a => {
          const href = a.getAttribute('href') || '';
          return /^\/[^/]+\/?$/.test(href) && !/^\/(explore|reels|reel|direct|accounts|stories|p|about|legal|privacy|help|api)\b/i.test(href);
        });
        if (siblingProfileLinks.length !== 1) continue;
        candidates.push({ el: clickTarget, score: 220 - depth * 30, rect: r });
      }
      scope = scope.parentElement;
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score || a.rect.top - b.rect.top);

    const token = `ig-reply-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    candidates[0].el.setAttribute('data-ig-reply-target', token);
    return { token, rect: candidates[0].rect };
  }).catch(() => null);

  if (!replyDescriptor?.token) throw new Error('REPLY_BUTTON_NOT_FOUND');

  const selector = `[data-ig-reply-target="${String(replyDescriptor.token).replace(/"/g, '\\"')}"]`;
  const locator = page.locator(selector).first();
  if (!(await locator.isVisible().catch(() => false))) throw new Error('REPLY_BUTTON_NOT_FOUND');

  await locator.scrollIntoViewIfNeeded().catch(() => {});
  return locator;
}


async function findReplyComposer(page, root, username) {
  const usernameNorm = normalizeText(username).replace(/^@/, '');
  const candidates = [
    root.locator('textarea').last(),
    root.locator('[contenteditable="true"]').last(),
    page.locator('textarea').last(),
    page.locator('[contenteditable="true"]').last()
  ];

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    for (const input of candidates) {
      if (!(await input.isVisible().catch(() => false))) continue;

      const meta = await input.evaluate(el => ({
        value: String(el.value || ''),
        text: String(el.textContent || ''),
        placeholder: String(el.getAttribute('placeholder') || ''),
        aria: String(el.getAttribute('aria-label') || ''),
        nearbyText: String(el.closest('form,[role="dialog"]')?.innerText || el.parentElement?.innerText || '').slice(0, 500)
      })).catch(() => null);

      if (!meta) continue;

      const joined = normalizeText([
        meta.value,
        meta.text,
        meta.placeholder,
        meta.aria,
        meta.nearbyText
      ].join(' '));

      const strongMentionSource = normalizeText(`${meta.value} ${meta.text} ${meta.placeholder} ${meta.aria}`);
      const nearbySource = normalizeText(meta.nearbyText);
      const hasUserMention = strongMentionSource.includes(`@${usernameNorm}`) || strongMentionSource.includes(usernameNorm);
      const replySemantic = /replying to|reply to|پاسخ به|پاسخ به کامنت/i.test(
        normalizeText(`${meta.placeholder} ${meta.aria}`)
      ) || (
        nearbySource.length <= 700 &&
        (nearbySource.includes(`@${usernameNorm}`) || /replying to|reply to|پاسخ به/i.test(nearbySource))
      );
      const isFocused = await input.evaluate(el => document.activeElement === el).catch(() => false);
      const composerLike = /message|reply|comment|پیام|پاسخ|نظر/i.test(
        normalizeText(`${meta.placeholder} ${meta.aria}`)
      );

      // Instagram may not expose an @mention in every desktop locale/layout.
      // When that happens, only accept the composer if the Reply click actually
      // focused this composer OR its accessible metadata explicitly identifies a
      // reply context. A generic page-wide composer is never accepted merely
      // because it is visible.
      if (hasUserMention || replySemantic || (isFocused && composerLike)) {
        return { input, meta, hasUserMention, replySemantic, isFocused, composerLike };
      }
    }
    await page.waitForTimeout(220);
  }

  throw new Error('REPLY_UI_NOT_OPENED');
}


async function getCommentThreadStats(root, targetUsername, targetComment) {
  return root.evaluate((rootEl, { username, commentText }) => {
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

    const validHref = href => /^\/[^/]+\/?$/.test(String(href || '')) && !/^\/(explore|reels|reel|direct|accounts|stories|p|about|legal|privacy|help|api)\b/i.test(String(href || ''));
    const user = normalize(username);
    const comment = normalize(commentText);
    const rows = [];

    for (const link of Array.from(rootEl.querySelectorAll('a[href^="/"]'))) {
      if (!validHref(link.getAttribute('href'))) continue;
      if (normalize(link.textContent || '') !== user) continue;

      let node = link;
      for (let depth = 0; depth < 10 && node && node !== rootEl; depth += 1) {
        node = node.parentElement;
        if (!node) break;
        const text = normalize(node.innerText || '');
        const profiles = Array.from(node.querySelectorAll('a[href^="/"]')).filter(a => validHref(a.getAttribute('href')));
        if (profiles.length !== 1 || !node.querySelector('time')) continue;
        if (!text.includes(user) || !text.includes(comment)) continue;
        if (text.length > 900) continue;
        rows.push(node);
        break;
      }
    }

    if (!rows.length) return null;

    const row = rows[0];
    const rect = row.getBoundingClientRect();
    const text = normalize(row.innerText || '');
    const threadAncestor = (() => {
      let current = row.parentElement;
      for (let i = 0; i < 4 && current && current !== rootEl; i += 1, current = current.parentElement) {
        const raw = normalize(current.innerText || '');
        if (raw.includes(user) && raw.includes(comment) && raw.length <= 1800) return current;
      }
      return row.parentElement || row;
    })();

    const replyCountMatch = text.match(/(?:view all|hide all|view)\s+(\d+)\s+repl(?:y|ies)/i);
    return {
      targetLeft: rect.left,
      targetTop: rect.top,
      targetBottom: rect.bottom,
      targetText: text,
      replyCount: replyCountMatch ? Number(replyCountMatch[1]) : 0,
      replyTextCount: 0,
      threadToken: (() => {
        const token = `ig-thread-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        threadAncestor.setAttribute('data-ig-thread-target', token);
        return token;
      })()
    };
  }, { username: targetUsername, commentText: targetComment }).catch(() => null);
}


async function verifyReplyIsNested(root, username, commentText, replyText, beforeStats) {
  const normalizedReply = normalizeText(replyText);
  const normalizedUser = normalizeText(username).replace(/^@/, '');

  const verified = await root.evaluate((rootEl, { username, commentText, replyText, before }) => {
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

    const validHref = href => /^\/[^/]+\/?$/.test(String(href || '')) && !/^\/(explore|reels|reel|direct|accounts|stories|p|about|legal|privacy|help|api)\b/i.test(String(href || ''));
    const visible = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };

    const targetRows = [];
    const markedTarget = rootEl.querySelector('[data-ig-target-row]');
    if (markedTarget && visible(markedTarget)) {
      targetRows.push(markedTarget);
    }
    if (targetRows.length) {
      // The exact row was marked before the Reply click. Reuse it even if
      // Instagram has temporarily added nested DOM below it.
    } else for (const link of Array.from(rootEl.querySelectorAll('a[href^="/"]'))) {
      if (!validHref(link.getAttribute('href'))) continue;
      if (normalize(link.textContent || '') !== normalize(username)) continue;

      let node = link;
      for (let depth = 0; depth < 10 && node && node !== rootEl; depth += 1) {
        node = node.parentElement;
        if (!node || !visible(node)) continue;
        const text = normalize(node.innerText || '');
        const profiles = Array.from(node.querySelectorAll('a[href^="/"]')).filter(a => validHref(a.getAttribute('href')));
        if (profiles.length !== 1 || !node.querySelector('time')) continue;
        if (!text.includes(normalize(username)) || !text.includes(normalize(commentText)) || text.length > 900) continue;
        targetRows.push(node);
        break;
      }
    }

    if (!targetRows.length) return { ok: false, reason: 'TARGET_ROW_GONE' };
    const targetRow = targetRows[0];
    const targetRect = targetRow.getBoundingClientRect();

    const replyCandidates = [];
    for (const link of Array.from(rootEl.querySelectorAll('a[href^="/"]'))) {
      if (!validHref(link.getAttribute('href'))) continue;
      let node = link;
      for (let depth = 0; depth < 10 && node && node !== rootEl; depth += 1) {
        node = node.parentElement;
        if (!node || !visible(node)) continue;
        const text = normalize(node.innerText || '');
        const profiles = Array.from(node.querySelectorAll('a[href^="/"]')).filter(a => validHref(a.getAttribute('href')));
        if (profiles.length !== 1 || !node.querySelector('time')) continue;
        if (!text.includes(normalize(replyText)) || text.length > 900) continue;

        const rect = node.getBoundingClientRect();
        if (rect.top < targetRect.bottom - 5) continue;
        replyCandidates.push({ node, rect, text });
        break;
      }
    }

    if (!replyCandidates.length) return { ok: false, reason: 'REPLY_ROW_NOT_FOUND' };

    replyCandidates.sort((a, b) => Math.abs(a.rect.top - targetRect.bottom) - Math.abs(b.rect.top - targetRect.bottom));
    const replyRow = replyCandidates[0].node;
    const replyRect = replyCandidates[0].rect;

    const hasMention = normalize(replyRow.innerText || '').includes(`@${normalize(username)}`);

    // Strongest UI signal: the reply must be visually indented relative to the
    // parent comment. A top-level comment posted with @mention has the same
    // indentation as normal comments and therefore fails this gate.
    const indented = replyRect.left >= targetRect.left + 10;

    // Also require a local thread ancestor rather than the root comments list.
    let localAncestor = replyRow.parentElement;
    let local = false;
    while (localAncestor && localAncestor !== rootEl) {
      if (localAncestor.querySelector('[data-ig-target-row]')) {
        local = true;
        break;
      }
      localAncestor = localAncestor.parentElement;
    }

    // Finally accept a thread-control increase as supporting evidence.
    const currentTargetText = normalize(targetRow.innerText || '');
    const countMatch = currentTargetText.match(/(?:view all|hide all|view)\s+(\d+)\s+repl(?:y|ies)/i);
    const currentCount = countMatch ? Number(countMatch[1]) : 0;
    const countIncreased = currentCount > Number(before?.replyCount || 0);
    const allText = normalize(rootEl.innerText || '');
    const currentReplyTextCount = allText.split(normalize(replyText)).length - 1;
    const replyTextIncreased = currentReplyTextCount > Number(before?.replyTextCount || 0);

    const ok = indented || countIncreased || replyTextIncreased;
    return {
      ok,
      reason: ok ? 'VERIFIED' : 'NOT_NESTED',
      hasMention,
      indented,
      local,
      countIncreased,
      beforeCount: Number(before?.replyCount || 0),
      currentCount,
      replyTextIncreased,
      targetLeft: targetRect.left,
      replyLeft: replyRect.left
    };
  }, { username, commentText, replyText, before: beforeStats || { replyCount: 0 } }).catch(() => ({ ok: false, reason: 'VERIFY_EXCEPTION' }));

  if (!verified?.ok) {
    throw new Error('REPLY_NOT_CONFIRMED');
  }

  return verified;
}



async function sendMainCommentReply(page, root, username, replyText) {
  const textToSend = String(replyText || '').trim();
  const user = String(username || '').trim().replace(/^@+/, '');

  if (!user || !textToSend) {
    throw new Error('REPLY_NOT_CONFIRMED');
  }

  const payload = `@${user} ${textToSend}`.trim();
  const normalizedPayload = normalizeText(payload);

  appendLog('MAIN_COMMENT_REPLY_INPUT_SEARCH', {
    username: user,
    payload,
    method: 'main-comment-composer-placeholder-and-geometry'
  });

  /*
   * IMPORTANT:
   * The Instagram Web composer in the supplied screenshot is the MAIN
   * "Add a comment..." field at the very bottom of the Comments panel.
   * It is NOT necessarily a textarea and the visible placeholder can be a
   * separate child node rather than a real HTML placeholder attribute.
   *
   * Therefore we find it from the visible placeholder text + the geometry of
   * the bottom composer + a contenteditable/textbox descendant.
   */
  const composerDescriptor = await page.evaluate(() => {
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

    const visible = el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return (
        s.display !== 'none' &&
        s.visibility !== 'hidden' &&
        s.opacity !== '0' &&
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.right > 0 &&
        r.top < innerHeight &&
        r.left < innerWidth
      );
    };

    const isRowComposer = el => Boolean(
      el.closest('[data-ig-target-row],[data-ig-reply-target]')
    );

    const roots = [];
    const markedRoot = document.querySelector('[data-ig-comment-root="1"]');
    if (markedRoot) roots.push(markedRoot);

    for (const dialog of Array.from(document.querySelectorAll('[role="dialog"]'))) {
      if (visible(dialog)) roots.push(dialog);
    }

    if (!roots.length) roots.push(document);

    const inputCandidates = [];

    for (const scope of roots) {
      for (const el of Array.from(scope.querySelectorAll(
        'textarea,[contenteditable="true"],[role="textbox"],input:not([type="hidden"])'
      ))) {
        if (!visible(el) || isRowComposer(el)) continue;

        const r = el.getBoundingClientRect();
        const meta = normalize([
          el.getAttribute('placeholder'),
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.getAttribute('role')
        ].join(' '));

        let ancestor = el;
        let ancestorText = '';
        let depth = 0;

        while (ancestor && depth < 7) {
          const raw = String(ancestor.innerText || '').trim();
          if (raw) ancestorText += ` ${raw}`;
          ancestor = ancestor.parentElement;
          depth += 1;
        }

        const normalizedAncestorText = normalize(ancestorText);
        const exactPlaceholder = /add a comment|افزودن نظر|نظر خود را بنویس|کامنت/i.test(meta);
        const visiblePlaceholderText = /add a comment|افزودن نظر|نظر خود را بنویس|کامنت/i.test(normalizedAncestorText);
        const bottom = r.bottom >= innerHeight * 0.78;
        const wide = r.width >= 100;
        const rightPanel = r.left >= innerWidth * 0.55;
        const contentEditable = el.getAttribute('contenteditable') === 'true';
        const textarea = el.tagName === 'TEXTAREA';

        let score = 0;
        score += exactPlaceholder ? 1000 : 0;
        score += visiblePlaceholderText ? 700 : 0;
        score += bottom ? 350 : 0;
        score += rightPanel ? 220 : 0;
        score += wide ? 180 : 0;
        score += textarea ? 70 : 0;
        score += contentEditable ? 90 : 0;
        score += el.getAttribute('role') === 'textbox' ? 50 : 0;
        score -= r.left < innerWidth * 0.45 ? 400 : 0;
        score -= isRowComposer(el) ? 10000 : 0;

        inputCandidates.push({
          el,
          score,
          rect: {
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height
          },
          meta,
          ancestorText: normalizedAncestorText.slice(0, 500)
        });
      }
    }

    /*
     * Strong fallback: find the visible literal "Add a comment..." element,
     * then walk upward until a textbox/contenteditable appears in the same
     * composer container.
     */
    const placeholderNodes = [];
    for (const scope of roots) {
      for (const el of Array.from(scope.querySelectorAll('div,span,p'))) {
        if (!visible(el)) continue;
        const text = normalize(el.textContent || '');
        if (!/^(add a comment\.\.\.|add a comment…|add a comment)$/i.test(text)) continue;
        const r = el.getBoundingClientRect();
        if (r.bottom < innerHeight * 0.70) continue;
        placeholderNodes.push({ el, rect: r });
      }
    }

    placeholderNodes.sort(
      (a, b) => b.rect.bottom - a.rect.bottom || b.rect.width - a.rect.width
    );

    for (const ph of placeholderNodes.slice(0, 5)) {
      let node = ph.el;
      for (let depth = 0; depth < 7 && node; depth += 1, node = node.parentElement) {
        const inputs = Array.from(
          node.querySelectorAll(
            'textarea,[contenteditable="true"],[role="textbox"],input:not([type="hidden"])'
          )
        ).filter(visible).filter(el => !isRowComposer(el));

        for (const input of inputs) {
          const r = input.getBoundingClientRect();
          if (r.bottom < innerHeight * 0.70 || r.width < 100) continue;

          inputCandidates.push({
            el: input,
            score: 1600 - depth * 25,
            rect: {
              left: r.left,
              top: r.top,
              width: r.width,
              height: r.height
            },
            meta: normalize([
              input.getAttribute('placeholder'),
              input.getAttribute('aria-label'),
              input.getAttribute('title'),
              input.getAttribute('role')
            ].join(' ')),
            ancestorText: normalize(node.innerText || '').slice(0, 500),
            viaPlaceholder: true
          });
        }
      }
    }

    if (!inputCandidates.length) return null;

    inputCandidates.sort(
      (a, b) =>
        b.score - a.score ||
        b.rect.bottom - a.rect.bottom ||
        b.rect.width - a.rect.width
    );

    const best = inputCandidates[0];
    const token = `ig-main-comment-composer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    best.el.setAttribute('data-ig-main-comment-composer', token);

    return {
      token,
      score: best.score,
      viaPlaceholder: Boolean(best.viaPlaceholder),
      meta: best.meta,
      ancestorText: best.ancestorText,
      tag: best.el.tagName,
      contenteditable: best.el.getAttribute('contenteditable') || null,
      role: best.el.getAttribute('role') || null,
      placeholder: best.el.getAttribute('placeholder') || null,
      aria: best.el.getAttribute('aria-label') || null,
      rect: best.rect
    };
  });

  if (!composerDescriptor?.token) {
    throw new Error('MAIN_COMMENT_INPUT_NOT_FOUND');
  }

  appendLog('MAIN_COMMENT_INPUT_FOUND', {
    username: user,
    score: composerDescriptor.score,
    viaPlaceholder: composerDescriptor.viaPlaceholder,
    tag: composerDescriptor.tag,
    contenteditable: composerDescriptor.contenteditable,
    role: composerDescriptor.role,
    placeholder: composerDescriptor.placeholder,
    rect: composerDescriptor.rect
  });

  const inputSelector = `[data-ig-main-comment-composer="${String(composerDescriptor.token).replace(/"/g, '\\"')}"]`;
  const input = page.locator(inputSelector).first();

  if (!(await input.isVisible().catch(() => false))) {
    throw new Error('MAIN_COMMENT_INPUT_NOT_FOUND');
  }

  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click({ timeout: CLICK_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(200);

  /* Clear the main public comment field and insert EXACTLY:
   * @instagram-user-id + one space + configured reply text
   */
  const isNativeInput = await input.evaluate(
    el => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
  ).catch(() => false);

  const clearAndTypeComposer = async () => {
    await input.click({ timeout: CLICK_TIMEOUT_MS }).catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.waitForTimeout(80);

    // Instagram's public comment composer is currently a controlled native
    // INPUT. Use real keyboard input so the same input events are emitted as
    // when a human types the comment.
    await input.pressSequentially(payload, {
      delay: 8,
      timeout: CLICK_TIMEOUT_MS
    });
    await page.waitForTimeout(180);
  };

  const setNativeValueWithEvents = async () => {
    await input.evaluate((el, value) => {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
      const proto = Object.getPrototypeOf(el);
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor?.set) descriptor.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: value
      }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, payload).catch(() => {});
    await page.waitForTimeout(180);
  };

  async function currentComposerText() {
    return input.evaluate(
      el => String(
        'value' in el
          ? el.value
          : (el.textContent || el.innerText || '')
      )
    ).catch(() => '');
  }

  // Attempt 1: keyboard path (most reliable for Instagram's React composer).
  await clearAndTypeComposer().catch(() => {});
  let currentValue = await currentComposerText();

  // Attempt 2: native value setter + input/change events for controlled INPUTs.
  if (!normalizeText(currentValue).includes(normalizedPayload) && isNativeInput) {
    await setNativeValueWithEvents();
    currentValue = await currentComposerText();
  }

  // Attempt 3: refocus and use insertText after the composer is re-rendered.
  if (!normalizeText(currentValue).includes(normalizedPayload)) {
    await input.click({ timeout: CLICK_TIMEOUT_MS }).catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.waitForTimeout(80);
    await page.keyboard.insertText(payload).catch(() => {});
    await page.waitForTimeout(180);
    currentValue = await currentComposerText();
  }

  if (!normalizeText(currentValue).includes(normalizedPayload)) {
    throw new Error('MAIN_COMMENT_INPUT_FILL_FAILED');
  }

  appendLog('MAIN_COMMENT_REPLY_INPUT_FILLED', {
    username: user,
    payload,
    inputTag: composerDescriptor.tag,
    contenteditable: composerDescriptor.contenteditable
  });

  /*
   * The Send icon may have NO text, NO aria-label and NO title until the
   * composer has text. Find it by its relationship to the input:
   * - same composer / nearby ancestors
   * - visible
   * - immediately to the RIGHT of the input
   * - vertically aligned
   * - small icon/button
   */
  const sendInfo = await page.evaluate(composerToken => {
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

    const input = document.querySelector(
      `[data-ig-main-comment-composer="${CSS.escape(composerToken)}"]`
    );
    if (!input) return null;

    const visible = el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return (
        s.display !== 'none' &&
        s.visibility !== 'hidden' &&
        s.opacity !== '0' &&
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.right > 0 &&
        r.top < innerHeight &&
        r.left < innerWidth
      );
    };

    const labelOf = el => normalize([
      el.innerText || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.getAttribute('data-testid') || ''
    ].join(' '));

    const inputRect = input.getBoundingClientRect();
    const scopes = [];
    let scope = input.parentElement;

    for (let i = 0; i < 8 && scope; i += 1, scope = scope.parentElement) {
      scopes.push(scope);
    }

    if (input.closest('[role="dialog"]')) {
      scopes.push(input.closest('[role="dialog"]'));
    }

    const candidates = [];
    const seen = new Set();

    for (const current of scopes) {
      if (!current) continue;

      for (const el of Array.from(
        current.querySelectorAll(
          'button,[role="button"],[type="submit"],svg'
        )
      )) {
        const clickTarget =
          el.closest('button,[role="button"],[type="submit"]') || el;

        if (!clickTarget || seen.has(clickTarget)) continue;
        seen.add(clickTarget);
        if (!visible(clickTarget)) continue;
        if (clickTarget === input) continue;

        const r = clickTarget.getBoundingClientRect();
        const label = labelOf(clickTarget);
        const rightGap = r.left - inputRect.right;
        const verticalGap = Math.abs(
          r.top + r.height / 2 -
          (inputRect.top + inputRect.height / 2)
        );

        const isExplicitSend =
          /\b(post|send|ارسال|پست)\b/i.test(label);

        const isSmallIcon =
          r.width <= 90 &&
          r.height <= 90;

        const isRightOfInput =
          rightGap >= -15 &&
          rightGap <= 120;

        const isAligned =
          verticalGap <= Math.max(70, inputRect.height * 3);

        let score = 0;
        score += isExplicitSend ? 700 : 0;
        score += isRightOfInput ? 500 : 0;
        score += isAligned ? 280 : 0;
        score += isSmallIcon ? 120 : 0;
        score += clickTarget.querySelectorAll('svg').length ? 80 : 0;
        score -= r.left < inputRect.left - 80 ? 250 : 0;
        score -= r.top < inputRect.top - 100 ? 150 : 0;

        if (
          isExplicitSend ||
          (isRightOfInput && isAligned && isSmallIcon)
        ) {
          candidates.push({
            el: clickTarget,
            score,
            label,
            rect: {
              left: r.left,
              top: r.top,
              width: r.width,
              height: r.height
            }
          });
        }
      }
    }

    if (!candidates.length) return null;

    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        b.rect.left - a.rect.left
    );

    const best = candidates[0];
    const token = `ig-main-comment-send-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    best.el.setAttribute(
      'data-ig-main-comment-send',
      token
    );

    return {
      token,
      score: best.score,
      label: best.label,
      rect: best.rect
    };
  }, composerDescriptor.token);

  if (!sendInfo?.token) {
    throw new Error('MAIN_COMMENT_SEND_BUTTON_NOT_FOUND');
  }

  appendLog('MAIN_COMMENT_SEND_BUTTON_FOUND', {
    username: user,
    label: sendInfo.label,
    score: sendInfo.score,
    rect: sendInfo.rect
  });

  const sendSelector = `[data-ig-main-comment-send="${String(sendInfo.token).replace(/"/g, '\\"')}"]`;
  const sendButton = page.locator(sendSelector).first();

  if (!(await sendButton.isVisible().catch(() => false))) {
    throw new Error('MAIN_COMMENT_SEND_BUTTON_NOT_FOUND');
  }

  await sendButton.scrollIntoViewIfNeeded().catch(() => {});

  // The requested final public-comment flow is explicit: after the full
  // payload is in the main comment input, click the Post control. Do not use
  // Enter as the primary submit action because Instagram can interpret it
  // differently depending on the current composer state.
  let postClicked = false;
  try {
    await sendButton.click({ timeout: CLICK_TIMEOUT_MS });
    postClicked = true;
  } catch (error) {
    appendLog('MAIN_COMMENT_SEND_CLICK_FAILED', {
      username: user,
      error: String(error?.message || error)
    });
    const closed = await dismissTransientOverlay(page);
    if (closed) {
      await page.waitForTimeout(250);
      try {
        await sendButton.click({ timeout: CLICK_TIMEOUT_MS });
        postClicked = true;
      } catch (retryError) {
        appendLog('MAIN_COMMENT_SEND_RETRY_FAILED', {
          username: user,
          error: String(retryError?.message || retryError)
        });
      }
    }
  }

  if (!postClicked) {
    throw new Error('MAIN_COMMENT_SEND_CLICK_FAILED');
  }

  await page.waitForTimeout(500);

  let composerCleared = await page.waitForFunction(
    composerToken => {
      const el = document.querySelector(
        `[data-ig-main-comment-composer="${CSS.escape(composerToken)}"]`
      );
      if (!el) return true;
      const value = 'value' in el
        ? String(el.value || '')
        : String(el.textContent || el.innerText || '');
      return !value.trim();
    },
    composerDescriptor.token,
    { timeout: 2500 }
  ).then(() => true).catch(() => false);

  if (!composerCleared) {
    await sendButton.click({ timeout: CLICK_TIMEOUT_MS });
    await page.waitForTimeout(500);
    composerCleared = await page.waitForFunction(
      composerToken => {
        const el = document.querySelector(
          `[data-ig-main-comment-composer="${CSS.escape(composerToken)}"]`
        );
        if (!el) return true;
        const value = 'value' in el
          ? String(el.value || '')
          : String(el.textContent || el.innerText || '');
        return !value.trim();
      },
      composerDescriptor.token,
      { timeout: 2500 }
    ).then(() => true).catch(() => false);
  }

  appendLog('MAIN_COMMENT_SEND_TRIGGERED', {
    username: user,
    method: 'post-button',
    composerCleared,
    payload
  });

  /*
   * Verify by looking for the exact payload in the comment panel AFTER the
   * send. The panel may virtualize rows, so first force it to the bottom.
   */
  await root.evaluate(el => {
    el.scrollTop = Math.max(
      0,
      el.scrollHeight - el.clientHeight
    );
  }).catch(() => {});

  const verified = await page.waitForFunction(
    ({ username: verifyUser, replyText: verifyText }) => {
      const norm = value => String(value || '')
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

      const expected = norm(`@${verifyUser} ${verifyText}`);
      const expectedWithoutAt = norm(`${verifyUser} ${verifyText}`);
      const rootEl = document.querySelector('[data-ig-comment-root="1"]') || document;
      const rootText = norm(rootEl.innerText || '');

      return (
        rootText.includes(expected) ||
        rootText.includes(expectedWithoutAt)
      );
    },
    { username: user, replyText: textToSend },
    { timeout: 10000 }
  ).then(() => true).catch(() => false);

  if (!verified) {
    /*
     * Secondary confirmation: the main composer became empty AFTER the send
     * button was explicitly clicked. This is accepted only after the exact
     * send button was found/clicked and the UI is still on the Comments panel.
     */
    const cleared = await page.waitForFunction(
      composerToken => {
        const el = document.querySelector(
          `[data-ig-main-comment-composer="${CSS.escape(composerToken)}"]`
        );
        if (!el) return true;
        const value = 'value' in el
          ? String(el.value || '')
          : String(el.textContent || el.innerText || '');
        return !value.trim();
      },
      composerDescriptor.token,
      { timeout: 5000 }
    ).then(() => true).catch(() => false);

    if (!cleared) {
      throw new Error('REPLY_NOT_CONFIRMED');
    }
  }

  appendLog('MAIN_COMMENT_REPLY_VERIFIED', {
    username: user,
    payload,
    verification: verified ? 'comment-visible' : 'composer-cleared-after-send'
  });

  return true;
}

async function sendReply(page, root, username, profilePath, commentText, replyText) {
  if (!root) throw new Error('COMMENT_ROW_NOT_FOUND_FOR_MATCH');
  const textToSend = String(replyText || '').trim();
  if (!textToSend) throw new Error('REPLY_NOT_CONFIRMED');

  const beforeStats = await getCommentThreadStats(root, username, commentText);
  if (!beforeStats) throw new Error('COMMENT_ROW_NOT_FOUND_FOR_MATCH');
  beforeStats.replyTextCount = await root.evaluate((rootEl, text) => {
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
    const body = normalize(rootEl.innerText || '');
    return body.split(normalize(text)).length - 1;
  }, textToSend);

  const row = await findCommentRow(root, {
    username,
    commentText,
    profilePath
  }, page);

  const replyLocator = await locateReplyControl(page, row, username);

  // Clear accidental focus from any general comment composer before clicking
  // the row-level Reply control.
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(150);

  let composer = null;
  for (let clickAttempt = 0; clickAttempt < 2 && !composer; clickAttempt += 1) {
    await replyLocator.hover().catch(() => {});
    await replyLocator.click({ timeout: CLICK_TIMEOUT_MS }).catch(async () => {
      await replyLocator.evaluate(el => {
        if (el instanceof HTMLElement) {
          el.click();
        } else {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }
      }).catch(() => {});
    });

    try {
      composer = await findReplyComposer(page, root, username);
    } catch {
      if (clickAttempt === 0) {
        await page.waitForTimeout(450);
        continue;
      }
      throw new Error('REPLY_UI_NOT_OPENED');
    }
  }

  if (!composer?.input) throw new Error('REPLY_UI_NOT_OPENED');

  const input = composer.input;
  const beforeMeta = composer.meta;
  const currentValue = String(beforeMeta.value || beforeMeta.text || '').trim();

  // Never replace the mention/token that Instagram inserted after Reply.
  // Append text to the active reply composer instead.
  await input.click();
  if (currentValue) {
    await input.press('End').catch(() => {});
    await input.pressSequentially(` ${textToSend}`, { delay: 12 });
  } else {
    await input.pressSequentially(textToSend, { delay: 12 });
  }

  const afterValue = await input.inputValue().catch(() => '');
  const afterText = await input.textContent().catch(() => '');
  const replyPayload = normalizeText(`${afterValue} ${afterText}`);
  if (!replyPayload.includes(normalizeText(textToSend))) {
    throw new Error('REPLY_UI_NOT_OPENED');
  }

  // Send only from the active composer.
  const composerScope = input.locator('xpath=ancestor::*[self::form or @role="dialog" or contains(@class,"comment")][1]');
  const sendCandidates = [
    composerScope.getByRole('button', { name: /Post|Send|ارسال|پست/i }).last(),
    root.getByRole('button', { name: /^Post$|^Send$|^ارسال$|^پست$/i }).last()
  ];

  let sent = false;
  for (const button of sendCandidates) {
    if (await button.isVisible().catch(() => false)) {
      sent = await safeClick(button, 2500);
      if (sent) break;
    }
  }

  if (!sent) {
    await input.press('Enter');
  }

  appendLog('REPLY_SUBMIT_TRIGGERED', { username });

  // Allow React/Instagram to commit the reply before verifying.
  await page.waitForTimeout(900);

  try {
    await verifyReplyIsNested(root, username, commentText, textToSend, beforeStats);
  } catch {
    throw new Error('REPLY_NOT_CONFIRMED');
  }

  return true;
}


async function getProfilePrivacyState(page) {
  return page.evaluate(() => {
    const normalize = value => String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase('fa')
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const text = normalize(document.body.innerText || '');
    const privatePatterns = [
      'this account is private',
      'این حساب خصوصی است',
      'حساب خصوصی است'
    ];

    return privatePatterns.some(pattern => text.includes(pattern));
  }).catch(() => false);
}


async function clickProfileMessageAction(dmPage, isPrivate) {
  const messageRegex = /^(Message|Send message|پیام|ارسال پیام|ارسال پیام مستقیم)$/i;
  const moreRegex = /^(More options|Options|More|گزینه‌های بیشتر|گزینه ها|بیشتر)$/i;

  if (!isPrivate) {
    const directCandidates = [
      dmPage.getByRole('button', { name: messageRegex }).first(),
      dmPage.getByRole('link', { name: messageRegex }).first()
    ];
    for (const direct of directCandidates) {
      if (await direct.isVisible().catch(() => false)) {
        if (await safeClick(direct, 3500)) return 'message-button';
      }
    }
  }

  // Private profiles (and profiles where Message is hidden) commonly expose
  // the DM action through the profile header's three-dot More menu.
  const moreCandidates = [
    dmPage.getByRole('button', { name: moreRegex }).first(),
    dmPage.locator('button[aria-label*="More" i],button[aria-label*="Options" i],button[aria-label*="گزینه" i],button[aria-label*="بیشتر" i]').first(),
    dmPage.locator('header button').filter({ has: dmPage.locator('svg') }).last()
  ];

  let menuOpened = false;
  for (const more of moreCandidates) {
    if (await more.isVisible().catch(() => false)) {
      if (await safeClick(more, 2500)) {
        menuOpened = true;
        break;
      }
    }
  }

  if (menuOpened) {
    await dmPage.waitForTimeout(350);

    const menuItems = [
      dmPage.getByRole('menuitem', { name: messageRegex }).first(),
      dmPage.getByText(messageRegex).last(),
      dmPage.locator('[role="menu"] [role="menuitem"]').filter({ hasText: /Message|Send message|پیام|ارسال پیام/i }).last()
    ];

    for (const item of menuItems) {
      if (await item.isVisible().catch(() => false)) {
        if (await safeClick(item, 3000)) return isPrivate ? 'private-menu-message' : 'more-menu-message';
      }
    }
  }

  // A private account may still expose the Message button after the profile
  // finishes hydrating; retry once after the menu attempt.
  const delayedCandidates = [
    dmPage.getByRole('button', { name: messageRegex }).first(),
    dmPage.getByRole('link', { name: messageRegex }).first()
  ];
  for (const delayed of delayedCandidates) {
    if (await delayed.isVisible().catch(() => false)) {
      if (await safeClick(delayed, 2500)) return 'message-button-delayed';
    }
  }

  throw new Error('DM_MESSAGE_ACTION_NOT_FOUND');
}


async function findDmComposer(dmPage, username) {
  const candidates = await dmPage.evaluate(() => {
    const normalize = value => String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase('fa')
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const visible = el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return (
        s.display !== 'none' &&
        s.visibility !== 'hidden' &&
        s.opacity !== '0' &&
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.right > 0 &&
        r.top < innerHeight &&
        r.left < innerWidth
      );
    };

    const isSearchLike = el => {
      const meta = normalize([
        el.getAttribute('placeholder'),
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('name'),
        el.getAttribute('role')
      ].join(' '));
      return /search|جستجو|username|password|email|comment|نظر|caption/i.test(meta);
    };

    const isMessageLike = el => {
      const meta = normalize([
        el.getAttribute('placeholder'),
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('name')
      ].join(' '));
      return /message|type a message|پیام|نوشتن پیام|پیام بنویس/i.test(meta);
    };

    const elements = Array.from(document.querySelectorAll(
      'textarea,input:not([type="hidden"]),[contenteditable="true"],[role="textbox"]'
    ));

    const scored = elements
      .filter(visible)
      .filter(el => !isSearchLike(el))
      .map(el => {
        const r = el.getBoundingClientRect();
        const messageLike = isMessageLike(el);
        let score = 0;

        if (messageLike) score += 500;
        if (el.matches('textarea')) score += 80;
        if (el.getAttribute('contenteditable') === 'true') score += 100;
        if (el.getAttribute('role') === 'textbox') score += 80;

        // Desktop Instagram's DM composer is normally a wide field in the
        // lower part of the conversation pane. This deliberately rejects the
        // left-side Search box even when its role is textbox.
        if (r.top > innerHeight * 0.68) score += 180;
        if (r.width >= 260) score += 100;
        if (r.left > innerWidth * 0.28) score += 80;
        if (r.bottom > innerHeight * 0.75) score += 100;

        score += Math.min(60, r.width / 10);

        return {
          el,
          score,
          rect: { left: r.left, top: r.top, width: r.width, height: r.height },
          messageLike
        };
      })
      .sort((a, b) => b.score - a.score || b.rect.top - a.rect.top);

    if (!scored.length) return null;

    const best = scored[0];
    const token = `ig-dm-composer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    best.el.setAttribute('data-ig-dm-composer', token);

    return {
      token,
      score: best.score,
      rect: best.rect,
      messageLike: best.messageLike,
      tag: best.el.tagName,
      role: best.el.getAttribute('role') || null,
      placeholder: best.el.getAttribute('placeholder') || null,
      aria: best.el.getAttribute('aria-label') || null,
      contenteditable: best.el.getAttribute('contenteditable') || null
    };
  });

  if (!candidates?.token) {
    throw new Error(`DM_INPUT_NOT_FOUND:${username}`);
  }

  const selector = `[data-ig-dm-composer="${String(candidates.token).replace(/"/g, '\\"')}"]`;
  const input = dmPage.locator(selector).first();

  if (!(await input.isVisible().catch(() => false))) {
    throw new Error(`DM_INPUT_NOT_FOUND:${username}`);
  }

  await input.scrollIntoViewIfNeeded().catch(() => {});
  return { input, descriptor: candidates };
}


async function putTextInDmComposer(dmPage, input, messageText, username) {
  const target = normalizeText(messageText);
  if (!target) throw new Error(`DM_NOT_CONFIRMED:${username}`);

  await input.click({ timeout: 3000 }).catch(() => {});
  await dmPage.waitForTimeout(150);

  let inserted = false;

  // Native textarea/input path.
  if (await input.evaluate(el => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement).catch(() => false)) {
    inserted = await input.fill(messageText).then(() => true, () => false);
  }

  // Instagram's current desktop composer is commonly contenteditable. For
  // React/ProseMirror-like editors, keyboard insertion is more reliable than
  // locator.fill().
  if (!inserted) {
    inserted = await input.evaluate(el => {
      try {
        if (el instanceof HTMLElement) {
          el.focus();
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
        return true;
      } catch {
        return false;
      }
    }).catch(() => false);

    if (inserted) {
      await dmPage.keyboard.press('Control+A').catch(() => {});
      await dmPage.keyboard.press('Backspace').catch(() => {});
      await dmPage.keyboard.insertText(messageText).catch(() => {});
    }
  }

  // Final fallback: sequential typing into the focused editor.
  let actual = await input.evaluate(el => String(
    'value' in el ? el.value : (el.textContent || el.innerText || '')
  )).catch(() => '');

  if (!normalizeText(actual).includes(target)) {
    await input.click().catch(() => {});
    await dmPage.keyboard.press('Control+A').catch(() => {});
    await dmPage.keyboard.press('Backspace').catch(() => {});
    await input.pressSequentially(messageText, { delay: 18 }).catch(() => {});
    actual = await input.evaluate(el => String(
      'value' in el ? el.value : (el.textContent || el.innerText || '')
    )).catch(() => '');
  }

  if (!normalizeText(actual).includes(target)) {
    throw new Error(`DM_INPUT_NOT_FILLED:${username}`);
  }

  appendLog('DM_INPUT_FILLED', {
    username,
    chars: messageText.length,
    inputTag: await input.evaluate(el => el.tagName).catch(() => null),
    inputRole: await input.getAttribute('role').catch(() => null)
  });

  return true;
}


async function verifyDmMessageSent(dmPage, messageText, beforeCount, username) {
  const normalizedMessage = normalizeText(messageText);

  const verified = await dmPage.waitForFunction(
    ({ normalizedMessage, beforeCount }) => {
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

      const visible = el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };

      const body = normalize(document.body.innerText || '');
      const count = body.split(normalizedMessage).length - 1;

      const visibleComposers = Array.from(document.querySelectorAll(
        'textarea,input:not([type="hidden"]),[contenteditable="true"],[role="textbox"]'
      )).filter(visible);

      const activeComposer = visibleComposers
        .filter(el => {
          const meta = normalize([
            el.getAttribute('placeholder'),
            el.getAttribute('aria-label'),
            el.getAttribute('role')
          ].join(' '));
          const r = el.getBoundingClientRect();
          return (
            /message|پیام|type a message|نوشتن پیام/i.test(meta) &&
            r.top > innerHeight * 0.65
          );
        })
        .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];

      const composerValue = activeComposer
        ? normalize('value' in activeComposer ? activeComposer.value : (activeComposer.textContent || activeComposer.innerText || ''))
        : '';

      // Supporting signals: Instagram typically renders the outgoing bubble
      // in the conversation, and the composer becomes empty after send.
      const delta = count > Number(beforeCount || 0);
      const composerCleared = !activeComposer || !composerValue;

      return delta && composerCleared;
    },
    { normalizedMessage, beforeCount },
    { timeout: 10000 }
  ).catch(() => false);

  if (!verified) throw new Error(`DM_NOT_CONFIRMED:${username}`);
  return true;
}


async function sendDM(dmPage, profilePath, username, message) {
  const rawProfile = String(profilePath || '').trim();
  const messageText = String(message || '').trim();
  if (!rawProfile) throw new Error(`INVALID_PROFILE_URL:${username}`);
  if (!messageText) throw new Error(`DM_NOT_CONFIRMED:${username}`);

  let profileUrl;
  try {
    if (/^https?:\/\//i.test(rawProfile)) {
      const url = new URL(rawProfile);
      if (!/^(www\.)?instagram\.com$/i.test(url.hostname)) throw new Error('external-host');
      profileUrl = url.href;
    } else {
      const pathPart = rawProfile.startsWith('/') ? rawProfile : `/${rawProfile}`;
      profileUrl = new URL(pathPart, 'https://www.instagram.com').href;
    }
  } catch {
    throw new Error(`INVALID_PROFILE_URL:${username}`);
  }

  await dmPage.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await dmPage.waitForTimeout(1200);
  await dismissCommonPopups(dmPage);
  await dismissTransientOverlay(dmPage);

  const isPrivate = await getProfilePrivacyState(dmPage);
  appendLog('DM_PROFILE_OPENED', { username, profile: rawProfile, private: isPrivate });

  const action = await clickProfileMessageAction(dmPage, isPrivate);
  appendLog('DM_MESSAGE_ACTION_FOUND', { username, action, private: isPrivate });

  // Do not assume the composer exists immediately after Message. Instagram
  // hydrates the conversation pane asynchronously.
  await dmPage.waitForTimeout(700);
  let composerResult = null;
  let lastComposerError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      composerResult = await findDmComposer(dmPage, username);
      if (composerResult?.input) break;
    } catch (error) {
      lastComposerError = error;
    }
    await dmPage.waitForTimeout(500 + attempt * 250);
  }

  if (!composerResult?.input) {
    throw new Error(lastComposerError?.message || `DM_INPUT_NOT_FOUND:${username}`);
  }

  appendLog('DM_INPUT_FOUND', {
    username,
    score: composerResult.descriptor.score,
    rect: composerResult.descriptor.rect,
    tag: composerResult.descriptor.tag,
    role: composerResult.descriptor.role,
    placeholder: composerResult.descriptor.placeholder,
    aria: composerResult.descriptor.aria,
    contenteditable: composerResult.descriptor.contenteditable
  });

  const input = composerResult.input;
  const beforeBody = normalizeText(await dmPage.locator('body').innerText().catch(() => ''));
  const beforeCount = beforeBody.split(normalizeText(messageText)).length - 1;

  await putTextInDmComposer(dmPage, input, messageText, username);

  appendLog('DM_SUBMIT_READY', { username });

  // Prefer the explicit Send control when Instagram exposes one. Otherwise,
  // Enter is the desktop-chat send action. We only do this AFTER verifying that
  // the intended text is truly inside the active composer.
  const sendButtonCandidates = [
    dmPage.getByRole('button', { name: /^(Send|ارسال)$/i }).last(),
    dmPage.locator('button[aria-label="Send" i],button[title="Send" i],button[aria-label="ارسال" i]').last()
  ];

  let clickedSend = false;
  for (const sendButton of sendButtonCandidates) {
    if (await sendButton.isVisible().catch(() => false)) {
      clickedSend = await safeClick(sendButton, 3000);
      if (clickedSend) break;
    }
  }

  if (!clickedSend) {
    await input.press('Enter').catch(async () => {
      await dmPage.keyboard.press('Enter');
    });
  }

  appendLog('DM_SUBMIT_TRIGGERED', {
    username,
    method: clickedSend ? 'button' : 'enter'
  });

  await verifyDmMessageSent(dmPage, messageText, beforeCount, username);
  appendLog('DM_MESSAGE_VERIFIED', { username });

  return true;
}


async function ensureCommentsUi(page, postUrl) {
  // After a successful DM, always reload the post and rebuild the real
  // Comment UI. Never trust the old root marker: Instagram may leave the
  // previous DOM subtree mounted while its visible panel is already closed.
  appendLog('COMMENTS_RETURN_REOPEN_REQUIRED', { url: postUrl });

  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200);
  await dismissCommonPopups(page);
  await dismissTransientOverlay(page);

  await page.evaluate(() => {
    document.querySelectorAll('[data-ig-comment-root="1"]').forEach(el => {
      el.removeAttribute('data-ig-comment-root');
    });
  }).catch(() => {});

  const clickInfo = await clickRealCommentButton(page);

  appendLog('COMMENTS_RETURN_COMMENT_BUTTON_FOUND', {
    url: postUrl,
    strategy: clickInfo.strategy
  });

  appendLog('COMMENTS_RETURN_COMMENT_BUTTON_CLICKED', {
    url: postUrl,
    strategy: clickInfo.strategy
  });

  const descriptor = await waitForCommentRoot(page);

  if (!descriptor || !descriptor.rowCount) {
    throw new Error('REPLY_COMMENT_UI_NOT_REOPENED');
  }

  await markCommentRoot(page, descriptor);

  const root = await getRootLocator(page);

  const verified =
    await root.isVisible().catch(() => false);

  if (!verified) {
    throw new Error('REPLY_COMMENT_UI_NOT_REOPENED');
  }

  appendLog('COMMENTS_RETURN_REOPENED', {
    url: postUrl,
    strategy: clickInfo.strategy
  });

  return root;
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
    successfulDirectMessages: 0,
    successfulReplies: 0,
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

    await saveCommentsScreenshot(page, root, postLog);

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

      appendLog('MATCH_FOUND', {
        url,
        username: comment.username,
        keyword: match.keyword,
        matchMode: match.mode,
        distance: match.distance
      });

      let failurePage = page;
      let failureStage = 'reply';

      try {
        // IMPORTANT ORDER:
        //   1) open author's profile
        //   2) send DM and verify it
        //   3) return to the post/comment list
        //   4) find the same comment again
        //   5) enter Reply mode and verify the reply is actually nested
        // We intentionally do NOT attempt the public comment reply before DM.
        appendLog('DM_ATTEMPT', {
          url,
          username: comment.username,
          profile: comment.profilePath
        });
        failurePage = dmPage;
        failureStage = 'dm';

        await sendDM(dmPage, comment.profilePath, comment.username, dmReply);
        item.dm = 'sent';
        postLog.successfulDirectMessages++;
        appendLog('DM_SENT', {
          url,
          username: comment.username,
          profile: comment.profilePath
        });

        appendLog('COMMENTS_RETURN_ATTEMPT', {
          url,
          username: comment.username
        });

        const returnedRoot = await ensureCommentsUi(page, url);
        failurePage = page;
        failureStage = 'reply';

        // The original root may have been re-rendered while the DM page was
        // active. Always use the fresh root returned above.
        const replyRoot = returnedRoot;

        appendLog('REPLY_ATTEMPT', {
          url,
          username: comment.username,
          keyword: match.keyword,
          method: 'main-comment-input-mention'
        });

        // FINAL COMMENT FLOW:
        // After DM succeeds and the post comments are freshly reopened,
        // do NOT search for the original row and do NOT click its Reply button.
        // Use the main Add-a-comment composer at the bottom of the comments list
        // and publish: "@instagram_username <configured reply text>".
        await sendMainCommentReply(
          page,
          replyRoot,
          comment.username,
          commentReply
        );

        item.reply = 'sent';
        postLog.successfulReplies++;
        item.status = 'done';
        postLog.matchesCompleted++;

        appendLog('REPLY_SENT', {
          url,
          username: comment.username,
          keyword: match.keyword,
          method: 'main-comment-input-mention'
        });
        appendLog('MATCH_COMPLETED', {
          url,
          username: comment.username,
          keyword: match.keyword
        });
      } catch (error) {
        item.status = 'error';
        item.error = String(error?.message || error);
        postLog.matchesFailed++;

        await saveFailureScreenshot(
          failurePage,
          postLog,
          failureStage,
          error
        );

        appendLog('MATCH_FAILED', {
          url,
          username: comment.username,
          comment: comment.commentText,
          error: item.error,
          failureStage
        });
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
      successfulDirectMessages: postLog.successfulDirectMessages,
      successfulReplies: postLog.successfulReplies,
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
    matchesFailed: 0,
    successfulDirectMessages: 0,
    successfulReplies: 0
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
        runLog.successfulDirectMessages += postLog.successfulDirectMessages;
        runLog.successfulReplies += postLog.successfulReplies;
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
