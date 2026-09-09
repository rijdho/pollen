import { el, clear, status } from '../ui.js?v=1';
import { t } from '../i18n.js?v=1';
import { normaliseCode } from '../shared/codes.js?v=1';
import { myRooms } from '../rooms.js?v=1';
import { allDecks, deleteDeck, downloadDeck, parseDeckFile, saveDeck } from '../decks.js?v=1';

export function renderHome(root, { onCreate, onJoin, onPresent, onOpenDeck, onRefresh }) {
  clear(root);

  const message = el('p', { class: 'status', role: 'status', hidden: true });

  const codeInput = el('input', {
    id: 'join-code',
    class: 'code-input',
    type: 'text',
    inputmode: 'latin',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    maxlength: '9',
    'aria-describedby': 'join-help',
    placeholder: t('home.joinPlaceholder'),
  });

  const submit = (event) => {
    event.preventDefault();
    const code = normaliseCode(codeInput.value);
    if (!code) {
      status(message, t('error.bad_code'), 'error');
      codeInput.focus();
      return;
    }
    onJoin(code);
  };

  const joinForm = el('form', { class: 'join-form', onSubmit: submit }, [
    el('label', { class: 'field-label', for: 'join-code', text: t('home.joinLabel') }),
    el('div', { class: 'join-row' }, [
      codeInput,
      el('button', { class: 'btn btn-brand', type: 'submit', text: t('home.joinButton') }),
    ]),
    message,
  ]);

  const mine = myRooms();
  const resume = mine.length === 0 ? null : el('section', { class: 'card' }, [
    el('p', { class: 'eyebrow', text: t('home.resume') }),
    el('ul', { class: 'room-list' }, mine.map((r) => el('li', {}, [
      el('button', {
        class: 'btn btn-quiet code-chip',
        type: 'button',
        text: r.code,
        onClick: () => onPresent(r.code),
      }),
    ]))),
  ]);

  // Saved sets, which are the whole answer to "how does a presenter keep their
  // work without an account". They live here and in an exported file, and
  // nothing about them ever reaches the server until a room is opened.
  function setsCard() {
    const decks = allDecks();
    const importer = el('input', {
      type: 'file', accept: 'application/json,.json', class: 'file-input',
      'aria-label': t('home.importSet'),
      onChange: async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const deck = parseDeckFile(await file.text());
        event.target.value = '';
        if (!deck) {
          status(message, t('home.importFailed'), 'error');
          return;
        }
        saveDeck(deck.name, deck.questions);
        onOpenDeck(deck);
      },
    });

    return el('section', { class: 'card' }, [
      el('p', { class: 'eyebrow', text: t('home.sets') }),
      decks.length === 0
        ? el('p', { class: 'hint', text: t('home.setsHint') })
        : el('ul', { class: 'deck-list' }, decks.map((deck) => el('li', { class: 'deck-item' }, [
          el('span', { class: 'deck-name', text: deck.name }),
          el('span', { class: 'deck-count', text: t('join.of', { n: deck.questions.length, total: deck.questions.length }) }),
          el('div', { class: 'deck-tools' }, [
            el('button', { class: 'btn btn-brand', type: 'button', text: t('home.openSet'), onClick: () => onOpenDeck(deck) }),
            el('button', { class: 'btn btn-quiet', type: 'button', text: t('home.exportSet'), onClick: () => downloadDeck(deck) }),
            el('button', {
              class: 'btn btn-quiet', type: 'button', text: t('home.deleteSet'),
              onClick: () => { deleteDeck(deck.name); onRefresh(); },
            }),
          ]),
        ]))),
      el('label', { class: 'btn btn-quiet file-label' }, [el('span', { text: t('home.importSet') }), importer]),
    ]);
  }

  root.append(
    el('section', { class: 'card card-lead' }, [
      el('p', { class: 'lede', text: t('home.lede') }),
      el('div', { class: 'actions' }, [
        el('button', { class: 'btn btn-brand btn-lg', type: 'button', text: t('home.create'), onClick: onCreate }),
      ]),
      el('p', { class: 'hint', text: t('home.createHint') }),
    ]),
    el('section', { class: 'card' }, [
      el('h2', { class: 'card-title', text: t('home.joinTitle') }),
      joinForm,
      el('p', { id: 'join-help', class: 'hint', text: t('home.about.how') + ': ' + t('home.about.howBody') }),
    ]),
    resume,
    setsCard(),
    el('section', { class: 'card card-about' }, [
      el('h2', { class: 'card-title', text: t('home.about.title') }),
      el('p', { text: t('home.about.body') }),
    ]),
  );
  codeInput.focus();
}
