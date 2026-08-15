import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ARTIFACTS = path.resolve('artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

const env = process.env;

const MAX_SCAN_ROUNDS = Number(
  env.INSTAGRAM_MAX_COMMENT_SCAN_ROUNDS || 120
);

const SCROLL_PIXELS = Number(
  env.INSTAGRAM_COMMENT_SCROLL_PIXELS || 600
);

const SCROLL_WAIT_MS = Number(
  env.INSTAGRAM_COMMENT_SCROLL_WAIT_MS || 1000
);

function now() {
  return new Date().toISOString();
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
    .map(x => x.trim())
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

  let prev = Array.from(
    { length: b.length + 1 },
    (_, i) => i
  );

  for (let i = 1; i <= a.length; i++) {
    const cur = [i];

    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        cur[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] +
          (a[i - 1] === b[j - 1] ? 0 : 1)
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
  const normalized = normalizeText(text);
  const compact = compactText(text);
  const words = normalized.split(/\s+/).filter(Boolean);

  for (const rawKeyword of keywords) {
    const keyword = normalizeText(rawKeyword);

    if (!keyword) continue;

    const compactKeyword = compactText(keyword);

    /*
     * Exact:
     *
     * "تبریک"
     * "تبریک خیلی زیاد"
     * "سلام تبریک"
     */
    if (
      normalized.includes(keyword) ||
      compact.includes(compactKeyword)
    ) {
      return {
        matched: true,
        keyword: rawKeyword,
        mode: 'exact',
        distance: 0
      };
    }

    /*
     * Fuzzy single word.
     */
    const targetWords = keyword
      .split(/\s+/)
      .filter(Boolean);

    if (targetWords.length === 1) {
      const target = targetWords[0];
      const threshold = typoThreshold(target);

      for (const word of words) {
        if (
          Math.abs(word.length - target.length) <=
          threshold
        ) {
          if (
            word.includes(target) ||
            target.includes(word)
          ) {
            return {
              matched: true,
              keyword: rawKeyword,
              mode: 'substring-typo',
              distance: Math.abs(
                word.length - target.length
              )
            };
          }
        }

        if (threshold > 0) {
          const d = distance(word, target);

          if (d <= threshold) {
            return {
              matched: true,
              keyword: rawKeyword,
              mode: 'typo',
              distance: d
            };
          }
        }
      }

      continue;
    }

    /*
     * Fuzzy multi-word.
     */
    for (
      let start = 0;
      start <= words.length - targetWords.length;
      start++
    ) {
      let ok = true;
      let totalDistance = 0;

      for (let i = 0; i < targetWords.length; i++) {
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

function appendLog(
  message,
  data = {}
) {
  const line = {
    time: now(),
    message,
    ...data
  };

  fs.appendFileSync(
    path.join(
      ARTIFACTS,
      'automation.log'
    ),
    JSON.stringify(line) + '\n',
    'utf8'
  );

  console.log(
    `[${line.time}] ${message}`,
    Object.keys(data).length
      ? data
      : ''
  );
}

function writeJson(
  filename,
  data
) {
  fs.writeFileSync(
    path.join(
      ARTIFACTS,
      filename
    ),
    JSON.stringify(
      data,
      null,
      2
    ),
    'utf8'
  );
}

async function safeClick(
  locator,
  timeout = 3000
) {
  try {
    await locator
      .first()
      .click({
        timeout
      });

    return true;
  } catch {
    return false;
  }
}

async function clickText(
  page,
  patterns,
  timeout = 3000
) {
  for (const pattern of patterns) {
    const candidates = [
      page
        .getByRole(
          'button',
          {
            name: pattern
          }
        )
        .first(),

      page
        .getByRole(
          'link',
          {
            name: pattern
          }
        )
        .first(),

      page
        .getByText(
          pattern
        )
        .first()
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
  if (
    !env.INSTAGRAM_SESSION_B64?.trim()
  ) {
    return null;
  }

  const decoded =
    Buffer
      .from(
        env.INSTAGRAM_SESSION_B64.trim(),
        'base64'
      )
      .toString('utf8');

  return JSON.parse(decoded);
}

async function login(
  page,
  context
) {
  await page.goto(
    'https://www.instagram.com/',
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
        'Instagram session is unavailable.'
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
        'Instagram requires interactive login/2FA.'
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

/**
 * مهم:
 *
 * در Instagram Web دسکتاپ،
 * پنل کامنت این پست داخل سمت راست صفحه است
 * و الزاماً role=dialog ندارد.
 *
 * بنابراین پنل را بر اساس:
 *
 * - position در سمت راست
 * - scrollable بودن
 * - ارتفاع مناسب
 * - scrollHeight
 * - وجود Add a comment / View insights
 *
 * پیدا می‌کنیم.
 */
async function findWebCommentPanel(
  page
) {
  return page.evaluate(() => {
    const viewportWidth =
      window.innerWidth;

    const all =
      Array.from(
        document.querySelectorAll(
          'body *'
        )
      );

    const candidates = [];

    for (const element of all) {
      const style =
        getComputedStyle(
          element
        );

      const rect =
        element.getBoundingClientRect();

      if (
        rect.width < 260 ||
        rect.width > 550
      ) {
        continue;
      }

      if (
        rect.height < 220
      ) {
        continue;
      }

      if (
        rect.x <
        viewportWidth * 0.50
      ) {
        continue;
      }

      if (
        !/(auto|scroll)/.test(
          style.overflowY
        )
      ) {
        continue;
      }

      if (
        element.scrollHeight <=
        element.clientHeight + 50
      ) {
        continue;
      }

      const text =
        element.innerText || '';

      let score = 0;

      if (
        /Add a comment/i.test(
          text
        )
      ) {
        score += 20;
      }

      if (
        /View insights/i.test(
          text
        )
      ) {
        score += 10;
      }

      if (
        /Boost post/i.test(
          text
        )
      ) {
        score += 5;
      }

      if (
        rect.x >
        viewportWidth * 0.58
      ) {
        score += 5;
      }

      if (
        element.scrollHeight >
        800
      ) {
        score += 5;
      }

      candidates.push({
        element,
        score,
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        },
        scrollTop:
          element.scrollTop,
        scrollHeight:
          element.scrollHeight,
        clientHeight:
          element.clientHeight
      });
    }

    candidates.sort(
      (a, b) =>
        b.score - a.score
    );

    if (!candidates.length) {
      return null;
    }

    const best =
      candidates[0];

    /*
     * یک index پایدار در querySelectorAll
     * برای استفاده در همان لحظه.
     */
    const index =
      all.indexOf(
        best.element
      );

    return {
      index,
      ...best,
      candidateCount:
        candidates.length
    };
  });
}

/**
 * اسکرول مستقیم همان پنل سمت راست.
 */
async function scrollWebCommentPanel(
  page,
  amount
) {
  return page.evaluate(
    pixels => {
      const viewportWidth =
        window.innerWidth;

      const all =
        Array.from(
          document.querySelectorAll(
            'body *'
          )
        );

      const candidates =
        all.filter(
          element => {
            const style =
              getComputedStyle(
                element
              );

            const rect =
              element.getBoundingClientRect();

            if (
              rect.width < 260 ||
              rect.width > 550
            ) {
              return false;
            }

            if (
              rect.height < 220
            ) {
              return false;
            }

            if (
              rect.x <
              viewportWidth * 0.50
            ) {
              return false;
            }

            if (
              !/(auto|scroll)/.test(
                style.overflowY
              )
            ) {
              return false;
            }

            return (
              element.scrollHeight >
              element.clientHeight + 50
            );
          }
        );

      candidates.sort(
        (a, b) => {
          const score = element => {
            const rect =
              element.getBoundingClientRect();

            const text =
              element.innerText ||
              '';

            let value = 0;

            if (
              /Add a comment/i.test(
                text
              )
            ) {
              value += 20;
            }

            if (
              /View insights/i.test(
                text
              )
            ) {
              value += 10;
            }

            if (
              rect.x >
              viewportWidth * 0.58
            ) {
              value += 5;
            }

            return value;
          };

          return (
            score(b) -
            score(a)
          );
        }
      );

      const panel =
        candidates[0];

      if (!panel) {
        return null;
      }

      const before =
        panel.scrollTop;

      const max =
        Math.max(
          0,
          panel.scrollHeight -
            panel.clientHeight
        );

      panel.scrollTop =
        Math.min(
          max,
          before + pixels
        );

      return {
        before,
        after:
          panel.scrollTop,
        max,
        changed:
          panel.scrollTop !== before
      };
    },
    amount
  );
}

/**
 * یک بار screenshot:
 *
 * قبل از آن کمی وارد لیست کامنت‌ها می‌شویم
 * تا خود لیست دیده شود، نه فقط کپشن.
 */
async function saveCommentsScreenshot(
  page
) {
  await scrollWebCommentPanel(
    page,
    450
  );

  await page.waitForTimeout(
    700
  );

  const panel =
    await findWebCommentPanel(
      page
    );

  const file =
    path.join(
      ARTIFACTS,
      'comments-list.png'
    );

  if (
    panel &&
    panel.rect
  ) {
    const viewport =
      await page
        .viewportSize();

    const x =
      Math.max(
        0,
        Math.floor(
          panel.rect.x
        )
      );

    const y =
      Math.max(
        0,
        Math.floor(
          panel.rect.y
        )
      );

    const width =
      Math.min(
        Math.floor(
          panel.rect.width
        ),
        viewport.width - x
      );

    const height =
      Math.min(
        Math.floor(
          panel.rect.height
        ),
        viewport.height - y
      );

    if (
      width > 10 &&
      height > 10
    ) {
      await page.screenshot({
        path: file,
        clip: {
          x,
          y,
          width,
          height
        }
      });

      return file;
    }
  }

  await page.screenshot({
    path: file,
    fullPage: false
  });

  return file;
}

/**
 * متن‌های UI که نباید به‌عنوان comment گرفته شوند.
 */
function isUiLine(
  line
) {
  const n =
    normalizeText(
      line
    );

  if (!n) return true;

  if (
    /^(follow|following|reply|replies|like|likes|more|translated|view all replies)$/i.test(
      n
    )
  ) {
    return true;
  }

  if (
    /^(دنبال کردن|دنبال شده|پاسخ|پاسخ ها|پسندیدن|بیشتر|ترجمه|نمایش همه پاسخ ها)$/i.test(
      n
    )
  ) {
    return true;
  }

  if (
    /^(\d+([smhdw]|\s*(ثانیه|دقیقه|ساعت|روز|هفته|ماه|سال)))$/i.test(
      n
    )
  ) {
    return true;
  }

  if (
    /^\d+([,.]\d+)*$/.test(
      n
    )
  ) {
    return true;
  }

  return false;
}

/**
 * این تابع فقط داخل پنل سمت راست دنبال
 * profile link + comment row می‌گردد.
 */
async function extractVisibleComments(
  page
) {
  return page.evaluate(() => {
    const viewportWidth =
      window.innerWidth;

    const normalize =
      value =>
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
          .replace(
            /ي/g,
            'ی'
          )
          .replace(
            /ى/g,
            'ی'
          )
          .replace(
            /ك/g,
            'ک'
          )
          .replace(
            /[ۀە]/g,
            'ه'
          )
          .replace(
            /[أإآ]/g,
            'ا'
          )
          .replace(
            /ؤ/g,
            'و'
          )
          .replace(
            /\s+/g,
            ' '
          )
          .trim();

    const isSimpleProfile =
      href => {
        return (
          /^\/[^/]+\/?$/.test(
            href
          ) &&
          !/^\/(explore|reels|direct|accounts|stories|p|reel|about|legal)\b/i.test(
            href
          )
        );
      };

    const all =
      Array.from(
        document.querySelectorAll(
          'body *'
        )
      );

    const panels =
      all.filter(
        element => {
          const style =
            getComputedStyle(
              element
            );

          const rect =
            element.getBoundingClientRect();

          if (
            rect.width < 260 ||
            rect.width > 550
          ) {
            return false;
          }

          if (
            rect.height < 220
          ) {
            return false;
          }

          if (
            rect.x <
            viewportWidth * 0.50
          ) {
            return false;
          }

          if (
            !/(auto|scroll)/.test(
              style.overflowY
            )
          ) {
            return false;
          }

          return (
            element.scrollHeight >
            element.clientHeight + 50
          );
        }
      );

    if (!panels.length) {
      return [];
    }

    panels.sort(
      (a, b) => {
        const score = el => {
          const rect =
            el.getBoundingClientRect();

          const text =
            el.innerText || '';

          let s = 0;

          if (
            /Add a comment/i.test(
              text
            )
          ) {
            s += 20;
          }

          if (
            /View insights/i.test(
              text
            )
          ) {
            s += 10;
          }

          if (
            rect.x >
            viewportWidth * 0.58
          ) {
            s += 5;
          }

          return s;
        };

        return score(b) - score(a);
      }
    );

    const panel =
      panels[0];

    const links =
      Array.from(
        panel.querySelectorAll(
          'a[href^="/"]'
        )
      ).filter(
        link =>
          isSimpleProfile(
            link.getAttribute(
              'href'
            ) || ''
          )
      );

    const results = [];
    const seen = new Set();

    for (
      const link of links
    ) {
      const profilePath =
        link.getAttribute(
          'href'
        ) || '';

      const username =
        (
          link.textContent ||
          ''
        ).trim();

      if (
        !username
      ) {
        continue;
      }

      const normalizedUsername =
        normalize(
          username
        );

      let node =
        link;

      let row = null;

      /*
       * از لینک username به بالا می‌رویم
       * تا کوچک‌ترین wrapperی که واقعاً
       * متعلق به یک comment باشد پیدا شود.
       */
      for (
        let level = 0;
        level < 10 &&
        node &&
        node !== panel;
        level++
      ) {
        node =
          node.parentElement;

        if (!node) {
          break;
        }

        const text =
          (
            node.innerText ||
            ''
          ).trim();

        if (
          !text ||
          text.length > 700
        ) {
          continue;
        }

        const normalizedText =
          normalize(
            text
          );

        if (
          !normalizedText.includes(
            normalizedUsername
          )
        ) {
          continue;
        }

        const hasReply =
          /(^|\n)\s*(reply|پاسخ)\s*($|\n)/i.test(
            text
          );

        const hasTime =
          node.querySelector(
            'time'
          ) !== null;

        /*
         * پست اصلی ممکن است username و caption
         * داشته باشد ولی Reply ندارد.
         *
         * بنابراین Reply یا time لازم است.
         */
        if (
          !hasReply &&
          !hasTime
        ) {
          continue;
        }

        /*
         * اگر متن شامل Add a comment یا View insights
         * باشد این wrapper مربوط به خود پست است.
         */
        if (
          /Add a comment|View insights|Boost post/i.test(
            text
          )
        ) {
          continue;
        }

        row = node;
        break;
      }

      if (!row) {
        continue;
      }

      const rawLines =
        (
          row.innerText ||
          ''
        )
          .split('\n')
          .map(
            x => x.trim()
          )
          .filter(
            Boolean
          );

      const commentLines =
        rawLines.filter(
          line => {
            const n =
              normalize(
                line
              );

            if (
              !n
            ) {
              return false;
            }

            if (
              n ===
              normalizedUsername
            ) {
              return false;
            }

            if (
              /^(follow|following|reply|replies|like|likes|more|translated|view all replies)$/i.test(
                n
              )
            ) {
              return false;
            }

            if (
              /^(دنبال کردن|دنبال شده|پاسخ|پاسخ ها|پسندیدن|بیشتر|ترجمه|نمایش همه پاسخ ها)$/i.test(
                n
              )
            ) {
              return false;
            }

            if (
              /^\d+([smhdw])$/i.test(
                n
              )
            ) {
              return false;
            }

            if (
              /^\d+([,.]\d+)*$/.test(
                n
              )
            ) {
              return false;
            }

            if (
              /^(\d+)\s*(s|m|h|d|w|mo|y)$/i.test(
                n
              )
            ) {
              return false;
            }

            return true;
          }
        );

      if (
        !commentLines.length
      ) {
        continue;
      }

      const commentText =
        commentLines.join(
          '\n'
        ).trim();

      const normalizedComment =
        normalize(
          commentText
        );

      if (
        !normalizedComment
      ) {
        continue;
      }

      /*
       * کل wrapper مربوط به پست را فیلتر می‌کنیم.
       */
      if (
        /200|بازدید|View insights|Boost post|Add a comment/i.test(
          commentText
        ) &&
        commentText.length > 250
      ) {
        continue;
      }

      const key =
        `${profilePath}|${normalizedComment}`;

      if (
        seen.has(key)
      ) {
        continue;
      }

      seen.add(key);

      results.push({
        username,
        profilePath,
        commentText,
        normalizedComment,
        rowText:
          textSafe(row)
      });
    }

    return results;

    function textSafe(node) {
      return (
        node?.innerText ||
        ''
      )
        .trim()
        .slice(0, 1000);
    }
  });
}

/**
 * "View more comments" در همان پنل.
 */
async function clickMoreComments(
  page
) {
  return page.evaluate(() => {
    const viewportWidth =
      window.innerWidth;

    const all =
      Array.from(
        document.querySelectorAll(
          'body *'
        )
      );

    const panels =
      all.filter(
        element => {
          const style =
            getComputedStyle(
              element
            );

          const rect =
            element.getBoundingClientRect();

          return (
            rect.width >= 260 &&
            rect.width <= 550 &&
            rect.height >= 220 &&
            rect.x >
              viewportWidth * 0.50 &&
            /(auto|scroll)/.test(
              style.overflowY
            ) &&
            element.scrollHeight >
              element.clientHeight + 50
          );
        }
      );

    if (!panels.length) {
      return false;
    }

    panels.sort(
      (a, b) => {
        const score =
          element => {
            const text =
              element.innerText || '';

            let s = 0;

            if (
              /Add a comment/i.test(
                text
              )
            ) {
              s += 20;
            }

            if (
              /View insights/i.test(
                text
              )
            ) {
              s += 10;
            }

            return s;
          };

        return score(b) - score(a);
      }
    );

    const panel =
      panels[0];

    const candidates =
      Array.from(
        panel.querySelectorAll(
          'button,[role="button"],a,span,div'
        )
      );

    for (
      const candidate of
      candidates
    ) {
      const text =
        (
          candidate.innerText ||
          ''
        ).trim();

      if (
        /^(View more comments|Load more comments|View all \d+ comments|View all comments|نمایش نظرهای بیشتر|نمایش دیدگاه‌های بیشتر)$/i.test(
          text
        )
      ) {
        candidate.click();

        return true;
      }
    }

    return false;
  });
}

/**
 * Reply را با username + commentText پیدا می‌کنیم.
 */
async function clickReplyForComment(
  page,
  comment
) {
  return page.evaluate(
    target => {
      const viewportWidth =
        window.innerWidth;

      const normalize =
        value =>
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
            .replace(
              /ي/g,
              'ی'
            )
            .replace(
              /ى/g,
              'ی'
            )
            .replace(
              /ك/g,
              'ک'
            )
            .replace(
              /[ۀە]/g,
              'ه'
            )
            .replace(
              /[أإآ]/g,
              'ا'
            )
            .replace(
              /ؤ/g,
              'و'
            )
            .replace(
              /\s+/g,
              ' '
            )
            .trim();

      const panels =
        Array.from(
          document.querySelectorAll(
            'body *'
          )
        )
          .filter(
            element => {
              const style =
                getComputedStyle(
                  element
                );

              const rect =
                element.getBoundingClientRect();

              return (
                rect.width >= 260 &&
                rect.width <= 550 &&
                rect.height >= 220 &&
                rect.x >
                  viewportWidth * 0.50 &&
                /(auto|scroll)/.test(
                  style.overflowY
                ) &&
                element.scrollHeight >
                  element.clientHeight + 50
              );
            }
          );

      if (!panels.length) {
        return {
          clicked: false,
          reason:
            'comment-panel-not-found'
        };
      }

      panels.sort(
        (a, b) => {
          const score =
            element => {
              const text =
                element.innerText ||
                '';

              let s = 0;

              if (
                /Add a comment/i.test(
                  text
                )
              ) {
                s += 20;
              }

              if (
                /View insights/i.test(
                  text
                )
              ) {
                s += 10;
              }

              return s;
            };

          return score(b) - score(a);
        }
      );

      const panel =
        panels[0];

      const links =
        Array.from(
          panel.querySelectorAll(
            'a[href^="/"]'
          )
        );

      for (
        const link of links
      ) {
        const href =
          link.getAttribute(
            'href'
          ) || '';

        if (
          href !==
          target.profilePath
        ) {
          continue;
        }

        const linkText =
          normalize(
            link.textContent ||
              ''
          );

        if (
          linkText !==
          normalize(
            target.username
          )
        ) {
          continue;
        }

        let node =
          link;

        for (
          let level = 0;
          level < 10 &&
          node &&
          node !== panel;
          level++
        ) {
          node =
            node.parentElement;

          if (!node) {
            break;
          }

          const text =
            normalize(
              node.innerText ||
                ''
            );

          if (
            !text.includes(
              normalize(
                target.commentText
              )
            )
          ) {
            continue;
          }

          if (
            !text.includes(
              normalize(
                target.username
              )
            )
          ) {
            continue;
          }

          const elements =
            Array.from(
              node.querySelectorAll(
                'button,[role="button"],span,div'
              )
            );

          for (
            const el of elements
          ) {
            const label =
              normalize(
                (
                  el.innerText ||
                  ''
                ).trim()
              );

            const aria =
              normalize(
                el.getAttribute(
                  'aria-label'
                ) || ''
              );

            if (
              label ===
                'reply' ||
              label ===
                'پاسخ' ||
              aria.includes(
                'reply'
              ) ||
              aria.includes(
                'پاسخ'
              )
            ) {
              el.click();

              return {
                clicked: true,
                rowText:
                  (
                    node.innerText ||
                    ''
                  )
                    .trim()
                    .slice(
                      0,
                      800
                    )
              };
            }
          }

          /*
           * ممکن است Reply داخل text باشد
           * ولی button نباشد.
           */
          const replyText =
            Array.from(
              node.querySelectorAll(
                '*'
              )
            ).find(
              el => {
                const t =
                  (
                    el.textContent ||
                    ''
                  ).trim();

                return (
                  /^Reply$/i.test(
                    t
                  ) ||
                  /^پاسخ$/i.test(
                    t
                  )
                );
              }
            );

          if (
            replyText
          ) {
            replyText.click();

            return {
              clicked: true,
              rowText:
                (
                  node.innerText ||
                  ''
                )
                  .trim()
                  .slice(
                    0,
                    800
                  )
            };
          }
        }
      }

      return {
        clicked: false,
        reason:
          'reply-control-not-found'
      };
    },
    comment
  );
}

async function sendReply(
  page,
  comment,
  replyText
) {
  const result =
    await clickReplyForComment(
      page,
      comment
    );

  if (
    !result.clicked
  ) {
    throw new Error(
      `Reply control not found: ${result.reason}`
    );
  }

  await page.waitForTimeout(
    500
  );

  const inputs = [
    page
      .getByPlaceholder(
        /Reply|Add a comment|پاسخ|نظر/i
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

  let input = null;

  for (
    const candidate of
    inputs
  ) {
    if (
      await candidate
        .isVisible()
        .catch(
          () => false
        )
    ) {
      input =
        candidate;

      break;
    }
  }

  if (!input) {
    throw new Error(
      'Reply input was not found.'
    );
  }

  await input.fill(
    replyText
  );

  let sent =
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
    1000
  );

  const value =
    await input
      .inputValue()
      .catch(
        () => ''
      );

  /*
   * اگر input خالی نشده،
   * یک بار دیگر Enter می‌زنیم.
   */
  if (
    String(value || '').trim()
  ) {
    await input.press(
      'Enter'
    );

    await page.waitForTimeout(
      900
    );
  }

  const finalValue =
    await input
      .inputValue()
      .catch(
        () => ''
      );

  if (
    String(finalValue || '').trim()
  ) {
    throw new Error(
      'Reply was not confirmed: input still contains text.'
    );
  }
}

async function sendDM(
  dmPage,
  profilePath,
  username,
  message
) {
  const origin =
    new URL(
      dmPage.url()
    ).origin;

  const url =
    new URL(
      profilePath,
      origin
    ).href;

  await dmPage.goto(
    url,
    {
      waitUntil:
        'domcontentloaded',
      timeout: 30000
    }
  );

  await dmPage.waitForTimeout(
    1000
  );

  await dismissCommonPopups(
    dmPage
  );

  let opened =
    await clickText(
      dmPage,
      [
        /Message/i,
        /Send message/i,
        /پیام/i
      ],
      3500
    );

  if (!opened) {
    const more =
      dmPage
        .getByLabel(
          /More options|گزینه‌های بیشتر/i
        )
        .first();

    if (
      await more
        .isVisible()
        .catch(
          () => false
        )
    ) {
      await safeClick(
        more,
        2000
      );

      await dmPage.waitForTimeout(
        400
      );
    }

    opened =
      await clickText(
        dmPage,
        [
          /Message/i,
          /Send message/i,
          /پیام/i
        ],
        3000
      );
  }

  if (!opened) {
    throw new Error(
      `Message button not found for ${username}.`
    );
  }

  const inputs = [
    dmPage
      .getByPlaceholder(
        /Message/i
      )
      .last(),

    dmPage
      .getByPlaceholder(
        /پیام/i
      )
      .last(),

    dmPage
      .locator(
        'textarea'
      )
      .last(),

    dmPage
      .locator(
        '[contenteditable="true"]'
      )
      .last()
  ];

  let input = null;

  for (
    const candidate of
    inputs
  ) {
    if (
      await candidate
        .isVisible()
        .catch(
          () => false
        )
    ) {
      input =
        candidate;

      break;
    }
  }

  if (!input) {
    throw new Error(
      `DM input not found for ${username}.`
    );
  }

  await input.fill(
    message
  );

  const sent =
    await clickText(
      dmPage,
      [
        'Send',
        'ارسال'
      ],
      3000
    );

  if (!sent) {
    await input.press(
      'Enter'
    );
  }

  await dmPage.waitForTimeout(
    1000
  );

  const value =
    await input
      .inputValue()
      .catch(
        () => ''
      );

  if (
    String(value || '').trim()
  ) {
    await input.press(
      'Enter'
    );

    await dmPage.waitForTimeout(
      900
    );
  }

  const finalValue =
    await input
      .inputValue()
      .catch(
        () => ''
      );

  if (
    String(finalValue || '').trim()
  ) {
    throw new Error(
      `DM was not confirmed for ${username}: input still contains text.`
    );
  }
}

async function processMatch(
  page,
  dmPage,
  comment,
  keywordResult,
  commentReply,
  dmReply
) {
  const result = {
    username:
      comment.username,

    profilePath:
      comment.profilePath,

    comment:
      comment.commentText,

    keyword:
      keywordResult.keyword,

    matchMode:
      keywordResult.mode,

    matchDistance:
      keywordResult.distance || 0,

    reply:
      'pending',

    dm:
      'pending',

    status:
      'pending'
  };

  appendLog(
    'MATCH_FOUND',
    {
      username:
        comment.username,

      profile:
        comment.profilePath,

      keyword:
        keywordResult.keyword,

      mode:
        keywordResult.mode,

      comment:
        comment.commentText
    }
  );

  try {
    /*
     * Reply در صفحه اصلی
     */
    await sendReply(
      page,
      comment,
      commentReply
    );

    result.reply =
      'sent';

    appendLog(
      'REPLY_SENT',
      {
        username:
          comment.username,

        comment:
          comment.commentText
      }
    );

    /*
     * DM در Page دوم
     */
    await sendDM(
      dmPage,
      comment.profilePath,
      comment.username,
      dmReply
    );

    result.dm =
      'sent';

    result.status =
      'done';

    appendLog(
      'DM_SENT',
      {
        username:
          comment.username
      }
    );
  } catch (error) {
    result.status =
      'error';

    result.error =
      String(
        error?.message ||
          error
      );

    appendLog(
      'MATCH_FAILED',
      {
        username:
          comment.username,

        comment:
          comment.commentText,

        error:
          result.error
      }
    );
  }

  return result;
}

async function processPost(
  page,
  dmPage,
  url,
  keywords,
  commentReply,
  dmReply,
  postIndex
) {
  const postLog = {
    postIndex,
    url,
    startedAt:
      now(),

    screenshot:
      null,

    rounds:
      0,

    commentsScanned:
      0,

    matchesFound:
      0,

    matchesCompleted:
      0,

    matchesFailed:
      0,

    matches:
      []
  };

  appendLog(
    'OPEN_POST',
    {
      url
    }
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

  await dismissCommonPopups(
    page
  );

  /*
   * اول تلاش می‌کنیم پنل inline وب را پیدا کنیم.
   */
  let panel =
    await findWebCommentPanel(
      page
    );

  /*
   * اگر هنوز نبود،
   * یک بار روی comment control می‌زنیم.
   */
  if (!panel) {
    appendLog(
      'COMMENT_PANEL_NOT_FOUND_INITIAL'
    );

    const clicked =
      await clickText(
        page,
        [
          /comment/i,
          /comments/i,
          /نظر/i,
          /دیدگاه/i
        ],
        3000
      );

    appendLog(
      'COMMENT_CONTROL_CLICK_RESULT',
      {
        clicked
      }
    );

    await page.waitForTimeout(
      1200
    );
  }

  panel =
    await findWebCommentPanel(
      page
    );

  if (!panel) {
    throw new Error(
      'Instagram Web comment panel could not be located.'
    );
  }

  appendLog(
    'COMMENT_PANEL_FOUND',
    {
      rect:
        panel.rect,

      scrollHeight:
        panel.scrollHeight,

      clientHeight:
        panel.clientHeight
    }
  );

  /*
   * فقط یک Screenshot.
   */
  postLog.screenshot =
    await saveCommentsScreenshot(
      page
    );

  appendLog(
    'COMMENTS_SCREENSHOT_SAVED',
    {
      path:
        postLog.screenshot
    }
  );

  /*
   * برگرد به ابتدای پنل برای شروع scan.
   */
  await page.evaluate(() => {
    const viewportWidth =
      window.innerWidth;

    const all =
      Array.from(
        document.querySelectorAll(
          'body *'
        )
      );

    const candidates =
      all.filter(
        element => {
          const style =
            getComputedStyle(
              element
            );

          const rect =
            element.getBoundingClientRect();

          return (
            rect.width >= 260 &&
            rect.width <= 550 &&
            rect.height >= 220 &&
            rect.x >
              viewportWidth * 0.50 &&
            /(auto|scroll)/.test(
              style.overflowY
            ) &&
            element.scrollHeight >
              element.clientHeight + 50
          );
        }
      );

    candidates.sort(
      (a, b) => {
        const score =
          element => {
            const text =
              element.innerText ||
              '';

            let s = 0;

            if (
              /Add a comment/i.test(
                text
              )
            ) {
              s += 20;
            }

            if (
              /View insights/i.test(
                text
              )
            ) {
              s += 10;
            }

            return s;
          };

        return score(b) - score(a);
      }
    );

    if (
      candidates[0]
    ) {
      candidates[0].scrollTop =
        0;
    }
  });

  const processedMatchKeys =
    new Set();

  let stableRounds = 0;
  let lastCommentCount = -1;

  for (
    let round = 1;
    round <= MAX_SCAN_ROUNDS;
    round++
  ) {
    postLog.rounds =
      round;

    /*
     * در هر دور فقط همین پنل بررسی می‌شود.
     */
    const comments =
      await extractVisibleComments(
        page
      );

    let newComments =
      0;

    let roundMatches =
      0;

    for (
      const comment of
      comments
    ) {
      /*
       * Match قبل از هر چیز.
       */
      const match =
        keywordMatch(
          comment.commentText,
          keywords
        );

      if (
        !match.matched
      ) {
        continue;
      }

      const key =
        `${comment.profilePath}|${compactText(
          comment.commentText
        )}|${match.keyword}`;

      if (
        processedMatchKeys.has(
          key
        )
      ) {
        continue;
      }

      processedMatchKeys.add(
        key
      );

      roundMatches++;

      postLog.matchesFound++;

      /*
       * همین الان پردازش.
       */
      const item =
        await processMatch(
          page,
          dmPage,
          comment,
          match,
          commentReply,
          dmReply
        );

      postLog.matches.push(
        item
      );

      if (
        item.status === 'done'
      ) {
        postLog.matchesCompleted++;
      } else {
        postLog.matchesFailed++;
      }
    }

    /*
     * شمارش commentهای دیده شده.
     */
    const currentCount =
      comments.length;

    if (
      currentCount !==
      lastCommentCount
    ) {
      newComments =
        Math.max(
          0,
          currentCount -
            Math.max(
              0,
              lastCommentCount
            )
        );
    }

    if (
      round === 1 ||
      roundMatches > 0 ||
      round % 5 === 0
    ) {
      appendLog(
        'SCAN_ROUND',
        {
          round,

          visibleComments:
            comments.length,

          roundMatches,

          totalMatches:
            postLog.matchesFound,

          matchesCompleted:
            postLog.matchesCompleted,

          matchesFailed:
            postLog.matchesFailed
        }
      );
    }

    /*
     * Load more.
     */
    const clickedMore =
      await clickMoreComments(
        page
      );

    await page.waitForTimeout(
      500
    );

    const scrollResult =
      await scrollWebCommentPanel(
        page,
        SCROLL_PIXELS
      );

    await page.waitForTimeout(
      SCROLL_WAIT_MS
    );

    if (
      currentCount ===
        lastCommentCount &&
      !clickedMore &&
      !scrollResult?.changed &&
      roundMatches === 0
    ) {
      stableRounds++;
    } else {
      stableRounds = 0;
    }

    lastCommentCount =
      currentCount;

    /*
     * توقف فقط بعد چند دور واقعاً ثابت.
     */
    if (
      stableRounds >=
      5
    ) {
      appendLog(
        'SCAN_FINISHED_STABLE',
        {
          round,
          comments:
            currentCount,
          matches:
            postLog.matchesFound
        }
      );

      break;
    }
  }

  /*
   * یک scan نهایی از همین position
   * تا کامنتی که دقیقاً در همان لحظه visible
   * است از دست نرود.
   */
  const finalComments =
    await extractVisibleComments(
      page
    );

  for (
    const comment of
    finalComments
  ) {
    const match =
      keywordMatch(
        comment.commentText,
        keywords
      );

    if (
      !match.matched
    ) {
      continue;
    }

    const key =
      `${comment.profilePath}|${compactText(
        comment.commentText
      )}|${match.keyword}`;

    if (
      processedMatchKeys.has(
        key
      )
    ) {
      continue;
    }

    processedMatchKeys.add(
      key
    );

    postLog.matchesFound++;

    const item =
      await processMatch(
        page,
        dmPage,
        comment,
        match,
        commentReply,
        dmReply
      );

    postLog.matches.push(
      item
    );

    if (
      item.status === 'done'
    ) {
      postLog.matchesCompleted++;
    } else {
      postLog.matchesFailed++;
    }
  }

  postLog.commentsScanned =
    lastCommentCount;

  postLog.finishedAt =
    now();

  appendLog(
    'POST_FINISHED',
    {
      url,

      commentsScanned:
        postLog.commentsScanned,

      matchesFound:
        postLog.matchesFound,

      matchesCompleted:
        postLog.matchesCompleted,

      matchesFailed:
        postLog.matchesFailed,

      screenshot:
        postLog.screenshot
    }
  );

  return postLog;
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

  /*
   * پاک کردن log قبلی
   */
  fs.writeFileSync(
    path.join(
      ARTIFACTS,
      'automation.log'
    ),
    '',
    'utf8'
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

  /*
   * Page اصلی:
   * Post + comments
   */
  const page =
    await context.newPage();

  /*
   * Page دوم:
   * DM
   */
  const dmPage =
    await context.newPage();

  const runLog = {
    startedAt:
      now(),

    keywords,
    postUrls,

    config: {
      maxScanRounds:
        MAX_SCAN_ROUNDS,

      scrollPixels:
        SCROLL_PIXELS,

      scrollWaitMs:
        SCROLL_WAIT_MS,

      screenshotCountPerPost:
        1,

      engine:
        'Instagram Web Desktop inline right-side comment panel'
    },

    posts: [],
    errors: []
  };

  try {
    appendLog(
      'LOGIN_START'
    );

    await login(
      page,
      context
    );

    appendLog(
      'LOGIN_OK'
    );

    for (
      let i = 0;
      i < postUrls.length;
      i++
    ) {
      try {
        const result =
          await processPost(
            page,
            dmPage,
            postUrls[i],
            keywords,
            commentReply,
            dmReply,
            i
          );

        runLog.posts.push(
          result
        );
      } catch (error) {
        const message =
          String(
            error?.message ||
              error
          );

        runLog.errors.push({
          url:
            postUrls[i],
          error:
            message
        });

        appendLog(
          'POST_ERROR',
          {
            url:
              postUrls[i],
            error:
              message
          }
        );
      }
    }
  } finally {
    runLog.finishedAt =
      now();

    /*
     * Summary.
     */
    writeJson(
      'run-summary.json',
      runLog
    );

    await context
      .storageState({
        path:
          path.join(
            ARTIFACTS,
            'session-after-run.json'
          )
      })
      .catch(
        () => {}
      );

    await browser.close();
  }

  if (
    runLog.errors.length > 0 ||
    runLog.posts.some(
      post =>
        post.matchesFailed > 0
    )
  ) {
    process.exitCode =
      1;
  }
}

main().catch(
  error => {
    writeJson(
      'fatal-error.json',
      {
        time:
          now(),

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
