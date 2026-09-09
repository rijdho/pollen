// One question form, used by the editor before a room opens and by the
// presenter to add a question to a room that is already running. Keeping it in
// one place is what stops the two from drifting into different rules about
// what a question may contain.

import { el, clear } from '../ui.js?v=1';
import { t } from '../i18n.js?v=1';
import { LIMITS } from '../shared/limits.js?v=1';

export const QUESTION_TYPES = ['choice', 'scale', 'rank', 'cloud', 'qa'];

export function blankQuestion(type) {
  if (type === 'choice') return { type, prompt: '', options: ['', ''], multiple: false, correct: [], seconds: 0 };
  if (type === 'scale') return { type, prompt: '', steps: 5, labels: { min: '', max: '' } };
  if (type === 'qa') return { type, prompt: '', moderation: true };
  if (type === 'rank') return { type, prompt: '', options: ['', '', ''], seconds: 0, showResults: false };
  // Off for a cloud, on for audience questions: see prepareQuestion in the
  // Worker for why the two differ.
  return { type, prompt: '', entries: 1, moderation: false };
}

export function typeLabel(type) {
  return t('editor.add' + type[0].toUpperCase() + type.slice(1));
}

/** A prompt field bound to `q`, shared by every type. */
export function promptField(q) {
  return el('input', {
    class: 'input', type: 'text', maxlength: String(LIMITS.prompt.maxChars),
    value: q.prompt, placeholder: t('editor.promptPlaceholder'),
    'aria-label': t('editor.prompt'),
    onInput: (event) => { q.prompt = event.target.value; },
  });
}

export function checkbox(label, checked, onChange) {
  const input = el('input', { type: 'checkbox', checked, onChange: (event) => onChange(event.target.checked) });
  return el('label', { class: 'check' }, [input, el('span', { text: label })]);
}

/** The part of the form that differs by type. */
export function typeFields(q) {
  if (q.type === 'choice') return choiceFields(q);
  if (q.type === 'scale') return scaleFields(q);
  if (q.type === 'qa') return qaFields(q);
  if (q.type === 'rank') return rankFields(q);
  return cloudFields(q);
}

/**
 * Showing the tally on every phone. Off by default and labelled with what it
 * costs, because it is the one setting here that changes how much traffic a
 * room makes: one extra request per person per question. That is linear and
 * affordable; streaming it would not be, which is why this is a fetch after
 * answering rather than a live feed.
 */
export function shareResults(q) {
  return el('div', { class: 'q-field' }, [
    checkbox(t('editor.showResults'), q.showResults, (on) => { q.showResults = on; }),
    el('p', { class: 'hint', text: t('editor.showResultsHint') }),
  ]);
}

function rankFields(q) {
  const box = el('div', { class: 'q-body' });
  const redraw = () => {
    clear(box);
    q.options.forEach((value, k) => {
      box.append(el('div', { class: 'opt-row' }, [
        el('span', { class: 'rank-num', text: String(k + 1) }),
        el('input', {
          class: 'input', type: 'text', value,
          maxlength: String(LIMITS.choice.maxOptionChars),
          'aria-label': t('editor.option', { n: k + 1 }),
          placeholder: t('editor.option', { n: k + 1 }),
          onInput: (event) => { q.options[k] = event.target.value; },
        }),
        q.options.length > 2
          ? el('button', {
            class: 'btn btn-quiet', type: 'button', text: '×', 'aria-label': t('editor.remove'),
            onClick: () => { q.options.splice(k, 1); redraw(); },
          })
          : null,
      ]));
    });
    if (q.options.length < LIMITS.choice.maxOptions) {
      box.append(el('button', {
        class: 'btn btn-quiet', type: 'button', text: t('editor.addOption'),
        onClick: () => { q.options.push(''); redraw(); },
      }));
    }
    box.append(
      el('p', { class: 'hint', text: t('editor.rankHint') }),
      timerField(q),
      shareResults(q),
    );
  };
  redraw();
  return box;
}

function choiceFields(q) {
  const box = el('div', { class: 'q-body' });
  const redraw = () => {
    clear(box);
    q.options.forEach((value, k) => {
      box.append(el('div', { class: 'opt-row' }, [
        // Marking a right answer turns a poll into a quiz. It is a checkbox per
        // option rather than a mode switch, so a question can be scored without
        // the presenter having decided that in advance.
        checkbox('', q.correct.includes(k), (on) => {
          const next = new Set(q.correct);
          if (on) next.add(k); else next.delete(k);
          q.correct = [...next].sort((a, b) => a - b);
        }),
        el('input', {
          class: 'input', type: 'text', value,
          maxlength: String(LIMITS.choice.maxOptionChars),
          'aria-label': t('editor.option', { n: k + 1 }),
          placeholder: t('editor.option', { n: k + 1 }),
          onInput: (event) => { q.options[k] = event.target.value; },
        }),
        q.options.length > 2
          ? el('button', {
            class: 'btn btn-quiet', type: 'button', text: '×', 'aria-label': t('editor.remove'),
            onClick: () => {
              q.options.splice(k, 1);
              q.correct = q.correct.filter((i) => i !== k).map((i) => (i > k ? i - 1 : i));
              redraw();
            },
          })
          : null,
      ]));
    });
    if (q.options.length < LIMITS.choice.maxOptions) {
      box.append(el('button', {
        class: 'btn btn-quiet', type: 'button', text: t('editor.addOption'),
        onClick: () => { q.options.push(''); redraw(); },
      }));
    }
    box.append(
      el('p', { class: 'hint', text: t('editor.correctHint') }),
      checkbox(t('editor.multiple'), q.multiple, (on) => { q.multiple = on; }),
      timerField(q),
      shareResults(q),
    );
  };
  redraw();
  return box;
}

/** Seconds to answer, or none. Shared by every type that can be timed. */
function timerField(q) {
  const input = el('input', {
    class: 'input input-num', type: 'number', value: String(q.seconds || 0),
    min: '0', max: String(LIMITS.question.maxSeconds), step: '5',
    'aria-label': t('editor.seconds'),
    onInput: (event) => { q.seconds = Number(event.target.value) || 0; },
  });
  return el('div', { class: 'q-field' }, [
    el('label', { class: 'field-label', text: t('editor.seconds') }),
    input,
    el('p', { class: 'hint', text: t('editor.secondsHint') }),
  ]);
}

function scaleFields(q) {
  return el('div', { class: 'q-body' }, [
    el('label', { class: 'field-label', text: t('editor.steps') }),
    el('input', {
      class: 'input input-num', type: 'number', value: String(q.steps),
      min: String(LIMITS.scale.minSteps), max: String(LIMITS.scale.maxSteps),
      onInput: (event) => { q.steps = Number(event.target.value); },
    }),
    el('input', {
      class: 'input', type: 'text', value: q.labels.min, placeholder: t('editor.labelMin'),
      'aria-label': t('editor.labelMin'), maxlength: String(LIMITS.choice.maxOptionChars),
      onInput: (event) => { q.labels.min = event.target.value; },
    }),
    el('input', {
      class: 'input', type: 'text', value: q.labels.max, placeholder: t('editor.labelMax'),
      'aria-label': t('editor.labelMax'), maxlength: String(LIMITS.choice.maxOptionChars),
      onInput: (event) => { q.labels.max = event.target.value; },
    }),
    shareResults(q),
  ]);
}

function cloudFields(q) {
  return el('div', { class: 'q-body' }, [
    el('label', { class: 'field-label', text: t('editor.entries') }),
    el('input', {
      class: 'input input-num', type: 'number', value: String(q.entries),
      min: '1', max: String(LIMITS.cloud.maxEntriesPerVoter),
      onInput: (event) => { q.entries = Number(event.target.value); },
    }),
    checkbox(t('editor.moderation'), q.moderation, (on) => { q.moderation = on; }),
    el('p', { class: 'hint', text: t('editor.moderationCloudHint') }),
    shareResults(q),
  ]);
}

function qaFields(q) {
  return el('div', { class: 'q-body' }, [
    el('p', { class: 'hint', text: t('editor.qaHint') }),
    checkbox(t('editor.moderation'), q.moderation, (on) => { q.moderation = on; }),
    el('p', { class: 'hint', text: t('editor.moderationHint') }),
  ]);
}
