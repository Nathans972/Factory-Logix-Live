import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { PersonCell, initials } from './components';

describe('initials', () => {
  it('keeps working for ordinary names', () => {
    expect(initials('JRivera')).toBe('JR');
    expect(initials('nathan sessions')).toBe('NS');
    expect(initials('')).toBe('?');
  });

  // FactoryLogix and automated stations commonly put "-" or "." where a person's name would go.
  it('does not throw for a name made only of separator characters', () => {
    for (const name of ['-', '_', '.', '--', '. .', ' - ']) {
      expect(() => initials(name), JSON.stringify(name)).not.toThrow();
    }
  });
});

describe('PersonCell', () => {
  it('renders an operator whose id is a bare dash instead of throwing during render', () => {
    const render = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PersonCell, { id: '-', name: null })));
    expect(render).not.toThrow();
  });
});
