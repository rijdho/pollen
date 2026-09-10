import { el, clear, status, appendAll } from '../ui.js?v=2';
import { t, locale } from '../i18n.js?v=2';
import { api, liveSocket, imageUrl, ApiError } from '../api.js?v=2';
import { qrSvg } from '../qr.js?v=2';
import { cloudWeight } from '../shared/aggregate.js?v=2';
import { layoutCloud } from '../shared/cloudlayout.js?v=2';
import { forget } from '../rooms.js?v=2';
import { blankQuestion, retype, typeLabel, promptField, imageField, typeFields, QUESTION_TYPES } from './qform.js?v=2';

/**
 * The projected screen. It is the only view that sees results, and the only
 * one that holds a socket carrying them: pushing the tally to every phone in
 * the room would multiply the message count by the size of the room.
 */
export function renderPresent(root, { code, adminKey, onHome }) {
  clear(root);
  const joinUrl = `${location.origin}/${code}`;

  const message = el('p', { class: 'status', role: 'status', hidden: true });
  const voters = el('span', { class: 'meta-count' });
  const expiry = el('span', { class: 'meta-count' });
  const link = el('div', { class: 'join-callout' }, [
    el('p', { class: 'eyebrow', text: t('present.joinAt') }),
    el('p', { class: 'join-url', text: joinUrl.replace(/^https?:\/\//, '') }),
    el('p', { class: 'eyebrow', text: t('present.code') }),
    el('p', { class: 'join-code', text: code }),
  ]);

  const countdown = el('p', { class: 'clock', hidden: true });
  let skew = 0;
  let ticker = null;

  const qrBox = el('div', { class: 'qr' });
  const qr = qrSvg(document, joinUrl);
  qr.setAttribute('aria-label', t('present.qrAlt', { url: joinUrl }));
  qrBox.append(qr);

  const stage = el('section', { class: 'stage' });
  const scores = el('section', { class: 'card scores', hidden: true });
  const queue = el('section', { class: 'card moderation', hidden: true });
  const controls = el('div', { class: 'controls' });

  // The key travels in the fragment, which browsers never send to a server, so
  // the link stays out of request lines, edge logs and referrers. Anyone
  // holding it controls the room, and the button says so when it copies.
  const recoveryLink = `${location.origin}/p/${code}#k=${encodeURIComponent(adminKey)}`;
  const recovery = el('details', { class: 'recovery' }, [
    el('summary', { text: t('present.recovery') }),
    el('div', { class: 'recovery-body' }, [
      el('button', {
        class: 'btn', type: 'button', text: t('present.copyLink'),
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(recoveryLink);
            status(message, t('present.copied'), 'warn');
          } catch {
            status(message, recoveryLink, 'warn');
          }
        },
      }),
    ]),
  ]);

  const adder = el('details', { class: 'adder' });

  // Collapsed, the join block is one line instead of a quarter of the screen.
  // The QR is worth its space for the first minute and nothing after it, and at
  // fifteen metres that space is the difference between reading the bars and
  // guessing them.
  let joined = false;
  const head = el('header', { class: 'present-head' });
  const joinToggle = el('button', {
    class: 'btn btn-quiet join-toggle', type: 'button',
    onClick: () => { joined = !joined; drawHead(); },
  });

  function drawHead() {
    clear(head);
    head.className = joined ? 'present-head is-collapsed' : 'present-head';
    joinToggle.textContent = joined ? '▾' : '▴';
    joinToggle.title = t(joined ? 'present.expandJoin' : 'present.collapseJoin');
    joinToggle.setAttribute('aria-label', joinToggle.title);
    joinToggle.setAttribute('aria-expanded', joined ? 'false' : 'true');
    appendAll(head, joined
      ? [
        el('span', { class: 'join-code-small', text: code }),
        el('span', { class: 'join-url-small', text: joinUrl.replace(/^https?:\/\//, '') }),
        el('div', { class: 'present-meta' }, [voters, countdown]),
        joinToggle,
      ]
      : [
        link, qrBox,
        el('div', { class: 'present-meta' }, [voters, expiry, countdown]),
        joinToggle,
      ]);
  }
  drawHead();

  appendAll(root, [
    head,
    stage,
    scores,
    queue,
    controls,
    el('div', { class: 'present-tools' }, [adder, recovery]),
    message,
  ]);

  /**
   * Presentation mode. Full screen removes the browser's own chrome, and
   * data-presenting removes this page's: the site header, the footer and the
   * tools, with the controls fading out until the mouse moves. What is left is
   * the question and the answers, which is what the room is looking at.
   */
  let idleTimer = null;
  function setPresenting(on) {
    document.body.dataset.presenting = on ? 'true' : 'false';
    fullscreenButton.textContent = t(on ? 'present.exitFullscreen' : 'present.fullscreen');
    clearTimeout(idleTimer);
    if (on) idle();
    else document.body.dataset.idle = 'false';
  }

  function idle() {
    document.body.dataset.idle = 'false';
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (document.body.dataset.presenting === 'true') document.body.dataset.idle = 'true';
    }, 3000);
  }

  const onMove = () => { if (document.body.dataset.presenting === 'true') idle(); };
  const onFullscreenChange = () => setPresenting(Boolean(document.fullscreenElement));
  addEventListener('mousemove', onMove);
  addEventListener('keydown', onMove);
  document.addEventListener('fullscreenchange', onFullscreenChange);

  const fullscreenButton = el('button', {
    class: 'btn', type: 'button', text: t('present.fullscreen'),
    onClick: async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch {
        // Some browsers refuse without a user gesture they recognise, and a
        // refused request is not worth an error on a projected screen.
        status(message, t('present.fullscreen'), 'warn');
      }
    },
  });

  function secondsLeft() {
    const seconds = state?.question?.spec?.seconds || 0;
    if (!seconds || !state.startedAt) return null;
    return Math.max(0, Math.ceil((state.startedAt + seconds * 1000 - (Date.now() + skew)) / 1000));
  }

  function runClock() {
    clearInterval(ticker);
    ticker = null;
    const tick = () => {
      const left = secondsLeft();
      if (left === null) { countdown.hidden = true; return; }
      countdown.hidden = false;
      countdown.textContent = left > 0 ? t('present.timeLeft', { n: left }) : t('present.timeUp');
      countdown.dataset.out = left === 0 ? 'true' : 'false';
      if (left === 0) { clearInterval(ticker); ticker = null; }
    };
    tick();
    if (secondsLeft() !== null) ticker = setInterval(tick, 500);
  }

  /** Adding a question to a room that is already running. */
  function drawAdder() {
    clear(adder);
    let draft = blankQuestion('choice');
    const body = el('div', { class: 'adder-body' });
    const redraw = () => {
      clear(body);
      body.append(
        el('div', { class: 'actions' }, QUESTION_TYPES.map((type) => el('button', {
          class: draft.type === type ? 'btn btn-brand' : 'btn', type: 'button',
          text: typeLabel(type),
          // retype, not blankQuestion: changing your mind about the type should
          // not throw away the question you have already typed.
          onClick: () => { draft = retype(draft, type); redraw(); },
        }))),
        promptField(draft),
        imageField(draft),
        typeFields(draft),
        el('button', {
          class: 'btn btn-brand btn-lg', type: 'button', text: t('present.addNow'),
          onClick: async () => {
            if (draft.prompt.trim() === '') { status(message, t('editor.empty'), 'error'); return; }
            await act('add', { question: draft });
            draft = blankQuestion(draft.type);
            redraw();
          },
        }),
      );
    };
    redraw();
    adder.append(el('summary', { text: t('present.add') }), body);
  }
  drawAdder();

  let state = null;

  async function act(action, payload = {}) {
    try {
      const res = await api.admin(code, adminKey, action, payload);
      if (res.closed) {
        forget(code);
        clear(root);
        root.append(el('section', { class: 'card' }, [
          el('p', { class: 'lede', text: t('present.closed') }),
          el('button', { class: 'btn btn-brand', type: 'button', text: t('brand.name'), onClick: onHome }),
        ]));
        socket.close();
        return;
      }
      if (res.state) paint(res.state);
    } catch (err) {
      status(message, t('error.' + (err instanceof ApiError ? err.code : 'internal')), 'error');
    }
  }

  function paint(next) {
    if (typeof next.now === 'number') skew = next.now - Date.now();
    state = next;
    runClock();
    voters.textContent = t('present.voters', { n: state.voters });
    // The room deleting itself is the whole privacy claim, so the person
    // standing next to the screen can read when it happens.
    expiry.textContent = state.expiresAt
      ? t('present.expires', { time: formatTime(state.expiresAt) })
      : '';
    drawStage();
    drawQueue();
    drawControls();
    drawScores();
  }

  function drawStage() {
    clear(stage);
    if (!state.question) {
      stage.append(el('p', { class: 'stage-idle', text: t('present.waiting') }));
      return;
    }
    appendAll(stage, [
      el('p', { class: 'stage-step', text: t('join.of', { n: state.current + 1, total: state.total }) }),
      el('h2', { class: 'stage-prompt', text: state.question.prompt }),
      // Fetched by URL, not carried in the socket. The presenter's socket
      // pushes the tally on every vote, and a picture riding on it would be
      // sent again with every answer in the room; here the browser fetches it
      // once per question and caches it. See api.js -> imageUrl.
      state.question.spec.image
        ? el('img', {
          class: 'stage-image', src: imageUrl(code, state.question.idx),
          alt: state.question.spec.image.alt || '',
        })
        : null,
      results(state.question, state.results),
    ]);
  }

  /** Only where something can be right. A scoreboard on a poll is nonsense. */
  function drawScores() {
    const board = state.scores;
    scores.hidden = !board;
    if (!board) return;
    clear(scores);
    scores.append(el('p', { class: 'eyebrow', text: t('present.scoreboard') }));
    if (board.rows.length === 0) {
      scores.append(el('p', { class: 'hint', text: t('present.noScores') }));
      return;
    }
    scores.append(el('ol', { class: 'score-list' }, board.rows.map((row, i) => el('li', {
      class: i === 0 ? 'score-row leading' : 'score-row',
    }, [
      el('span', { class: 'score-rank', text: String(i + 1) }),
      el('span', { class: 'score-nick', text: row.nick }),
      el('span', { class: 'score-points', text: t('present.points', { n: row.score, of: board.of }) }),
    ]))));
  }

  function qaChart(data) {
    return el('ol', { class: 'qa-board' }, data.items.map((item, i) => el('li', {
      class: i === 0 ? 'qa-board-item leading' : 'qa-board-item',
    }, [
      el('span', {
        class: 'qa-board-votes', text: '▲ ' + item.votes,
        'aria-label': t('present.supports', { n: item.votes }),
      }),
      el('span', { class: 'qa-board-text', text: item.text }),
    ])));
  }

  function results(question, data) {
    if (data && data.type === 'qa') {
      return data.items.length === 0
        ? el('p', { class: 'stage-idle', text: t('present.qaEmpty') })
        : qaChart(data);
    }
    if (!data || (data.type === 'choice' && data.responses === 0)
      || (data.type === 'scale' && data.n === 0)
      || (data.type === 'rank' && data.n === 0)
      || (data.type === 'cloud' && data.items.length === 0)) {
      return el('p', { class: 'stage-idle', text: t('present.noAnswers') });
    }
    if (data.type === 'choice') {
      const kind = question.spec.chart || 'bars';
      if (kind === 'donut') return donutChart(question, data);
      if (kind === 'dots') return dotsChart(question, data);
      return choiceChart(question, data);
    }
    if (data.type === 'scale') return scaleChart(question, data);
    if (data.type === 'rank') return rankChart(data);
    return cloudChart(data);
  }

  /**
   * A ramp of the brand rather than eight hues, because the letter is what
   * identifies a slice on a wall and a colour legend is one more thing to read
   * at fifteen metres. The gaps between segments do the separating.
   */
  function shade(i, total) {
    return (1 - (i / Math.max(1, total - 1)) * 0.62).toFixed(2);
  }

  function donutChart(question, data) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 42 42');
    svg.setAttribute('class', 'donut-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', data.options
      .map((label, i) => `${label}: ${data.percentages[i]}%`).join(', '));

    const R = 15.9155; // circumference 100, so a percentage is a dash length
    const GAP = 0.8;
    let offset = 25; // start at twelve o'clock
    data.percentages.forEach((pct, i) => {
      if (pct <= 0) return;
      const ring = document.createElementNS(NS, 'circle');
      ring.setAttribute('cx', '21');
      ring.setAttribute('cy', '21');
      ring.setAttribute('r', String(R));
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', 'currentColor');
      ring.setAttribute('stroke-width', '7');
      ring.setAttribute('stroke-opacity', shade(i, data.options.length));
      ring.setAttribute('stroke-dasharray', `${Math.max(0, pct - GAP)} ${100 - Math.max(0, pct - GAP)}`);
      ring.setAttribute('stroke-dashoffset', String(offset));
      offset -= pct;
      svg.append(ring);
    });

    const total = document.createElementNS(NS, 'text');
    total.setAttribute('x', '21');
    total.setAttribute('y', '21');
    total.setAttribute('text-anchor', 'middle');
    total.setAttribute('dominant-baseline', 'central');
    total.setAttribute('class', 'donut-total');
    total.textContent = String(data.responses);
    svg.append(total);

    return el('div', { class: 'donut' }, [
      svg,
      el('ul', { class: 'donut-key' }, data.options.map((label, i) => el('li', {
        class: 'donut-key-item',
      }, [
        el('span', {
          class: 'donut-swatch', 'aria-hidden': 'true',
          style: { opacity: shade(i, data.options.length) },
          text: LETTERS[i] || String(i + 1),
        }),
        el('span', { class: 'donut-key-label', text: label }),
        el('span', { class: 'donut-key-value', text: `${data.percentages[i]}% (${data.counts[i]})` }),
      ]))),
    ]);
  }

  /**
   * One dot per answer. Honest about small numbers in a way a percentage is
   * not: four out of twelve reads as four dots, where 33% reads as a third of
   * something that might have been a thousand.
   */
  function dotsChart(question, data) {
    return el('div', { class: 'dots' }, data.options.map((label, i) => el('div', {
      class: 'dots-row',
    }, [
      el('span', { class: 'bar-key', 'aria-hidden': 'true', text: LETTERS[i] || String(i + 1) }),
      el('span', { class: 'dots-label', text: label }),
      el('span', { class: 'dots-value', text: `${data.percentages[i]}% (${data.counts[i]})` }),
      el('div', {
        class: 'dots-grid',
        role: 'img',
        'aria-label': t('present.responses', { n: data.counts[i] }),
      }, Array.from({ length: data.counts[i] }, () => el('span', {
        class: 'dot', style: { opacity: shade(i, data.options.length) },
      }))),
    ])));
  }

  /** Lower is better: the average position the room put each option in. */
  function rankChart(data) {
    const worst = data.options.length;
    return el('ol', { class: 'rank-board' }, data.rows.map((row, i) => el('li', {
      class: i === 0 ? 'rank-board-item leading' : 'rank-board-item',
    }, [
      el('span', { class: 'rank-board-pos', text: String(i + 1) }),
      el('span', { class: 'rank-board-label', text: data.options[row.index] }),
      el('span', { class: 'rank-board-track' }, [
        el('span', {
          class: 'rank-board-fill',
          // A bar that grows as the average improves, so first place is the
          // longest rather than the shortest.
          style: { width: (((worst - row.average) / (worst - 1)) * 100).toFixed(1) + '%' },
        }),
      ]),
      el('span', { class: 'rank-board-avg', text: t('present.rankAverage', { value: row.average }) }),
    ])));
  }

  const LETTERS = 'ABCDEFGH';

  function choiceChart(question, data) {
    const top = Math.max(...data.counts);
    return el('div', { class: 'bars' }, data.options.map((label, i) => {
      // Only a real leader is marked. With everything tied, nothing leads, and
      // saying otherwise would be the chart inventing a result.
      const leads = data.counts[i] === top && top > 0 && data.counts.filter((c) => c === top).length === 1;
      // Once revealed, being right outranks being popular: the mark goes on
      // the correct option whether or not the room chose it.
      const right = state.revealed && (question.spec.correct || []).includes(i);
      const classes = ['bar-row', leads ? 'leading' : '', right ? 'is-right' : ''].filter(Boolean).join(' ');
      return el('div', { class: classes }, [
        right ? el('span', { class: 'right-flag', text: t('present.correct') }) : null,
        el('span', { class: 'bar-key', 'aria-hidden': 'true', text: LETTERS[i] || String(i + 1) }),
        el('span', { class: 'bar-name', text: label }),
        el('span', { class: 'bar-value' }, [
          el('span', { class: 'bar-pct', text: data.percentages[i] + '%' }),
          el('span', { class: 'bar-count', text: t('present.responses', { n: data.counts[i] }) }),
        ]),
        el('div', { class: 'bar-track' }, [
          el('div', { class: 'bar-fill', style: { width: data.percentages[i] + '%' } }),
        ]),
      ]);
    }));
  }

  function scaleChart(question, data) {
    const max = Math.max(...data.histogram, 1);
    const steps = question.spec.steps;
    const labels = question.spec.labels || { min: '', max: '' };
    // Column centres sit at (i + 0.5) / steps of the width, so a mean of 1
    // lands on the first column and a mean of `steps` on the last.
    const meanAt = ((data.mean - 0.5) / steps) * 100;

    return el('div', { class: 'scale-chart' }, [
      el('div', { class: 'scale-reading' }, [
        el('span', { class: 'scale-reading-value', text: data.mean.toFixed(1) }),
        el('span', { class: 'scale-reading-name', text: t('present.meanLabel') }),
        el('span', { class: 'scale-reading-sub', text: [
          t('present.median', { value: data.median }),
          t('present.responses', { n: data.n }),
        ].join(' · ') }),
      ]),
      // Three rows laid out identically rather than three stacked children per
      // column: it is what lets the mean marker sit in the same coordinate
      // space as the bars, and it keeps the count above its own bar instead of
      // below it, where it read as another step on the scale.
      el('div', { class: 'scale-plot' }, [
        el('div', { class: 'scale-row scale-counts' }, data.histogram.map((n) =>
          el('span', { class: n === max && max > 0 ? 'column-count is-top' : 'column-count', text: String(n) }))),
        el('div', { class: 'scale-row scale-tracks' }, [
          ...data.histogram.map((n) => el('div', { class: 'column-track' }, [
            el('div', {
              class: n === max && max > 0 ? 'column-fill tallest' : 'column-fill',
              style: { height: Math.round((n / max) * 100) + '%' },
            }),
          ])),
          el('div', {
            class: 'mean-mark',
            dataset: { label: data.mean.toFixed(1) },
            style: { left: meanAt + '%' },
          }),
        ]),
        el('div', { class: 'scale-row scale-steps' }, data.histogram.map((n, i) =>
          el('span', { class: 'column-step', text: String(i + 1) }))),
      ]),
      el('div', { class: 'scale-ends' }, [
        el('span', { text: labels.min }),
        el('span', { text: labels.max }),
      ]),
    ]);
  }

  // One canvas, reused, purely to ask the browser how wide a word will be at a
  // given size. Nothing is ever drawn on it.
  let ruler = null;
  function measureWord(text, size) {
    if (!ruler) ruler = document.createElement('canvas').getContext('2d');
    const font = getComputedStyle(document.body).getPropertyValue('--disp').trim();
    ruler.font = `700 ${size}px ${font}`;
    // Cap height plus a little, rather than the full line box: word clouds pack
    // by the ink, not by the leading.
    return { w: ruler.measureText(text).width, h: size * 0.78 };
  }

  // The layout box is fixed and the SVG scales to fit it, so the same answers
  // make the same cloud on a laptop and on a projector.
  const CLOUD_BOX = { width: 1200, height: 520 };

  function cloudChart(data) {
    const max = data.items[0]?.count || 1;
    const { placed, dropped } = layoutCloud(data.items, {
      ...CLOUD_BOX,
      measure: measureWord,
      minSize: 24,
      maxSize: 132,
    });

    // A spiral fills the middle and leaves the corners empty, so the drawing is
    // always smaller than the box it was laid out in. Cropping the viewBox to
    // what was actually placed lets the cloud fill the screen instead of
    // floating in the middle of its own padding.
    const margin = 8;
    const bounds = placed.reduce((box, w) => ({
      minX: Math.min(box.minX, w.x - w.w / 2),
      maxX: Math.max(box.maxX, w.x + w.w / 2),
      minY: Math.min(box.minY, w.y - w.h / 2),
      maxY: Math.max(box.maxY, w.y + w.h / 2),
    }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
    const view = placed.length === 0
      ? { x: 0, y: 0, w: CLOUD_BOX.width, h: CLOUD_BOX.height }
      : {
        x: bounds.minX - margin,
        y: bounds.minY - margin,
        w: bounds.maxX - bounds.minX + margin * 2,
        h: bounds.maxY - bounds.minY + margin * 2,
      };

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `${view.x.toFixed(1)} ${view.y.toFixed(1)} ${view.w.toFixed(1)} ${view.h.toFixed(1)}`);
    svg.setAttribute('class', 'cloud-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', data.items.map((i) => `${i.label} ${i.count}`).join(', '));

    for (const word of placed) {
      const node = document.createElementNS(NS, 'text');
      node.setAttribute('x', '0');
      node.setAttribute('y', '0');
      node.setAttribute('transform',
        `translate(${word.x.toFixed(1)} ${word.y.toFixed(1)})` + (word.rotate ? ` rotate(${word.rotate})` : ''));
      node.setAttribute('text-anchor', 'middle');
      node.setAttribute('dominant-baseline', 'central');
      node.setAttribute('font-size', String(word.size));
      // Weight and opacity ride with the count as well as size, so the busiest
      // words read as heavier and not merely bigger.
      const weight = cloudWeight(word.count, max);
      node.setAttribute('font-weight', String(Math.round(500 + weight * 300)));
      node.setAttribute('opacity', (0.55 + weight * 0.45).toFixed(2));
      node.setAttribute('fill', 'currentColor');
      node.textContent = word.label;
      const title = document.createElementNS(NS, 'title');
      title.textContent = t('present.responses', { n: word.count });
      node.append(title);
      svg.append(node);
    }

    return el('div', { class: 'cloud' }, [
      svg,
      // Said out loud rather than swallowed: a word that could not be fitted is
      // an answer somebody gave and nobody can see.
      dropped.length > 0
        ? el('p', { class: 'hint', text: t('present.cloudDropped', { n: dropped.length }) })
        : null,
    ]);
  }

  function drawQueue() {
    const items = state.pending || [];
    // Only where approval is actually switched on. A queue that says "nothing
    // waiting" under a question that never waits for anything is furniture.
    queue.hidden = !state.question
      || !['cloud', 'qa'].includes(state.question.type)
      || !state.question.spec?.moderation;
    if (queue.hidden) return;
    clear(queue);
    // The status colouring belongs to a queue that has something in it. An
    // empty queue wearing an amber edge announces an alert that is not there.
    queue.className = items.length > 0 ? 'card moderation moderation-waiting' : 'card moderation';
    queue.append(el('p', { class: 'eyebrow', text: t('present.pending') }));
    if (items.length === 0) {
      queue.append(el('p', { class: 'hint', text: t('present.noPending') }));
      return;
    }
    queue.append(el('ul', { class: 'queue-list' }, items.map((item) => el('li', { class: 'queue-item' }, [
      el('span', { class: 'queue-text', text: item.text }),
      el('button', { class: 'btn btn-brand', type: 'button', text: t('present.approve'), onClick: () => act('moderate', { voter: item.voter, seq: item.seq, approve: true }) }),
      el('button', { class: 'btn btn-quiet', type: 'button', text: t('present.reject'), onClick: () => act('moderate', { voter: item.voter, seq: item.seq, approve: false }) }),
    ]))));
  }

  function drawControls() {
    clear(controls);
    const at = state.current;
    const last = state.total - 1;
    // appendAll, not append: the reveal button is null on a question with no
    // right answer, and append() would write the word "null" between two real
    // buttons.
    appendAll(controls, [
      el('button', { class: 'btn', type: 'button', text: t('present.prev'), disabled: at <= 0, onClick: () => act('goto', { idx: at - 1 }) }),
      el('button', {
        class: 'btn btn-brand', type: 'button',
        text: at < 0 ? t('present.start') : t('present.next'),
        disabled: at >= last,
        onClick: () => act('goto', { idx: at + 1 }),
      }),
      el('button', {
        class: 'btn', type: 'button', disabled: at < 0,
        text: state.locked ? t('present.unlock') : t('present.lock'),
        onClick: () => act('lock', { locked: !state.locked }),
      }),
      el('button', {
        class: 'btn btn-quiet', type: 'button', disabled: at < 0, text: t('present.reset'),
        onClick: () => { if (confirm(t('present.resetConfirm'))) act('reset'); },
      }),
      (state.question?.spec?.correct || []).length > 0
        ? el('button', {
          class: state.revealed ? 'btn' : 'btn btn-brand', type: 'button',
          text: state.revealed ? t('present.hideAnswer') : t('present.reveal'),
          onClick: () => act('reveal', { revealed: !state.revealed }),
        })
        : null,
      fullscreenButton,
      el('button', { class: 'btn btn-quiet', type: 'button', text: t('present.export'), onClick: download }),
      el('button', { class: 'btn btn-quiet', type: 'button', text: t('present.exportCsv'), onClick: downloadCsv }),
      el('button', {
        class: 'btn btn-quiet', type: 'button', text: t('present.close'),
        onClick: () => { if (confirm(t('present.closeConfirm'))) act('close'); },
      }),
    ]);
  }

  function formatTime(stamp) {
    try {
      return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(stamp));
    } catch {
      return new Date(stamp).toISOString().slice(11, 16);
    }
  }

  /**
   * The same export as a spreadsheet. One long table with a `section` column
   * rather than several sheets, because a CSV has no sheets and splitting it
   * into several files is worse than one that opens.
   */
  function toCsv(data) {
    const cell = (v) => {
      const text = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };
    const rows = [['question', 'prompt', 'type', 'item', 'count', 'detail']];
    data.questions.forEach((q, i) => {
      const n = i + 1;
      const r = q.results;
      if (r.type === 'choice') {
        r.options.forEach((label, k) => rows.push([n, q.prompt, q.type, label, r.counts[k], r.percentages[k] + '%']));
      } else if (r.type === 'scale') {
        r.histogram.forEach((count, k) => rows.push([n, q.prompt, q.type, k + 1, count, '']));
        rows.push([n, q.prompt, q.type, 'mean', '', r.mean]);
        rows.push([n, q.prompt, q.type, 'median', '', r.median]);
      } else if (r.type === 'rank') {
        r.rows.forEach((row, place) => rows.push([n, q.prompt, q.type, r.options[row.index], row.firsts, 'average ' + row.average + ', place ' + (place + 1)]));
      } else if (r.type === 'cloud') {
        r.items.forEach((item) => rows.push([n, q.prompt, q.type, item.label, item.count, '']));
      } else if (r.type === 'qa') {
        r.items.forEach((item) => rows.push([n, q.prompt, q.type, item.text, item.votes, '']));
      }
    });
    if (data.scores) {
      data.scores.rows.forEach((row) => rows.push(['', 'scoreboard', 'score', row.nick, row.score, 'of ' + data.scores.of]));
    }
    return rows.map((row) => row.map(cell).join(',')).join('\r\n');
  }

  function save(text, mime, extension) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `pollen-${code}.${extension}` });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function downloadCsv() {
    try {
      save(toCsv(await api.exportResults(code, adminKey)), 'text/csv;charset=utf-8', 'csv');
    } catch (err) {
      status(message, t('error.' + (err instanceof ApiError ? err.code : 'internal')), 'error');
    }
  }

  async function download() {
    try {
      save(JSON.stringify(await api.exportResults(code, adminKey), null, 2), 'application/json', 'json');
    } catch (err) {
      status(message, t('error.' + (err instanceof ApiError ? err.code : 'internal')), 'error');
    }
  }

  const socket = liveSocket(`/api/rooms/${code}/live?k=${encodeURIComponent(adminKey)}`, {
    onMessage: (msg) => {
      if (msg.type === 'state') {
        status(message, '');
        paint(msg.state);
      } else if (msg.type === 'expired') {
        forget(code);
        status(message, t('present.closed'), 'error');
      }
    },
    onStatus: (kind) => {
      if (kind === 'reconnecting') status(message, t('present.reconnecting'), 'warn');
    },
  });

  // The socket delivers the first state on connect, but a refresh on a dead
  // connection should still show something rather than an empty screen.
  api.state(code, adminKey).then(paint).catch((err) => {
    status(message, t('error.' + (err instanceof ApiError ? err.code : 'internal')), 'error');
  });

  return () => {
    clearInterval(ticker);
    clearTimeout(idleTimer);
    removeEventListener('mousemove', onMove);
    removeEventListener('keydown', onMove);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.body.dataset.presenting = 'false';
    document.body.dataset.idle = 'false';
    socket.close();
  };
}
