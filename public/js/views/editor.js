import { el, clear, status, appendAll } from '../ui.js?v=1';
import { t } from '../i18n.js?v=1';
import { LIMITS } from '../shared/limits.js?v=1';
import { QUESTION_TYPES, blankQuestion, typeLabel, promptField, typeFields } from './qform.js?v=1';
import { saveDeck } from '../decks.js?v=1';

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
        el('span', { class: 'eyebrow', text: (i + 1) + '. ' + typeLabel(q.type) }),
        el('div', { class: 'q-tools' }, [
          el('button', { class: 'btn btn-quiet', type: 'button', text: '↑', title: t('editor.moveUp'), 'aria-label': t('editor.moveUp'), onClick: () => move(i, -1) }),
          el('button', { class: 'btn btn-quiet', type: 'button', text: '↓', title: t('editor.moveDown'), 'aria-label': t('editor.moveDown'), onClick: () => move(i, 1) }),
          el('button', { class: 'btn btn-quiet', type: 'button', text: t('editor.remove'), onClick: () => { questions.splice(i, 1); draw(); } }),
        ]),
      ]),
      promptField(q),
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
            const name = saveDeck(setName.value, ready);
            setName.value = name;
            status(message, t('editor.setSaved'), 'info');
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
