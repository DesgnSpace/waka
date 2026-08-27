// One shared stand-in for src/lib/rate-limit used by every suite that mocks
// it. bun's mock.module is process-global, so separate factories would race:
// whichever suite loaded last would hand another suite's static imports a
// different shape than the one it was written against.
//
// requestAddress and bindServer stay real because rate-limit.test.ts asserts
// their actual behavior; only checkRateLimit is stubbed, to let requests
// through without touching the database.
import { bindServer, requestAddress } from "./rate-limit";

export const fakeRateLimitModule = {
  bindServer,
  requestAddress,
  checkRateLimit: async () => ({ allowed: true }),
};
