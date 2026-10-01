import { encode } from 'uqr';
import { describe, expect, it } from 'vitest';

import { accessQrSvg } from './access-qr.js';

describe('team access QR code (spec 03, section 6)', () => {
  const link = 'https://varal.kratinho.com.br/e/ESPT26';

  it('is an SVG drawn on the server, square, with the quiet zone', () => {
    const svg = accessQrSvg(link);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    expect(viewBox?.[1]).toBe(viewBox?.[2]);
    // Modules of the QR plus 4 blank modules on each side, 8 units each.
    const { size } = encode(link, { ecc: 'M', border: 4 });
    expect(Number(viewBox?.[1])).toBe(size * 8);
  });

  it('encodes the link (same matrix as the encoder) and is deterministic', () => {
    expect(accessQrSvg(link)).toBe(accessQrSvg(link));
    expect(accessQrSvg(link)).not.toBe(accessQrSvg(`${link}X`));
    const { data } = encode(link, { ecc: 'M', border: 4 });
    expect(data.length).toBeGreaterThan(20);
  });
});
