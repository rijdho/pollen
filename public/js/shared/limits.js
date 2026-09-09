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
    roomsPerHourPerIp: 10, // creation, in the shared throttle object
  },
};
