import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ARTIFACTS = path.resolve('artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

const env = process.env;

const MAX_SCAN_ROUNDS = Number(
  env.INSTAGRAM_MAX_COMMENT_SCAN_ROUNDS || 150
);

const SCROLL_STEP = Number(
  env.INSTAGRAM_COMMENT_SCROLL_PIXELS || 550
);

const SCROLL_WAIT = Number(
  env.INSTAGRAM_COMMENT_SCROLL_WAIT_MS || 900
);

const END_STABLE_ROUNDS = Number(
  env.INSTAGRAM_COMMENT_END_STABLE_ROUNDS || 4
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
    .replace(/\s+/g, ' ')
    .trim();
}

function compactText(value) {
  return normalizeText(value)
    .replace(/\s+/g, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  let prev = Array.from(
    {
      length:
        b.length + 1
    },
    (_, i) => i
  );

  for (
    let i = 1;
    i <= a.length;
    i++
  ) {
    const cur = [i];

    for (
      let j = 1;
      j <= b.length;
      j++
    ) {
      cur[j] =
        Math.min(
          cur[j - 1] + 1,
          prev[j] + 1,
          prev[j - 1] +
            (
              a[i - 1] ===
              b[j - 1]
                ? 0
                : 1
            )
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

function keywordMatch(
  text,
  keywords
) {
  const normalized =
    normalizeText(text);

  const compact =
    compactText(text);

  const words =
    normalized
      .split(/\s+/)
      .filter(Boolean);

  for (
    const raw of keywords
  ) {
    const keyword =
      normalizeText(raw);

    if (!keyword) {
      continue;
    }

    /*
     * Exact anywhere in comment.
     */
    if (
      normalized.includes(
        keyword
      ) ||
      compact.includes(
        compactText(keyword)
      )
    ) {
      return {
        matched: true,
        keyword: raw,
        mode: 'exact',
        distance: 0
      };
    }

    const targets =
      keyword
        .split(/\s+/)
        .filter(Boolean);

    /*
     * Single word fuzzy.
     */
    if (
      targets.length === 1
    ) {
      const target =
        targets[0];

      const threshold =
        typoThreshold(
          target
        );

      for (
        const word of words
      ) {
        if (
          threshold > 0 &&
          Math.abs(
            word.length -
              target.length
          ) <=
            threshold
        ) {
          if (
            word.includes(
              target
            ) ||
            target.includes(
              word
            )
          ) {
            return {
              matched: true,
              keyword: raw,
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

        if (
          threshold > 0
        ) {
          const d =
            levenshtein(
              word,
              target
            );

          if (
            d <=
            threshold
          ) {
            return {
              matched: true,
              keyword: raw,
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
          targets.length;
      start++
    ) {
      let ok = true;
      let total = 0;

      for (
        let i = 0;
        i < targets.length;
        i++
      ) {
        const word =
          words[
            start + i
          ];

        const target =
          targets[i];

        if (
          word === target
        ) {
          continue;
        }

        const d =
          levenshtein(
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

        total += d;
      }

      if (ok) {
        return {
          matched: true,
          keyword: raw,
          mode:
            'phrase-typo',
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

async function loadSession() {
  if (
    !env.INSTAGRAM_SESSION_B64?.trim()
  ) {
    return null;
  }

  return JSON.parse(
    Buffer
      .from(
        env
          .INSTAGRAM_SESSION_B64
          .trim(),
        'base64'
      )
      .toString('utf8')
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
  const texts = [
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
    const text of texts
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

/* =========================================================
   FIND REAL COMMENT BUTTON
   ========================================================= */

async function findCommentButton(
  page
) {
  return page.evaluate(
    () => {
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

      const visible =
        nodes.filter(
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
              r.height > 0 &&
              r.right > 0 &&
              r.bottom > 0 &&
              r.left < vw &&
              r.top < vh
            );
          }
        );

      /*
       * Direct semantic detection.
       */
      const explicit =
        visible.find(
          el => {
            const label = [
              el.getAttribute(
                'aria-label'
              ) || '',
              el.getAttribute(
                'title'
              ) || '',
              el.textContent || ''
            ].join(' ');

            return /(^|\s)(comment|comments|نظر|دیدگاه)(\s|$)/i.test(
              label
            );
          }
        );

      if (explicit) {
        const r =
          explicit.getBoundingClientRect();

        return {
          strategy:
            'explicit-label',

          rect: {
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height,

            centerX:
              r.left +
              r.width / 2,

            centerY:
              r.top +
              r.height / 2
          },

          html:
            explicit
              .outerHTML
              .slice(
                0,
                1600
              )
        };
      }

      /*
       * Small SVG controls in post action area.
       */
      const iconButtons =
        visible
          .map(
            el => {
              const r =
                el.getBoundingClientRect();

              return {
                el,
                r,
                svg:
                  el.querySelector(
                    'svg'
                  )
              };
            }
          )
          .filter(
            x =>
              x.svg &&
              x.r.width <=
                80 &&
              x.r.height <=
                80 &&
              x.r.width >=
                20 &&
              x.r.height >=
                20 &&
              x.r.left >
                vw * 0.50 &&
              x.r.top >
                350 &&
              x.r.top <
                vh - 80
          );

      const near = (
        a,
        b
      ) =>
        Math.abs(
          a.r.centerY -
            b.r.centerY
        ) < 50 ||
        Math.abs(
          a.r.centerX -
            b.r.centerX
        ) < 50;

      const clusters = [];

      for (
        const item of
        iconButtons
      ) {
        let cluster =
          clusters.find(
            c =>
              c.some(
                x =>
                  near(
                    x,
                    item
                  )
              )
          );

        if (!cluster) {
          cluster = [];
          clusters.push(
            cluster
          );
        }

        cluster.push(
          item
        );
      }

      const usefulClusters =
        clusters
          .filter(
            c =>
              c.length >=
              4
          )
          .sort(
            (a, b) =>
              b.length -
              a.length
          );

      if (
        usefulClusters.length
      ) {
        let c =
          usefulClusters[
            0
          ].slice();

        const xs =
          c.map(
            x =>
              x.r.left +
              x.r.width /
                2
          );

        const ys =
          c.map(
            x =>
              x.r.top +
              x.r.height /
                2
          );

        const xSpan =
          Math.max(
            ...xs
          ) -
          Math.min(
            ...xs
          );

        const ySpan =
          Math.max(
            ...ys
          ) -
          Math.min(
            ...ys
          );

        if (
          xSpan >=
          ySpan
        ) {
          c.sort(
            (a, b) =>
              a.r.left -
              b.r.left
          );
        } else {
          c.sort(
            (a, b) =>
              a.r.top -
              b.r.top
          );
        }

        /*
         * Standard Instagram action-bar order:
         *
         * Like
         * Comment
         * Repost
         * Share
         * Save
         */
        const item =
          c[1];

        if (!item) {
          return null;
        }

        const r =
          item.r;

        return {
          strategy:
            `post-action-cluster-${
              xSpan >=
              ySpan
                ? 'horizontal'
                : 'vertical'
            }`,

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
              r.width /
                2,

            centerY:
              r.top +
              r.height /
                2
          },

          clusterSize:
            c.length,

          html:
            item.el
              .outerHTML
              .slice(
                0,
                1600
              )
        };
      }

      /*
       * Last local adjacency fallback.
       */
      const small =
        iconButtons
          .sort(
            (a, b) =>
              a.r.left -
                b.r.left ||
              a.r.top -
                b.r.top
          );

      for (
        let i = 0;
        i <
          small.length -
            1;
        i++
      ) {
        const a =
          small[i];

        const b =
          small[i + 1];

        const sameRow =
          Math.abs(
            a.r.top -
              b.r.top
          ) < 50;

        const adjacent =
          b.r.left -
            a.r.right <
          90;

        if (
          sameRow &&
          adjacent
        ) {
          const r =
            b.r;

          return {
            strategy:
              'adjacent-post-action-icon',

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
                r.width /
                  2,

              centerY:
                r.top +
                r.height /
                  2
            },

            html:
              b.el
                .outerHTML
                .slice(
                  0,
                  1600
                )
          };
        }
      }

      return null;
    }
  );
}

async function clickActualCommentButton(
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

  /*
   * Click the exact point belonging
   * to the actual element.
   */
  await page.mouse.click(
    found.rect.centerX,
    found.rect.centerY
  );

  await page.waitForTimeout(
    1200
  );

  return found;
}

/* =========================================================
   VERIFY REAL COMMENT UI
   ========================================================= */

async function overlayFingerprint(
  page
) {
  return page.evaluate(
    () => {
      const all =
        Array.from(
          document.querySelectorAll(
            'body *'
          )
        );

      return all
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

            const text =
              (
                el.innerText ||
                ''
              ).trim();

            if (
              r.width < 250 ||
              r.height <
                220 ||
              s.display ===
                'none' ||
              s.visibility ===
                'hidden'
            ) {
              return null;
            }

            const fixedish =
              s.position ===
                'fixed' ||
              s.position ===
                'absolute' ||
              el.getAttribute(
                'role'
              ) ===
                'dialog';

            const scrollable =
              /(auto|scroll)/.test(
                s.overflowY
              ) &&
              el.scrollHeight >
                el.clientHeight +
                  50;

            const rightSide =
              r.right >
              window.innerWidth *
                0.55;

            const commentWords =
              /Reply|View all comments|comments|پاسخ|نظر|دیدگاه/i.test(
                text
              );

            if (
              !(
                fixedish ||
                scrollable
              ) ||
              !(
                rightSide ||
                el.getAttribute(
                  'role'
                ) === 'dialog'
              )
            ) {
              return null;
            }

            return {
              index,

              role:
                el.getAttribute(
                  'role'
                ),

              position:
                s.position,

              scrollTop:
                el.scrollTop,

              scrollHeight:
                el.scrollHeight,

              clientHeight:
                el.clientHeight,

              rect: {
                x: r.x,
                y: r.y,
                width:
                  r.width,
                height:
                  r.height
              },

              commentWords,

              textSample:
                text.slice(
                  0,
                  700
                )
            };
          }
        )
        .filter(Boolean);
    }
  );
}

async function verifyCommentPanelOpened(
  page,
  beforeFingerprint
) {
  const deadline =
    Date.now() +
    6000;

  while (
    Date.now() <
    deadline
  ) {
    const dialogs =
      await page
        .locator(
          '[role="dialog"]:visible'
        )
        .count()
        .catch(
          () =>
            0
        );

    if (
      dialogs > 0
    ) {
      return {
        verified: true,
        strategy:
          'visible-dialog'
      };
    }

    const after =
      await overlayFingerprint(
        page
      );

    const beforeKeys =
      new Set(
        (
          beforeFingerprint ||
          []
        ).map(
          x =>
            JSON.stringify(
              [
                x.role,
                x.position,
                x.rect.x,
                x.rect.y,
                x.rect.width,
                x.rect.height,
                x.scrollHeight,
                x.textSample
              ]
            )
        )
      );

    const fresh =
      after.filter(
        x =>
          !beforeKeys.has(
            JSON.stringify(
              [
                x.role,
                x.position,
                x.rect.x,
                x.rect.y,
                x.rect.width,
                x.rect.height,
                x.scrollHeight,
                x.textSample
              ]
            )
          )
      );

    if (
      fresh.some(
        x =>
          x.commentWords ||
          x.scrollHeight >
            x.clientHeight +
              150
      )
    ) {
      return {
        verified: true,
        strategy:
          'new-comment-overlay'
      };
    }

    /*
     * Instagram sometimes reuses an existing
     * fixed container rather than inserting
     * a brand new node.
     */
    for (
      const b of
      beforeFingerprint ||
      []
    ) {
      const match =
        after.find(
          a =>
            a.position ===
              b.position &&
            Math.abs(
              a.rect.x -
                b.rect.x
            ) < 3 &&
            Math.abs(
              a.rect.y -
                b.rect.y
            ) < 3 &&
            Math.abs(
              a.rect.width -
                b.rect.width
            ) < 3 &&
            Math.abs(
              a.rect.height -
                b.rect.height
            ) < 3
        );

      if (!match) {
        continue;
      }

      const textChanged =
        match.textSample !==
        b.textSample;

      const scrollGrew =
        match.scrollHeight >
        b.scrollHeight +
          120;

      if (
        (
          textChanged ||
          scrollGrew
        ) &&
        (
          match.commentWords ||
          match.scrollHeight >
            match.clientHeight +
              150
        )
      ) {
        return {
          verified: true,
          strategy:
            'reused-comment-overlay'
        };
      }
    }

    await page.waitForTimeout(
      400
    );
  }

  return {
    verified: false,
    strategy:
      'no-new-comment-ui'
  };
}

/* =========================================================
   MARK REAL COMMENT ROOT
   ========================================================= */

async function markCommentRoot(
  page
) {
  return page.evaluate(
    () => {
      const MARK =
        'data-ig-automation-comment-root';

      document
        .querySelectorAll(
          `[${MARK}]`
        )
        .forEach(
          el =>
            el.removeAttribute(
              MARK
            )
        );

      const candidates =
        [];

      /*
       * Visible dialogs:
       * choose the actual scrollable child
       * when it exists.
       */
      const dialogs =
        Array.from(
          document.querySelectorAll(
            '[role="dialog"]:visible'
          )
        );

      for (
        const dialog of dialogs
      ) {
        const r =
          dialog.getBoundingClientRect();

        const s =
          getComputedStyle(
            dialog
          );

        const text =
          dialog.innerText ||
          '';

        const dialogScrollables =
          Array.from(
            dialog.querySelectorAll(
              '*'
            )
          ).filter(
            el => {
              const es =
                getComputedStyle(
                  el
                );

              return (
                /(auto|scroll)/.test(
                  es.overflowY
                ) &&
                el.scrollHeight >
                  el.clientHeight +
                    80
              );
            }
          );

        if (
          dialogScrollables.length
        ) {
          dialogScrollables.sort(
            (a, b) => {
              const score =
                el =>
                  (
                    /(
                      Reply|
                      پاسخ
                    )/ix.test(
                      el.innerText ||
                        ''
                    )
                      ? 50
                      : 0
                  ) +
                  (
                    /(
                      View all comments|
                      View all \d+ comments
                    )/ix.test(
                      el.innerText ||
                        ''
                    )
                      ? 30
                      : 0
                  ) +
                  Math.min(
                    20,
                    Math.floor(
                      (
                        el.scrollHeight -
                        el.clientHeight
                      ) / 100
                    )
                  );

              return (
                score(b) -
                score(a)
              );
            }
          );

          const child =
            dialogScrollables[0];

          const cr =
            child.getBoundingClientRect();

          candidates.push({
            el: child,

            score:
              125 +
              (
                /(Reply|پاسخ)/i.test(
                  child.innerText ||
                    ''
                )
                  ? 40
                  : 0
              ) +
              (
                /(
                  View all comments|
                  View all \d+ comments
                )/ix.test(
                  child.innerText ||
                    ''
                )
                  ? 30
                  : 0
              ),

            area:
              cr.width *
              cr.height
          });
        } else {
          candidates.push({
            el: dialog,

            score:
              100 +
              (
                /(Reply|پاسخ)/i.test(
                  text
                )
                  ? 40
                  : 0
              ) +
              (
                /(
                  View all comments|
                  View all \d+ comments
                )/ix.test(
                  text
                )
                  ? 30
                  : 0
              ) +
              (
                /(auto|scroll)/.test(
                  s.overflowY
                )
                  ? 25
                  : 0
              ),

            area:
              r.width *
              r.height
          });
        }
      }

      /*
       * Non-dialog overlay fallback.
       */
      const all =
        Array.from(
          document.querySelectorAll(
            'body *'
          )
        );

      for (
        const el of all
      ) {
        const r =
          el.getBoundingClientRect();

        const s =
          getComputedStyle(
            el
          );

        const text =
          el.innerText ||
          '';

        if (
          r.width < 280 ||
          r.height < 260 ||
          r.right <
            window.innerWidth *
              0.55 ||
          !(
            s.position ===
              'fixed' ||
            s.position ===
              'absolute' ||
            /(auto|scroll)/.test(
              s.overflowY
            )
          ) ||
          el.scrollHeight <=
            el.clientHeight +
              80
        ) {
          continue;
        }

        let score =
          0;

        if (
          /Reply|پاسخ/i.test(
            text
          )
        ) {
          score += 35;
        }

        if (
          /(
            View all comments|
            View all \d+ comments
          )/ix.test(
            text
          )
        ) {
          score += 25;
        }

        if (
          /Add a comment/i.test(
            text
          )
        ) {
          score += 5;
        }

        if (
          el.scrollHeight >
          1000
        ) {
          score += 15;
        }

        candidates.push({
          el,
          score,
          area:
            r.width *
            r.height
        });
      }

      candidates.sort(
        (a, b) =>
          (
            b.score -
            a.score
          ) ||
          (
            b.area -
            a.area
          )
      );

      const best =
        candidates[0];

      if (
        !best ||
        best.score < 30
      ) {
        return false;
      }

      best.el.setAttribute(
        MARK,
        '1'
      );

      return {
        score:
          best.score,

        tag:
          best.el.tagName,

        role:
          best.el.getAttribute(
            'role'
          ),

        rect:
          (() => {
            const r =
              best.el.getBoundingClientRect();

            return {
              x:
                r.x,

              y:
                r.y,

              width:
                r.width,

              height:
                r.height
            };
          })(),

        scrollHeight:
          best.el.scrollHeight,

        clientHeight:
          best.el.clientHeight
      };
    }
  );
}

async function requireRealCommentRoot(
  page
) {
  const info =
    await markCommentRoot(
      page
    );

  if (!info) {
    throw new Error(
      'COMMENT_ROOT_NOT_FOUND_AFTER_REAL_CLICK'
    );
  }

  appendLog(
    'COMMENT_ROOT_MARKED',
    info
  );

  return page.locator(
    '[data-ig-automation-comment-root="1"]'
  );
}

async function saveSingleCommentsScreenshot(
  page,
  rootLocator
) {
  const file =
    path.join(
      ARTIFACTS,
      'comments-list.png'
    );

  await rootLocator.screenshot({
    path: file
  });

  return file;
}

/* =========================================================
   EXTRACT COMMENTS
   ========================================================= */

async function extractComments(
  rootLocator
) {
  return rootLocator.evaluate(
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

      const validProfile =
        href =>
          /^\/[^/]+\/?$/.test(
            href || ''
          ) &&
          !/^\/(explore|reels|direct|accounts|stories|p|reel|about|legal)\b/i.test(
            href || ''
          );

      const links =
        Array.from(
          root.querySelectorAll(
            'a[href^="/"]'
          )
        ).filter(
          a =>
            validProfile(
              a.getAttribute(
                'href'
              )
            )
        );

      const seen =
        new Set();

      const output =
        [];

      for (
        const link of
        links
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

        /*
         * Walk up from username
         * to the smallest real comment row.
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
            !text ||
            text.length >
              700
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

        output.push({
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

      return output;
    }
  );
}

async function clickMoreComments(
  rootLocator
) {
  return rootLocator
    .evaluate(
      root => {
        const elements =
          Array.from(
            root.querySelectorAll(
              'button,[role="button"],a,span,div'
            )
          );

        for (
          const el of
          elements
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
  rootLocator,
  amount
) {
  return rootLocator.evaluate(
    (
      root,
      step
    ) => {
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
          before + step
        );

      return {
        before,

        after:
          root.scrollTop,

        max,

        clientHeight:
          root.clientHeight,

        scrollHeight:
          root.scrollHeight,

        changed:
          root.scrollTop !==
          before,

        atBottom:
          root.scrollTop >=
          max - 8
      };
    },
    amount
  );
}

/* =========================================================
   FULL COMMENT SCAN TO END
   ========================================================= */

async function collectAllComments(
  page,
  rootLocator
) {
  const byKey =
    new Map();

  let stableAtBottom =
    0;

  let previousSignature =
    '';

  for (
    let round = 1;
    round <=
      MAX_SCAN_ROUNDS;
    round++
  ) {
    const before =
      await rootLocator.evaluate(
        root => ({
          scrollTop:
            root.scrollTop,

          scrollHeight:
            root.scrollHeight,

          clientHeight:
            root.clientHeight,

          max:
            Math.max(
              0,
              root.scrollHeight -
                root.clientHeight
            )
        })
      );

    const clickedMore =
      await clickMoreComments(
        rootLocator
      );

    if (
      clickedMore
    ) {
      await page.waitForTimeout(
        500
      );
    }

    const visible =
      await extractComments(
        rootLocator
      );

    let added =
      0;

    for (
      const comment of
      visible
    ) {
      if (
        !byKey.has(
          comment.key
        )
      ) {
        byKey.set(
          comment.key,
          comment
        );

        added++;
      }
    }

    const scroll =
      await scrollRoot(
        rootLocator,
        SCROLL_STEP
      );

    await page.waitForTimeout(
      SCROLL_WAIT
    );

    const after =
      await rootLocator.evaluate(
        root => ({
          scrollTop:
            root.scrollTop,

          scrollHeight:
            root.scrollHeight,

          clientHeight:
            root.clientHeight,

          max:
            Math.max(
              0,
              root.scrollHeight -
                root.clientHeight
            )
        })
      );

    const signature =
      JSON.stringify({
        count:
          byKey.size,

        scrollTop:
          after.scrollTop,

        max:
          after.max,

        scrollHeight:
          after.scrollHeight
      });

    if (
      after.scrollTop >=
        after.max - 8 &&
      added === 0 &&
      !clickedMore &&
      signature ===
        previousSignature
    ) {
      stableAtBottom++;
    } else {
      stableAtBottom =
        0;
    }

    previousSignature =
      signature;

    if (
      round === 1 ||
      round % 5 === 0 ||
      added > 0 ||
      clickedMore
    ) {
      appendLog(
        'COMMENT_SCAN_ROUND',
        {
          round,

          visible:
            visible.length,

          added,

          totalUnique:
            byKey.size,

          before,

          scroll,

          after,

          clickedMore,

          stableAtBottom
        }
      );
    }

    /*
     * Stop ONLY after reaching bottom and
     * remaining stable for multiple rounds.
     */
    if (
      stableAtBottom >=
      END_STABLE_ROUNDS
    ) {
      appendLog(
        'COMMENT_SCAN_END_REACHED',
        {
          round,

          totalUnique:
            byKey.size,

          final:
            after
        }
      );

      break;
    }
  }

  return Array.from(
    byKey.values()
  );
}

/* =========================================================
   REVEAL MATCHED COMMENT IN VIRTUALIZED LIST
   ========================================================= */

async function revealComment(
  page,
  rootLocator,
  comment
) {
  for (
    let attempt = 0;
    attempt < 30;
    attempt++
  ) {
    const handle =
      await rootLocator
        .evaluateHandle(
          (
            root,
            target
          ) => {
            const normalize =
              value =>
                String(
                  value || ''
                )
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
              const link of
              links
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
                let level = 0;
                level < 10 &&
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

    await rootLocator.evaluate(
      root => {
        const max =
          Math.max(
            0,
            root.scrollHeight -
              root.clientHeight
          );

        root.scrollTop =
          Math.min(
            max,
            root.scrollTop +
              Math.floor(
                root.clientHeight *
                  0.75
              )
          );
      }
    );

    await page.waitForTimeout(
      500
    );
  }

  throw new Error(
    'COMMENT_NOT_REVEALED_FOR_PROCESSING'
  );
}

/* =========================================================
   REPLY
   ========================================================= */

async function clickReplyOnComment(
  page,
  commentElement
) {
  const result =
    await commentElement.evaluate(
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
              const label =
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
                  label
                ) ||
                /\breply\b/i.test(
                  label
                ) ||
                /پاسخ/i.test(
                  label
                )
              );
            }
          );

        if (
          !reply
        ) {
          return false;
        }

        reply.click();

        return true;
      }
    );

  if (
    !result
  ) {
    throw new Error(
      'REPLY_BUTTON_NOT_FOUND'
    );
  }

  await page.waitForTimeout(
    500
  );
}

async function findReplyInput(
  page
) {
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
      return candidate;
    }
  }

  return null;
}

async function sendReply(
  page,
  commentElement,
  replyText
) {
  await clickReplyOnComment(
    page,
    commentElement
  );

  const input =
    await findReplyInput(
      page
    );

  if (!input) {
    throw new Error(
      'REPLY_INPUT_NOT_FOUND'
    );
  }

  await input.fill(
    replyText
  );

  const postButton =
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
      postButton,
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

  let input =
    null;

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
      `DM_INPUT_NOT_FOUND:${username}`
    );
  }

  await input.fill(
    message
  );

  const sendButton =
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
      sendButton,
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

/* =========================================================
   PROCESS MATCHES
   ========================================================= */

async function processMatches(
  page,
  dmPage,
  rootLocator,
  comments,
  keywords,
  commentReply,
  dmReply,
  postLog
) {
  const matches =
    [];

  /*
   * First determine every match from
   * the complete collected comment set.
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

    matches.push({
      comment,
      match
    });

    postLog.matchesFound++;

    appendLog(
      'MATCH_FOUND',
      {
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
  }

  /*
   * Then process each match one-by-one.
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

    try {
      const row =
        await revealComment(
          page,
          rootLocator,
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

  return matches;
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
   * Fingerprint BEFORE click.
   */
  const beforeFingerprint =
    await overlayFingerprint(
      page
    );

  /*
   * Find and click actual Comment icon.
   */
  const clickInfo =
    await clickActualCommentButton(
      page
    );

  postLog.commentClickStrategy =
    clickInfo.strategy;

  /*
   * Verify that a REAL comment UI
   * appeared after click.
   */
  const verification =
    await verifyCommentPanelOpened(
      page,
      beforeFingerprint
    );

  appendLog(
    'COMMENT_UI_VERIFICATION',
    verification
  );

  if (
    !verification.verified
  ) {
    throw new Error(
      'COMMENT_UI_DID_NOT_OPEN_AFTER_REAL_ICON_CLICK'
    );
  }

  /*
   * Mark only the real comment root.
   */
  const root =
    await requireRealCommentRoot(
      page
    );

  /*
   * Exactly ONE screenshot.
   */
  postLog.screenshot =
    await saveSingleCommentsScreenshot(
      page,
      root
    );

  appendLog(
    'COMMENTS_SCREENSHOT_SAVED',
    {
      path:
        postLog.screenshot
    }
  );

  /*
   * Start from top of actual comment root.
   */
  await root.evaluate(
    el => {
      el.scrollTop =
        0;
    }
  );

  await page.waitForTimeout(
    500
  );

  /*
   * Full scan to bottom.
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

      keywordCount:
        keywords.length
    }
  );

  if (
    !comments.length
  ) {
    throw new Error(
      'REAL_COMMENT_ROOT_OPENED_BUT_ZERO_REAL_COMMENTS_EXTRACTED'
    );
  }

  /*
   * Match + Reply + DM.
   */
  await processMatches(
    page,
    dmPage,
    root,
    comments,
    keywords,
    commentReply,
    dmReply,
    postLog
  );

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

  /*
   * Reset log.
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

  /*
   * Same browser context => same Instagram session.
   */
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
   * Post + Comment List.
   */
  const page =
    await context.newPage();

  /*
   * Second page:
   * DM.
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
        'Instagram Web Desktop - verified real Comment button + real comment root',

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

    posts:
      [],

    errors:
      []
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

    /*
     * Summary JSON.
     */
    writeJson(
      'run-summary.json',
      runLog
    );

    /*
     * Save latest session state.
     */
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
