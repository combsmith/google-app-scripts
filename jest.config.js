module.exports = {
  preset: 'ts-jest/presets/js-with-ts',
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/test-utils/setup.js'],
  testMatch: ['**/tests/**/*.test.[jt]s?(x)'],
  // Agent worktrees (.claude/worktrees/*) hold full repo copies; without this
  // every suite runs once per worktree.
  testPathIgnorePatterns: ['/node_modules/', '/\\.claude/', '/\\.wt-'],
  transform: {
    '^.+\\.[jt]sx?$': [
      'ts-jest',
      {
        tsconfig: {
          allowJs: true,
          strict: false,
        },
        diagnostics: false,
      },
    ],
  },
  collectCoverageFrom: [
    'src/**/*.{js,ts}',
    'gas-installer/src/**/*.{js,ts}',
    '!**/node_modules/**',
    '!**/coverage/**',
    '!**/tests/**',
  ],
  coverageThreshold: {
    global: {
      branches: 85,
      functions: 95,
      lines: 99,
      statements: 95,
    },
  },
}
