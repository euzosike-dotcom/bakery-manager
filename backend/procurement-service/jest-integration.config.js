/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'test',
  testRegex: '.*\\.integration-spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  // Real Postgres round-trips per test — the 5s default is comfortably
  // enough locally but CI's Postgres service container can be slower to
  // respond under cold cache.
  testTimeout: 15000,
};
