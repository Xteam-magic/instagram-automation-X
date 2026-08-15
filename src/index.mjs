import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ARTIFACTS = path.resolve('artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

const env = process.env;

const MAX_SCAN_ROUNDS = Number(
  env.INSTAGRAM_MAX_COMMENT_SCAN_ROUNDS || 120
);

const COMMENT_SCROLL_STEP = Number(
  env.INSTAGRAM_COMMENT_SCROLL_PIXELS || 500
);

const COMMENT_SCROLL_WAIT = Number(
  env.INSTAGRAM_COMMENT_SCROLL_WAIT_MS || 900
);

const COMMENT_PANEL_WAIT = Number(
  env.INSTAGRAM_COMMENT_PANEL_WAIT_MS || 1200
);

function now() {
  return new Date().toISOString();
}

function required(name) {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(
      `Missing required input: ${name}`
    );
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
  return normalizeText(value)
    .replace(/\s+/g, '');
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

  return Math.max(
    3,
    Math.floor(n * 0.25)
  );
}

function keywordMatch(text, keywords) {
  const normalized = normalizeText(text);
  const compact = compactText(text);

  const words =
    normalized
      .split(/\s+/)
      .filter(Boolean);

  for (const rawKeyword of keywords) {
    const keyword =
      normalizeText(rawKeyword);

    if (!keyword) continue;

    const keywordCompact =
      compactText(keyword);

    /*
     * Exact match anywhere in the comment.
     *
     * Example:
     * تبریک
     * خیلی تبریک میگم
     * تبریک بابت موفقیت
     */
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

    const targetWords =
      keyword
        .split(/\s+/)
        .filter(Boolean);

    /*
     * Single word fuzzy.
     */
    if (targetWords.length === 1) {
      const target =
        targetWords[0];

      const threshold =
        typoThreshold(target);

      for (const word of words) {
        if (
          Math.abs(
            word.length -
              target.length
          ) <= threshold
        ) {
          if (
            word.includes(target) ||
            target.includes(word)
          ) {
            return {
              matched: true,
              keyword: rawKeyword,
              mode:
                'substring-typo',
              distance:
                Math.abs(
                  word.length -
                    target.length
                )
            };
          }
        }

        if (threshold > 0) {
          const d =
            distance(
              word,
              target
            );

          if (
            d <= threshold
          ) {
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
     * Multi-word fuzzy.
     */
    for (
      let start = 0;
      start <=
        words.length -
          targetWords.length;
      start++
    ) {
      let ok = true;
      let totalDistance = 0;

      for (
        let i = 0;
        i < targetWords.length;
        i++
      ) {
        const word =
          words[start + i];

        const target =
          targetWords[i];

        if (
          word === target
        ) {
          continue;
        }

        const d =
          distance(
            word,
            target
          );

        if (
          d >
          typoThreshold(
            target
          )
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
          distance:
            totalDistance
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
  const event = {
    time: now(),
    message,
    ...data
  };

  fs.appendFileSync(
    path.join(
      ARTIFACTS,
      'automation.log'
    ),
    JSON.stringify(event) +
      '\n',
    'utf8'
  );

  console.log(
    `[${event.time}] ${message}`,
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
    await safeClick(
      page.getByText(
        text,
        {
          exact: true
        }
      ),
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
    page
      .url()
      .includes('/accounts/login')
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

    await page
      .getByRole(
        'button',
        {
          name:
            /Log in|ورود/i
        }
      )
      .click({
        timeout: 8000
      });

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

/* =========================================================
   POST ACTION BAR
   ========================================================= */

/**
 * جمع‌آوری تمام button-like های قابل مشاهده
 * برای پیدا کردن Action Bar واقعی پست.
 */
async function inspectActionButtons(
  page
) {
  return page.evaluate(() => {
    const vw =
      window.innerWidth;

    const vh =
      window.innerHeight;

    const nodes =
      Array.from(
        document.querySelectorAll(
          'button,[role="button"],a'
        )
      );

    return nodes
      .map(
        (el, index) => {
          const rect =
            el.getBoundingClientRect();

          const style =
            getComputedStyle(
              el
            );

          const svg =
            el.querySelector(
              'svg'
            );

          const aria =
            el.getAttribute(
              'aria-label'
            ) || '';

          const title =
            el.getAttribute(
              'title'
            ) || '';

          const text =
            (
              el.innerText ||
              ''
            ).trim();

          const visible =
            style.display !== 'none' &&
            style.visibility !==
              'hidden' &&
            rect.width > 0 &&
            rect.height > 0 &&
            rect.right > 0 &&
            rect.bottom > 0 &&
            rect.left < vw &&
            rect.top < vh;

          if (!visible) {
            return null;
          }

          return {
            index,

            tag:
              el.tagName,

            role:
              el.getAttribute(
                'role'
              ),

            aria,

            title,

            text:
              text.slice(
                0,
                120
              ),

            hasSvg:
              Boolean(svg),

            html:
              el.outerHTML.slice(
                0,
                1200
              ),

            rect: {
              left:
                rect.left,

              top:
                rect.top,

              width:
                rect.width,

              height:
                rect.height,

              right:
                rect.right,

              bottom:
                rect.bottom,

              centerX:
                rect.left +
                rect.width / 2,

              centerY:
                rect.top +
                rect.height / 2
            }
          };
        }
      )
      .filter(Boolean);
  });
}

/**
 * پیدا کردن Comment button واقعی:
 *
 * 1) aria-label / title
 * 2) SVG metadata
 * 3) تشخیص Action Bar
 *
 * Action Bar می‌تواند:
 *
 * horizontal:
 * Like | Comment | Repost | Send | Save
 *
 * یا vertical:
 * Like
 * Comment
 * Repost
 * Send
 * Save
 */
async function findCommentActionButton(
  page
) {
  const buttons =
    await inspectActionButtons(
      page
    );

  /*
   * روش ۱:
   * Accessibility مستقیم.
   */
  const direct =
    buttons.find(
      button =>
        /comment|comments|نظر|دیدگاه/i.test(
          `${button.aria} ${button.title}`
        )
    );

  if (direct) {
    return {
      strategy:
        'accessibility',
      button:
        direct
    };
  }

  /*
   * روش ۲:
   * SVG دارای title / aria-label.
   */
  const svgDirect =
    buttons.find(
      button =>
        button.hasSvg &&
        /comment|comments|نظر|دیدگاه/i.test(
          button.html
        )
    );

  if (svgDirect) {
    return {
      strategy:
        'svg-semantic',
      button:
        svgDirect
    };
  }

  /*
   * روش ۳:
   *
   * Action Bar را از روی geometry
   * پیدا می‌کنیم.
   *
   * از 20% سمت چپ صفحه به بعد:
   * navigation را حذف می‌کنیم.
   *
   * Message floating button را هم حذف می‌کنیم.
   */
  const candidates =
    buttons.filter(
      button => {
        const r =
          button.rect;

        if (
          !button.hasSvg
        ) {
          return false;
        }

        if (
          r.left <
          vwSafe(page, 200)
        ) {
          return false;
        }

        if (
          r.width > 100 ||
          r.height > 100
        ) {
          return false;
        }

        if (
          r.top < 100 ||
          r.bottom >
            950
        ) {
          return false;
        }

        if (
          /message|messages|follow|boost|close|more/i.test(
            `${button.aria} ${button.title} ${button.text}`
          )
        ) {
          return false;
        }

        return true;
      }
    );

  /*
   * گروه‌های افقی/عمودی.
   */
  const groups = [];

  for (
    const button of candidates
  ) {
    const sameHorizontal =
      groups.find(
        group =>
          group.orientation ===
            'horizontal' &&
          Math.abs(
            group.anchorY -
              button.rect.centerY
          ) < 35
      );

    if (
      sameHorizontal
    ) {
      sameHorizontal.items.push(
        button
      );

      continue;
    }

    const sameVertical =
      groups.find(
        group =>
          group.orientation ===
            'vertical' &&
          Math.abs(
            group.anchorX -
              button.rect.centerX
          ) < 35
      );

    if (
      sameVertical
    ) {
      sameVertical.items.push(
        button
      );

      continue;
    }

    /*
     * تعیین اولیه جهت:
     * هنوز آیتم دیگری نداریم.
     */
    groups.push({
      orientation:
        'unknown',
      anchorX:
        button.rect.centerX,
      anchorY:
        button.rect.centerY,
      items: [button]
    });
  }

  /*
   * گروه‌ها را با نزدیک‌ترین اعضا
   * دوباره normalize می‌کنیم.
   */
  for (
    const group of groups
  ) {
    if (
      group.items.length >= 2
    ) {
      const xs =
        group.items.map(
          x =>
            x.rect.centerX
        );

      const ys =
        group.items.map(
          x =>
            x.rect.centerY
        );

      const xSpan =
        Math.max(...xs) -
        Math.min(...xs);

      const ySpan =
        Math.max(...ys) -
        Math.min(...ys);

      group.orientation =
        xSpan >= ySpan
          ? 'horizontal'
          : 'vertical';
    }
  }

  const usableGroups =
    groups
      .filter(
        group =>
          group.items.length >=
          4
      )
      .sort(
        (a, b) =>
          b.items.length -
          a.items.length
      );

  if (
    usableGroups.length
  ) {
    const group =
      usableGroups[0];

    const items =
      group.items.slice();

    if (
      group.orientation ===
      'horizontal'
    ) {
      items.sort(
        (a, b) =>
          a.rect.centerX -
          b.rect.centerX
      );
    } else {
      items.sort(
        (a, b) =>
          a.rect.centerY -
          b.rect.centerY
      );
    }

    /*
     * استاندارد Action Bar اینستاگرام:
     *
     * 0 = Like
     * 1 = Comment
     *
     * اگر حداقل 4 icon در action bar
     * داریم، آیتم دوم را Comment می‌گیریم.
     */
    if (
      items.length >= 4
    ) {
      return {
        strategy:
          `action-bar-${group.orientation}`,
        button:
          items[1],
        actionBar:
          items.map(
            item => ({
              x:
                item.rect.centerX,
              y:
                item.rect.centerY,
              aria:
                item.aria,
              title:
                item.title
            })
          )
      };
    }
  }

  /*
   * روش آخر:
   * آیکون‌هایی که در سمت راست
   * action area اصلی پست هستند.
   */
  const rightIcons =
    candidates
      .filter(
        button =>
          button.rect.centerX >
          500
      )
      .sort(
        (a, b) =>
          a.rect.top -
          b.rect.top
      );

  if (
    rightIcons.length >= 4
  ) {
    /*
     * ابتدا تلاش horizontal:
     */
    const minY =
      Math.min(
        ...rightIcons.map(
          x =>
            x.rect.centerY
        )
      );

    const horizontal =
      rightIcons
        .filter(
          x =>
            Math.abs(
              x.rect.centerY -
                minY
            ) < 40
        )
        .sort(
          (a, b) =>
            a.rect.left -
            b.rect.left
        );

    if (
      horizontal.length >= 4
    ) {
      return {
        strategy:
          'action-bar-horizontal-fallback',
        button:
          horizontal[1]
      };
    }

    /*
     * vertical:
     */
    const x0 =
      rightIcons[0]
        ?.rect
        .centerX;

    const vertical =
      rightIcons
        .filter(
          x =>
            Math.abs(
              x.rect.centerX -
                x0
            ) < 40
        )
        .sort(
          (a, b) =>
            a.rect.top -
            b.rect.top
        );

    if (
      vertical.length >= 4
    ) {
      return {
        strategy:
          'action-bar-vertical-fallback',
        button:
          vertical[1]
      };
    }
  }

  return null;
}

function vwSafe(
  page,
  fallback
) {
  /*
   * فقط برای فیلتر تقریبی.
   * مقدار viewport فعلی ما 1440 است.
   */
  return fallback;
}

/**
 * کلیک واقعی روی Comment icon.
 */
async function clickRealCommentIcon(
  page
) {
  const found =
    await findCommentActionButton(
      page
    );

  if (!found) {
    throw new Error(
      'REAL_COMMENT_ICON_NOT_FOUND'
    );
  }

  appendLog(
    'REAL_COMMENT_ICON_FOUND',
    {
      strategy:
        found.strategy,

      rect:
        found.button.rect,

      aria:
        found.button.aria,

      title:
        found.button.title,

      text:
        found.button.text,

      actionBar:
        found.actionBar ||
        null
    }
  );

  const buttons =
    page.locator(
      'button,[role="button"],a'
    );

  const locator =
    buttons.nth(
      found.button.index
    );

  /*
   * scroll into view
   */
  await locator.scrollIntoViewIfNeeded();

  /*
   * کلیک واقعی.
   */
  await locator.click({
    force: true,
    timeout: 5000
  });

  await page.waitForTimeout(
    COMMENT_PANEL_WAIT
  );

  return found;
}

/* =========================================================
   COMMENT PANEL VERIFICATION
   ========================================================= */

async function inspectAfterCommentClick(
  page
) {
  return page.evaluate(() => {
    const bodyText =
      document.body?.innerText ||
      '';

    const dialogs =
      Array.from(
        document.querySelectorAll(
          '[role="dialog"]'
        )
      ).filter(
        element => {
          const style =
            getComputedStyle(
              element
            );

          const rect =
            element.getBoundingClientRect();

          return (
            style.display !==
              'none' &&
            style.visibility !==
              'hidden' &&
            rect.width > 200 &&
            rect.height > 200
          );
        }
      );

    const textareas =
      Array.from(
        document.querySelectorAll(
          'textarea'
        )
      ).filter(
        element =>
          element.getBoundingClientRect()
            .width > 0
      );

    const editables =
      Array.from(
        document.querySelectorAll(
          '[contenteditable="true"]'
        )
      ).filter(
        element =>
          element.getBoundingClientRect()
            .width > 0
      );

    const commentSignals = [
      'View all comments',
      'View all',
      'Add a comment',
      'Reply',
      'پاسخ',
      'نظر',
      'دیدگاه'
    ];

    const bodySignals =
      commentSignals.filter(
        signal =>
          bodyText
            .toLocaleLowerCase()
            .includes(
              signal
                .toLocaleLowerCase()
            )
      );

    return {
      dialogCount:
        dialogs.length,

      textareaCount:
        textareas.length,

      editableCount:
        editables.length,

      bodySignals,

      bodyLength:
        bodyText.length
    };
  });
}

async function verifyCommentPanel(
  page
) {
  const initial =
    await inspectAfterCommentClick(
      page
    );

  /*
   * Dialog is strongest signal.
   */
  if (
    initial.dialogCount >
    0
  ) {
    return {
      verified: true,
      reason:
        'dialog'
    };
  }

  /*
   * اگر dialog نبود، ولی
   * comment-specific input ایجاد شده.
   */
  if (
    initial.textareaCount >
      0 &&
    initial.bodySignals.length >
      0
  ) {
    return {
      verified: true,
      reason:
        'comment-input-and-signal'
    };
  }

  /*
   * چند بار کوتاه صبر می‌کنیم
   * برای رندر asynchronous.
   */
  for (
    let i = 0;
    i < 5;
    i++
  ) {
    await page.waitForTimeout(
      500
    );

    const state =
      await inspectAfterCommentClick(
        page
      );

    if (
      state.dialogCount >
        0 ||
      (
        state.textareaCount >
          0 &&
        state.bodySignals.length >
          0
      )
    ) {
      return {
        verified: true,
        reason:
          state.dialogCount
            ? 'dialog-delayed'
            : 'comment-ui-delayed'
      };
    }
  }

  return {
    verified: false,
    reason:
      'COMMENT_PANEL_NOT_VERIFIED'
  };
}

/* =========================================================
   COMMENT EXTRACTION
   ========================================================= */

async function findCommentContainer(
  page
) {
  return page.evaluate(() => {
    const dialogs =
      Array.from(
        document.querySelectorAll(
          '[role="dialog"]'
        )
      ).filter(
        element => {
          const rect =
            element.getBoundingClientRect();

          const style =
            getComputedStyle(
              element
            );

          return (
            rect.width > 250 &&
            rect.height > 250 &&
            style.display !==
              'none'
          );
        }
      );

    if (
      dialogs.length
    ) {
      dialogs.sort(
        (a, b) =>
          b.getBoundingClientRect()
            .height -
          a.getBoundingClientRect()
            .height
      );

      return {
        type:
          'dialog',
        found:
          true
      };
    }

    /*
     * Fallback overlay:
     * فقط وقتی بعد از click ساخته شده
     * و right side/center است.
     */
    const candidates =
      Array.from(
        document.querySelectorAll(
          'body *'
        )
      )
        .map(
          element => ({
            element,
            rect:
              element.getBoundingClientRect(),
            style:
              getComputedStyle(
                element
              ),
            text:
              element.innerText ||
              ''
          })
        )
        .filter(
          item =>
            item.rect.width >
              250 &&
            item.rect.height >
              250 &&
            item.rect.right >
              window.innerWidth *
                0.35 &&
            /(auto|scroll)/.test(
              item.style.overflowY
            ) &&
            item.element
              .scrollHeight >
              item.element
                .clientHeight +
                50
        )
      .sort(
        (a, b) => {
          const score =
            item => {
              let s = 0;

              if (
                /Add a comment/i.test(
                  item.text
                )
              ) {
                s += 20;
              }

              if (
                /Reply/i.test(
                  item.text
                )
              ) {
                s += 10;
              }

              if (
                item.rect.right >
                window.innerWidth *
                  0.7
              ) {
                s += 5;
              }

              return s;
            };

          return (
            score(b) -
            score(a)
          );
        }
      );

    return {
      type:
        'scrollable-overlay',
      found:
        candidates.length >
        0
    };
  });
}

async function extractVisibleComments(
  page
) {
  return page.evaluate(() => {
    const normalize =
      value =>
        String(value || '')
          .normalize('NFKC')
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

    const isProfileHref =
      href =>
        /^\/[^/]+\/?$/.test(
          href || ''
        ) &&
        !/^\/(explore|reels|direct|accounts|stories|p|reel|about|legal)\b/i.test(
          href || ''
        );

    /*
     * تعیین container.
     */
    let root =
      document.querySelector(
        '[role="dialog"]'
      );

    if (!root) {
      const candidates =
        Array.from(
          document.querySelectorAll(
            'body *'
          )
        )
          .map(
            element => {
              const rect =
                element.getBoundingClientRect();

              const style =
                getComputedStyle(
                  element
                );

              return {
                element,
                rect,
                style,
                text:
                  element.innerText ||
                  ''
              };
            }
          )
          .filter(
            item =>
              item.rect.width >
                250 &&
              item.rect.height >
                250 &&
              /(auto|scroll)/.test(
                item.style.overflowY
              ) &&
              item.element
                .scrollHeight >
                item.element
                  .clientHeight +
                  50 &&
              item.rect.right >
                window.innerWidth *
                  0.35
          )
          .sort(
            (a, b) => {
              const score =
                item => {
                  let s = 0;

                  if (
                    /Reply/i.test(
                      item.text
                    )
                  ) {
                    s += 15;
                  }

                  if (
                    /Add a comment/i.test(
                      item.text
                    )
                  ) {
                    s += 10;
                  }

                  return s;
                };

              return (
                score(b) -
                score(a)
              );
            }
          );

      root =
        candidates[0]
          ?.element ||
        null;
    }

    if (!root) {
      return [];
    }

    const links =
      Array.from(
        root.querySelectorAll(
          'a[href^="/"]'
        )
      ).filter(
        link =>
          isProfileHref(
            link.getAttribute(
              'href'
            )
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

      if (!username) {
        continue;
      }

      const normalizedUsername =
        normalize(
          username
        );

      let node =
        link;

      let row =
        null;

      /*
       * از username به parentها می‌رویم
       * تا خود comment row را پیدا کنیم.
       */
      for (
        let level = 0;
        level < 9 &&
        node &&
        node !== root;
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
          !text
        ) {
          continue;
        }

        /*
         * Caption یا کل پست را رد کن.
         */
        if (
          text.length >
          800
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
          /\bReply\b/i.test(
            text
          ) ||
          /(^|\n)\s*پاسخ\s*($|\n)/i.test(
            text
          );

        const hasTime =
          node.querySelector(
            'time'
          ) !== null;

        const hasLikeButton =
          node.querySelector(
            'button,[role="button"]'
          ) !== null;

        if (
          !hasReply &&
          !hasTime &&
          !hasLikeButton
        ) {
          continue;
        }

        row =
          node;

        break;
      }

      if (!row) {
        continue;
      }

      const lines =
        (
          row.innerText ||
          ''
        )
          .split('\n')
          .map(
            x =>
              x.trim()
          )
          .filter(Boolean);

      const commentLines =
        lines.filter(
          line => {
            const n =
              normalize(
                line
              );

            if (!n) {
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

      if (
        !commentText
      ) {
        continue;
      }

      /*
       * اگر wrapper شامل کپشن و اطلاعات پست است،
       * آن را comment حساب نکن.
       */
      if (
        commentText.length >
        500
      ) {
        continue;
      }

      const key =
        `${profilePath}|${normalize(
          commentText
        )}`;

      if (
        seen.has(key)
      ) {
        continue;
      }

      seen.add(key);

      results.push({
        key,
        username,
        profilePath,
        commentText,
        normalizedComment:
          normalize(
            commentText
          )
      });
    }

    return results;
  });
}

/* =========================================================
   COMMENTS SCROLLING
   ========================================================= */

async function scrollCommentContainer(
  page,
  amount
) {
  return page.evaluate(
    pixels => {
      let root =
        document.querySelector(
          '[role="dialog"]'
        );

      if (!root) {
        const candidates =
          Array.from(
            document.querySelectorAll(
              'body *'
            )
          )
            .map(
              element => {
                const rect =
                  element.getBoundingClientRect();

                const style =
                  getComputedStyle(
                    element
                  );

                return {
                  element,
                  rect,
                  style,
                  text:
                    element.innerText ||
                    ''
                };
              }
            )
            .filter(
              item =>
                item.rect.width >
                  250 &&
                item.rect.height >
                  250 &&
                item.rect.right >
                  window.innerWidth *
                    0.35 &&
                /(auto|scroll)/.test(
                  item.style.overflowY
                ) &&
                item.element
                  .scrollHeight >
                  item.element
                    .clientHeight +
                    50
            )
            .sort(
              (a, b) => {
                const score =
                  item => {
                    let s = 0;

                    if (
                      /Reply/i.test(
                        item.text
                      )
                    ) {
                      s += 15;
                    }

                    if (
                      /Add a comment/i.test(
                        item.text
                      )
                    ) {
                      s += 10;
                    }

                    return s;
                  };

                return (
                  score(b) -
                  score(a)
                );
              }
            );

        root =
          candidates[0]
            ?.element ||
          null;
      }

      if (!root) {
        return {
          changed: false,
          before: null,
          after: null
        };
      }

      const before =
        root.scrollTop;

      const max =
        Math.max(
          0,
          root.scrollHeight -
            root.clientHeight
        );

      root.scrollTop =
        Math.min(
          max,
          before + pixels
        );

      return {
        changed:
          root.scrollTop !==
          before,

        before,

        after:
          root.scrollTop,

        max,

        clientHeight:
          root.clientHeight,

        scrollHeight:
          root.scrollHeight
      };
    },
    amount
  );
}

async function clickMoreComments(
  page
) {
  return page.evaluate(() => {
    let root =
      document.querySelector(
        '[role="dialog"]'
      );

    if (!root) {
      return false;
    }

    const candidates =
      Array.from(
        root.querySelectorAll(
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
        /^(View more comments|Load more comments|View all \d+ comments|View all comments|نمایش نظرهای بیشتر|نمایش دیدگاه‌های بیشتر|مشاهده همه نظرات)$/i.test(
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

/* =========================================================
   COMMENT REPLY
   ========================================================= */

async function clickReplyForComment(
  page,
  comment
) {
  const result =
    await page.evaluate(
      target => {
        const root =
          document.querySelector(
            '[role="dialog"]'
          );

        if (!root) {
          return {
            clicked: false,
            reason:
              'comment-dialog-not-found'
          };
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
                /\s+/g,
                ' '
              )
              .trim();

        const links =
          Array.from(
            root.querySelectorAll(
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

          const username =
            normalize(
              link.textContent ||
                ''
            );

          if (
            username !==
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
            level < 9 &&
            node &&
            node !== root;
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

            const controls =
              Array.from(
                node.querySelectorAll(
                  'button,[role="button"],span,div'
                )
              );

            for (
              const control of
              controls
            ) {
              const label =
                normalize(
                  (
                    control.innerText ||
                    ''
                  ).trim()
                );

              const aria =
                normalize(
                  control.getAttribute(
                    'aria-label'
                  ) ||
                    ''
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
                control.click();

                return {
                  clicked: true
                };
              }
            }
          }
        }

        return {
          clicked: false,
          reason:
            'reply-button-not-found'
        };
      },
      comment
    );

  if (
    !result.clicked
  ) {
    throw new Error(
      `Reply click failed: ${result.reason}`
    );
  }
}

async function sendReply(
  page,
  comment,
  replyText
) {
  await clickReplyForComment(
    page,
    comment
  );

  await page.waitForTimeout(
    500
  );

  const candidates = [
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
    candidates
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

  let submitted =
    await safeClick(
      page.getByRole(
        'button',
        {
          name:
            /Post|Reply|Send|ارسال|پاسخ/i
        }
      ),
      3000
    );

  if (!submitted) {
    await input.press(
      'Enter'
    );
  }

  await page.waitForTimeout(
    1000
  );

  const remaining =
    await input
      .inputValue()
      .catch(
        () => ''
      );

  if (
    String(
      remaining || ''
    ).trim()
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
    String(
      finalValue || ''
    ).trim()
  ) {
    throw new Error(
      'Reply submission could not be confirmed.'
    );
  }
}

/* =========================================================
   DM
   ========================================================= */

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
    await safeClick(
      dmPage
        .getByRole(
          'button',
          {
            name:
              /Message|Send message|پیام/i
          }
        )
        .first(),
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
        2200
      );

      await dmPage.waitForTimeout(
        500
      );
    }

    opened =
      await safeClick(
        dmPage
          .getByText(
            /Message|Send message|پیام/i
          )
          .first(),
        3000
      );
  }

  if (!opened) {
    throw new Error(
      `Message button not found for ${username}.`
    );
  }

  await dmPage.waitForTimeout(
    700
  );

  const candidates = [
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
    candidates
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

  const submitted =
    await safeClick(
      dmPage.getByRole(
        'button',
        {
          name:
            /Send|ارسال/i
        }
      ),
      2500
    );

  if (!submitted) {
    await input.press(
      'Enter'
    );
  }

  await dmPage.waitForTimeout(
    900
  );

  const remaining =
    await input
      .inputValue()
      .catch(
        () => ''
      );

  if (
    String(
      remaining || ''
    ).trim()
  ) {
    await input.press(
      'Enter'
    );

    await dmPage.waitForTimeout(
      800
    );
  }

  const finalValue =
    await input
      .inputValue()
      .catch(
        () => ''
      );

  if (
    String(
      finalValue || ''
    ).trim()
  ) {
    throw new Error(
      `DM submission could not be confirmed for ${username}.`
    );
  }
}

/* =========================================================
   ONE SCREENSHOT
   ========================================================= */

async function saveCommentsScreenshot(
  page
) {
  const file =
    path.join(
      ARTIFACTS,
      'comments-list.png'
    );

  const dialog =
    await page
      .locator(
        '[role="dialog"]'
      )
      .last();

  if (
    await dialog
      .isVisible()
      .catch(
        () => false
      )
  ) {
    await dialog.screenshot({
      path: file
    });

    return file;
  }

  const viewport =
    await page.viewportSize();

  const controls =
    await inspectActionButtons(
      page
    );

  /*
   * fallback screen screenshot،
   * ولی فقط بعد از verified comment UI.
   */
  if (
    viewport
  ) {
    await page.screenshot({
      path: file,
      fullPage: false
    });

    return file;
  }

  return null;
}

/* =========================================================
   PROCESS POST
   ========================================================= */

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

    commentsScanned:
      0,

    matchesFound:
      0,

    matchesCompleted:
      0,

    matchesFailed:
      0,

    matchItems:
      [],

    rounds:
      0,

    commentClickStrategy:
      null
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
    1500
  );

  await dismissCommonPopups(
    page
  );

  /*
   * =======================================================
   * STEP 1:
   * REAL ACTION BAR COMMENT ICON
   * =======================================================
   */
  let commentButton;

  try {
    commentButton =
      await clickRealCommentIcon(
        page
      );
  } catch (error) {
    appendLog(
      'REAL_COMMENT_CLICK_FAILED',
      {
        error:
          String(
            error?.message ||
              error
          )
      }
    );

    throw error;
  }

  postLog.commentClickStrategy =
    commentButton.strategy;

  /*
   * =======================================================
   * STEP 2:
   * VERIFY COMMENT UI
   * =======================================================
   */
  const verification =
    await verifyCommentPanel(
      page
    );

  appendLog(
    'COMMENT_UI_VERIFICATION',
    {
      verified:
        verification.verified,

      reason:
        verification.reason
    }
  );

  if (
    !verification.verified
  ) {
    throw new Error(
      'REAL_COMMENT_BUTTON_CLICKED_BUT_COMMENT_UI_DID_NOT_OPEN'
    );
  }

  /*
   * =======================================================
   * STEP 3:
   * NOW AND ONLY NOW:
   * ONE SCREENSHOT
   * =======================================================
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
   * Ensure comment container exists.
   */
  const container =
    await findCommentContainer(
      page
    );

  if (
    !container?.found
  ) {
    throw new Error(
      'COMMENT_UI_VERIFIED_BUT_COMMENT_CONTAINER_NOT_FOUND'
    );
  }

  appendLog(
    'COMMENT_CONTAINER_CONFIRMED',
    {
      type:
        container.type
    }
  );

  /*
   * =======================================================
   * STEP 4:
   * SCAN
   * =======================================================
   */
  const processed =
    new Set();

  let stable =
    0;

  let previousVisible =
    -1;

  for (
    let round = 1;
    round <= MAX_SCAN_ROUNDS;
    round++
  ) {
    postLog.rounds =
      round;

    const comments =
      await extractVisibleComments(
        page
      );

    let newMatchCount =
      0;

    /*
     * هر کامنت visible همان لحظه بررسی می‌شود.
     */
    for (
      const comment of
      comments
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

      const matchKey =
        `${comment.profilePath}|${compactText(
          comment.commentText
        )}|${match.keyword}`;

      if (
        processed.has(
          matchKey
        )
      ) {
        continue;
      }

      processed.add(
        matchKey
      );

      newMatchCount++;

      postLog.matchesFound++;

      appendLog(
        'MATCH_FOUND',
        {
          round,

          username:
            comment.username,

          profile:
            comment.profilePath,

          keyword:
            match.keyword,

          mode:
            match.mode,

          distance:
            match.distance,

          comment:
            comment.commentText
        }
      );

      /*
       * Reply + DM بلافاصله.
       */
      const item = {
        username:
          comment.username,

        profile:
          comment.profilePath,

        comment:
          comment.commentText,

        keyword:
          match.keyword,

        mode:
          match.mode,

        distance:
          match.distance,

        reply:
          'pending',

        dm:
          'pending',

        status:
          'pending'
      };

      try {
        await sendReply(
          page,
          comment,
          commentReply
        );

        item.reply =
          'sent';

        appendLog(
          'REPLY_SENT',
          {
            username:
              comment.username
          }
        );

        /*
         * DM در page دوم.
         */
        await sendDM(
          dmPage,
          comment.profilePath,
          comment.username,
          dmReply
        );

        item.dm =
          'sent';

        item.status =
          'done';

        postLog.matchesCompleted++;

        appendLog(
          'MATCH_COMPLETED',
          {
            username:
              comment.username
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

        postLog.matchesFailed++;

        appendLog(
          'MATCH_FAILED',
          {
            username:
              comment.username,

            comment:
              comment.commentText,

            error:
              item.error
          }
        );
      }

      postLog.matchItems.push(
        item
      );
    }

    postLog.commentsScanned =
      comments.length;

    /*
     * Logging کنترل‌شده.
     */
    if (
      round === 1 ||
      round % 5 === 0 ||
      newMatchCount > 0
    ) {
      appendLog(
        'SCAN_ROUND',
        {
          round,

          visibleComments:
            comments.length,

          newMatches:
            newMatchCount,

          totalMatches:
            postLog.matchesFound,

          completed:
            postLog.matchesCompleted,

          failed:
            postLog.matchesFailed
        }
      );
    }

    /*
     * Load more.
     */
    let clickedMore =
      false;

    if (
      round === 1 ||
      round % 2 === 0
    ) {
      clickedMore =
        await clickMoreComments(
          page
        );
    }

    /*
     * Scroll.
     */
    const scroll =
      await scrollCommentContainer(
        page,
        COMMENT_SCROLL_STEP
      );

    await page.waitForTimeout(
      COMMENT_SCROLL_WAIT
    );

    /*
     * Stable detection.
     */
    if (
      comments.length ===
        previousVisible &&
      !clickedMore &&
      !scroll.changed &&
      newMatchCount === 0
    ) {
      stable++;
    } else {
      stable = 0;
    }

    previousVisible =
      comments.length;

    if (
      stable >= 6
    ) {
      appendLog(
        'SCAN_STOP_STABLE',
        {
          round,

          visibleComments:
            comments.length,

          matches:
            postLog.matchesFound
        }
      );

      break;
    }
  }

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

/* =========================================================
   MAIN
   ========================================================= */

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
   * Main page:
   * Post + comments
   */
  const page =
    await context.newPage();

  /*
   * Second page:
   * DM only.
   */
  const dmPage =
    await context.newPage();

  const runLog = {
    startedAt:
      now(),

    keywords,
    postUrls,

    config: {
      engine:
        'Instagram Web Desktop - real post Action Bar Comment button',

      maxScanRounds:
        MAX_SCAN_ROUNDS,

      commentScrollStep:
        COMMENT_SCROLL_STEP,

      commentScrollWait:
        COMMENT_SCROLL_WAIT,

      screenshotsPerPost:
        1
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
      'LOGIN_SUCCESS'
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
