import { renderSVG } from 'uqr';

/**
 * QR code of the team access link (spec 03, section 6), as SVG drawn on the server with `uqr` (no
 * dependencies). Error correction M and the 4-module quiet zone of the QR standard, so another
 * phone reads it from the screen; the SVG scales to any size without blurring.
 */
export function accessQrSvg(link: string): string {
  return renderSVG(link, { ecc: 'M', border: 4, pixelSize: 8 });
}
