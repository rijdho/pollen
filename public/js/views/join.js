import { el, clear, status } from '../ui.js?v=1';
import { t } from '../i18n.js?v=1';
import { api, liveSocket, ApiError } from '../api.js?v=1';
import { LIMITS } from '../shared/limits.js?v=1';
import { wordCount } from '../shared/sanitize.js?v=1';

/**
 * The phone. It receives only the current question over its socket, never the
 * running tally: results belong on the projector, and pushing them here would
 * multiply every vote by the size of the room.
 */
export function renderJoin(root, { code }) {
  clear(root);
  const message = el('p', { class: 'status', role: 'status', hidden: true });
  const stage = el('section', { class: 'card card-lead join-stage' });
  root.append(el('p', { class: 'join-room', text: code }), stage, message);

  // What this device has already sent, so the phone can say so without asking
  // the server on every question change.
  const sent = new Map();
  // The question the person asked to answer again. Cleared whenever the room
  // moves, so it cannot leak into the next question.
  let editing = null;
  let view = null;

  function paint(next) {
    const moved = view === null || next.current !== view.current;
    view = next;
    if (moved) editing = null;
    draw();
  }

  /**
   * One place decides what the phone shows, so that a socket message arriving
   * after an answer was sent cannot put the form back. That is not cosmetic: a
   * participant who sees the form again assumes their answer was lost.
   */
  function draw() {
    clear(stage);
    if (!view.question) {
      stage.append(el('p', { class: 'lede', text: t('join.waiting') }));
      return;
    }
    stage.append(
      el('p', { class: 'eyebrow', text: t('join.of', { n: view.current + 1, total: view.total }) }),
      el('h2', { class: 'card-title', text: view.question.prompt }),
    );
    if (view.locked) {
      stage.append(el('p', { class: 'hint', text: t('join.locked') }));
      return;
    }
    const type = view.question.type;
    const answered = (sent.get(view.current) || 0) > 0;
    if (type !== 'cloud' && answered && editing !== view.current) {
      stage.append(
        el('p', { class: 'sent', text: t('join.thanks') }),
        el('button', {
          class: 'btn btn-quiet', type: 'button', text: t('join.change'),
          onClick: () => { editing = view.current; draw(); },
        }),
      );
      return;
    }
    stage.append(type === 'choice' ? choiceForm() : type === 'scale' ? scaleForm() : cloudForm());
  }

  async function send(value) {
    try {
      status(message, '');
      await api.vote(code, view.current, value);
      sent.set(view.current, (sent.get(view.current) || 0) + 1);
      editing = null;
      draw();
    } catch (err) {
      const failure = err instanceof ApiError ? err.code : 'internal';
      status(message, t('error.' + failure, { n: LIMITS.cloud.maxWords }), 'error');
    }
  }

  function choiceForm() {
    const spec = view.question.spec;
    const picked = new Set();
    const buttons = [];
    const box = el('div', { class: 'choices' });
    spec.options.forEach((label, i) => {
      const button = el('button', {
        class: 'choice', type: 'button', 'aria-pressed': 'false', text: label,
        onClick: () => {
          if (spec.multiple) {
            if (picked.has(i)) picked.delete(i); else picked.add(i);
          } else {
            picked.clear();
            picked.add(i);
          }
          buttons.forEach((node, k) => node.setAttribute('aria-pressed', picked.has(k) ? 'true' : 'false'));
        },
      });
      buttons.push(button);
      box.append(button);
    });
    return el('div', {}, [
      el('p', { class: 'hint', text: spec.multiple ? t('join.chooseMany') : t('join.chooseOne') }),
      box,
      el('button', {
        class: 'btn btn-brand btn-lg btn-block', type: 'button', text: t('join.submit'),
        onClick: () => {
          if (picked.size === 0) { status(message, t('error.empty'), 'error'); return; }
          send([...picked]);
        },
      }),
    ]);
  }

  function scaleForm() {
    const spec = view.question.spec;
    let chosen = null;
    const steps = el('div', { class: 'steps' });
    const buttons = [];
    for (let i = 1; i <= spec.steps; i += 1) {
      const button = el('button', {
        class: 'step', type: 'button', 'aria-pressed': 'false', text: String(i),
        onClick: () => {
          chosen = i;
          buttons.forEach((b, k) => b.setAttribute('aria-pressed', k + 1 === i ? 'true' : 'false'));
        },
      });
      buttons.push(button);
      steps.append(button);
    }
    return el('div', {}, [
      el('p', { class: 'hint', text: t('join.scaleHint', { min: spec.labels.min || '1', max: spec.labels.max || String(spec.steps), max_step: spec.steps }) }),
      steps,
      el('div', { class: 'scale-ends' }, [
        el('span', { text: spec.labels.min }),
        el('span', { text: spec.labels.max }),
      ]),
      el('button', {
        class: 'btn btn-brand btn-lg btn-block', type: 'button', text: t('join.submit'),
        onClick: () => {
          if (chosen === null) { status(message, t('error.empty'), 'error'); return; }
          send(chosen);
        },
      }),
    ]);
  }

  function cloudForm() {
    const spec = view.question.spec;
    const used = sent.get(view.current) || 0;
    const left = Math.max(0, Math.min(spec.entries, LIMITS.cloud.maxEntriesPerVoter) - used);
    if (left === 0) {
      return el('div', {}, [
        el('p', { class: 'sent', text: t('join.thanks') }),
        el('p', { class: 'hint', text: spec.moderation ? t('join.pending') : t('join.entriesNone') }),
      ]);
    }
    const input = el('input', {
      class: 'input input-word', type: 'text', maxlength: String(LIMITS.cloud.maxChars),
      autocomplete: 'off', placeholder: t('join.cloudPlaceholder'),
      'aria-label': view.question.prompt,
    });
    const form = el('form', {
      onSubmit: (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (text === '') { status(message, t('error.empty'), 'error'); return; }
        if (wordCount(text) > LIMITS.cloud.maxWords) {
          status(message, t('error.too_many_words', { n: LIMITS.cloud.maxWords }), 'error');
          return;
        }
        send(text);
      },
    }, [
      input,
      el('button', { class: 'btn btn-brand btn-lg btn-block', type: 'submit', text: t('join.submit') }),
      el('p', { class: 'hint', text: t('join.entriesLeft', { n: left }) }),
    ]);
    return form;
  }

  const socket = liveSocket(`/api/rooms/${code}/follow`, {
    onMessage: (msg) => {
      if (msg.type === 'question') {
        status(message, '');
        paint(msg);
      }
    },
  });

  api.view(code)
    .then((state) => {
      // The server knows what this device already sent; trust it over the
      // in-memory map, which a refresh empties.
      if (state.current >= 0) sent.set(state.current, state.mine.length);
      paint(state);
    })
    .catch((err) => {
      status(message, t('error.' + (err instanceof ApiError ? err.code : 'internal')), 'error');
    });

  return () => socket.close();
}
