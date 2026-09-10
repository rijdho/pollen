import { el, clear, status, appendAll } from '../ui.js?v=2';
import { t } from '../i18n.js?v=2';
import { LIMITS } from '../shared/limits.js?v=2';
import { QUESTION_TYPES, blankQuestion, retype, typeLabel, typePicker, promptField, imageField, typeFields } from './qform.js?v=2';
import { saveDeck } from '../decks.js?v=2';

/**
 * Building the question set. Everything lives in memory until the room is
 * opened, so nothing reaches the network while it is being written, and the
 * set can be saved to this device without a room ever existing.
 */
export function renderEditor(root, { onCreate, onBack, deck = null }) {
  clear(root);
  const questions = deck ? structuredClone(deck.questions) : [blankQuestion('choice')];
  const list = el('div', { class: 'q-list' });
  const message = el('p', { class: 'status', role: 'status', hidden: true });

  function add(type) {
    if (questions.length >= LIMITS.room.maxQuestions) {
      status(message, t('editor.full', { n: LIMITS.room.maxQuestions }), 'error');
      return;
    }
    questions.push(blankQuestion(type));
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
    return el('section', { class: 'card q-card' }, [
      el('div', { class: 'q-head' }, [
        el('span', { class: 'q-pos', text: String(i + 1) }),
        typePicker(q, (type) => {
          questions[i] = retype(q, type);
          draw();
        }),
        el('div', { class: 'q-tools' }, [
          // Disabled at the ends rather than silently doing nothing, which is
          // indistinguishable from a broken button.
          el('button', {
            class: 'btn btn-quiet', type: 'button', text: '↑',
            title: t('editor.moveUp'), 'aria-label': t('editor.moveUp') + ': ' + (q.prompt || typeLabel(q.type)),
            disabled: i === 0, onClick: () => move(i, -1),
          }),
          el('button', {
            class: 'btn btn-quiet', type: 'button', text: '↓',
            title: t('editor.moveDown'), 'aria-label': t('editor.moveDown') + ': ' + (q.prompt || typeLabel(q.type)),
            disabled: i === questions.length - 1, onClick: () => move(i, 1),
          }),
          el('button', { class: 'btn btn-quiet', type: 'button', text: t('editor.remove'), onClick: () => { questions.splice(i, 1); draw(); } }),
        ]),
      ]),
      promptField(q),
      imageField(q),
      typeFields(q),
    ]);
  }

  function usable() {
    return questions.filter((q) => q.prompt.trim() !== '');
  }

  const create = el('button', {
    class: 'btn btn-brand btn-lg', type: 'button', text: t('editor.create'),
    onClick: async () => {
      const ready = usable();
      if (ready.length === 0) {
        status(message, t('editor.empty'), 'error');
        return;
      }
      create.disabled = true;
      try {
        await onCreate(ready, message);
      } finally {
        create.disabled = false;
      }
    },
  });

  const setName = el('input', {
    class: 'input', type: 'text', maxlength: '60',
    value: deck ? deck.name : '',
    placeholder: t('editor.setName'), 'aria-label': t('editor.setName'),
  });

  // The add buttons sit BELOW the list, where someone who has just finished
  // typing a question is already looking.
  const addRow = el('div', { class: 'add-row' }, [
    el('span', { class: 'eyebrow', text: t('editor.addAnother') }),
    el('div', { class: 'actions' }, QUESTION_TYPES.map((type) => el('button', {
      class: 'btn', type: 'button', text: '+ ' + typeLabel(type), onClick: () => add(type),
    }))),
  ]);

  draw();

  appendAll(root, [
    el('section', { class: 'card card-lead' }, [
      el('h2', { class: 'card-title', text: t('editor.title') }),
      el('p', { class: 'hint', text: t('editor.hint') }),
    ]),
    list,
    addRow,
    el('section', { class: 'card' }, [
      el('p', { class: 'eyebrow', text: t('editor.saveSet') }),
      el('div', { class: 'join-row' }, [
        setName,
        el('button', {
          class: 'btn', type: 'button', text: t('editor.saveSet'),
          onClick: () => {
            const ready = usable();
            if (ready.length === 0) {
              status(message, t('editor.empty'), 'error');
              return;
            }
            // saveDeck reports rather than swallowing. A set with pictures in
            // it is three orders of magnitude larger than one without, and the
            // browser's storage quota is per origin: a save that quietly did
            // nothing would be discovered next week, with the set gone.
            const saved = saveDeck(setName.value, ready);
            if (saved.status === 'saved') {
              setName.value = saved.name;
              status(message, t('editor.setSaved'), 'info');
            } else {
              status(message, t('editor.setFailed_' + saved.status), 'error');
            }
          },
        }),
      ]),
      el('p', { class: 'hint', text: t('home.setsHint') }),
    ]),
    el('div', { class: 'actions actions-end' }, [
      el('button', { class: 'btn btn-quiet', type: 'button', text: t('editor.back'), onClick: onBack }),
      create,
    ]),
    message,
  ]);
}
