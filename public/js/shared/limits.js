// Every cap in one place. The Worker enforces these; the browser only mirrors
// them as a courtesy (maxlength, disabled buttons). Client-side limits are UX,
// never defence: the request is re-checked in the Durable Object.

export const LIMITS = {
  code: {
    length: 6,
  },
  room: {
    maxQuestions: 20,
    ttlHours: 12,          // the room deletes itself; see Room.alarm()
    maxVoters: 500,        // distinct voter tokens per room
    // Sockets one room will hold. Without a ceiling, anyone holding a code
    // could open them by the thousand: each connection and each pushed message
    // is a billed request, so an open room was a way to spend someone else's
    // daily allowance. Comfortably above maxVoters, because phones reconnect.
    maxSockets: 700,
  },
  prompt: {
    maxChars: 200,
  },
  image: {
    // Bytes of the decoded image, which is what "100 KB" means to whoever
    // picks the file. The data URI carrying it is a third larger again, and
    // that inflated string is what the cap below is actually checked against.
    //
    // The browser reaches this number by rescaling and re-encoding, never by
    // refusing the file: a tool that answers a 4 MB phone photo with "too
    // big, resize it yourself" has handed its job back to the presenter.
    maxBytes: 100 * 1024,
    // Longest side before encoding. Enough for a projector, and small enough
    // that 100 KB is reachable at a quality that does not smear text.
    maxSide: 1280,
    // Raster only. An SVG is a document, not a picture: it can carry script
    // and external references, and while a browser does not run either inside
    // an <img>, that guarantee is the browser's to withdraw and not ours to
    // depend on. Nothing here needs vector, so nothing here accepts it.
    types: ['image/jpeg', 'image/png', 'image/webp'],
    // Words describing the picture, for whoever is not looking at the wall.
    maxAltChars: 120,
  },
  choice: {
    maxOptions: 8,
    maxOptionChars: 80,
  },
  scale: {
    minSteps: 2,
    maxSteps: 10,
  },
  question: {
    // Seconds a question stays open when it is timed. Zero means untimed,
    // which stays the default: a countdown changes the feel of a room and
    // should be a decision, not something that arrives with the tool.
    maxSeconds: 600,
  },
  qa: {
    maxChars: 240,          // a question, not an essay
    maxPerVoter: 3,         // how many one person may ask
    maxItems: 200,          // per question, across the room
  },
  quiz: {
    maxNickChars: 20,
    boardSize: 10,          // names shown on the projected scoreboard
  },
  cloud: {
    maxChars: 40,          // an entry, not a sentence
    maxWords: 3,
    maxEntriesPerVoter: 3,
  },
  rate: {
    votesPerMinute: 20,    // per voter token, inside the room
    // Creation, counted in the shared throttle object, and charged only when a
    // room actually opens. Set for the person who spends an afternoon building
    // and re-building a set of questions, not for the tidiest possible number:
    // a limit that a legitimate user trips over is a broken tool, and the abuse
    // it exists to stop looks nothing like thirty.
    roomsPerHourPerIp: 30,
  },
};
