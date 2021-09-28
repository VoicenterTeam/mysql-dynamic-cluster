/** @type {import('ts-jest/dist/types').InitialOptionsTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  moduleDirectories: [
    "node_modules"
  ],
  testPathIgnorePatterns: [
      'dist',
      'tests/loads'
  ],
  testTimeout: 300000,
  collectCoverageFrom: [
    "**/*.{ts}",
    "**/tests/**",
    "!**/node_modules/**",
    "!**/dist/**",
    "!**/tests/loads/**"
  ],
  coverageThreshold: {
    global: {
      branches: 10,
      functions: 10,
      lines: 10,
      statements: 10
    }
  }
};
