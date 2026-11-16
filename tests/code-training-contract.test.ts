import { describe, expect, it } from 'vitest';
import { matchesSignature } from '../scripts/code-training/contract.ts';

describe('generated TypeScript declaration contract', () => {
  it('accepts formatting variations and equivalent union ordering', () => {
    expect(matchesSignature('export function f(value: undefined | number | null): number { return value ?? 0; }',
      'f(value: number | null | undefined): number')).toBe(true);
    expect(matchesSignature('export function sum( a : number , b : number ) : number { return a + b; }',
      'sum(a: number, b: number): number')).toBe(true);
  });

  it.each([
    'export function sum(a: string, b: string): string { return a + b; }',
    'export function sum(a: number, b: number): string { return a + b; }',
    'export function sum(a: number, b?: number): number { return a + b; }',
    'export function sum(b: number, a: number): number { return a + b; }',
    'export function sum(a: number, b: number, unused?: number): number { return a + b; }',
    'export function sum(a: number, b: any): number { return a + b; }',
    'export function sum(a: number, b: number = 0): number { return a + b; }',
  ])('rejects an incorrect declaration even when numeric runtime probes could pass: %s', source => {
    expect(matchesSignature(source, 'sum(a: number, b: number): number')).toBe(false);
  });

  it('rejects required-versus-optional mismatch in either direction', () => {
    expect(matchesSignature('export function f(value: number): number { return value; }', 'f(value?: number): number')).toBe(false);
  });

  it('rejects arrays with a different element type, rest parameters and missing contracts', () => {
    const source = 'export function count(values: number[]): number { return values.length; }';
    expect(matchesSignature(source, 'count(values: string[]): number')).toBe(false);
    expect(matchesSignature(source, 'count(...values: number[]): number')).toBe(false);
    expect(matchesSignature(source, undefined)).toBe(false);
    expect(matchesSignature(source, '')).toBe(false);
  });
});
