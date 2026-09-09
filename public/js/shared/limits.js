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
  },
  prompt: {
    maxChars: 200,
  },
  choice: {
    maxOptions: 8,
    maxOptionChars: 80,
  },
  scale: {
    minSteps: 2,
    maxSteps: 10,
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
