import { describe, it, expect } from 'vitest';
import {
  toSnakeCase,
  neuronId,
  synapseId,
  sessionId,
  isValidNeuronId,
  inferNeuronType,
} from '../src/utils/ids.js';

describe('toSnakeCase', () => {
  it('lowercases and replaces spaces with underscores', () => {
    expect(toSnakeCase('OctoChat Plugin')).toBe('octochat_plugin');
  });

  it('strips special characters', () => {
    expect(toSnakeCase('Node.js & React!')).toBe('nodejs_react');
  });

  it('collapses repeated separators and trims edges', () => {
    expect(toSnakeCase('  --Hello___World--  ')).toBe('hello_world');
  });
});

describe('neuronId', () => {
  it('prefixes the slug with the type', () => {
    expect(neuronId('OctoChat', 'project')).toBe('project_octochat');
    expect(neuronId('Firebase', 'tech')).toBe('tech_firebase');
  });
});

describe('synapseId', () => {
  it('strips prefixes and sorts the two nodes alphabetically', () => {
    expect(synapseId('project_octochat', 'tech_firebase')).toBe('syn_firebase__octochat');
  });

  it('is order-independent', () => {
    expect(synapseId('tech_firebase', 'project_octochat')).toBe(
      synapseId('project_octochat', 'tech_firebase')
    );
  });
});

describe('sessionId', () => {
  it('builds an id from a given date', () => {
    expect(sessionId('2026-05-06')).toBe('session_2026-05-06');
  });
});

describe('isValidNeuronId', () => {
  it('accepts well-formed ids', () => {
    expect(isValidNeuronId('project_octochat')).toBe(true);
    expect(isValidNeuronId('protocol_card_zero')).toBe(true);
  });

  it('rejects ids without a known prefix or with bad characters', () => {
    expect(isValidNeuronId('octochat')).toBe(false);
    expect(isValidNeuronId('Project_OctoChat')).toBe(false);
    expect(isValidNeuronId('random_Thing!')).toBe(false);
  });
});

describe('inferNeuronType', () => {
  it('detects tech topics (tech keywords are checked before process)', () => {
    expect(inferNeuronType('Firebase')).toBe('tech');
    expect(inferNeuronType('Firebase setup')).toBe('tech');
  });

  it('detects protocols and processes', () => {
    expect(inferNeuronType('Anti-hallucination protocol')).toBe('protocol');
    expect(inferNeuronType('Deploy pipeline')).toBe('process');
  });

  it('falls back to project when unsure', () => {
    expect(inferNeuronType('My side hustle')).toBe('project');
  });
});
