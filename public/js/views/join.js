import { el, clear, status, appendAll } from '../ui.js?v=1';
import { t } from '../i18n.js?v=1';
import { api, liveSocket, ApiError } from '../api.js?v=1';
import { LIMITS } from '../shared/limits.js?v=1';
import { wordCount } from '../shared/sanitize.js?v=1';
import { percentages } from '../shared/aggregate.js?v=1';

/**
 * The phone. It receives the current question over its socket, never the
 * running tally: results belong on the projector, and pushing them here would
 * multiply every vote by the size of the room.
 *
 * Audience questions are the one list a phone does see, and it is fetched on
 * demand rather than streamed, for the same reason.
 */
export function renderJoin(root, { code }) {
  clear(root);
  const message = el('p', { class: 'status', role: 'status', hidden: true });
  const stage = el('section', { class: 'card card-lead join-stage' });
  const clock = el('p', { class: 'clock', hidden: true });
  appendAll(root, [el('p', { class: 'join-room', text: code }), clock, stage, message]);

  const sent = new Map();
  // What this device actually answered, kept locally. The socket pushes the
  // follower view, which carries no answers, so after a reveal the phone would
  // otherwise have forgotten what it said and could not tell anyone how they
  // did.
  const myAnswer = new Map();
  let editing = null;
  let view = null;
  let nick = null;
  // The countdown is the server's clock, corrected once for how far this
  // device is from it. A phone with a slow clock would otherwise show time
  // that is not there, and be refused when it used it.
  let skew = 0;
  let ticker = null;

  function paint(next) {
    const moved = view === null || next.current !== view.current;
    if (typeof next.now === 'number') skew = next.now - Date.now();
    view = next;
    if (moved) editing = null;
    draw();
    runClock();
  }

  function secondsLeft() {
    const seconds = view?.question?.spec?.seconds || 0;
    if (!seconds || !view.startedAt) return null;
    return Math.max(0, Math.ceil((view.startedAt + seconds * 1000 - (Date.now() + skew)) / 1000));
  }

  function runClock() {
    clearInterval(ticker);
    ticker = null;
    const tick = () => {
      const left = secondsLeft();
      if (left === null) {
        clock.hidden = true;
        return;
      }
      clock.hidden = false;
      clock.textContent = left > 0 ? t('join.timeLeft', { n: left }) : t('join.timeUp');
      clock.dataset.out = left === 0 ? 'true' : 'false';
      if (left === 0) {
        clearInterval(ticker);
        ticker = null;
        draw();
      }
    };
    tick();
    if (secondsLeft() !== null) ticker = setInterval(tick, 500);
  }

  async function send(value) {
    try {
      status(message, '');
      await api.vote(code, view.current, value);
      sent.set(view.current, (sent.get(view.current) || 0) + 1);
      myAnswer.set(view.current, value);
      editing = null;
      draw();
    } catch (err) {
      const failure = err instanceof ApiError ? err.code : 'internal';
      status(message, t('error.' + failure, { n: LIMITS.cloud.maxWords }), 'error');
      if (failure === 'time_up') draw();
    }
  }

  /**
   * One place decides what the phone shows, so a socket message arriving after
   * an answer was sent cannot put the form back. A participant who sees the
   * form again assumes their answer was lost.
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
    if (view.scored) stage.append(nickField());
    if (view.locked) {
      stage.append(el('p', { class: 'hint', text: t('join.locked') }));
      return;
    }
    if (secondsLeft() === 0) {
      stage.append(el('p', { class: 'hint', text: t('join.timeUp') }));
      return;
    }
    const type = view.question.type;
    if (type === 'qa') {
      stage.append(qaForm());
      return;
    }
    const answered = (sent.get(view.current) || 0) > 0;
    if (!['cloud', 'qa'].includes(type) && answered && editing !== view.current) {
      stage.append(sentState());
      return;
    }
    stage.append(
      type === 'choice' ? choiceForm()
        : type === 'scale' ? scaleForm()
          : type === 'rank' ? rankForm()
            : cloudForm(),
    );
  }

  /**
   * Ordering by buttons rather than by dragging. A drag on a phone competes
   * with the page's own scrolling and fails silently when it loses; two
   * buttons work with a thumb, with a keyboard and with a screen reader.
   */
  function rankForm() {
    const spec = view.question.spec;
    const order = spec.options.map((_, i) => i);
    const list = el('ol', { class: 'rank-list' });

    const redraw = () => {
      clear(list);
      order.forEach((option, position) => {
        list.append(el('li', { class: 'rank-item' }, [
          el('span', { class: 'rank-num', text: String(position + 1) }),
          el('span', { class: 'rank-label', text: spec.options[option] }),
          el('div', { class: 'rank-tools' }, [
            el('button', {
              class: 'btn btn-quiet', type: 'button', text: '↑',
              'aria-label': t('join.rankUp') + ': ' + spec.options[option],
              disabled: position === 0,
              onClick: () => {
                [order[position - 1], order[position]] = [order[position], order[position - 1]];
                redraw();
              },
            }),
            el('button', {
              class: 'btn btn-quiet', type: 'button', text: '↓',
              'aria-label': t('join.rankDown') + ': ' + spec.options[option],
              disabled: position === order.length - 1,
              onClick: () => {
                [order[position + 1], order[position]] = [order[position], order[position + 1]];
                redraw();
              },
            }),
          ]),
        ]));
      });
    };
    redraw();

    return el('div', {}, [
      el('p', { class: 'hint', text: t('join.rankHint') }),
      list,
      el('button', {
        class: 'btn btn-brand btn-lg btn-block', type: 'button', text: t('join.submit'),
        onClick: () => send([...order]),
      }),
    ]);
  }

  /**
   * The tally, on the phone, only where the presenter asked for it. Fetched
   * once after answering rather than streamed: see qform.js for the arithmetic
   * that makes the difference.
   */
  function resultsPanel() {
    const box = el('div', { class: 'phone-results' }, [el('p', { class: 'hint', text: '…' })]);
    api.results(code, view.current).then(({ results: data }) => {
      clear(box);
      box.append(el('p', { class: 'eyebrow', text: t('join.results') }));
      if (data.type === 'choice') {
        box.append(el('ul', { class: 'mini-bars' }, data.options.map((label, i) => el('li', {}, [
          el('span', { class: 'mini-name', text: label }),
          el('span', { class: 'mini-value', text: data.percentages[i] + '%' }),
          el('span', { class: 'mini-track' }, [
            el('span', { class: 'mini-fill', style: { width: data.percentages[i] + '%' } }),
          ]),
        ]))));
      } else if (data.type === 'scale') {
        const share = percentages(data.histogram);
        box.append(el('ul', { class: 'mini-bars' }, data.histogram.map((n, i) => el('li', {}, [
          el('span', { class: 'mini-name', text: String(i + 1) }),
          el('span', { class: 'mini-value', text: String(n) }),
          el('span', { class: 'mini-track' }, [
            el('span', { class: 'mini-fill', style: { width: share[i] + '%' } }),
          ]),
        ]))));
      } else if (data.type === 'rank') {
        box.append(el('ol', { class: 'mini-rank' }, data.rows.map((row) => el('li', {
          text: data.options[row.index] + (row.average === null ? '' : ` · ${row.average}`),
        }))));
      } else if (data.type === 'cloud') {
        box.append(el('p', { class: 'hint', text: data.items.slice(0, 12).map((i) => `${i.label} (${i.count})`).join(' · ') }));
      }
    }).catch(() => {
      // A tally the presenter did not share is not an error worth shouting
      // about on a phone; the panel simply does not appear.
      box.remove();
    });
    return box;
  }

  function sentState() {
    const correct = view.revealed ? view.question.spec?.correct : null;
    const mine = myAnswer.get(view.current) ?? view.mine?.[0]?.value;
    let verdict = null;
    if (Array.isArray(correct) && Array.isArray(mine)) {
      const same = JSON.stringify([...mine].sort((a, b) => a - b)) === JSON.stringify([...correct].sort((a, b) => a - b));
      verdict = el('p', { class: same ? 'verdict verdict-right' : 'verdict verdict-wrong',
        text: same ? t('join.rightAnswer') : t('join.wrongAnswer') });
    }
    return el('div', {}, [
      el('p', { class: 'sent', text: t('join.thanks') }),
      verdict,
      el('button', {
        class: 'btn btn-quiet', type: 'button', text: t('join.change'),
        onClick: () => { editing = view.current; draw(); },
      }),
      view.question.spec?.showResults ? resultsPanel() : null,
    ]);
  }

  /** Optional, and said to be optional, because a name goes on a wall. */
  function nickField() {
    if (nick || view.nick) {
      nick = nick || view.nick;
      return el('p', { class: 'hint', text: t('join.nickTitle') + ': ' + nick });
    }
    const input = el('input', {
      class: 'input', type: 'text', maxlength: String(LIMITS.quiz.maxNickChars),
      placeholder: t('join.nickPlaceholder'), 'aria-label': t('join.nickTitle'), autocomplete: 'off',
    });
    return el('form', {
      class: 'nick-form',
      onSubmit: async (event) => {
        event.preventDefault();
        try {
          const res = await api.setNick(code, input.value);
          nick = res.nick;
          draw();
        } catch (err) {
          status(message, t('error.' + (err instanceof ApiError ? err.code : 'internal')), 'error');
        }
      },
    }, [
      el('label', { class: 'field-label', text: t('join.nickTitle') }),
      el('div', { class: 'join-row' }, [input, el('button', { class: 'btn', type: 'submit', text: t('join.nickSave') })]),
      el('p', { class: 'hint', text: t('join.nickHint') }),
    ]);
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
    return el('form', {
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
  }

  // --- audience questions ---------------------------------------------------

  function qaForm() {
    const asked = sent.get(view.current) || 0;
    const left = Math.max(0, LIMITS.qa.maxPerVoter - asked);
    const listBox = el('div', { class: 'qa-list' }, [el('p', { class: 'hint', text: t('join.qaEmpty') })]);

    async function refresh() {
      try {
        const data = await api.qaList(code, view.current);
        clear(listBox);
        if (data.items.length === 0) {
          listBox.append(el('p', { class: 'hint', text: t('join.qaEmpty') }));
          return;
        }
        listBox.append(el('ul', { class: 'qa-items' }, data.items.map((item) => el('li', { class: 'qa-item' }, [
          el('p', { class: 'qa-text', text: item.text }),
          item.own
            // No support button on your own question: the server refuses it,
            // and offering a button that always fails is a worse answer than
            // saying whose it is.
            ? el('span', { class: 'qa-own', text: t('join.qaOwn') + ' · ▲ ' + item.votes })
            : el('button', {
              class: item.mine ? 'btn btn-brand qa-up' : 'btn qa-up',
              type: 'button',
              'aria-pressed': item.mine ? 'true' : 'false',
              text: '▲ ' + item.votes,
              title: item.mine ? t('join.supported') : t('join.support'),
              onClick: async () => {
                try {
                  await api.upvote(code, view.current, item.id);
                  refresh();
                } catch (err) {
                  status(message, t('error.' + (err instanceof ApiError ? err.code : 'internal')), 'error');
                }
              },
            }),
        ]))));
      } catch (err) {
        status(message, t('error.' + (err instanceof ApiError ? err.code : 'internal')), 'error');
      }
    }

    const input = el('input', {
      class: 'input', type: 'text', maxlength: String(LIMITS.qa.maxChars),
      autocomplete: 'off', placeholder: t('join.qaPlaceholder'), 'aria-label': view.question.prompt,
    });
    const form = el('form', {
      onSubmit: async (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (text === '') { status(message, t('error.empty'), 'error'); return; }
        await send(text);
        input.value = '';
        refresh();
      },
    }, [
      input,
      el('button', { class: 'btn btn-brand btn-lg btn-block', type: 'submit', disabled: left === 0, text: t('join.qaSend') }),
      el('p', { class: 'hint', text: t('join.qaLeft', { n: left }) }),
    ]);

    refresh();
    return el('div', {}, [
      form,
      el('div', { class: 'qa-head' }, [
        el('span', { class: 'eyebrow', text: t('join.qaList') }),
        // Fetched, not streamed. Pushing every change to every phone is what
        // the whole design exists to avoid.
        el('button', { class: 'btn btn-quiet', type: 'button', text: t('join.qaRefresh'), onClick: refresh }),
      ]),
      listBox,
    ]);
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
      if (state.current >= 0) {
        sent.set(state.current, state.mine.length);
        if (state.mine.length > 0) myAnswer.set(state.current, state.mine[0].value);
      }
      paint(state);
    })
    .catch((err) => {
      status(message, t('error.' + (err instanceof ApiError ? err.code : 'internal')), 'error');
    });

  return () => {
    clearInterval(ticker);
    socket.close();
  };
}
