// One question form, used by the editor before a room opens and by the
// presenter to add a question to a room that is already running. Keeping it in
// one place is what stops the two from drifting into different rules about
// what a question may contain.

import { el, clear, appendAll } from '../ui.js?v=2';
import { t } from '../i18n.js?v=2';
import { LIMITS } from '../shared/limits.js?v=2';
import { imageFromFile } from '../imagefile.js?v=2';

export const QUESTION_TYPES = ['choice', 'scale', 'rank', 'cloud', 'qa'];

export function blankQuestion(type) {
  if (type === 'choice') return { type, prompt: '', options: ['', ''], multiple: false, correct: [], seconds: 0, chart: 'bars' };
  if (type === 'scale') return { type, prompt: '', steps: 5, labels: { min: '', max: '' } };
  if (type === 'qa') return { type, prompt: '', moderation: true };
  if (type === 'rank') return { type, prompt: '', options: ['', '', ''], seconds: 0, showResults: false };
  // Off for a cloud, on for audience questions: see prepareQuestion in the
  // Worker for why the two differ.
  return { type, prompt: '', entries: 1, moderation: false };
}

/**
 * Change a question's type without losing what has already been typed. The
 * prompt always survives, and so do the settings that mean the same thing in
 * both types; everything specific to the old type is dropped, because there is
 * no honest way to turn three options into a five-step scale.
 */
export function retype(q, type) {
  const next = blankQuestion(type);
  next.prompt = q.prompt;
  // The picture survives, for the same reason the prompt does: it belongs to
  // what is being asked, not to how the answer is collected.
  if (q.image) next.image = q.image;
  if ('seconds' in next && 'seconds' in q) next.seconds = q.seconds;
  if ('showResults' in next && 'showResults' in q) next.showResults = q.showResults;
  // Options carry between the two types that have them, which is the switch
  // someone actually makes: a list written as a poll, meant as a ranking.
  if (Array.isArray(next.options) && Array.isArray(q.options)) {
    const carried = q.options.slice(0, LIMITS.choice.maxOptions);
    while (carried.length < 2) carried.push('');
    next.options = carried;
  }
  return next;
}

export function typeLabel(type) {
  return t('editor.add' + type[0].toUpperCase() + type.slice(1));
}

/**
 * The type, as a control rather than a label. It was a static eyebrow, which
 * meant the first question was permanently whatever the editor happened to
 * start with and a question written as the wrong type had to be deleted and
 * retyped from scratch.
 */
export function typePicker(q, onChange) {
  return el('select', {
    class: 'q-type', 'aria-label': t('editor.type'),
    onChange: (event) => onChange(event.target.value),
  }, QUESTION_TYPES.map((type) => el('option', {
    value: type, selected: type === q.type, text: typeLabel(type),
  })));
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

/**
 * A picture for the question, shared by every type because it means the same
 * thing on all of them. Optional, and absent by default: most questions do not
 * want one, and an empty frame on a projector is worse than no frame.
 *
 * The file is rescaled and re-encoded here rather than checked and refused.
 * See imagefile.js for why: someone attaching a photo off their phone should
 * not have to go and find an image editor first.
 */
export function imageField(q) {
  const box = el('div', { class: 'q-field q-image' });
  const note = el('p', { class: 'hint', role: 'status' });

  const alt = el('input', {
    class: 'input', type: 'text', maxlength: String(LIMITS.image.maxAltChars),
    value: q.image?.alt || '', placeholder: t('editor.imageAlt'),
    'aria-label': t('editor.imageAlt'),
    onInput: (event) => { if (q.image) q.image.alt = event.target.value; },
  });

  const picker = el('input', {
    // Taken out of the visual flow rather than hidden, so it is still focusable
    // and still reachable by a keyboard and by assistive technology: the label
    // wrapping it below is what a mouse clicks. display:none would take it off
    // the accessibility tree and out of the tab order along with the pixels.
    class: 'visually-hidden', type: 'file', accept: LIMITS.image.types.join(','),
    'aria-label': t('editor.image'),
    onChange: async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      note.textContent = t('editor.imageWorking');
      const made = await imageFromFile(file);
      if (!made.ok) {
        // Named causes, not one apology. "Too detailed" is a real answer the
        // presenter can act on: crop it, or use fewer words on the slide.
        note.textContent = t('editor.imageFailed_' + made.reason);
        event.target.value = '';
        return;
      }
      q.image = { src: made.src, alt: q.image?.alt || '' };
      note.textContent = t('editor.imageReady', { kb: Math.round(made.bytes / 1024) });
      draw();
    },
  });

  function draw() {
    clear(box);
    appendAll(box, [
      el('label', { class: 'field-label', text: t('editor.image') }),
      q.image?.src
        ? el('div', { class: 'q-image-has' }, [
          el('img', { class: 'q-image-thumb', src: q.image.src, alt: q.image.alt || '' }),
          el('button', {
            class: 'btn btn-quiet', type: 'button', text: t('editor.imageRemove'),
            onClick: () => { q.image = null; picker.value = ''; note.textContent = ''; draw(); },
          }),
        ])
        : el('label', { class: 'btn file-btn' }, [picker, el('span', { text: t('editor.imagePick') })]),
      q.image?.src ? alt : null,
      q.image?.src ? el('p', { class: 'hint', text: t('editor.imageAltHint') }) : null,
      note,
      q.image?.src ? null : el('p', { class: 'hint', text: t('editor.imageHint', { kb: Math.round(LIMITS.image.maxBytes / 1024) }) }),
    ]);
  }

  draw();
  return box;
}

export function checkbox(label, checked, onChange) {
  const input = el('input', { type: 'checkbox', checked, onChange: (event) => onChange(event.target.checked) });
  // No span when there are no words to put in it. An empty one is invisible but
  // not free: `.check` is a flex row with a gap, so it was adding half a rem of
  // dead space beside every option's tick box and pushing the fields out of
  // line with everything below them.
  return el('label', { class: 'check' }, [input, label ? el('span', { text: label }) : null]);
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
        class: 'btn btn-quiet opt-add', type: 'button', text: t('editor.addOption'),
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
        class: 'btn btn-quiet opt-add', type: 'button', text: t('editor.addOption'),
        onClick: () => { q.options.push(''); redraw(); },
      }));
    }
    box.append(
      el('p', { class: 'hint', text: t('editor.correctHint') }),
      checkbox(t('editor.multiple'), q.multiple, (on) => { q.multiple = on; }),
      chartField(q),
      timerField(q),
      shareResults(q),
    );
  };
  redraw();
  return box;
}

/**
 * How the projector draws the answers. Bars are the default and stay the
 * recommendation: a donut and a grid of dots look better in a screenshot and
 * worse on a wall, where reading a length beats reading an angle.
 */
function chartField(q) {
  const picker = el('select', {
    class: 'q-type', 'aria-label': t('editor.chart'),
    onChange: (event) => { q.chart = event.target.value; },
  }, ['bars', 'donut', 'dots'].map((kind) => el('option', {
    value: kind, selected: (q.chart || 'bars') === kind, text: t('editor.chart_' + kind),
  })));
  return el('div', { class: 'q-field' }, [
    el('label', { class: 'field-label', text: t('editor.chart') }),
    picker,
    el('p', { class: 'hint', text: t('editor.chartHint') }),
  ]);
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
