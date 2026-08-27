import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { allTools } from '../../src/tools/index.js';
import { TOOLSETS } from '../../src/config/schema.js';

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const ACCESS_TIERS = new Set(['read', 'write', 'destroy']);

function inputKeys(tool: (typeof allTools)[number]): string[] {
  const shape = (tool.inputSchema as z.ZodObject).shape as Record<string, unknown>;
  return Object.keys(shape);
}

describe('allTools invariants', () => {
  it('has at least one tool defined', () => {
    expect(allTools.length).toBeGreaterThan(0);
  });

  it('has a unique name per tool', () => {
    const names = allTools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('names match the snake_case pattern and stay within 64 characters', () => {
    for (const tool of allTools) {
      expect(tool.name).toMatch(NAME_PATTERN);
      expect(tool.name.length).toBeLessThanOrEqual(64);
    }
  });

  it('has a non-empty description ending in punctuation', () => {
    for (const tool of allTools) {
      expect(tool.description.trim().length).toBeGreaterThan(0);
      expect(tool.description.trim()).toMatch(/[.!?]$/);
    }
  });

  it('declares a known toolset', () => {
    for (const tool of allTools) {
      expect(TOOLSETS).toContain(tool.toolset);
    }
  });

  it('declares a known access tier', () => {
    for (const tool of allTools) {
      expect(ACCESS_TIERS.has(tool.access)).toBe(true);
    }
  });

  it('accepts administration_id, except list_administrations which has no administration to name', () => {
    for (const tool of allTools) {
      if (tool.name === 'list_administrations') continue;
      expect(inputKeys(tool)).toContain('administration_id');
    }
  });

  it('has a unique title per tool', () => {
    const titles = allTools.map((tool) => tool.title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});
