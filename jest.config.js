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
    "src/**/*.ts",
    "index.ts"
  ],
  // Measured on an earlier build of this line plus the follow-up tests: statements 84.89, branches 78.83,
  // functions 83.41, lines 85.63. Each floor is that number less 5, rounded down
  coverageThreshold: {
    global: {
      branches: 73,
      functions: 78,
      lines: 80,
      statements: 79
    }
  }
};
