import { el, clear, status } from '../ui.js?v=1';
import { t, locale } from '../i18n.js?v=1';
import { api, liveSocket, ApiError } from '../api.js?v=1';
import { qrSvg } from '../qr.js?v=1';
import { cloudWeight } from '../shared/aggregate.js?v=1';
import { forget } from '../rooms.js?v=1';
import { blankQuestion, typeLabel, promptField, typeFields, QUESTION_TYPES } from './qform.js?v=1';

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

  root.append(
    el('header', { class: 'present-head' }, [
      link, qrBox,
      el('div', { class: 'present-meta' }, [voters, expiry, countdown]),
    ]),
    stage,
    scores,
    queue,
    controls,
    el('div', { class: 'present-tools' }, [adder, recovery]),
    message,
  );

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
          onClick: () => { draft = blankQuestion(type); redraw(); },
        }))),
        promptField(draft),
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
    stage.append(
      el('p', { class: 'stage-step', text: t('join.of', { n: state.current + 1, total: state.total }) }),
      el('h2', { class: 'stage-prompt', text: state.question.prompt }),
      results(state.question, state.results),
    );
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
      || (data.type === 'cloud' && data.items.length === 0)) {
      return el('p', { class: 'stage-idle', text: t('present.noAnswers') });
    }
    if (data.type === 'choice') return choiceChart(question, data);
    if (data.type === 'scale') return scaleChart(question, data);
    return cloudChart(data);
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

  function cloudChart(data) {
    const max = data.items[0]?.count || 1;
    return el('div', { class: 'cloud' }, data.items.map((item, i) => {
      const weight = cloudWeight(item.count, max);
      // Weight rides with the count as well as size, so the busiest words read
      // as heavier and not merely bigger.
      return el('span', {
        class: 'cloud-word',
        style: {
          fontSize: (1.1 + weight * 2.9).toFixed(2) + 'rem',
          fontWeight: String(Math.round(500 + weight * 300)),
          opacity: (0.6 + weight * 0.4).toFixed(2),
        },
        title: t('present.responses', { n: item.count }),
      }, [
        item.label,
        // A number beside every word is noise. Beside the few that lead, it is
        // the thing the room wants to know.
        item.count > 1 && i < 3
          ? el('span', { class: 'cloud-word-count', text: String(item.count) })
          : null,
      ]);
    }));
  }

  function drawQueue() {
    const items = state.pending || [];
    queue.hidden = !state.question || !['cloud', 'qa'].includes(state.question.type);
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
    controls.append(
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
      el('button', { class: 'btn btn-quiet', type: 'button', text: t('present.export'), onClick: download }),
      el('button', {
        class: 'btn btn-quiet', type: 'button', text: t('present.close'),
        onClick: () => { if (confirm(t('present.closeConfirm'))) act('close'); },
      }),
    );
  }

  function formatTime(stamp) {
    try {
      return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(stamp));
    } catch {
      return new Date(stamp).toISOString().slice(11, 16);
    }
  }

  async function download() {
    try {
      const data = await api.exportResults(code, adminKey);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `pollen-${code}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
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
    socket.close();
  };
}
