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
  return String(value || '')
    .split(/\r?\n|,|،/)
    .map(s => s.trim())
    .filter(Boolean);
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
    .replace(/ة/g, 'ه')
    .replace(/[ۀە]/g, 'ه')
    .replace(/[أإآ]/g, 'ا')
    .replace(/[ؤ]/g, 'و')
    .replace(/[ة]/g, 'ه')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactText(value) {
  return normalizeText(value).replace(/\s+/g, '');
}

function distance(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const cur = [i];

    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        cur[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }

    for (let j = 0; j <= b.length; j++) {
      prev[j] = cur[j];
    }
  }

  return prev[b.length];
}

function typoThreshold(word) {
  const length = word.length;

  if (length <= 3) return 0;
  if (length <= 5) return 1;
  if (length <= 8) return 2;

  return Math.max(2, Math.floor(length * 0.24));
}

function fuzzySingleWordMatch(words, target) {
  const threshold = typoThreshold(target);

  if (threshold <= 0) return false;

  return words.some(word => {
    if (!word) return false;

    if (word.includes(target) || target.includes(word)) {
      return Math.abs(word.length - target.length) <= threshold;
    }

    return distance(word, target) <= threshold;
  });
}

function fuzzyPhraseMatch(words, targetWords) {
  if (!targetWords.length) return null;

  if (targetWords.length === 1) {
    return fuzzySingleWordMatch(words, targetWords[0]) ? 0 : null;
  }

  for (
    let start = 0;
    start <= words.length - targetWords.length;
    start++
  ) {
    let total = 0;
    let ok = true;

    for (let i = 0; i < targetWords.length; i++) {
      const word = words[start + i];
      const target = targetWords[i];

      const exact =
        word === target ||
        word.includes(target) ||
        target.includes(word);

      const d = exact ? 0 : distance(word, target);

      if (d > typoThreshold(target)) {
        ok = false;
        break;
      }

      total += d;
    }

    if (ok) return total;
  }

  return null;
}

function keywordMatch(text, keywords) {
  const normalized = normalizeText(text);
  const compact = compactText(text);
  const words = normalized.split(/\s+/).filter(Boolean);

  for (const raw of keywords) {
    const keyword = normalizeText(raw);

    if (!keyword) continue;

    const keywordCompact = compactText(keyword);

    if (!keywordCompact) continue;

    // 1) Exact match anywhere in the whole sentence.
    if (
      normalized.includes(keyword) ||
      compact.includes(keywordCompact)
    ) {
      return {
        matched: true,
        keyword: raw,
        mode: 'exact'
      };
    }

    const targetWords = keyword
      .split(/\s+/)
      .filter(Boolean);

    // 2) Single-word typo tolerance.
    if (
      targetWords.length === 1 &&
      fuzzySingleWordMatch(words, targetWords[0])
    ) {
      return {
        matched: true,
        keyword: raw,
        mode: 'typo'
      };
    }

    // 3) Multi-word typo tolerance.
    const phraseDistance = fuzzyPhraseMatch(
      words,
      targetWords
    );

    if (phraseDistance !== null) {
      return {
        matched: true,
        keyword: raw,
        mode: 'phrase-typo',
        distance: phraseDistance
      };
    }
  }

  return {
    matched: false
  };
}

async function safeClick(locator, timeout = 4000) {
  try {
    await locator.first().click({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function clickText(page, patterns, timeout = 3500) {
  for (const p of patterns) {
    const roleButtons = page.getByRole(
      'button',
      {
        name: p,
        exact: true
      }
    );

    if (await safeClick(roleButtons, timeout)) {
      return true;
    }

    const roleLinks = page.getByRole(
      'link',
      {
        name: p,
        exact: true
      }
    );

    if (await safeClick(roleLinks, timeout)) {
      return true;
    }

    const text = page.getByText(
      p,
      {
        exact: true
      }
    );

    if (await safeClick(text, timeout)) {
      return true;
    }
  }

  return false;
}

async function dismissCommonPopups(page) {
  const patterns = [
    'Not now',
    'Not Now',
    'Later',
    'Cancel',
    'Close',
    'OK',
    'Got it',
    'بعداً',
    'اکنون نه',
    'لغو',
    'بستن',
    'باشه'
  ];

  for (const p of patterns) {
    await clickText(page, [p], 800);
  }
}

async function handleMessageCategory(page) {
  const candidates = [
    'Primary',
    'PRIMARY',
    'General',
    'GENERAL',
    'اصلی',
    'عمومی',
    'Requests',
    'درخواست‌ها'
  ];

  for (const p of candidates) {
    if (await clickText(page, [p], 1000)) {
      return true;
    }
  }

  return false;
}

async function loadSession() {
  if (env.INSTAGRAM_SESSION_B64?.trim()) {
    const json = Buffer
      .from(
        env.INSTAGRAM_SESSION_B64.trim(),
        'base64'
      )
      .toString('utf8');

    return JSON.parse(json);
  }

  return null;
}

async function login(page, context) {
  await page.goto(
    'https://www.instagram.com/',
    {
      waitUntil: 'domcontentloaded'
    }
  );

  await dismissCommonPopups(page);

  if (page.url().includes('/accounts/login')) {
    if (
      !env.INSTAGRAM_USERNAME ||
      !env.INSTAGRAM_PASSWORD
    ) {
      throw new Error(
        'Instagram session is unavailable and username/password fallback is not configured.'
      );
    }

    await page
      .getByLabel(
        /Phone number, username, or email/i
      )
      .fill(env.INSTAGRAM_USERNAME);

    await page
      .getByLabel(/Password/i)
      .fill(env.INSTAGRAM_PASSWORD);

    await clickText(
      page,
      ['Log in', 'ورود'],
      8000
    );

    await page.waitForTimeout(3000);

    if (
      /challenge|two_factor|login/.test(
        page.url()
      )
    ) {
      throw new Error(
        'Instagram requires interactive login/2FA. Refresh INSTAGRAM_SESSION_B64 using scripts/create-auth-state.mjs.'
      );
    }
  }

  await context.storageState({
    path: path.join(
      ARTIFACTS,
      'session-after-run.json'
    )
  });
}

async function getCommentsDialog(page) {
  const dialogs = page.locator(
    'div[role="dialog"]'
  );

  const count = await dialogs.count();

  if (!count) return null;

  return dialogs.last();
}

async function getVisibleScrollableNodes(page) {
  return page
    .locator('div[role="dialog"] div')
    .evaluateAll(elements => {
      const result = [];

      for (const el of elements) {
        const style = getComputedStyle(el);

        const scrollable =
          /(auto|scroll)/.test(
            style.overflowY
          ) &&
          el.scrollHeight >
            el.clientHeight + 50;

        if (!scrollable) continue;

        const rect =
          el.getBoundingClientRect();

        if (
          rect.width < 50 ||
          rect.height < 80
        ) {
          continue;
        }

        result.push({
          top: rect.top,
          height: rect.height,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight
        });
      }

      return result.sort(
        (a, b) =>
          (b.scrollHeight - b.clientHeight) -
          (a.scrollHeight - a.clientHeight)
      );
    })
    .catch(() => []);
}

async function scrollCommentArea(page) {
  const dialog =
    await getCommentsDialog(page);

  if (!dialog) {
    await page.mouse.wheel(0, 1800);
    return;
  }

  // Scroll all nested scroll containers.
  await page
    .locator('div[role="dialog"] div')
    .evaluateAll(elements => {
      for (const el of elements) {
        const style = getComputedStyle(el);

        if (
          /(auto|scroll)/.test(
            style.overflowY
          ) &&
          el.scrollHeight >
            el.clientHeight + 50
        ) {
          el.scrollTop += Math.max(
            700,
            Math.floor(
              el.clientHeight * 0.85
            )
          );
        }
      }
    })
    .catch(() => {});

  // Scroll dialog itself.
  await dialog
    .evaluate(el => {
      el.scrollTop += Math.max(
        700,
        Math.floor(
          el.clientHeight * 0.85
        )
      );
    })
    .catch(() => {});

  // Fallback page scroll.
  await page.mouse.wheel(0, 1200);

  // Let Instagram fetch more comments.
  await page.waitForTimeout(850);
}

async function clickMoreComments(page) {
  const patterns = [
    /View more comments/i,
    /Load more comments/i,
    /View all \d+ comments/i,
    /نمایش نظرهای بیشتر/i,
    /نمایش دیدگاه‌های بیشتر/i,
    /مشاهده همه.*نظر/i,
    /مشاهده.*نظر/i
  ];

  for (const pattern of patterns) {
    const candidates = [
      page
        .getByText(pattern)
        .last(),

      page
        .getByRole(
          'button',
          { name: pattern }
        )
        .last(),

      page
        .getByRole(
          'link',
          { name: pattern }
        )
        .last()
    ];

    for (const candidate of candidates) {
      if (
        await candidate
          .isVisible()
          .catch(() => false)
      ) {
        if (
          await safeClick(
            candidate,
            1800
          )
        ) {
          await page.waitForTimeout(700);
          return true;
        }
      }
    }
  }

  return false;
}

function isUsefulCommentText(text) {
  const normalized =
    normalizeText(text);

  if (
    !normalized ||
    normalized.length < 2
  ) {
    return false;
  }

  const blocked = [
    /^add a comment$/i,
    /^write a comment$/i,
    /^comment$/i,
    /^reply$/i,
    /^پاسخ$/i,
    /^نظر$/i,
    /^دیدگاه$/i,
    /^log in$/i,
    /^follow$/i
  ];

  return !blocked.some(
    re => re.test(normalized)
  );
}

async function findCommentRows(page) {
  const dialog =
    await getCommentsDialog(page);

  if (!dialog) return [];

  const selectors = [
    'ul > li',
    'li',
    '[role="listitem"]'
  ];

  const found = [];
  const seen = new Set();

  for (const selector of selectors) {
    const locator =
      dialog.locator(selector);

    const count =
      await locator.count();

    for (
      let i = 0;
      i < count;
      i++
    ) {
      const row =
        locator.nth(i);

      if (
        await row
          .isVisible()
          .catch(() => false) === false
      ) {
        continue;
      }

      const text =
        await row
          .innerText()
          .catch(() => '');

      if (
        !isUsefulCommentText(text)
      ) {
        continue;
      }

      const normalized =
        normalizeText(text);

      // Avoid duplicate nested li nodes.
      const key =
        compactText(normalized);

      if (
        key.length < 2 ||
        seen.has(key)
      ) {
        continue;
      }

      // Comments almost always contain a username anchor,
      // timestamp, reply button, or like control.
      const hasAuthor =
        await row
          .locator('a[href^="/"]')
          .count() > 0;

      const hasReply =
        await row
          .getByText(
            /^(Reply|پاسخ)$/i
          )
          .count() > 0;

      const hasButton =
        await row
          .locator(
            'button,[role="button"]'
          )
          .count() > 0;

      if (
        !hasAuthor &&
        !hasReply &&
        !hasButton
      ) {
        continue;
      }

      seen.add(key);
      found.push(row);
    }

    if (found.length) {
      break;
    }
  }

  return found;
}

async function getCommentScrollFingerprint(page) {
  const dialog =
    await getCommentsDialog(page);

  const dialogState =
    await dialog
      ?.evaluate(el => ({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight
      }))
      .catch(() => null);

  const nestedState =
    await page
      .locator(
        'div[role="dialog"] div'
      )
      .evaluateAll(elements => {
        return elements
          .map(el => {
            const style =
              getComputedStyle(el);

            if (
              !/(auto|scroll)/.test(
                style.overflowY
              )
            ) {
              return null;
            }

            return {
              scrollTop: el.scrollTop,
              scrollHeight:
                el.scrollHeight,
              clientHeight:
                el.clientHeight
            };
          })
          .filter(Boolean)
          .filter(
            x =>
              x.scrollHeight >
              x.clientHeight + 50
          );
      })
      .catch(() => []);

  return JSON.stringify({
    dialog: dialogState,
    nested: nestedState
  });
}

async function scrollCommentsToTop(page) {
  const dialog =
    await getCommentsDialog(page);

  if (!dialog) return;

  await page
    .locator('div[role="dialog"] div')
    .evaluateAll(elements => {
      for (const el of elements) {
        const style =
          getComputedStyle(el);

        if (
          /(auto|scroll)/.test(
            style.overflowY
          )
        ) {
          el.scrollTop = 0;
        }
      }
    })
    .catch(() => {});

  await dialog
    .evaluate(el => {
      el.scrollTop = 0;
    })
    .catch(() => {});

  await page.waitForTimeout(500);
}

async function loadAllComments(page) {
  const seen = new Map();

  let stableRounds = 0;
  let atEndRounds = 0;
  let lastFingerprint = '';

  const MAX_ROUNDS = 90;

  let rounds = 0;

  for (
    rounds = 0;
    rounds < MAX_ROUNDS;
    rounds++
  ) {
    const clickedMore =
      await clickMoreComments(page);

    const rows =
      await findCommentRows(page);

    for (const row of rows) {
      const text =
        await row
          .innerText()
          .catch(() => '');

      if (
        !isUsefulCommentText(text)
      ) {
        continue;
      }

      const key =
        compactText(text);

      if (
        key.length < 2 ||
        seen.has(key)
      ) {
        continue;
      }

      seen.set(key, text);
    }

    const before =
      await getCommentScrollFingerprint(
        page
      );

    await scrollCommentArea(page);

    const after =
      await getCommentScrollFingerprint(
        page
      );

    if (after === before) {
      atEndRounds += 1;
    } else {
      atEndRounds = 0;
    }

    if (
      after === lastFingerprint &&
      !clickedMore
    ) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
    }

    lastFingerprint = after;

    if (
      atEndRounds >= 3 &&
      stableRounds >= 3
    ) {
      break;
    }

    if (clickedMore) {
      stableRounds = 0;
      atEndRounds = 0;

      await page.waitForTimeout(
        1000
      );
    }
  }

  return {
    rounds,
    stableRounds,
    uniqueCommentsScanned:
      seen.size,
    comments: [
      ...seen.entries()
    ].map(
      ([key, text]) => ({
        key,
        text
      })
    )
  };
}

async function findCommentRowByText(
  page,
  targetText
) {
  const target =
    compactText(targetText);

  if (!target) return null;

  await scrollCommentsToTop(page);

  let stableRounds = 0;
  let lastFingerprint = '';

  for (
    let round = 0;
    round < 60;
    round++
  ) {
    const rows =
      await findCommentRows(page);

    for (const row of rows) {
      const text =
        await row
          .innerText()
          .catch(() => '');

      if (
        compactText(text) ===
        target
      ) {
        return row;
      }
    }

    const before =
      await getCommentScrollFingerprint(
        page
      );

    await scrollCommentArea(page);

    const after =
      await getCommentScrollFingerprint(
        page
      );

    if (
      after === before ||
      after === lastFingerprint
    ) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
    }

    lastFingerprint = after;

    if (stableRounds >= 4) {
      break;
    }
  }

  return null;
}

async function openComments(page) {
  await dismissCommonPopups(page);

  const candidates = [
    page
      .getByLabel(
        /comment|comments|نظر|دیدگاه/i
      )
      .first(),

    page
      .getByRole(
        'button',
        {
          name:
            /comment|comments|نظر|دیدگاه/i
        }
      )
      .first(),

    page
      .locator(
        '[aria-label*="comment" i]'
      )
      .first(),

    page
      .locator(
        '[aria-label*="نظر" i]'
      )
      .first(),

    page
      .locator(
        '[aria-label*="دیدگاه" i]'
      )
      .first()
  ];

  for (
    const candidate of candidates
  ) {
    if (
      await candidate
        .isVisible()
        .catch(() => false) &&
      await safeClick(
        candidate,
        3000
      )
    ) {
      await page.waitForTimeout(
        1200
      );

      if (
        await getCommentsDialog(
          page
        )
      ) {
        return true;
      }
    }
  }

  // Broad fallback for icon buttons.
  const svgButtons =
    page.locator(
      'div[role="button"]:has(svg)'
    );

  const count =
    await svgButtons.count();

  for (
    let i = 0;
    i < Math.min(count, 12);
    i++
  ) {
    if (
      await safeClick(
        svgButtons.nth(i),
        1200
      )
    ) {
      await page.waitForTimeout(
        800
      );

      if (
        await getCommentsDialog(
          page
        )
      ) {
        return true;
      }
    }
  }

  throw new Error(
    'Comment control was not found or the comments dialog did not open.'
  );
}

async function replyToComment(
  page,
  row,
  replyText
) {
  const replyCandidates = [
    row
      .getByRole(
        'button',
        {
          name:
            /reply|پاسخ/i
        }
      )
      .first(),

    row
      .getByText(
        /^(Reply|reply|پاسخ)$/ 
      )
      .first(),

    row
      .locator('button')
      .filter({
        hasText:
          /reply|پاسخ/i
      })
      .first()
  ];

  let opened = false;

  for (
    const candidate of
    replyCandidates
  ) {
    if (
      await candidate
        .isVisible()
        .catch(() => false) &&
      await safeClick(
        candidate,
        2500
      )
    ) {
      opened = true;
      break;
    }
  }

  if (!opened) {
    throw new Error(
      'Reply control was not found for matched comment.'
    );
  }

  await page.waitForTimeout(
    400
  );

  const inputs = [
    page
      .getByPlaceholder(
        /Add a comment|Reply|نظر|پاسخ/i
      )
      .last(),

    page
      .locator('textarea')
      .last(),

    page
      .locator(
        '[contenteditable="true"]'
      )
      .last()
  ];

  for (
    const input of inputs
  ) {
    if (
      await input
        .isVisible()
        .catch(() => false)
    ) {
      await input.fill(
        replyText
      );

      const sent =
        await clickText(
          page,
          [
            'Post',
            'Reply',
            'Send',
            'ارسال',
            'پاسخ'
          ],
          3000
        );

      if (!sent) {
        await input.press(
          'Enter'
        );
      }

      await page.waitForTimeout(
        900
      );

      return;
    }
  }

  throw new Error(
    'Reply input was not found.'
  );
}

async function getAuthorProfile(
  page,
  row
) {
  const links =
    row
      .locator(
        'a[href^="/"]'
      )
      .filter({
        hasText: /./
      });

  const count =
    await links.count();

  for (
    let i = 0;
    i < count;
    i++
  ) {
    const href =
      await links
        .nth(i)
        .getAttribute(
          'href'
        );

    if (
      href &&
      /^\/[^/]+\/?$/.test(
        href
      ) &&
      !/^\/(explore|reels|direct)/.test(
        href
      )
    ) {
      return href;
    }
  }

  return await row
    .locator('a')
    .first()
    .getAttribute(
      'href'
    )
    .catch(
      () => null
    );
}

async function sendDmToProfile(
  page,
  profilePath,
  dmText
) {
  const origin =
    new URL(
      page.url()
    ).origin;

  await page.goto(
    new URL(
      profilePath,
      origin
    ).href,
    {
      waitUntil:
        'domcontentloaded'
    }
  );

  await page.waitForTimeout(
    1200
  );

  await dismissCommonPopups(
    page
  );

  let messageFound =
    await clickText(
      page,
      [
        'Message',
        'Send message',
        'پیام'
      ],
      3000
    );

  if (!messageFound) {
    const more =
      page
        .getByLabel(
          /More options|گزینه‌های بیشتر/i
        )
        .first();

    if (
      !(await safeClick(
        more,
        2500
      ))
    ) {
      const dots =
        page
          .locator(
            '[role="button"]'
          )
          .filter({
            has:
              page.locator(
                'svg'
              )
          });

      await safeClick(
        dots.last(),
        2500
      );
    }

    await page.waitForTimeout(
      500
    );

    messageFound =
      await clickText(
        page,
        [
          'Message',
          'Send message',
          'پیام'
        ],
        3000
      );
  }

  if (!messageFound) {
    throw new Error(
      'Message control was not found on author profile.'
    );
  }

  await handleMessageCategory(
    page
  );

  const inputs = [
    page
      .getByPlaceholder(
        /Message/i
      )
      .last(),

    page
      .getByPlaceholder(
        /پیام/i
      )
      .last(),

    page
      .locator(
        'textarea'
      )
      .last(),

    page
      .locator(
        '[contenteditable="true"]'
      )
      .last()
  ];

  for (
    const input of inputs
  ) {
    if (
      await input
        .isVisible()
        .catch(() => false)
    ) {
      await input.fill(
        dmText
      );

      if (
        !(await clickText(
          page,
          [
            'Send',
            'ارسال'
          ],
          2500
        ))
      ) {
        await input.press(
          'Enter'
        );
      }

      await page.waitForTimeout(
        800
      );

      return;
    }
  }

  throw new Error(
    'Direct-message input was not found.'
  );
}

async function processPost(
  page,
  url,
  keywords,
  commentReply,
  dmReply,
  runLog
) {
  await page.goto(
    url,
    {
      waitUntil:
        'domcontentloaded'
    }
  );

  await page.waitForTimeout(
    1200
  );

  await openComments(page);

  const scanStats =
    await loadAllComments(
      page
    );

  const matchedComments = [];
  const seenMatchKeys =
    new Set();

  for (
    const entry of
    scanStats.comments
  ) {
    const match =
      keywordMatch(
        entry.text,
        keywords
      );

    if (!match.matched) {
      continue;
    }

    const key =
      `${entry.key}|${match.keyword}`;

    if (
      seenMatchKeys.has(key)
    ) {
      continue;
    }

    seenMatchKeys.add(key);

    matchedComments.push({
      text: entry.text,
      match
    });
  }

  const snapshot = [];

  for (
    let index = 0;
    index <
      matchedComments.length;
    index++
  ) {
    const candidate =
      matchedComments[index];

    const item = {
      url,
      index,
      keyword:
        candidate.match.keyword,
      matchMode:
        candidate.match.mode,
      matchDistance:
        candidate.match.distance ??
        0,
      comment:
        candidate.text,
      authorPath: null,
      status:
        'pending'
    };

    try {
      // Re-open post for every match.
      await page.goto(
        url,
        {
          waitUntil:
            'domcontentloaded'
        }
      );

      await page.waitForTimeout(
        900
      );

      await openComments(
        page
      );

      const row =
        await findCommentRowByText(
          page,
          candidate.text
        );

      if (!row) {
        throw new Error(
          'Matched comment disappeared or could not be located after full scroll.'
        );
      }

      item.authorPath =
        await getAuthorProfile(
          page,
          row
        );

      await replyToComment(
        page,
        row,
        commentReply
      );

      item.commentReply =
        'sent';

      if (!item.authorPath) {
        throw new Error(
          'Comment author profile link was not found.'
        );
      }

      await sendDmToProfile(
        page,
        item.authorPath,
        dmReply
      );

      item.dm = 'sent';
      item.status = 'done';

    } catch (error) {
      item.status = 'error';

      item.error =
        String(
          error?.message ||
          error
        );

      const shot =
        path.join(
          ARTIFACTS,
          `error-${Date.now()}-comment-${index}.png`
        );

      await page
        .screenshot({
          path: shot,
          fullPage: true
        })
        .catch(() => {});

      item.screenshot = shot;
    }

    snapshot.push(item);
  }

  runLog.posts.push({
    url,
    commentCountScanned:
      scanStats.uniqueCommentsScanned,

    matches:
      snapshot.length,

    scanStats: {
      rounds:
        scanStats.rounds,

      stableRounds:
        scanStats.stableRounds,

      uniqueCommentsScanned:
        scanStats.uniqueCommentsScanned
    },

    items:
      snapshot
  });
}

async function main() {
  const postUrls =
    parseList(
      required(
        'INSTAGRAM_POST_URLS'
      )
    );

  const keywords =
    parseList(
      required(
        'INSTAGRAM_KEYWORDS'
      )
    );

  const commentReply =
    required(
      'INSTAGRAM_COMMENT_REPLY'
    );

  const dmReply =
    required(
      'INSTAGRAM_DM_REPLY'
    );

  const session =
    await loadSession();

  const browser =
    await chromium.launch({
      headless:
        env.INSTAGRAM_HEADLESS !==
        'false'
    });

  const context =
    await browser.newContext({
      storageState:
        session ||
        undefined,

      viewport: {
        width: 1440,
        height: 1000
      }
    });

  const page =
    await context.newPage();

  const runLog = {
    startedAt:
      new Date().toISOString(),

    keywords,

    posts: [],

    errors: []
  };

  try {
    await login(
      page,
      context
    );

    for (
      const url of
      postUrls
    ) {
      try {
        await processPost(
          page,
          url,
          keywords,
          commentReply,
          dmReply,
          runLog
        );
      } catch (error) {
        const name =
          `error-${Date.now()}-post.png`;

        await page
          .screenshot({
            path:
              path.join(
                ARTIFACTS,
                name
              ),
            fullPage:
              true
          })
          .catch(
            () => {}
          );

        runLog.errors.push({
          url,

          error:
            String(
              error?.message ||
              error
            ),

          screenshot:
            name
        });
      }
    }

  } finally {
    runLog.finishedAt =
      new Date().toISOString();

    fs.writeFileSync(
      path.join(
        ARTIFACTS,
        'run-summary.json'
      ),

      JSON.stringify(
        runLog,
        null,
        2
      ),

      'utf8'
    );

    await browser.close();
  }

  if (
    runLog.errors.length ||
    runLog.posts.some(
      post =>
        post.items.some(
          item =>
            item.status ===
            'error'
        )
    )
  ) {
    process.exitCode = 1;
  }
}

main().catch(
  error => {
    fs.writeFileSync(
      path.join(
        ARTIFACTS,
        'fatal-error.json'
      ),

      JSON.stringify(
        {
          error:
            String(
              error?.stack ||
              error
            )
        },
        null,
        2
      )
    );

    process.exitCode = 1;
  }
);
