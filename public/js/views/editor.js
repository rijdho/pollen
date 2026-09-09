import { el, clear, status } from '../ui.js?v=1';
import { t } from '../i18n.js?v=1';
import { LIMITS } from '../shared/limits.js?v=1';

/**
 * Building the question set. The whole thing lives in memory until the room is
 * opened, so nothing reaches the network while it is being written.
 */
export function renderEditor(root, { onCreate, onBack }) {
  clear(root);
  const questions = [];
  const list = el('div', { class: 'q-list' });
  const message = el('p', { class: 'status', role: 'status', hidden: true });

  function add(type) {
    if (questions.length >= LIMITS.room.maxQuestions) {
      status(message, t('editor.full', { n: LIMITS.room.maxQuestions }), 'error');
      return;
    }
    if (type === 'choice') questions.push({ type, prompt: '', options: ['', ''], multiple: false });
    else if (type === 'scale') questions.push({ type, prompt: '', steps: 5, labels: { min: '', max: '' } });
    else questions.push({ type, prompt: '', entries: 1, moderation: true });
    draw();
  }

  function move(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= questions.length) return;
    [questions[i], questions[j]] = [questions[j], questions[i]];
    draw();
  }

  function draw() {
    clear(list);
    questions.forEach((q, i) => list.append(card(q, i)));
  }

  function card(q, i) {
    const promptField = el('input', {
      class: 'input', type: 'text', maxlength: String(LIMITS.prompt.maxChars),
      value: q.prompt, placeholder: t('editor.promptPlaceholder'),
      'aria-label': t('editor.prompt'),
      onInput: (e) => { q.prompt = e.target.value; },
    });

    return el('section', { class: 'card q-card' }, [
      el('div', { class: 'q-head' }, [
        el('span', { class: 'eyebrow', text: (i + 1) + '. ' + t('editor.add' + q.type[0].toUpperCase() + q.type.slice(1)) }),
        el('div', { class: 'q-tools' }, [
          el('button', { class: 'btn btn-quiet', type: 'button', text: '↑', title: t('editor.moveUp'), 'aria-label': t('editor.moveUp'), onClick: () => move(i, -1) }),
          el('button', { class: 'btn btn-quiet', type: 'button', text: '↓', title: t('editor.moveDown'), 'aria-label': t('editor.moveDown'), onClick: () => move(i, 1) }),
          el('button', { class: 'btn btn-quiet', type: 'button', text: t('editor.remove'), onClick: () => { questions.splice(i, 1); draw(); } }),
        ]),
      ]),
      promptField,
      q.type === 'choice' ? choiceFields(q) : q.type === 'scale' ? scaleFields(q) : cloudFields(q),
    ]);
  }

  function choiceFields(q) {
    const box = el('div', { class: 'q-body' });
    const redraw = () => {
      clear(box);
      q.options.forEach((value, k) => {
        box.append(el('div', { class: 'opt-row' }, [
          el('input', {
            class: 'input', type: 'text', value,
            maxlength: String(LIMITS.choice.maxOptionChars),
            'aria-label': t('editor.option', { n: k + 1 }),
            placeholder: t('editor.option', { n: k + 1 }),
            onInput: (e) => { q.options[k] = e.target.value; },
          }),
          q.options.length > 2
            ? el('button', { class: 'btn btn-quiet', type: 'button', text: '×', 'aria-label': t('editor.remove'), onClick: () => { q.options.splice(k, 1); redraw(); } })
            : null,
        ]));
      });
      if (q.options.length < LIMITS.choice.maxOptions) {
        box.append(el('button', {
          class: 'btn btn-quiet', type: 'button', text: t('editor.addOption'),
          onClick: () => { q.options.push(''); redraw(); },
        }));
      }
      box.append(checkbox(t('editor.multiple'), q.multiple, (on) => { q.multiple = on; }));
    };
    redraw();
    return box;
  }

  function scaleFields(q) {
    return el('div', { class: 'q-body' }, [
      el('label', { class: 'field-label', text: t('editor.steps') }),
      el('input', {
        class: 'input input-num', type: 'number', value: String(q.steps),
        min: String(LIMITS.scale.minSteps), max: String(LIMITS.scale.maxSteps),
        onInput: (e) => { q.steps = Number(e.target.value); },
      }),
      el('input', {
        class: 'input', type: 'text', value: q.labels.min, placeholder: t('editor.labelMin'),
        'aria-label': t('editor.labelMin'), maxlength: String(LIMITS.choice.maxOptionChars),
        onInput: (e) => { q.labels.min = e.target.value; },
      }),
      el('input', {
        class: 'input', type: 'text', value: q.labels.max, placeholder: t('editor.labelMax'),
        'aria-label': t('editor.labelMax'), maxlength: String(LIMITS.choice.maxOptionChars),
        onInput: (e) => { q.labels.max = e.target.value; },
      }),
    ]);
  }

  function cloudFields(q) {
    return el('div', { class: 'q-body' }, [
      el('label', { class: 'field-label', text: t('editor.entries') }),
      el('input', {
        class: 'input input-num', type: 'number', value: String(q.entries),
        min: '1', max: String(LIMITS.cloud.maxEntriesPerVoter),
        onInput: (e) => { q.entries = Number(e.target.value); },
      }),
      checkbox(t('editor.moderation'), q.moderation, (on) => { q.moderation = on; }),
      el('p', { class: 'hint', text: t('editor.moderationHint') }),
    ]);
  }

  function checkbox(label, checked, onChange) {
    const input = el('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked) });
    return el('label', { class: 'check' }, [input, el('span', { text: label })]);
  }

  // Disabled while the request is in flight. Without that, a second click on a
  // slow connection opens a second room and charges the creation limit twice
  // for one intention.
  const create = el('button', {
    class: 'btn btn-brand btn-lg', type: 'button', text: t('editor.create'),
    onClick: async () => {
      const usable = questions.filter((q) => q.prompt.trim() !== '');
      if (usable.length === 0) {
        status(message, t('editor.empty'), 'error');
        return;
      }
      create.disabled = true;
      try {
        await onCreate(usable, message);
      } finally {
        create.disabled = false;
      }
    },
  });

  add('choice');

  // The add buttons sit BELOW the list, where someone who has just finished
  // typing a question is already looking. Above the list they were a row you
  // had to scroll back up to find, so the obvious next step read as if the
  // only options were to go back or to open the room.
  const addRow = el('div', { class: 'add-row' }, [
    el('span', { class: 'eyebrow', text: t('editor.addAnother') }),
    el('div', { class: 'actions' }, [
      el('button', { class: 'btn', type: 'button', text: '+ ' + t('editor.addChoice'), onClick: () => add('choice') }),
      el('button', { class: 'btn', type: 'button', text: '+ ' + t('editor.addScale'), onClick: () => add('scale') }),
      el('button', { class: 'btn', type: 'button', text: '+ ' + t('editor.addCloud'), onClick: () => add('cloud') }),
    ]),
  ]);

  root.append(
    el('section', { class: 'card card-lead' }, [
      el('h2', { class: 'card-title', text: t('editor.title') }),
      el('p', { class: 'hint', text: t('editor.hint') }),
    ]),
    list,
    addRow,
    el('div', { class: 'actions actions-end' }, [
      el('button', { class: 'btn btn-quiet', type: 'button', text: t('editor.back'), onClick: onBack }),
      create,
    ]),
    message,
  );
}
