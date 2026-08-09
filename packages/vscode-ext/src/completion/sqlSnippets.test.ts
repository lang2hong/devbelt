import { describe, expect, it } from 'vitest';
import { SQL_SNIPPETS, getSqlSnippet } from './sqlSnippets';

describe('SQL snippets', () => {
  it('provides the expected set of triggers', () => {
    expect(SQL_SNIPPETS.map((snippet) => snippet.trigger).sort()).toEqual(['del', 'ins', 'joi', 'sel', 'upd']);
  });

  it('has unique triggers', () => {
    const triggers = SQL_SNIPPETS.map((snippet) => snippet.trigger);
    expect(new Set(triggers).size).toBe(triggers.length);
  });

  it('renders editor placeholders for fill-in, not pre-executed SQL', () => {
    const insert = getSqlSnippet('ins')!;
    expect(insert.body).toContain('${');
    expect(insert.body).toMatch(/INSERT INTO/);
  });

  it('returns undefined for an unknown trigger', () => {
    expect(getSqlSnippet('nope')).toBeUndefined();
  });
});