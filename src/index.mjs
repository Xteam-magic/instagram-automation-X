import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ARTIFACTS = path.resolve('artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

const env = process.env;
const MAX_SCAN_ROUNDS = Number(env.INSTAGRAM_MAX_COMMENT_SCAN_ROUNDS || 160);
const SCROLL_STEP = Number(env.INSTAGRAM_COMMENT_SCROLL_PIXELS || 520);
const SCROLL_WAIT = Number(env.INSTAGRAM_COMMENT_SCROLL_WAIT_MS || 850);
const END_STABLE_ROUNDS = Number(env.INSTAGRAM_COMMENT_END_STABLE_ROUNDS || 4);

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

function normalizeText(v) {
  return String(v || '')
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

function compactText(v) {
  return normalizeText(v).replace(/\s+/g, '');
}

function levenshtein(a, b) {
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
    Math.floor(n * 0.24)
  );
}

function keywordMatch(text, keywords) {
  const normalized = normalizeText(text);
  const compact = compactText(text);
  const words = normalized
    .split(/\s+/)
    .filter(Boolean);

  for (const raw of keywords) {
    const keyword = normalizeText(raw);

    if (!keyword) continue;

    if (
      normalized.includes(keyword) ||
      compact.includes(compactText(keyword))
    ) {
      return {
        matched: true,
        keyword: raw,
        mode: 'exact',
        distance: 0
      };
    }

    const targets = keyword
      .split(/\s+/)
      .filter(Boolean);

    if (targets.length === 1) {
      const target = targets[0];
      const threshold = typoThreshold(target);

      if (threshold > 0) {
        for (const word of words) {
          const d = levenshtein(word, target);

          if (d <= threshold) {
            return {
              matched: true,
              keyword: raw,
              mode: 'typo',
              distance: d
            };
          }

          if (
            (word.includes(target) ||
              target.includes(word)) &&
            Math.abs(
              word.length - target.length
            ) <= threshold
          ) {
            return {
              matched: true,
              keyword: raw,
              mode: 'substring-typo',
              distance: Math.abs(
                word.length - target.length
              )
            };
          }
        }
      }

      continue;
    }

    for (
      let start = 0;
      start <= words.length - targets.length;
      start++
    ) {
      let ok = true;
      let total = 0;

      for (
        let i = 0;
        i < targets.length;
        i++
      ) {
        const word = words[start + i];
        const target = targets[i];

        if (word === target) {
          continue;
        }

        const d = levenshtein(
          word,
          target
        );

        if (
          d > typoThreshold(target)
        ) {
          ok = false;
          break;
        }

        total += d;
      }

      if (ok) {
        return {
          matched: true,
          keyword: raw,
          mode: 'phrase-typo',
          distance: total
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
    JSON.stringify(event) + '\n',
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
  name,
  data
) {
  fs.writeFileSync(
    path.join(
      ARTIFACTS,
      name
    ),
    JSON.stringify(
      data,
      null,
      2
    ),
    'utf8'
  );
}

async function loadSession() {
  if (
    !env.INSTAGRAM_SESSION_B64?.trim()
  ) {
    return null;
  }

  return JSON.parse(
    Buffer.from(
      env.INSTAGRAM_SESSION_B64.trim(),
      'base64'
    ).toString('utf8')
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
  for (
    const text of [
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
    ]
  ) {
    await safeClick(
      page.getByText(
        text,
        {
          exact: true
        }
      ),
      600
    );
  }
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
      .includes(
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
    path:
      path.join(
        ARTIFACTS,
        'session-after-run.json'
      )
  });
}

/* ------------------------ COMMENT BUTTON ------------------------ */

async function inspectCommentCandidates(
  page
) {
  return page.evaluate(() => {
    const vw = innerWidth;
    const vh = innerHeight;

    return Array.from(
      document.querySelectorAll(
        'button,[role="button"],a'
      )
    )
      .map(
        (
          el,
          index
        ) => {
          const r =
            el.getBoundingClientRect();

          const s =
            getComputedStyle(
              el
            );

          const label =
            `${el.getAttribute(
              'aria-label'
            ) || ''} ${
              el.getAttribute(
                'title'
              ) || ''
            } ${
              el.textContent || ''
            }`.trim();

          if (
            s.display ===
              'none' ||
            s.visibility ===
              'hidden' ||
            r.width <= 0 ||
            r.height <= 0 ||
            r.left >= vw ||
            r.top >= vh ||
            r.right <= 0 ||
            r.bottom <= 0
          ) {
            return null;
          }

          return {
            index,

            aria:
              el.getAttribute(
                'aria-label'
              ) || '',

            title:
              el.getAttribute(
                'title'
              ) || '',

            text:
              (
                el.innerText ||
                ''
              )
                .trim()
                .slice(
                  0,
                  100
                ),

            label:
              label.slice(
                0,
                180
              ),

            hasSvg:
              !!el.querySelector(
                'svg'
              ),

            rect: {
              left:
                r.left,

              top:
                r.top,

              width:
                r.width,

              height:
                r.height,

              centerX:
                r.left +
                r.width / 2,

              centerY:
                r.top +
                r.height / 2
            }
          };
        }
      )
      .filter(Boolean);
  });
}

async function findCommentButton(
  page
) {
  const candidates =
    await inspectCommentCandidates(
      page
    );

  const explicit =
    candidates.find(
      x =>
        /(^|\s)(comment|comments|نظر|دیدگاه)(\s|$)/i.test(
          `${x.aria} ${x.title} ${x.text}`
        )
    );

  if (explicit) {
    return {
      ...explicit,
      strategy:
        'explicit-label'
    };
  }

  const icons =
    candidates.filter(
      x =>
        x.hasSvg &&
        x.rect.width >= 20 &&
        x.rect.width <= 80 &&
        x.rect.height >= 20 &&
        x.rect.height <= 80 &&
        x.rect.left >
          innerWidth * 0.50 &&
        x.rect.top > 300 &&
        x.rect.top <
          innerHeight - 70
    );

  if (!icons.length) {
    return null;
  }

  const groups = [];

  for (
    const item of icons
  ) {
    let group =
      groups.find(
        g =>
          g.some(
            x =>
              Math.abs(
                x.rect.centerY -
                  item.rect.centerY
              ) < 45 ||
              Math.abs(
                x.rect.centerX -
                  item.rect.centerX
              ) < 45
          )
      );

    if (!group) {
      group = [];
      groups.push(group);
    }

    group.push(item);
  }

  const groups4 =
    groups
      .filter(
        g =>
          g.length >= 4
      )
      .sort(
        (a, b) =>
          b.length - a.length
      );

  if (
    groups4.length
  ) {
    const g =
      groups4[0].slice();

    const xs =
      g.map(
        x =>
          x.rect.centerX
      );

    const ys =
      g.map(
        x =>
          x.rect.centerY
      );

    const horizontal =
      Math.max(...xs) -
        Math.min(...xs) >=
      Math.max(...ys) -
        Math.min(...ys);

    g.sort(
      (a, b) =>
        horizontal
          ? a.rect.centerX -
            b.rect.centerX
          : a.rect.centerY -
            b.rect.centerY
    );

    if (g[1]) {
      return {
        ...g[1],
        strategy:
          `action-bar-${
            horizontal
              ? 'horizontal'
              : 'vertical'
          }`
      };
    }
  }

  const sorted =
    icons.slice().sort(
      (a, b) =>
        a.rect.left -
          b.rect.left ||
        a.rect.top -
          b.rect.top
    );

  for (
    let i = 0;
    i < sorted.length - 1;
    i++
  ) {
    const a =
      sorted[i];

    const b =
      sorted[i + 1];

    if (
      Math.abs(
        a.rect.centerY -
          b.rect.centerY
      ) < 45 &&
      b.rect.left -
        (
          a.rect.left +
          a.rect.width
        ) < 100
    ) {
      return {
        ...b,
        strategy:
          'adjacent-to-like'
      };
    }
  }

  return null;
}

async function clickRealCommentButton(
  page
) {
  const found =
    await findCommentButton(
      page
    );

  if (!found) {
    throw new Error(
      'REAL_COMMENT_ICON_NOT_FOUND'
    );
  }

  appendLog(
    'REAL_COMMENT_ICON_FOUND',
    found
  );

  const locator =
    page
      .locator(
        'button,[role="button"],a'
      )
      .nth(
        found.index
      );

  await locator
    .scrollIntoViewIfNeeded()
    .catch(
      () => {}
    );

  try {
    await locator.click({
      force: true,
      timeout: 5000
    });
  } catch {
    await page.mouse.click(
      found.rect.centerX,
      found.rect.centerY
    );
  }

  await page.waitForTimeout(
    1200
  );

  return found;
}

/* ------------------------ COMMENT ROOT ------------------------ */

async function getCommentRootDescriptor(
  page
) {
  return page.evaluate(() => {
    const validProfileHref =
      href =>
        /^\/[^/]+\/?$/.test(
          href || ''
        ) &&
        !/^\/(explore|reels|direct|accounts|stories|p|reel|about|legal)\b/i.test(
          href || ''
        );

    const scoreRoot =
      el => {
        const r =
          el.getBoundingClientRect();

        const s =
          getComputedStyle(
            el
          );

        const text =
          el.innerText || '';

        let score = 0;

        const profileCount =
          Array.from(
            el.querySelectorAll(
              'a[href^="/"]'
            )
          ).filter(
            a =>
              validProfileHref(
                a.getAttribute(
                  'href'
                )
              )
          ).length;

        const replyCount =
          (
            text.match(
              /\bReply\b/gi
            ) || []
          ).length +
          (
            text.match(
              /پاسخ/g
            ) || []
          ).length;

        const timeCount =
          el.querySelectorAll(
            'time'
          ).length;

        if (
          profileCount >= 2
        ) {
          score += Math.min(
            60,
            profileCount * 6
          );
        }

        if (
          replyCount
        ) {
          score += Math.min(
            30,
            replyCount * 5
          );
        }

        if (
          timeCount
        ) {
          score += Math.min(
            15,
            timeCount * 2
          );
        }

        if (
          /View more comments|View all \d+ comments|Load more comments/i.test(
            text
          )
        ) {
          score += 30;
        }

        if (
          /Add a comment/i.test(
            text
          )
        ) {
          score += 5;
        }

        if (
          /(auto|scroll)/.test(
            s.overflowY
          ) &&
          el.scrollHeight >
            el.clientHeight +
              80
        ) {
          score += 30;
        }

        if (
          r.right >
          innerWidth * 0.55
        ) {
          score += 15;
        }

        if (
          r.width >= 280 &&
          r.width <= 650
        ) {
          score += 10;
        }

        if (
          r.height >= 250
        ) {
          score += 10;
        }

        return {
          score,
          profileCount,
          replyCount,
          timeCount,
          scrollable:
            /(auto|scroll)/.test(
              s.overflowY
            ) &&
            el.scrollHeight >
              el.clientHeight +
                80,
          rect: {
            x:
              r.x,
            y:
              r.y,
            width:
              r.width,
            height:
              r.height
          },
          scrollHeight:
            el.scrollHeight,
          clientHeight:
            el.clientHeight,
          textSample:
            text.slice(
              0,
              900
            )
        };
      };

    const all =
      Array.from(
        document.querySelectorAll(
          'body *'
        )
      );

    const visible =
      all.filter(
        el => {
          const r =
            el.getBoundingClientRect();

          const s =
            getComputedStyle(
              el
            );

          return (
            s.display !==
              'none' &&
            s.visibility !==
              'hidden' &&
            r.width > 0 &&
            r.height > 0
          );
        }
      );

    const dialogs =
      visible.filter(
        el =>
          el.getAttribute(
            'role'
          ) ===
            'dialog' &&
          el.getBoundingClientRect()
            .width >= 250 &&
          el.getBoundingClientRect()
            .height >= 250
      );

    const sources =
      dialogs.length
        ? dialogs
        : visible.filter(
            el => {
              const r =
                el.getBoundingClientRect();

              const s =
                getComputedStyle(
                  el
                );

              if (
                r.width < 250 ||
                r.height < 250 ||
                r.right <
                  innerWidth *
                    0.45
              ) {
                return false;
              }

              if (
                s.position !==
                  'fixed' &&
                s.position !==
                  'absolute' &&
                !/(auto|scroll)/.test(
                  s.overflowY
                )
              ) {
                return false;
              }

              return (
                el.scrollHeight >
                el.clientHeight +
                  80
              );
            }
          );

    const scored =
      sources
        .map(
          el => ({
            el,
            info:
              scoreRoot(el)
          })
        )
        .sort(
          (a, b) =>
            b.info.score -
            a.info.score
        );

    if (
      !scored.length
    ) {
      return null;
    }

    const best =
      scored[0];

    if (
      best.info.score <
        45 ||
      best.info.profileCount <
        2
    ) {
      return null;
    }

    const index =
      all.indexOf(
        best.el
      );

    return {
      index,
      ...best.info
    };
  });
}

async function waitForCommentRoot(
  page
) {
  const deadline =
    Date.now() +
    7000;

  while (
    Date.now() <
    deadline
  ) {
    const root =
      await getCommentRootDescriptor(
        page
      );

    if (
      root &&
      (
        root.profileCount >= 2 ||
        root.replyCount >= 1
      )
    ) {
      return root;
    }

    await page.waitForTimeout(
      350
    );
  }

  return null;
}

async function markCommentRoot(
  page,
  descriptor
) {
  return page.evaluate(
    index => {
      const all =
        Array.from(
          document.querySelectorAll(
            'body *'
          )
        );

      const el =
        all[index];

      if (!el) {
        return false;
      }

      document
        .querySelectorAll(
          '[data-ig-comment-root="1"]'
        )
        .forEach(
          x =>
            x.removeAttribute(
              'data-ig-comment-root'
            )
        );

      el.setAttribute(
        'data-ig-comment-root',
        '1'
      );

      return true;
    },
    descriptor.index
  );
}

async function getRootLocator(
  page
) {
  const locator =
    page
      .locator(
        '[data-ig-comment-root="1"]'
      )
      .first();

  if (
    !(await locator.count())
  ) {
    throw new Error(
      'COMMENT_ROOT_MARK_FAILED'
    );
  }

  return locator;
}

/* ------------------------ EXTRACTION ------------------------ */

async function extractVisibleComments(
  root
) {
  return root.evaluate(
    root => {
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

      const validProfileHref =
        href =>
          /^\/[^/]+\/?$/.test(
            href || ''
          ) &&
          !/^\/(explore|reels|direct|accounts|stories|p|reel|about|legal)\b/i.test(
            href || ''
          );

      const ignored =
        /^(follow|following|reply|replies|like|likes|more|translated|view all replies|دنبال کردن|دنبال شده|پاسخ|پاسخ ها|پسندیدن|بیشتر|ترجمه|نمایش همه پاسخ ها)$/i;

      const links =
        Array.from(
          root.querySelectorAll(
            'a[href^="/"]'
          )
        ).filter(
          a =>
            validProfileHref(
              a.getAttribute(
                'href'
              )
            )
        );

      const seen =
        new Set();

      const out =
        [];

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

        let row =
          null;

        let node =
          link;

        for (
          let level = 0;
          level < 10 &&
          node &&
          node !== root;
          level++
        ) {
          node =
            node.parentElement;

          if (!node) break;

          const text =
            (
              node.innerText ||
              ''
            ).trim();

          if (
            !text ||
            text.length >
              650
          ) {
            continue;
          }

          const ntext =
            normalize(
              text
            );

          if (
            !ntext.includes(
              normalizedUsername
            )
          ) {
            continue;
          }

          if (
            /Add a comment|View insights|Boost post/i.test(
              text
            )
          ) {
            continue;
          }

          const hasReply =
            /(^|\n)\s*(Reply|پاسخ)\s*($|\n)/i.test(
              text
            );

          const hasTime =
            !!node.querySelector(
              'time'
            );

          const hasControl =
            !!node.querySelector(
              'button,[role="button"]'
            );

          if (
            !hasReply &&
            !hasTime &&
            !hasControl
          ) {
            continue;
          }

          row =
            node;

          break;
        }

        if (!row) continue;

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

              if (
                !n ||
                n ===
                  normalizedUsername ||
                ignored.test(
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
          !commentText ||
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
          seen.has(
            key
          )
        ) {
          continue;
        }

        seen.add(
          key
        );

        out.push({
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

      return out;
    }
  );
}

async function clickMoreComments(
  root
) {
  return root
    .evaluate(
      root => {
        for (
          const el of
          Array.from(
            root.querySelectorAll(
              'button,[role="button"],a,span,div'
            )
          )
        ) {
          const text =
            (
              el.innerText ||
              ''
            ).trim();

          if (
            /^(View more comments|Load more comments|View all \d+ comments|View all comments|نمایش نظرهای بیشتر|نمایش دیدگاه‌های بیشتر|مشاهده همه نظرات)$/i.test(
              text
            )
          ) {
            el.click();
            return true;
          }
        }

        return false;
      }
    )
    .catch(
      () => false
    );
}

async function scrollRoot(
  root,
  amount
) {
  return root.evaluate(
    (
      el,
      step
    ) => {
      const before =
        el.scrollTop;

      const max =
        Math.max(
          0,
          el.scrollHeight -
            el.clientHeight
        );

      el.scrollTop =
        Math.min(
          max,
          before + step
        );

      return {
        before,

        after:
          el.scrollTop,

        max,

        changed:
          el.scrollTop !==
          before,

        atBottom:
          el.scrollTop >=
          max - 8,

        scrollHeight:
          el.scrollHeight,

        clientHeight:
          el.clientHeight
      };
    },
    amount
  );
}

async function collectAllComments(
  page,
  root
) {
  const map =
    new Map();

  let stable = 0;
  let lastSig = '';

  await root.evaluate(
    el => {
      el.scrollTop = 0;
    }
  );

  await page.waitForTimeout(
    500
  );

  for (
    let round = 1;
    round <=
      MAX_SCAN_ROUNDS;
    round++
  ) {
    const clickedMore =
      await clickMoreComments(
        root
      );

    if (
      clickedMore
    ) {
      await page.waitForTimeout(
        500
      );
    }

    const visible =
      await extractVisibleComments(
        root
      );

    let added = 0;

    for (
      const comment of visible
    ) {
      if (
        !map.has(
          comment.key
        )
      ) {
        map.set(
          comment.key,
          comment
        );

        added++;
      }
    }

    const scroll =
      await scrollRoot(
        root,
        SCROLL_STEP
      );

    await page.waitForTimeout(
      SCROLL_WAIT
    );

    const sig =
      JSON.stringify({
        count:
          map.size,

        after:
          scroll.after,

        max:
          scroll.max,

        height:
          scroll.scrollHeight
      });

    if (
      scroll.atBottom &&
      added === 0 &&
      !clickedMore &&
      sig === lastSig
    ) {
      stable++;
    } else {
      stable = 0;
    }

    lastSig =
      sig;

    if (
      round === 1 ||
      added > 0 ||
      clickedMore ||
      round % 5 === 0
    ) {
      appendLog(
        'COMMENT_SCAN_ROUND',
        {
          round,

          visible:
            visible.length,

          added,

          totalUnique:
            map.size,

          clickedMore,

          scroll,

          stable
        }
      );
    }

    if (
      stable >=
      END_STABLE_ROUNDS
    ) {
      appendLog(
        'COMMENT_SCAN_END_REACHED',
        {
          round,

          totalUnique:
            map.size,

          scroll
        }
      );

      break;
    }
  }

  return Array.from(
    map.values()
  );
}

/* ------------------------ FIND MATCHED COMMENT ------------------------ */

async function findCommentRow(
  root,
  comment
) {
  for (
    let attempt = 0;
    attempt < 40;
    attempt++
  ) {
    const handle =
      await root.evaluateHandle(
        (
          root,
          target
        ) => {
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

          const links =
            Array.from(
              root.querySelectorAll(
                'a[href^="/"]'
              )
            );

          for (
            const link of links
          ) {
            if (
              (
                link.getAttribute(
                  'href'
                ) || ''
              ) !==
              target.profilePath
            ) {
              continue;
            }

            if (
              normalize(
                link.textContent ||
                  ''
              ) !==
              normalize(
                target.username
              )
            ) {
              continue;
            }

            let node =
              link;

            for (
              let i = 0;
              i < 10 &&
              node &&
              node !== root;
              i++
            ) {
              node =
                node.parentElement;

              if (!node) break;

              const text =
                normalize(
                  node.innerText ||
                    ''
                );

              if (
                text.includes(
                  normalize(
                    target.commentText
                  )
                ) &&
                text.includes(
                  normalize(
                    target.username
                  )
                ) &&
                !/Add a comment|View insights|Boost post/i.test(
                  text
                )
              ) {
                node.scrollIntoView(
                  {
                    block:
                      'center',
                    inline:
                      'nearest'
                  }
                );

                return node;
              }
            }
          }

          return null;
        },
        comment
      );

    const element =
      handle.asElement();

    if (
      element
    ) {
      return element;
    }

    await root.evaluate(
      root => {
        root.scrollTop =
          Math.min(
            root.scrollHeight -
              root.clientHeight,

            root.scrollTop +
              Math.floor(
                root.clientHeight *
                  0.7
              )
          );
      }
    );

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          400
        )
    );
  }

  throw new Error(
    'COMMENT_ROW_NOT_FOUND_FOR_MATCH'
  );
}

/* ------------------------ REPLY ------------------------ */

async function sendReply(
  page,
  row,
  replyText
) {
  const clicked =
    await row.evaluate(
      node => {
        const controls =
          Array.from(
            node.querySelectorAll(
              'button,[role="button"],span,div'
            )
          );

        const reply =
          controls.find(
            el => {
              const t =
                `${
                  el.innerText ||
                  ''
                } ${
                  el.getAttribute(
                    'aria-label'
                  ) || ''
                }`.trim();

              return (
                /^(reply|پاسخ)$/i.test(
                  t
                ) ||
                /\breply\b/i.test(
                  t
                ) ||
                /پاسخ/i.test(
                  t
                )
              );
            }
          );

        if (!reply) {
          return false;
        }

        reply.click();

        return true;
      }
    );

  if (!clicked) {
    throw new Error(
      'REPLY_BUTTON_NOT_FOUND'
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
      'REPLY_INPUT_NOT_FOUND'
    );
  }

  await input.fill(
    replyText
  );

  const button =
    page
      .getByRole(
        'button',
        {
          name:
            /Post|Reply|Send|ارسال|پاسخ/i
        }
      )
      .last();

  if (
    !(await safeClick(
      button,
      3000
    ))
  ) {
    await input.press(
      'Enter'
    );
  }

  await page.waitForTimeout(
    1000
  );

  let value =
    await input
      .inputValue()
      .catch(
        () => ''
      );

  if (
    String(value).trim()
  ) {
    await input.press(
      'Enter'
    );

    await page.waitForTimeout(
      900
    );

    value =
      await input
        .inputValue()
        .catch(
          () => ''
        );
  }

  if (
    String(value).trim()
  ) {
    throw new Error(
      'REPLY_NOT_CONFIRMED'
    );
  }
}

/* ------------------------ DM ------------------------ */

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

  await dmPage.goto(
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
        2000
      );

      await dmPage.waitForTimeout(
        400
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
      `MESSAGE_BUTTON_NOT_FOUND:${username}`
    );
  }

  await dmPage.waitForTimeout(
    700
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
      `DM_INPUT_NOT_FOUND:${username}`
    );
  }

  await input.fill(
    message
  );

  const button =
    dmPage
      .getByRole(
        'button',
        {
          name:
            /Send|ارسال/i
        }
      )
      .last();

  if (
    !(await safeClick(
      button,
      2500
    ))
  ) {
    await input.press(
      'Enter'
    );
  }

  await dmPage.waitForTimeout(
    900
  );

  let value =
    await input
      .inputValue()
      .catch(
        () => ''
      );

  if (
    String(value).trim()
  ) {
    await input.press(
      'Enter'
    );

    await dmPage.waitForTimeout(
      800
    );

    value =
      await input
        .inputValue()
        .catch(
          () => ''
        );
  }

  if (
    String(value).trim()
  ) {
    throw new Error(
      `DM_NOT_CONFIRMED:${username}`
    );
  }
}

/* ------------------------ POST PROCESS ------------------------ */

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

    commentClickStrategy:
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

    scanRounds:
      0
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
   * IMPORTANT:
   * This is the actual function defined above.
   *
   * The previous broken version called:
   * clickActualCommentButton()
   *
   * which did not exist.
   */
  const clickInfo =
    await clickRealCommentButton(
      page
    );

  postLog.commentClickStrategy =
    clickInfo.strategy;

  appendLog(
    'COMMENT_CLICKED',
    {
      strategy:
        clickInfo.strategy
    }
  );

  const descriptor =
    await waitForCommentRoot(
      page
    );

  if (!descriptor) {
    throw new Error(
      'COMMENT_UI_DID_NOT_OPEN_AS_REAL_LIST'
    );
  }

  appendLog(
    'COMMENT_ROOT_FOUND',
    descriptor
  );

  await markCommentRoot(
    page,
    descriptor
  );

  const root =
    await getRootLocator(
      page
    );

  /*
   * Exactly ONE screenshot.
   */
  postLog.screenshot =
    path.join(
      ARTIFACTS,
      'comments-list.png'
    );

  await root.screenshot({
    path:
      postLog.screenshot
  });

  appendLog(
    'COMMENTS_SCREENSHOT_SAVED',
    {
      path:
        postLog.screenshot
    }
  );

  await root.evaluate(
    el => {
      el.scrollTop = 0;
    }
  );

  await page.waitForTimeout(
    500
  );

  /*
   * Scan complete comments list.
   */
  const comments =
    await collectAllComments(
      page,
      root
    );

  postLog.commentsScanned =
    comments.length;

  appendLog(
    'COMMENT_SCAN_COMPLETE',
    {
      comments:
        comments.length,

      keywords
    }
  );

  if (!comments.length) {
    throw new Error(
      'REAL_COMMENT_LIST_OPENED_BUT_ZERO_COMMENTS_FOUND'
    );
  }

  /*
   * Find every match.
   */
  const matches =
    [];

  const processed =
    new Set();

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

    const key =
      `${comment.profilePath}|${compactText(
        comment.commentText
      )}|${match.keyword}`;

    if (
      processed.has(key)
    ) {
      continue;
    }

    processed.add(key);

    matches.push({
      comment,
      match
    });
  }

  postLog.matchesFound =
    matches.length;

  appendLog(
    'MATCH_SCAN_COMPLETE',
    {
      totalComments:
        comments.length,

      matches:
        matches.length
    }
  );

  /*
   * Process every match.
   */
  for (
    const {
      comment,
      match
    } of matches
  ) {
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

    appendLog(
      'MATCH_FOUND',
      item
    );

    try {
      const row =
        await findCommentRow(
          root,
          comment
        );

      await sendReply(
        page,
        row,
        commentReply
      );

      item.reply =
        'sent';

      appendLog(
        'REPLY_SENT',
        {
          username:
            comment.username,

          keyword:
            match.keyword
        }
      );

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
        'DM_SENT',
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

/* ------------------------ MAIN ------------------------ */

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
   * Page 1:
   * Post + Comment List
   */
  const page =
    await context.newPage();

  /*
   * Page 2:
   * Direct Message
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
        'Instagram Web Desktop',

      commentStrategy:
        'real post action-bar Comment button',

      maxScanRounds:
        MAX_SCAN_ROUNDS,

      scrollStep:
        SCROLL_STEP,

      scrollWait:
        SCROLL_WAIT,

      endStableRounds:
        END_STABLE_ROUNDS,

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
    runLog.errors.length ||
    runLog.posts.some(
      p =>
        p.matchesFailed >
        0
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
