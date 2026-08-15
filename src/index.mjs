import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ARTIFACTS = path.resolve('artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

const env = process.env;

const DEBUG_SCREENSHOT_EVERY_ROUND =
  env.INSTAGRAM_DEBUG_SCREENSHOT_EVERY_ROUND !== 'false';

const MAX_SCAN_ROUNDS = Number(
  env.INSTAGRAM_MAX_COMMENT_SCAN_ROUNDS || 80
);

const SCROLL_PIXELS = Number(
  env.INSTAGRAM_COMMENT_SCROLL_PIXELS || 900
);

function now() {
  return new Date().toISOString();
}

function safeName(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .slice(0, 100);
}

function required(name) {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required input: ${name}`);
  }

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
    .replace(/[ۀە]/g, 'ه')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/[‏‎‏]/g, '')
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

function typoThreshold(word) {
  const n = word.length;

  if (n <= 3) return 0;
  if (n <= 5) return 1;
  if (n <= 8) return 2;
  if (n <= 12) return 3;

  return Math.max(3, Math.floor(n * 0.25));
}

function keywordMatch(text, keywords) {
  const original = String(text || '');
  const normalized = normalizeText(original);
  const compact = compactText(original);
  const words = normalized.split(/\s+/).filter(Boolean);

  for (const rawKeyword of keywords) {
    const keyword = normalizeText(rawKeyword);

    if (!keyword) continue;

    const keywordCompact = compactText(keyword);

    if (
      normalized.includes(keyword) ||
      compact.includes(keywordCompact)
    ) {
      return {
        matched: true,
        keyword: rawKeyword,
        mode: 'exact'
      };
    }

    const targetWords = keyword.split(/\s+/).filter(Boolean);

    if (targetWords.length === 1) {
      const target = targetWords[0];
      const maxDistance = typoThreshold(target);

      for (const word of words) {
        if (
          word.includes(target) ||
          target.includes(word)
        ) {
          if (
            Math.abs(word.length - target.length) <=
            maxDistance
          ) {
            return {
              matched: true,
              keyword: rawKeyword,
              mode: 'substring-typo'
            };
          }
        }

        if (
          maxDistance > 0 &&
          distance(word, target) <= maxDistance
        ) {
          return {
            matched: true,
            keyword: rawKeyword,
            mode: 'typo',
            distance: distance(word, target)
          };
        }
      }

      continue;
    }

    for (
      let start = 0;
      start <= words.length - targetWords.length;
      start++
    ) {
      let totalDistance = 0;
      let ok = true;

      for (
        let i = 0;
        i < targetWords.length;
        i++
      ) {
        const word = words[start + i];
        const target = targetWords[i];

        if (word === target) {
          continue;
        }

        const d = distance(word, target);

        if (d > typoThreshold(target)) {
          ok = false;
          break;
        }

        totalDistance += d;
      }

      if (ok) {
        return {
          matched: true,
          keyword: rawKeyword,
          mode: 'phrase-typo',
          distance: totalDistance
        };
      }
    }
  }

  return {
    matched: false
  };
}

function createLogger(runLog, postLog) {
  return {
    info(message, data = {}) {
      const item = {
        time: now(),
        level: 'info',
        message,
        ...data
      };

      postLog.events.push(item);
      runLog.events.push({
        ...item,
        postUrl: postLog.url
      });

      console.log(
        `[${item.time}] ${message}`,
        Object.keys(data).length ? JSON.stringify(data) : ''
      );
    },

    warn(message, data = {}) {
      const item = {
        time: now(),
        level: 'warn',
        message,
        ...data
      };

      postLog.events.push(item);
      runLog.events.push({
        ...item,
        postUrl: postLog.url
      });

      console.warn(
        `[${item.time}] WARN ${message}`,
        Object.keys(data).length ? JSON.stringify(data) : ''
      );
    },

    error(message, data = {}) {
      const item = {
        time: now(),
        level: 'error',
        message,
        ...data
      };

      postLog.events.push(item);
      runLog.events.push({
        ...item,
        postUrl: postLog.url
      });

      console.error(
        `[${item.time}] ERROR ${message}`,
        Object.keys(data).length ? JSON.stringify(data) : ''
      );
    }
  };
}

function writeJson(filename, data) {
  fs.writeFileSync(
    path.join(ARTIFACTS, filename),
    JSON.stringify(data, null, 2),
    'utf8'
  );
}

async function saveScreenshot(page, filename) {
  const fullPath = path.join(
    ARTIFACTS,
    filename
  );

  await page.screenshot({
    path: fullPath,
    fullPage: false
  });

  return fullPath;
}

async function saveFullPageScreenshot(page, filename) {
  const fullPath = path.join(
    ARTIFACTS,
    filename
  );

  await page.screenshot({
    path: fullPath,
    fullPage: true
  });

  return fullPath;
}

async function saveDiagnosticDom(page, postLog, reason) {
  const stamp = Date.now();
  const base = safeName(
    `${postLog.postIndex}-${stamp}-${reason}`
  );

  const screenshot = await saveScreenshot(
    page,
    `debug-${base}.png`
  );

  const fullScreenshot =
    await saveFullPageScreenshot(
      page,
      `debug-${base}-full.png`
    );

  const data = await page.evaluate(() => {
    const all = Array.from(
      document.querySelectorAll('*')
    );

    const visible = all.filter(el => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();

      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );
    });

    const scrollables = visible
      .filter(el => {
        const style = getComputedStyle(el);

        return (
          /(auto|scroll)/.test(style.overflowY) &&
          el.scrollHeight >
            el.clientHeight + 50
        );
      })
      .slice(0, 50)
      .map(el => {
        const rect = el.getBoundingClientRect();

        return {
          tag: el.tagName,
          id: el.id || null,
          className:
            typeof el.className === 'string'
              ? el.className.slice(0, 300)
              : null,
          role: el.getAttribute('role'),
          ariaLabel:
            el.getAttribute('aria-label'),
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          }
        };
      });

    const candidateElements = visible
      .filter(el => {
        const text =
          (el.innerText || '').trim();

        if (!text || text.length < 2) {
          return false;
        }

        if (text.length > 1000) {
          return false;
        }

        return (
          el.matches('li') ||
          el.matches('[role="listitem"]') ||
          el.matches('article') ||
          el.querySelector(
            'a[href^="/"],time,button'
          ) !== null
        );
      })
      .slice(0, 200)
      .map(el => ({
        tag: el.tagName,
        role: el.getAttribute('role'),
        ariaLabel:
          el.getAttribute('aria-label'),
        text: (el.innerText || '')
          .trim()
          .slice(0, 1000),
        html: el.outerHTML.slice(0, 2000)
      }));

    return {
      url: location.href,
      title: document.title,
      bodyText:
        document.body?.innerText?.slice(
          0,
          30000
        ) || '',
      dialogCount:
        document.querySelectorAll(
          '[role="dialog"]'
        ).length,
      listItemCount:
        document.querySelectorAll(
          'li,[role="listitem"]'
        ).length,
      articleCount:
        document.querySelectorAll(
          'article'
        ).length,
      textareaCount:
        document.querySelectorAll(
          'textarea'
        ).length,
      contentEditableCount:
        document.querySelectorAll(
          '[contenteditable="true"]'
        ).length,
      scrollables,
      candidateElements
    };
  });

  const jsonName =
    `debug-${base}.json`;

  writeJson(jsonName, {
    reason,
    screenshot,
    fullScreenshot,
    capturedAt: now(),
    data
  });

  postLog.debugArtifacts.push({
    reason,
    screenshot,
    fullScreenshot,
    json:
      path.join(
        ARTIFACTS,
        jsonName
      )
  });

  return data;
}

async function safeClick(locator, timeout = 3000) {
  try {
    await locator.first().click({
      timeout
    });

    return true;
  } catch {
    return false;
  }
}

async function clickText(page, patterns, timeout = 3000) {
  for (const pattern of patterns) {
    const candidates = [
      page.getByRole(
        'button',
        {
          name: pattern
        }
      ).first(),

      page.getByRole(
        'link',
        {
          name: pattern
        }
      ).first(),

      page.getByText(
        pattern
      ).first()
    ];

    for (const locator of candidates) {
      if (
        await locator
          .isVisible()
          .catch(() => false)
      ) {
        if (
          await safeClick(
            locator,
            timeout
          )
        ) {
          return true;
        }
      }
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

  for (const text of patterns) {
    await clickText(
      page,
      [text],
      700
    );
  }
}

async function loadSession() {
  if (!env.INSTAGRAM_SESSION_B64?.trim()) {
    return null;
  }

  const json = Buffer
    .from(
      env.INSTAGRAM_SESSION_B64.trim(),
      'base64'
    )
    .toString('utf8');

  return JSON.parse(json);
}

async function login(page, context) {
  await page.goto(
    'https://www.instagram.com/',
    {
      waitUntil:
        'domcontentloaded',
      timeout: 30000
    }
  );

  await dismissCommonPopups(page);

  if (
    page.url().includes(
      '/accounts/login'
    )
  ) {
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
      .fill(
        env.INSTAGRAM_USERNAME
      );

    await page
      .getByLabel(
        /Password/i
      )
      .fill(
        env.INSTAGRAM_PASSWORD
      );

    await clickText(
      page,
      [
        'Log in',
        'ورود'
      ],
      8000
    );

    await page.waitForTimeout(
      4000
    );

    if (
      /challenge|two_factor|login/.test(
        page.url()
      )
    ) {
      throw new Error(
        'Instagram requires interactive login/2FA. Refresh INSTAGRAM_SESSION_B64.'
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

async function pageState(page) {
  return page.evaluate(() => {
    const scrollables =
      Array.from(
        document.querySelectorAll(
          'body *'
        )
      )
        .filter(el => {
          const style =
            getComputedStyle(el);

          return (
            /(auto|scroll)/.test(
              style.overflowY
            ) &&
            el.scrollHeight >
              el.clientHeight + 50
          );
        })
        .slice(0, 20)
        .map(el => ({
          tag: el.tagName,
          role:
            el.getAttribute('role'),
          ariaLabel:
            el.getAttribute(
              'aria-label'
            ),
          scrollTop: el.scrollTop,
          scrollHeight:
            el.scrollHeight,
          clientHeight:
            el.clientHeight
        }));

    return {
      url: location.href,
      title: document.title,
      dialogs:
        document.querySelectorAll(
          '[role="dialog"]'
        ).length,
      listItems:
        document.querySelectorAll(
          'li'
        ).length,
      roleListItems:
        document.querySelectorAll(
          '[role="listitem"]'
        ).length,
      articles:
        document.querySelectorAll(
          'article'
        ).length,
      buttons:
        document.querySelectorAll(
          'button'
        ).length,
      scrollables
    };
  });
}

async function openComments(page, logger) {
  logger.info(
    'Trying to open comments'
  );

  const labels = [
    /comment/i,
    /comments/i,
    /نظر/i,
    /دیدگاه/i
  ];

  for (const label of labels) {
    const candidates = [
      page.getByLabel(label).first(),
      page.getByRole(
        'button',
        {
          name: label
        }
      ).first()
    ];

    for (const locator of candidates) {
      if (
        await locator
          .isVisible()
          .catch(() => false)
      ) {
        if (
          await safeClick(
            locator,
            3500
          )
        ) {
          await page.waitForTimeout(
            1200
          );

          const state =
            await pageState(
              page
            );

          logger.info(
            'Comments control clicked',
            state
          );

          return true;
        }
      }
    }
  }

  const iconButtons =
    page.locator(
      'button,[role="button"]'
    );

  const count =
    await iconButtons.count();

  for (
    let i = 0;
    i < Math.min(count, 40);
    i++
  ) {
    const button =
      iconButtons.nth(i);

    const label =
      await button
        .getAttribute(
          'aria-label'
        )
        .catch(
          () => ''
        );

    if (
      /comment|نظر|دیدگاه/i.test(
        String(label || '')
      )
    ) {
      if (
        await safeClick(
          button,
          2500
        )
      ) {
        await page.waitForTimeout(
          1200
        );

        logger.info(
          'Comments opened via aria-label fallback',
          {
            ariaLabel: label
          }
        );

        return true;
      }
    }
  }

  logger.warn(
    'Could not positively identify a comments control; continuing with DOM diagnostics'
  );

  return false;
}

async function getScrollableContainers(page) {
  return page.evaluate(() => {
    return Array.from(
      document.querySelectorAll(
        'body *'
      )
    )
      .filter(el => {
        const style =
          getComputedStyle(el);

        return (
          /(auto|scroll)/.test(
            style.overflowY
          ) &&
          el.scrollHeight >
            el.clientHeight + 50
        );
      })
      .map((el, index) => {
        const rect =
          el.getBoundingClientRect();

        return {
          index,
          tag:
            el.tagName,
          role:
            el.getAttribute(
              'role'
            ),
          ariaLabel:
            el.getAttribute(
              'aria-label'
            ),
          className:
            typeof el.className ===
            'string'
              ? el.className.slice(
                  0,
                  200
                )
              : '',
          scrollTop:
            el.scrollTop,
          scrollHeight:
            el.scrollHeight,
          clientHeight:
            el.clientHeight,
          width:
            rect.width,
          height:
            rect.height
        };
      })
      .sort(
        (a, b) =>
          (b.scrollHeight -
            b.clientHeight) -
          (a.scrollHeight -
            a.clientHeight)
      )
      .slice(0, 15);
  });
}

async function scrollEverything(page) {
  return page.evaluate(
    scrollPixels => {
      const elements =
        Array.from(
          document.querySelectorAll(
            'body *'
          )
        );

      let changed = 0;

      for (const el of elements) {
        const style =
          getComputedStyle(el);

        if (
          !/(auto|scroll)/.test(
            style.overflowY
          )
        ) {
          continue;
        }

        if (
          el.scrollHeight <=
          el.clientHeight + 50
        ) {
          continue;
        }

        const before =
          el.scrollTop;

        el.scrollTop =
          Math.min(
            el.scrollTop +
              scrollPixels,
            el.scrollHeight
          );

        if (
          el.scrollTop !== before
        ) {
          changed++;
        }
      }

      window.scrollBy(
        0,
        scrollPixels
      );

      return changed;
    },
    SCROLL_PIXELS
  );
}

async function clickMoreComments(page) {
  const patterns = [
    /View more comments/i,
    /Load more comments/i,
    /View all \d+ comments/i,
    /View all comments/i,
    /نمایش نظرهای بیشتر/i,
    /نمایش دیدگاه‌های بیشتر/i,
    /مشاهده همه.*نظر/i,
    /مشاهده.*نظر/i
  ];

  for (const pattern of patterns) {
    const elements = [
      page.getByRole(
        'button',
        {
          name: pattern
        }
      ),
      page.getByText(
        pattern
      )
    ];

    for (const locator of elements) {
      const count =
        await locator.count();

      for (
        let i = 0;
        i < count;
        i++
      ) {
        const item =
          locator.nth(i);

        if (
          await item
            .isVisible()
            .catch(
              () => false
            )
        ) {
          if (
            await safeClick(
              item,
              1800
            )
          ) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

async function extractCommentCandidates(page) {
  return page.evaluate(() => {
    const normalize = value =>
      String(value || '')
        .normalize('NFKC')
        .toLocaleLowerCase('fa')
        .replace(
          /[\u200b\u200c\u200d\ufeff]/g,
          ''
        )
        .replace(
          /[ًٌٍَُِّْـ]/g,
          ''
        )
        .replace(/ي/g, 'ی')
        .replace(/ك/g, 'ک')
        .replace(
          /[\p{P}\p{S}]+/gu,
          ' '
        )
        .replace(
          /\s+/g,
          ' '
        )
        .trim();

    const nodes =
      Array.from(
        document.querySelectorAll(
          'li,[role="listitem"],article,div'
        )
      );

    const result = [];
    const seen = new Set();

    for (const el of nodes) {
      const text =
        (el.innerText || '')
          .trim();

      if (
        !text ||
        text.length < 2 ||
        text.length > 1000
      ) {
        continue;
      }

      const normalized =
        normalize(text);

      if (
        !normalized ||
        normalized.length < 2
      ) {
        continue;
      }

      const links =
        Array.from(
          el.querySelectorAll(
            'a[href^="/"]'
          )
        );

      const profileLinks =
        links
          .map(a =>
            a.getAttribute(
              'href'
            )
          )
          .filter(Boolean)
          .filter(href =>
            /^\/[^/]+\/?$/.test(
              href
            )
          );

      const hasTime =
        el.querySelector(
          'time'
        ) !== null;

      const hasReplyText =
        /(^|\n)\s*(reply|repl(y|ies)|پاسخ)\s*($|\n)/i.test(
          text
        );

      const hasLikeButton =
        el.querySelector(
          'button,[role="button"]'
        ) !== null;

      if (
        !(
          profileLinks.length ||
          hasTime ||
          hasReplyText ||
          hasLikeButton
        )
      ) {
        continue;
      }

      const key = normalized;

      if (
        seen.has(key)
      ) {
        continue;
      }

      seen.add(key);

      result.push({
        text,
        normalized,
        profilePath:
          profileLinks[0] ||
          null,
        hasTime,
        hasReplyText,
        hasLikeButton,
        tagName:
          el.tagName,
        role:
          el.getAttribute(
            'role'
          ),
        html:
          el.outerHTML.slice(
            0,
            2500
          )
      });
    }

    return result;
  });
}

async function scanComments(
  page,
  postLog,
  logger
) {
  const commentsByKey =
    new Map();

  let sameRounds = 0;
  let previousSignature = '';
  let rounds = 0;

  logger.info(
    'Starting full comment scan',
    {
      maxRounds:
        MAX_SCAN_ROUNDS,
      scrollPixels:
        SCROLL_PIXELS
    }
  );

  for (
    rounds = 1;
    rounds <= MAX_SCAN_ROUNDS;
    rounds++
  ) {
    const clicked =
      await clickMoreComments(
        page
      );

    const candidates =
      await extractCommentCandidates(
        page
      );

    let added = 0;

    for (const candidate of candidates) {
      const key =
        compactText(
          candidate.text
        );

      if (
        !key ||
        commentsByKey.has(key)
      ) {
        continue;
      }

      commentsByKey.set(
        key,
        candidate
      );

      added++;
    }

    const containers =
      await getScrollableContainers(
        page
      );

    const beforeCount =
      commentsByKey.size;

    const screenshotName =
      `comments-round-${String(
        postLog.postIndex
      ).padStart(2, '0')}-${String(
        rounds
      ).padStart(3, '0')}.png`;

    if (
      DEBUG_SCREENSHOT_EVERY_ROUND ||
      rounds === 1
    ) {
      const screenshot =
        await saveScreenshot(
          page,
          screenshotName
        );

      postLog.roundScreenshots.push(
        {
          round: rounds,
          screenshot
        }
      );
    }

    const changed =
      await scrollEverything(
        page
      );

    await page.waitForTimeout(
      1100
    );

    const afterCandidates =
      await extractCommentCandidates(
        page
      );

    for (
      const candidate of
      afterCandidates
    ) {
      const key =
        compactText(
          candidate.text
        );

      if (
        key &&
        !commentsByKey.has(key)
      ) {
        commentsByKey.set(
          key,
          candidate
        );

        added++;
      }
    }

    const signature =
      JSON.stringify({
        count:
          commentsByKey.size,
        containers:
          containers.map(
            c => ({
              scrollTop:
                c.scrollTop,
              scrollHeight:
                c.scrollHeight,
              clientHeight:
                c.clientHeight
            })
          )
      });

    if (
      signature ===
      previousSignature &&
      added === 0 &&
      !clicked
    ) {
      sameRounds++;
    } else {
      sameRounds = 0;
    }

    previousSignature =
      signature;

    logger.info(
      'Comment scan round',
      {
        round: rounds,
        visibleCandidates:
          candidates.length,
        addedThisRound:
          added,
        totalUniqueComments:
          commentsByKey.size,
        scrollableContainers:
          containers.length,
        changedContainers:
          changed,
        clickedMoreComments:
          clicked,
        sameRounds
      }
    );

    postLog.rounds.push({
      round: rounds,
      visibleCandidates:
        candidates.length,
      addedThisRound:
        added,
      totalUniqueComments:
        commentsByKey.size,
      scrollableContainers:
        containers.length,
      changedContainers:
        changed,
      clickedMoreComments:
        clicked,
      sameRounds
    });

    if (sameRounds >= 5) {
      logger.info(
        'Comment scan stopped because DOM/scroll state became stable',
        {
          rounds,
          totalUniqueComments:
            commentsByKey.size
        }
      );

      break;
    }

    if (
      commentsByKey.size ===
      beforeCount &&
      changed === 0 &&
      !clicked
    ) {
      sameRounds++;

      if (sameRounds >= 5) {
        break;
      }
    }
  }

  const finalScreenshot =
    await saveScreenshot(
      page,
      `comments-final-${postLog.postIndex}.png`
    );

  const finalFullScreenshot =
    await saveFullPageScreenshot(
      page,
      `comments-final-${postLog.postIndex}-full.png`
    );

  const allComments =
    Array.from(
      commentsByKey.values()
    );

  postLog.commentsScreenshot =
    finalScreenshot;

  postLog.commentsFullScreenshot =
    finalFullScreenshot;

  postLog.uniqueComments =
    allComments.length;

  writeJson(
    `comments-${postLog.postIndex}.json`,
    {
      capturedAt: now(),
      url:
        postLog.url,
      comments:
        allComments
    }
  );

  logger.info(
    'Full comment scan finished',
    {
      rounds,
      uniqueComments:
        allComments.length,
      finalScreenshot,
      finalFullScreenshot
    }
  );

  return allComments;
}

async function findCommentElement(
  page,
  targetText,
  logger
) {
  const target =
    compactText(
      targetText
    );

  if (!target) {
    return null;
  }

  const locators = [
    page.locator('li'),
    page.locator('[role="listitem"]'),
    page.locator('article'),
    page.locator('div')
  ];

  for (
    const locator of
    locators
  ) {
    const count =
      Math.min(
        await locator.count(),
        500
      );

    for (
      let i = 0;
      i < count;
      i++
    ) {
      const row =
        locator.nth(i);

      if (
        !(await row
          .isVisible()
          .catch(
            () => false
          ))
      ) {
        continue;
      }

      const text =
        await row
          .innerText()
          .catch(() => '');

      if (
        compactText(
          text
        ) === target
      ) {
        logger.info(
          'Matched comment element found',
          {
            index: i
          }
        );

        return row;
      }
    }
  }

  return null;
}

async function getAuthorProfile(
  row
) {
  const hrefs =
    await row
      .locator(
        'a[href^="/"]'
      )
      .evaluateAll(
        anchors =>
          anchors
            .map(
              a =>
                a.getAttribute(
                  'href'
                )
            )
            .filter(Boolean)
      )
      .catch(() => []);

  for (const href of hrefs) {
    if (
      /^\/[^/]+\/?$/.test(
        href
      ) &&
      !/^\/(explore|reels|direct|accounts)/.test(
        href
      )
    ) {
      return href;
    }
  }

  return null;
}

async function replyToComment(
  page,
  row,
  replyText
) {
  const reply =
    row.getByText(
      /^(Reply|reply|پاسخ)$/i
    ).first();

  if (
    await reply
      .isVisible()
      .catch(() => false)
  ) {
    if (
      !(await safeClick(
        reply,
        3000
      ))
    ) {
      throw new Error(
        'Reply control could not be clicked.'
      );
    }
  } else {
    const button =
      row
        .getByRole(
          'button',
          {
            name:
              /reply|پاسخ/i
          }
        )
        .first();

    if (
      !(await safeClick(
        button,
        3000
      ))
    ) {
      throw new Error(
        'Reply control was not found for matched comment.'
      );
    }
  }

  await page.waitForTimeout(
    500
  );

  const inputs = [
    page
      .getByPlaceholder(
        /Add a comment|Reply|نظر|پاسخ/i
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

  for (const input of inputs) {
    if (
      await input
        .isVisible()
        .catch(
          () => false
        )
    ) {
      await input.fill(
        replyText
      );

      if (
        !(await clickText(
          page,
          [
            'Post',
            'Reply',
            'Send',
            'ارسال',
            'پاسخ'
          ],
          3000
        ))
      ) {
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

async function handleMessageCategory(
  page
) {
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

  for (const text of candidates) {
    if (
      await clickText(
        page,
        [text],
        1000
      )
    ) {
      return true;
    }
  }

  return false;
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
        'domcontentloaded',
      timeout: 30000
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
        /Message/i,
        /Send message/i,
        /پیام/i
      ],
      3000
    );

  if (!messageFound) {
    const more =
      page.getByLabel(
        /More options|گزینه‌های بیشتر/i
      ).first();

    if (
      !(await safeClick(
        more,
        2200
      ))
    ) {
      const candidates =
        page.locator(
          '[role="button"]'
        );

      const count =
        await candidates.count();

      for (
        let i = Math.max(
          0,
          count - 8
        );
        i < count;
        i++
      ) {
        if (
          await safeClick(
            candidates.nth(i),
            1000
          )
        ) {
          break;
        }
      }
    }

    await page.waitForTimeout(
      500
    );

    messageFound =
      await clickText(
        page,
        [
          /Message/i,
          /Send message/i,
          /پیام/i
        ],
        3000
      );
  }

  if (!messageFound) {
    throw new Error(
      'Message control was not found on profile.'
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

  for (const input of inputs) {
    if (
      await input
        .isVisible()
        .catch(
          () => false
        )
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
        900
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
  runLog,
  postIndex
) {
  const postLog = {
    postIndex,
    url,
    startedAt: now(),
    events: [],
    rounds: [],
    roundScreenshots: [],
    debugArtifacts: [],
    matches: [],
    errors: []
  };

  const logger =
    createLogger(
      runLog,
      postLog
    );

  runLog.posts.push(
    postLog
  );

  logger.info(
    'Opening post'
  );

  await page.goto(
    url,
    {
      waitUntil:
        'domcontentloaded',
      timeout: 30000
    }
  );

  await page.waitForTimeout(
    1800
  );

  logger.info(
    'Post loaded',
    {
      state:
        await pageState(
          page
        )
    }
  );

  await saveDiagnosticDom(
    page,
    postLog,
    'after-post-load'
  );

  await openComments(
    page,
    logger
  );

  await page.waitForTimeout(
    1000
  );

  postLog.commentsOpenScreenshot =
    await saveScreenshot(
      page,
      `comments-open-${postIndex}.png`
    );

  postLog.commentsOpenFullScreenshot =
    await saveFullPageScreenshot(
      page,
      `comments-open-${postIndex}-full.png`
    );

  await saveDiagnosticDom(
    page,
    postLog,
    'comments-open'
  );

  const allComments =
    await scanComments(
      page,
      postLog,
      logger
    );

  if (
    allComments.length === 0
  ) {
    logger.error(
      'ZERO comments extracted after full scan'
    );

    await saveDiagnosticDom(
      page,
      postLog,
      'zero-comments'
    );

    postLog.commentCountScanned =
      0;

    postLog.matches = [];
    postLog.finishedAt = now();

    return;
  }

  const matches = [];

  for (
    const comment of
    allComments
  ) {
    const match =
      keywordMatch(
        comment.text,
        keywords
      );

    logger.info(
      'Keyword evaluation',
      {
        comment:
          comment.text,
        matched:
          match.matched,
        keyword:
          match.keyword ||
          null,
        mode:
          match.mode ||
          null,
        distance:
          match.distance ||
          0
      }
    );

    if (
      match.matched
    ) {
      matches.push({
        ...comment,
        match
      });
    }
  }

  postLog.commentCountScanned =
    allComments.length;

  postLog.matchCount =
    matches.length;

  logger.info(
    'Keyword scan finished',
    {
      comments:
        allComments.length,
      matches:
        matches.length
    }
  );

  for (
    let index = 0;
    index < matches.length;
    index++
  ) {
    const match =
      matches[index];

    const item = {
      index,
      comment:
        match.text,
      keyword:
        match.match.keyword,
      matchMode:
        match.match.mode,
      matchDistance:
        match.match.distance ||
        0,
      status:
        'pending'
    };

    try {
      logger.info(
        'Processing matched comment',
        {
          index,
          comment:
            match.text,
          keyword:
            match.match.keyword
        }
      );

      const row =
        await findCommentElement(
          page,
          match.text,
          logger
        );

      if (!row) {
        throw new Error(
          'Matched comment text was collected, but its DOM element could not be located again.'
        );
      }

      const authorPath =
        await getAuthorProfile(
          row
        );

      item.authorPath =
        authorPath;

      logger.info(
        'Author profile resolved',
        {
          authorPath
        }
      );

      if (!authorPath) {
        throw new Error(
          'Author profile link was not found.'
        );
      }

      await replyToComment(
        page,
        row,
        commentReply
      );

      item.commentReply =
        'sent';

      logger.info(
        'Comment reply sent'
      );

      await sendDmToProfile(
        page,
        authorPath,
        dmReply
      );

      item.dm =
        'sent';

      item.status =
        'done';

      logger.info(
        'DM sent successfully'
      );
    } catch (error) {
      item.status =
        'error';

      item.error =
        String(
          error?.message ||
          error
        );

      const base =
        safeName(
          `${postIndex}-${index}-${Date.now()}`
        );

      const screenshot =
        await saveFullPageScreenshot(
          page,
          `match-error-${base}.png`
        );

      item.screenshot =
        screenshot;

      logger.error(
        'Matched comment processing failed',
        {
          index,
          error:
            item.error,
          screenshot
        }
      );
    }

    postLog.matches.push(
      item
    );
  }

  postLog.finishedAt =
    now();
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
    startedAt: now(),
    keywords,
    postUrls,
    config: {
      maxScanRounds:
        MAX_SCAN_ROUNDS,
      scrollPixels:
        SCROLL_PIXELS,
      screenshotEveryRound:
        DEBUG_SCREENSHOT_EVERY_ROUND
    },
    events: [],
    posts: [],
    errors: []
  };

  try {
    console.log(
      `Starting Instagram automation at ${runLog.startedAt}`
    );

    await login(
      page,
      context
    );

    runLog.events.push({
      time: now(),
      level: 'info',
      message:
        'Login/session initialization completed'
    });

    for (
      let i = 0;
      i < postUrls.length;
      i++
    ) {
      const url =
        postUrls[i];

      try {
        await processPost(
          page,
          url,
          keywords,
          commentReply,
          dmReply,
          runLog,
          i
        );
      } catch (error) {
        const message =
          String(
            error?.message ||
            error
          );

        const screenshot =
          await saveFullPageScreenshot(
            page,
            `post-error-${i}-${Date.now()}.png`
          ).catch(
            () => null
          );

        runLog.errors.push({
          url,
          error: message,
          screenshot
        });

        runLog.events.push({
          time: now(),
          level: 'error',
          message:
            'Post processing failed',
          url,
          error: message,
          screenshot
        });
      }
    }
  } finally {
    runLog.finishedAt =
      now();

    writeJson(
      'run-summary.json',
      runLog
    );

    fs.writeFileSync(
      path.join(
        ARTIFACTS,
        'automation.log'
      ),
      runLog.events
        .map(event =>
          JSON.stringify(event)
        )
        .join('\n') +
        '\n',
      'utf8'
    );

    await context
      .storageState({
        path: path.join(
          ARTIFACTS,
          'session-after-run.json'
        )
      })
      .catch(() => {});

    await browser.close();
  }

  const hadErrors =
    runLog.errors.length > 0 ||
    runLog.posts.some(
      post =>
        post.errors.length > 0 ||
        post.matches.some(
          item =>
            item.status ===
            'error'
        )
    );

  if (hadErrors) {
    process.exitCode =
      1;
  }
}

main().catch(
  error => {
    writeJson(
      'fatal-error.json',
      {
        at: now(),
        error:
          String(
            error?.stack ||
            error
          )
      }
    );

    process.exitCode =
      1;
  }
);
