import { el, clear, status } from '../ui.js?v=1';
import { t, locale } from '../i18n.js?v=1';
import { api, liveSocket, ApiError } from '../api.js?v=1';
import { qrSvg } from '../qr.js?v=1';
import { cloudWeight } from '../shared/aggregate.js?v=1';
import { forget } from '../rooms.js?v=1';

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

  const qrBox = el('div', { class: 'qr' });
  const qr = qrSvg(document, joinUrl);
  qr.setAttribute('aria-label', t('present.qrAlt', { url: joinUrl }));
  qrBox.append(qr);

  const stage = el('section', { class: 'stage' });
  const queue = el('section', { class: 'card moderation', hidden: true });
  const controls = el('div', { class: 'controls' });

  root.append(
    el('header', { class: 'present-head' }, [link, qrBox, el('div', { class: 'present-meta' }, [voters, expiry])]),
    stage,
    queue,
    controls,
    message,
  );

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
    state = next;
    voters.textContent = t('present.voters', { n: state.voters });
    // The room deleting itself is the whole privacy claim, so the person
    // standing next to the screen can read when it happens.
    expiry.textContent = state.expiresAt
      ? t('present.expires', { time: formatTime(state.expiresAt) })
      : '';
    drawStage();
    drawQueue();
    drawControls();
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

  function results(question, data) {
    if (!data || (data.type === 'choice' && data.responses === 0)
      || (data.type === 'scale' && data.n === 0)
      || (data.type === 'cloud' && data.items.length === 0)) {
      return el('p', { class: 'stage-idle', text: t('present.noAnswers') });
    }
    if (data.type === 'choice') return choiceChart(data);
    if (data.type === 'scale') return scaleChart(question, data);
    return cloudChart(data);
  }

  function choiceChart(data) {
    return el('div', { class: 'bars' }, data.options.map((label, i) => el('div', { class: 'bar-row' }, [
      el('div', { class: 'bar-label' }, [
        el('span', { class: 'bar-name', text: label }),
        el('span', { class: 'bar-value', text: `${data.percentages[i]}% (${data.counts[i]})` }),
      ]),
      el('div', { class: 'bar-track' }, [
        el('div', { class: 'bar-fill', style: { width: data.percentages[i] + '%' } }),
      ]),
    ])));
  }

  function scaleChart(question, data) {
    const max = Math.max(...data.histogram, 1);
    const labels = question.spec.labels || { min: '', max: '' };
    return el('div', { class: 'scale-chart' }, [
      el('div', { class: 'columns' }, data.histogram.map((n, i) => el('div', { class: 'column' }, [
        el('div', { class: 'column-track' }, [
          el('div', { class: 'column-fill', style: { height: Math.round((n / max) * 100) + '%' } }),
        ]),
        el('span', { class: 'column-count', text: String(n) }),
        el('span', { class: 'column-step', text: String(i + 1) }),
      ]))),
      el('div', { class: 'scale-ends' }, [
        el('span', { text: labels.min }),
        el('span', { text: labels.max }),
      ]),
      el('p', { class: 'stage-meta', text: [
        t('present.mean', { value: data.mean.toFixed(2) }),
        t('present.median', { value: data.median }),
        t('present.responses', { n: data.n }),
      ].join(' · ') }),
    ]);
  }

  function cloudChart(data) {
    const max = data.items[0]?.count || 1;
    return el('div', { class: 'cloud' }, data.items.map((item) => {
      const weight = cloudWeight(item.count, max);
      const size = (1 + weight * 2.6).toFixed(2);
      return el('span', {
        class: 'cloud-word',
        style: { fontSize: size + 'rem', opacity: (0.55 + weight * 0.45).toFixed(2) },
        title: String(item.count),
        text: item.label,
      });
    }));
  }

  function drawQueue() {
    const items = state.pending || [];
    queue.hidden = !state.question || state.question.type !== 'cloud';
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

  return () => socket.close();
}
