import { describe, expect, it } from 'vitest';
import { extractDomain, isValidHttpUrl, normalizeUrl, prettifyDomain } from './url-utils';

describe('normalizeUrl', () => {
  it('accepts http(s) with a dotted host, lowercasing the host but preserving path case', () => {
    expect(normalizeUrl('https://Example.COM/MixedPath')).toBe('https://example.com/MixedPath');
    expect(normalizeUrl('  https://example.com/x  ')).toBe('https://example.com/x'); // trimmed
  });

  it('rejects non-http schemes, dotless hosts, and garbage', () => {
    for (const bad of ['ftp://files.example.com/x', 'javascript:alert(1)', 'http://nodots', 'not a url', '', '   ']) {
      expect(normalizeUrl(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('special-cases localhost and [::1] despite having no dot', () => {
    expect(normalizeUrl('http://localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(normalizeUrl('http://[::1]/x')).toBe('http://[::1]/x');
  });

  it('strips the fragment and the root-path trailing slash only', () => {
    expect(normalizeUrl('https://example.com/page#section')).toBe('https://example.com/page');
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
    expect(normalizeUrl('https://example.com/deep/')).toBe('https://example.com/deep/'); // non-root kept
    expect(normalizeUrl('https://example.com/x?q=1')).toBe('https://example.com/x?q=1'); // query kept
  });
});

describe('extractDomain', () => {
  it('returns the hostname minus a www prefix; empty string for garbage', () => {
    expect(extractDomain('https://www.github.com/avlo')).toBe('github.com');
    expect(extractDomain('https://docs.github.com/x')).toBe('docs.github.com');
    expect(extractDomain('garbage')).toBe('');
  });
});

describe('prettifyDomain', () => {
  it('capitalizes the registrable label, skipping subdomains and two-segment TLDs', () => {
    expect(prettifyDomain('github.com')).toBe('Github');
    expect(prettifyDomain('docs.github.com')).toBe('Github');
    expect(prettifyDomain('play.google.com')).toBe('Google');
    expect(prettifyDomain('news.ycombinator.com')).toBe('Ycombinator');
    expect(prettifyDomain('amazon.co.uk')).toBe('Amazon');
    expect(prettifyDomain('shop.amazon.com.au')).toBe('Amazon');
    expect(prettifyDomain('localhost')).toBe('Localhost');
    expect(prettifyDomain('')).toBe('');
  });
});

describe('isValidHttpUrl', () => {
  it('is a scheme check, not a reachability or host check', () => {
    expect(isValidHttpUrl('https://example.com')).toBe(true);
    expect(isValidHttpUrl(' http://x ')).toBe(true); // trims, and URL accepts dotless hosts here
    expect(isValidHttpUrl('ftp://example.com')).toBe(false);
    expect(isValidHttpUrl('nope')).toBe(false);
  });
});
