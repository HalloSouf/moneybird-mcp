import { describe, expect, it } from 'vitest';
import { buildFilter, parseLinkHeader, readPageInfo } from '../../src/moneybird/pagination.js';

describe('parseLinkHeader', () => {
  it('parses multiple comma-separated rels', () => {
    const header =
      '<https://moneybird.com/api/v2/123/contacts.json?page=2>; rel="next", ' +
      '<https://moneybird.com/api/v2/123/contacts.json?page=1>; rel="prev"';

    expect(parseLinkHeader(header)).toEqual({
      next: 'https://moneybird.com/api/v2/123/contacts.json?page=2',
      prev: 'https://moneybird.com/api/v2/123/contacts.json?page=1',
    });
  });

  it('accepts an unquoted rel value', () => {
    const header = '<https://moneybird.com/api/v2/123/contacts.json?page=2>; rel=next';
    expect(parseLinkHeader(header)).toEqual({
      next: 'https://moneybird.com/api/v2/123/contacts.json?page=2',
    });
  });

  it('returns an empty object for a missing header', () => {
    expect(parseLinkHeader(null)).toEqual({});
  });

  it('ignores a malformed header instead of throwing', () => {
    expect(parseLinkHeader('not a link header at all')).toEqual({});
  });
});

describe('readPageInfo', () => {
  it('derives the next and previous page numbers from the Link header', () => {
    const headers = new Headers({
      link:
        '<https://moneybird.com/api/v2/123/contacts.json?page=3>; rel="next", ' +
        '<https://moneybird.com/api/v2/123/contacts.json?page=1>; rel="prev"',
    });

    const info = readPageInfo(headers, { page: 2, perPage: 50 });

    expect(info).toMatchObject({
      page: 2,
      perPage: 50,
      hasNextPage: true,
      hasPreviousPage: true,
      nextPage: 3,
      previousPage: 1,
    });
  });

  it('reports no next/previous page when the Link header is absent', () => {
    const info = readPageInfo(new Headers());
    expect(info).toMatchObject({
      hasNextPage: false,
      hasPreviousPage: false,
      nextPage: undefined,
      previousPage: undefined,
    });
  });

  it('reads X-Total-Count when present', () => {
    const headers = new Headers({ 'x-total-count': '42' });
    expect(readPageInfo(headers).totalCount).toBe(42);
  });

  it('leaves totalCount undefined when the header is absent', () => {
    expect(readPageInfo(new Headers()).totalCount).toBeUndefined();
  });
});

describe('buildFilter', () => {
  it('joins key:value pairs with commas', () => {
    expect(buildFilter({ contact_type: 'company', state: 'open' })).toBe(
      'contact_type:company,state:open',
    );
  });

  it('drops undefined values', () => {
    expect(buildFilter({ contact_type: 'company', reference: undefined })).toBe(
      'contact_type:company',
    );
  });

  it('returns an empty string when every value is undefined', () => {
    expect(buildFilter({ reference: undefined })).toBe('');
  });
});
