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
  env.INSTAGRAM_COMMENT_SCROLL_PIXELS || 650
);

const SCROLL_WAIT_MS = Number(
  env.INSTAGRAM_COMMENT_SCROLL_WAIT_MS || 900
);

const LOG_EVERY_N_ROUNDS = Number(
  env.INSTAGRAM_LOG_EVERY_N_ROUNDS || 1
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
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * فارسی را برای مقایسه مقاوم‌تر نرمال می‌کند:
 * - ي / ى -> ی
 * - ك -> ک
 * - حذف اعراب
 * - حذف نیم‌فاصله و کاراکترهای نامرئی
 * - یکسان‌سازی فاصله
 */
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

/**
 * Levenshtein
 */
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

  return Math.max(
    3,
    Math.floor(n * 0.25)
  );
}

/**
 * تطبیق:
 * 1) دقیق
 * 2) داخل جمله
 * 3) بدون فاصله
 * 4) خطای املایی
 * 5) عبارت چندکلمه‌ای
 */
function keywordMatch(text, keywords) {
  const normalized = normalizeText(text);
  const compact = compactText(text);

  const words = normalized
    .split(/\s+/)
    .filter(Boolean);

  for (const rawKeyword of keywords) {
    const keyword =
      normalizeText(rawKeyword);

    if (!keyword) continue;

    const keywordCompact =
      compactText(keyword);

    // Exact anywhere.
    if (
      normalized.includes(keyword) ||
      compact.includes(keywordCompact)
    ) {
      return {
        matched: true,
        keyword: rawKeyword,
        mode: 'exact',
        distance: 0
      };
    }

    const targets =
      keyword.split(/\s+/)
        .filter(Boolean);

    // Single-word fuzzy match.
    if (targets.length === 1) {
      const target = targets[0];
      const threshold =
        typoThreshold(target);

      for (const word of words) {
        if (
          Math.abs(
            word.length - target.length
          ) <= threshold
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
          const d =
            distance(word, target);

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

    // Multi-word fuzzy phrase.
    for (
      let start = 0;
      start <=
        words.length - targets.length;
      start++
    ) {
      let totalDistance = 0;
      let ok = true;

      for (
        let i = 0;
        i < targets.length;
        i++
      ) {
        const word =
          words[start + i];

        const target =
          targets[i];

        if (word === target) {
          continue;
        }

        const d =
          distance(word, target);

        if (
          d >
          typoThreshold(target)
        ) {
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

function jsonFile(
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

function makeLogger(
  runLog,
  postLog
) {
  const write = (
    level,
    message,
    data = {}
  ) => {
    const event = {
      time: now(),
      level,
      message,
      ...data
    };

    postLog.events.push(event);

    runLog.events.push({
      ...event,
      postUrl: postLog.url
    });

    const suffix =
      Object.keys(data).length
        ? ` ${JSON.stringify(data)}`
        : '';

    const line =
      `${event.time} ` +
      `[${level.toUpperCase()}] ` +
      `${message}${suffix}`;

    fs.appendFileSync(
      path.join(
        ARTIFACTS,
        'automation.log'
      ),
      `${line}\n`,
      'utf8'
    );

    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  };

  return {
    info:
      (message, data) =>
        write(
          'info',
          message,
          data
        ),

    warn:
      (message, data) =>
        write(
          'warn',
          message,
          data
        ),

    error:
      (message, data) =>
        write(
          'error',
          message,
          data
        )
  };
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
  for (
    const pattern of patterns
  ) {
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

    for (
      const candidate of
      candidates
    ) {
      if (
        await candidate
          .isVisible()
          .catch(
            () => false
          )
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

async function dismissCommonPopups(
  page
) {
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

  for (
    const text of patterns
  ) {
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

  const raw =
    Buffer
      .from(
        env
          .INSTAGRAM_SESSION_B64
          .trim(),
        'base64'
      )
      .toString('utf8');

  return JSON.parse(raw);
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

  await dismissCommonPopups(
    page
  );

  if (
    page
      .url()
      .includes(
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
      3500
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

async function openComments(
  page,
  logger
) {
  const patterns = [
    /comment/i,
    /comments/i,
    /نظر/i,
    /دیدگاه/i
  ];

  logger.info(
    'Opening comments'
  );

  for (
    const pattern of patterns
  ) {
    const candidates = [
      page
        .getByLabel(
          pattern
        )
        .first(),

      page
        .getByRole(
          'button',
          {
            name: pattern
          }
        )
        .first()
    ];

    for (
      const candidate of
      candidates
    ) {
      if (
        await candidate
          .isVisible()
          .catch(
            () => false
          )
      ) {
        if (
          await safeClick(
            candidate,
            3500
          )
        ) {
          await page.waitForTimeout(
            1000
          );

          logger.info(
            'Comments control clicked'
          );

          return true;
        }
      }
    }
  }

  const buttons =
    page.locator(
      'button,[role="button"]'
    );

  const count =
    await buttons.count();

  for (
    let i = 0;
    i < Math.min(
      count,
      60
    );
    i++
  ) {
    const button =
      buttons.nth(i);

    const label =
      await button
        .getAttribute(
          'aria-label'
        )
        .catch(
          () => null
        );

    if (
      label &&
      /comment|نظر|دیدگاه/i.test(
        label
      )
    ) {
      if (
        await safeClick(
          button,
          2500
        )
      ) {
        await page.waitForTimeout(
          1000
        );

        logger.info(
          'Comments opened through aria-label fallback',
          {
            ariaLabel: label
          }
        );

        return true;
      }
    }
  }

  throw new Error(
    'Could not open the comments panel.'
  );
}

/**
 * دقیقاً یک Screenshot
 */
async function saveSingleCommentsScreenshot(
  page
) {
  const file =
    path.join(
      ARTIFACTS,
      'comments-list.png'
    );

  await page.screenshot({
    path: file,
    fullPage: false
  });

  return file;
}

async function findCommentsDialog(
  page
) {
  const dialogs =
    page.locator(
      '[role="dialog"]'
    );

  const count =
    await dialogs.count();

  if (!count) {
    return null;
  }

  return dialogs.last();
}

async function getScrollableCommentContainer(
  page
) {
  return page.evaluate(
    () => {
      const elements =
        Array.from(
          document.querySelectorAll(
            'body *'
          )
        )
          .filter(el => {
            const style =
              getComputedStyle(
                el
              );

            const rect =
              el.getBoundingClientRect();

            return (
              rect.width > 150 &&
              rect.height > 150 &&
              /(auto|scroll)/.test(
                style.overflowY
              ) &&
              el.scrollHeight >
                el.clientHeight +
                  80
            );
          })
          .map(el => {
            const rect =
              el.getBoundingClientRect();

            return {
              top: rect.top,
              height: rect.height,
              scrollTop:
                el.scrollTop,
              scrollHeight:
                el.scrollHeight,
              clientHeight:
                el.clientHeight
            };
          })
          .sort(
            (
              a,
              b
            ) =>
              b.scrollHeight -
              a.scrollHeight
          );

      return elements.slice(
        0,
        8
      );
    }
  );
}

async function scrollComments(
  page
) {
  return page.evaluate(
    pixels => {
      const dialog =
        document.querySelector(
          '[role="dialog"]'
        );

      const roots = [];

      if (dialog) {
        roots.push(dialog);
      }

      const candidates =
        Array.from(
          document.querySelectorAll(
            'body *'
          )
        ).filter(el => {
          const style =
            getComputedStyle(
              el
            );

          const rect =
            el.getBoundingClientRect();

          return (
            rect.width > 150 &&
            rect.height > 150 &&
            /(auto|scroll)/.test(
              style.overflowY
            ) &&
            el.scrollHeight >
              el.clientHeight +
                80
          );
        });

      roots.push(
        ...candidates
      );

      let changed = 0;
      const seen =
        new Set();

      for (
        const el of roots
      ) {
        if (
          seen.has(el)
        ) {
          continue;
        }

        seen.add(el);

        const before =
          el.scrollTop;

        const max =
          Math.max(
            0,
            el.scrollHeight -
              el.clientHeight
          );

        if (
          max > before
        ) {
          el.scrollTop =
            Math.min(
              max,
              before +
                pixels
            );

          if (
            el.scrollTop !==
            before
          ) {
            changed++;
          }
        }
      }

      return changed;
    },
    SCROLL_PIXELS
  );
}

async function clickMoreComments(
  page
) {
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

  for (
    const pattern of patterns
  ) {
    const candidates = [
      page
        .getByRole(
          'button',
          {
            name: pattern
          }
        ),

      page
        .getByText(
          pattern
        )
    ];

    for (
      const locator of
      candidates
    ) {
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
            await page.waitForTimeout(
              600
            );

            return true;
          }
        }
      }
    }
  }

  return false;
}

/**
 * مهم‌ترین قسمت:
 *
 * دیگر divهای عمومی صفحه را به عنوان کامنت
 * در نظر نمی‌گیریم.
 *
 * فقط داخل [role="dialog"] حرکت می‌کنیم
 * و از لینک پروفایل نویسنده به سمت parent
 * همان کامنت را پیدا می‌کنیم.
 */
async function extractVisibleComments(
  page
) {
  return page.evaluate(
    () => {
      const dialog =
        document.querySelector(
          '[role="dialog"]'
        );

      if (!dialog) {
        return [];
      }

      const normalize =
        value =>
          String(value || '')
            .normalize(
              'NFKC'
            )
            .toLocaleLowerCase(
              'fa'
            )
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

      const profileLinks =
        Array.from(
          dialog.querySelectorAll(
            'a[href^="/"]'
          )
        ).filter(
          anchor => {
            const href =
              anchor.getAttribute(
                'href'
              ) || '';

            return (
              /^\/[^/]+\/?$/.test(
                href
              ) &&
              !/^\/(explore|reels|direct|accounts|stories|p|reel|about|legal)\b/i.test(
                href
              )
            );
          }
        );

      const results = [];
      const seen =
        new Set();

      const ignored =
        new Set([
          'follow',
          'following',
          'reply',
          'like',
          'likes',
          'more',
          'پاسخ',
          'دنبال کردن',
          'دنبال‌شده',
          'پسندیدن'
        ]);

      for (
        const link of
        profileLinks
      ) {
        const href =
          link.getAttribute(
            'href'
          );

        const username =
          (
            link.textContent ||
            ''
          ).trim();

        if (
          !href ||
          !username
        ) {
          continue;
        }

        let node =
          link;

        let candidate =
          null;

        for (
          let level = 0;
          level < 8 &&
          node &&
          node !== dialog;
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

          if (!text) {
            continue;
          }

          const lines =
            text
              .split('\n')
              .map(
                x =>
                  x.trim()
              )
              .filter(
                Boolean
              );

          const normalizedLines =
            lines.map(
              normalize
            );

          const normalizedUsername =
            normalize(
              username
            );

          if (
            !normalizedLines.includes(
              normalizedUsername
            )
          ) {
            continue;
          }

          const hasButton =
            node.querySelector(
              'button,[role="button"]'
            ) !== null;

          const hasTime =
            node.querySelector(
              'time'
            ) !== null;

          if (
            !hasButton &&
            !hasTime
          ) {
            continue;
          }

          if (
            lines.length < 2
          ) {
            continue;
          }

          candidate = {
            node,
            lines
          };

          // اگر wrapper خیلی بزرگ نیست،
          // همین مناسب‌ترین candidate است.
          if (
            text.length <= 500
          ) {
            break;
          }
        }

        if (!candidate) {
          continue;
        }

        const candidateNode =
          candidate.node;

        const lines =
          candidate.lines;

        const textParts =
          [];

        /**
         * Instagram معمولاً متن visible را
         * در spanهای dir="auto" قرار می‌دهد.
         */
        const autos =
          Array.from(
            candidateNode.querySelectorAll(
              '[dir="auto"]'
            )
          );

        if (
          autos.length
        ) {
          for (
            const el of autos
          ) {
            const value =
              (
                el.textContent ||
                ''
              ).trim();

            if (!value) {
              continue;
            }

            const n =
              normalize(
                value
              );

            if (!n) {
              continue;
            }

            if (
              n ===
              normalize(
                username
              )
            ) {
              continue;
            }

            if (
              ignored.has(n)
            ) {
              continue;
            }

            if (
              /^\d+[smhdw]$/i.test(
                n
              )
            ) {
              continue;
            }

            if (
              /^\d+[,.]?\d*$/.test(
                n
              )
            ) {
              continue;
            }

            textParts.push(
              value
            );
          }
        }

        /**
         * Fallback:
         * اگر dir="auto" پیدا نشد،
         * از lineها استفاده کن.
         */
        if (
          !textParts.length
        ) {
          for (
            const line of
            lines
          ) {
            const n =
              normalize(
                line
              );

            if (!n) {
              continue;
            }

            if (
              n ===
              normalize(
                username
              )
            ) {
              continue;
            }

            if (
              ignored.has(n)
            ) {
              continue;
            }

            if (
              /^\d+[smhdw]$/i.test(
                n
              )
            ) {
              continue;
            }

            if (
              /^\d+[,.]?\d*$/.test(
                n
              )
            ) {
              continue;
            }

            if (
              /^(view|load) more comments/i.test(
                n
              )
            ) {
              continue;
            }

            textParts.push(
              line
            );
          }
        }

        const commentText =
          textParts
            .join('\n')
            .trim();

        if (
          !commentText
        ) {
          continue;
        }

        const normalizedComment =
          normalize(
            commentText
          );

        const key =
          `${normalize(
            href
          )}|${normalizedComment}`;

        if (
          seen.has(key)
        ) {
          continue;
        }

        seen.add(key);

        results.push({
          key,
          username,
          profilePath:
            href,
          commentText,
          normalizedComment
        });
      }

      return results;
    }
  );
}

/**
 * دوباره همان کامنت visible را پیدا می‌کند.
 */
async function findVisibleCommentRow(
  page,
  comment
) {
  return page.evaluateHandle(
    target => {
      const dialog =
        document.querySelector(
          '[role="dialog"]'
        );

      if (!dialog) {
        return null;
      }

      const normalize =
        value =>
          String(value || '')
            .normalize(
              'NFKC'
            )
            .toLocaleLowerCase(
              'fa'
            )
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

      const username =
        normalize(
          target.username
        );

      const commentText =
        normalize(
          target.commentText
        );

      const links =
        Array.from(
          dialog.querySelectorAll(
            'a[href^="/"]'
          )
        );

      for (
        const link of
        links
      ) {
        const href =
          link.getAttribute(
            'href'
          ) || '';

        const linkText =
          normalize(
            link.textContent ||
              ''
          );

        if (
          href !==
            target.profilePath ||
          linkText !==
            username
        ) {
          continue;
        }

        let node =
          link;

        for (
          let level = 0;
          level < 8 &&
          node &&
          node !== dialog;
          level++
        ) {
          node =
            node.parentElement;

          if (!node) {
            break;
          }

          const rowText =
            normalize(
              node.innerText ||
                ''
            );

          if (
            rowText.includes(
              commentText
            ) &&
            rowText.includes(
              username
            )
          ) {
            return node;
          }
        }
      }

      return null;
    },
    comment
  );
}

/**
 * Reply را در همان صفحه اصلی انجام می‌دهد.
 */
async function replyToVisibleComment(
  page,
  comment,
  replyText,
  logger
) {
  const handle =
    await findVisibleCommentRow(
      page,
      comment
    );

  if (
    !handle
  ) {
    throw new Error(
      'Matched comment is not currently visible in the comments panel.'
    );
  }

  const result =
    await handle.evaluate(
      node => {
        const controls =
          Array.from(
            node.querySelectorAll(
              'button,[role="button"]'
            )
          );

        const replyButton =
          controls.find(
            button =>
              /reply|پاسخ/i.test(
                (
                  button.innerText ||
                  ''
                ) +
                  ' ' +
                  (
                    button.getAttribute(
                      'aria-label'
                    ) ||
                    ''
                  )
              )
          );

        if (
          replyButton
        ) {
          replyButton.click();

          return {
            clicked: true
          };
        }

        const textElement =
          Array.from(
            node.querySelectorAll(
              '*'
            )
          ).find(
            element =>
              /^(reply|پاسخ)$/i.test(
                (
                  element.textContent ||
                  ''
                ).trim()
              )
          );

        if (
          textElement
        ) {
          textElement.click();

          return {
            clicked: true
          };
        }

        return {
          clicked: false
        };
      }
    );

  await handle.dispose();

  if (
    !result.clicked
  ) {
    throw new Error(
      'Reply button was not found for the matched comment.'
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

  for (
    const input of inputs
  ) {
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

      logger.info(
        'Reply sent',
        {
          username:
            comment.username,
          comment:
            comment.commentText
        }
      );

      return;
    }
  }

  throw new Error(
    'Reply input was not found after clicking Reply.'
  );
}

async function handleMessageCategory(
  page
) {
  const labels = [
    'Primary',
    'PRIMARY',
    'General',
    'GENERAL',
    'اصلی',
    'عمومی',
    'Requests',
    'درخواست‌ها'
  ];

  for (
    const label of labels
  ) {
    if (
      await clickText(
        page,
        [label],
        900
      )
    ) {
      return true;
    }
  }

  return false;
}

/**
 * DM در Page جدا.
 *
 * این نکته مهم است:
 * صفحه اصلی روی لیست کامنت‌ها باقی می‌ماند.
 */
async function sendDm(
  dmPage,
  profilePath,
  dmText,
  logger,
  username
) {
  const origin =
    new URL(
      dmPage.url()
    ).origin;

  const profileUrl =
    new URL(
      profilePath,
      origin
    ).href;

  await dmPage.goto(
    profileUrl,
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
      'Message control was not found on author profile.'
    );
  }

  await handleMessageCategory(
    dmPage
  );

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

  for (
    const input of inputs
  ) {
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

      const sent =
        await clickText(
          dmPage,
          [
            'Send',
            'ارسال'
          ],
          2500
        );

      if (!sent) {
        await input.press(
          'Enter'
        );
      }

      await dmPage.waitForTimeout(
        800
      );

      logger.info(
        'DM sent',
        {
          username
        }
      );

      return;
    }
  }

  throw new Error(
    'Direct-message input was not found.'
  );
}

async function processMatch(
  page,
  dmPage,
  comment,
  keywordResult,
  commentReply,
  dmReply,
  logger
) {
  logger.info(
    'Match found',
    {
      username:
        comment.username,

      keyword:
        keywordResult.keyword,

      mode:
        keywordResult.mode,

      distance:
        keywordResult.distance ||
        0,

      comment:
        comment.commentText
    }
  );

  const item = {
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
      keywordResult.distance ||
      0,

    reply:
      'pending',

    dm:
      'pending',

    status:
      'pending'
  };

  try {
    /**
     * اول Reply.
     */
    await replyToVisibleComment(
      page,
      comment,
      commentReply,
      logger
    );

    item.reply =
      'sent';

    /**
     * بعد DM در صفحه دوم.
     */
    await sendDm(
      dmPage,
      comment.profilePath,
      dmReply,
      logger,
      comment.username
    );

    item.dm =
      'sent';

    item.status =
      'done';

    logger.info(
      'Match completed',
      {
        username:
          comment.username,
        keyword:
          keywordResult.keyword
      }
    );
  } catch (error) {
    item.status =
      'error';

    item.error =
      String(
        error?.message ||
          error
      );

    logger.error(
      'Match processing failed',
      {
        username:
          comment.username,

        keyword:
          keywordResult.keyword,

        error:
          item.error
      }
    );
  }

  return item;
}

async function scanAndProcessPost(
  page,
  dmPage,
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
    startedAt:
      now(),

    events: [],
    rounds: [],

    commentsSeen:
      0,

    matchesFound:
      0,

    matchesCompleted:
      0,

    matchesFailed:
      0,

    screenshot:
      null,

    matchItems: []
  };

  runLog.posts.push(
    postLog
  );

  const logger =
    makeLogger(
      runLog,
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
    1400
  );

  await openComments(
    page,
    logger
  );

  await page.waitForTimeout(
    1000
  );

  /**
   * فقط یک screenshot.
   */
  postLog.screenshot =
    await saveSingleCommentsScreenshot(
      page
    );

  logger.info(
    'Saved single comments-list screenshot',
    {
      screenshot:
        postLog.screenshot
    }
  );

  const seenComments =
    new Map();

  const processedMatches =
    new Set();

  let stableRounds = 0;
  let previousState = '';

  for (
    let round = 1;
    round <=
      MAX_SCAN_ROUNDS;
    round++
  ) {
    const dialog =
      await findCommentsDialog(
        page
      );

    if (!dialog) {
      logger.warn(
        'Comments dialog disappeared; reopening'
      );

      await openComments(
        page,
        logger
      );

      await page.waitForTimeout(
        800
      );
    }

    const clickedMore =
      await clickMoreComments(
        page
      );

    const visibleComments =
      await extractVisibleComments(
        page
      );

    let newComments = 0;
    let newMatches = 0;

    /**
     * هر کامنتی که دیده می‌شود همان لحظه
     * بررسی می‌شود.
     */
    for (
      const comment of
      visibleComments
    ) {
      const key =
        `${comment.profilePath}|${compactText(
          comment.commentText
        )}`;

      if (
        !seenComments.has(
          key
        )
      ) {
        seenComments.set(
          key,
          comment
        );

        newComments++;
      }

      const keywordResult =
        keywordMatch(
          comment.commentText,
          keywords
        );

      if (
        !keywordResult.matched
      ) {
        continue;
      }

      const matchKey =
        `${key}|${keywordResult.keyword}`;

      if (
        processedMatches.has(
          matchKey
        )
      ) {
        continue;
      }

      processedMatches.add(
        matchKey
      );

      newMatches++;
      postLog.matchesFound++;

      /**
       * مهم:
       * Match را همین لحظه پردازش می‌کنیم.
       * دیگر نمی‌گذاریم اسکن تمام شود و بعد
       * از روی متن قدیمی دنبال DOM بگردیم.
       */
      const item =
        await processMatch(
          page,
          dmPage,
          comment,
          keywordResult,
          commentReply,
          dmReply,
          logger
        );

      postLog.matchItems.push(
        item
      );

      if (
        item.status ===
        'done'
      ) {
        postLog.matchesCompleted++;
      } else {
        postLog.matchesFailed++;
      }
    }

    const before =
      await getScrollableCommentContainer(
        page
      );

    const changed =
      await scrollComments(
        page
      );

    await page.waitForTimeout(
      SCROLL_WAIT_MS
    );

    const after =
      await getScrollableCommentContainer(
        page
      );

    const state =
      JSON.stringify({
        commentCount:
          seenComments.size,

        first:
          after[0] || null,

        second:
          after[1] || null
      });

    if (
      state ===
        previousState &&
      newComments ===
        0 &&
      newMatches ===
        0 &&
      !clickedMore &&
      changed ===
        0
    ) {
      stableRounds++;
    } else {
      stableRounds = 0;
    }

    previousState =
      state;

    postLog.commentsSeen =
      seenComments.size;

    if (
      round %
        LOG_EVERY_N_ROUNDS ===
        0 ||
      newMatches > 0 ||
      round === 1
    ) {
      logger.info(
        'Scan round',
        {
          round,

          visibleComments:
            visibleComments.length,

          newComments,

          totalUniqueComments:
            seenComments.size,

          newMatches,

          totalMatches:
            postLog.matchesFound,

          matchesCompleted:
            postLog.matchesCompleted,

          matchesFailed:
            postLog.matchesFailed,

          clickedMoreComments:
            clickedMore,

          changedScrollContainers:
            changed,

          stableRounds,

          scrollablesBefore:
            before,

          scrollablesAfter:
            after
        }
      );
    }

    postLog.rounds.push({
      round,

      visibleComments:
        visibleComments.length,

      newComments,

      totalUniqueComments:
        seenComments.size,

      newMatches,

      totalMatches:
        postLog.matchesFound,

      matchesCompleted:
        postLog.matchesCompleted,

      matchesFailed:
        postLog.matchesFailed,

      clickedMoreComments:
        clickedMore,

      changedScrollContainers:
        changed,

      stableRounds
    });

    /**
     * توقف فقط وقتی چند دور متوالی واقعاً ثابت باشد.
     */
    if (
      stableRounds >=
      5
    ) {
      logger.info(
        'Stopping scan: comments list reached stable state',
        {
          round,
          totalUniqueComments:
            seenComments.size
        }
      );

      break;
    }
  }

  postLog.finishedAt =
    now();

  logger.info(
    'Post finished',
    {
      uniqueCommentsScanned:
        postLog.commentsSeen,

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

  /**
   * فقط یک Browser.
   */
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

  /**
   * Page اول:
   * پست + لیست کامنت‌ها
   */
  const page =
    await context.newPage();

  /**
   * Page دوم:
   * فقط برای DM
   *
   * مزیت:
   * صفحه کامنت‌ها در Page اول باقی می‌ماند.
   */
  const dmPage =
    await context.newPage();

  const logPath =
    path.join(
      ARTIFACTS,
      'automation.log'
    );

  fs.writeFileSync(
    logPath,
    '',
    'utf8'
  );

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

      screenshotPolicy:
        'ONE screenshot per post: comments-list.png'
    },

    events: [],
    posts: [],
    errors: []
  };

  try {
    /**
     * هر دو Page از یک Context استفاده می‌کنند،
     * پس Session مشترک است.
     */
    await login(
      page,
      context
    );

    await login(
      dmPage,
      context
    );

    runLog.events.push({
      time:
        now(),

      level:
        'info',

      message:
        'Login/session initialization completed'
    });

    fs.appendFileSync(
      logPath,
      `${now()} [INFO] Login/session initialization completed\n`,
      'utf8'
    );

    for (
      let i = 0;
      i < postUrls.length;
      i++
    ) {
      const url =
        postUrls[i];

      try {
        await scanAndProcessPost(
          page,
          dmPage,
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

        runLog.errors.push({
          url,
          error:
            message
        });

        const event = {
          time:
            now(),

          level:
            'error',

          message:
            'Post processing failed',

          url,

          error:
            message
        };

        runLog.events.push(
          event
        );

        fs.appendFileSync(
          logPath,
          `${event.time} [ERROR] Post processing failed ${JSON.stringify({
            url,
            error: message
          })}\n`,
          'utf8'
        );
      }
    }
  } finally {
    runLog.finishedAt =
      now();

    /**
     * خلاصه JSON
     */
    jsonFile(
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
    runLog.errors.length >
      0 ||
    runLog.posts.some(
      post =>
        post.matchesFailed >
        0
    )
  ) {
    process.exitCode =
      1;
  }
}

main().catch(
  error => {
    const fatal = {
      time:
        now(),

      error:
        String(
          error?.stack ||
            error
        )
    };

    jsonFile(
      'fatal-error.json',
      fatal
    );

    process.exitCode =
      1;
  }
);
