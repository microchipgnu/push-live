import { ulid } from 'ulidx';

const ADJECTIVES = [
  'amber', 'azure', 'brave', 'bright', 'calm', 'clever', 'cosmic', 'crisp',
  'dawn', 'deep', 'eager', 'ember', 'fair', 'fierce', 'glad', 'gold',
  'grand', 'green', 'happy', 'jade', 'keen', 'kind', 'lake', 'lively',
  'lunar', 'mint', 'misty', 'noble', 'olive', 'open', 'pearl', 'plum',
  'polar', 'quick', 'quiet', 'rapid', 'rose', 'royal', 'rust', 'sage',
  'salty', 'sandy', 'silver', 'silent', 'snowy', 'solar', 'sunny', 'sweet',
  'swift', 'tender', 'tidal', 'vivid', 'warm', 'wild', 'witty', 'young',
];
const NOUNS = [
  'apple', 'arrow', 'bay', 'beach', 'brook', 'canvas', 'cedar', 'cliff',
  'cloud', 'comet', 'coral', 'cove', 'crane', 'creek', 'dawn', 'delta',
  'dune', 'echo', 'ember', 'fern', 'field', 'fjord', 'forest', 'fox',
  'glade', 'glow', 'grove', 'harbor', 'haze', 'heron', 'hill', 'isle',
  'lake', 'lark', 'leaf', 'lily', 'maple', 'marsh', 'meadow', 'mesa',
  'mist', 'moon', 'moss', 'oak', 'opal', 'orbit', 'pearl', 'peak',
  'pine', 'pond', 'prairie', 'reef', 'ridge', 'river', 'sail', 'shore',
  'sky', 'spark', 'spire', 'star', 'stone', 'stream', 'summit', 'tide',
  'trail', 'valley', 'vine', 'willow', 'wing', 'wood',
];

const ALPHANUM = 'abcdefghijkmnpqrstuvwxyz23456789';

export function newSlug(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += ALPHANUM[Math.floor(Math.random() * ALPHANUM.length)];
  return `${a}-${n}-${suffix}`;
}

export function newVersionId(): string {
  return ulid();
}

export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

export function newToken(byteLen = 32): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
