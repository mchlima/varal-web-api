import { describe, expect, it } from 'vitest';

import { EmailType } from '../generated/prisma/enums.js';
import type { EmailVariables } from './email-types.js';
import { renderEmail } from './templates.js';

const variables: EmailVariables = {
  recipientName: 'Ana <b>',
  organizationName: 'Espetinho & Cia',
  link: 'http://localhost:3100/definir-senha#token=abc&tipo=convite',
  expiresAt: '2026-10-08T15:30:00.000Z',
};

describe('e-mail templates (spec 01, section 9)', () => {
  it.each(Object.values(EmailType))(
    '%s has pt-BR text and HTML with the link and the footer (RN-01.21)',
    (type) => {
      const email = renderEmail(type, variables, { supportContact: undefined });
      expect(email.subject.length).toBeGreaterThan(5);
      expect(email.text).toContain(variables.link);
      expect(email.text).toContain('Não responda');
      expect(email.text).toContain('Precisa de ajuda?');
      expect(email.html).toContain('Não responda');
      expect(email.html).toContain('#BE185D');
      expect(email.html).toContain(
        'href="http://localhost:3100/definir-senha#token=abc&amp;tipo=convite"',
      );
    },
  );

  it('escapes names in the HTML', () => {
    const email = renderEmail('owner_invite', variables, { supportContact: undefined });
    expect(email.html).toContain('Ana &lt;b&gt;');
    expect(email.html).toContain('Espetinho &amp; Cia');
    expect(email.html).not.toContain('<b>!');
  });

  it('shows the validity in São Paulo time', () => {
    const email = renderEmail('owner_invite', variables, { supportContact: undefined });
    expect(email.text).toContain('08/10/2026 às 12:30');
  });

  it('points staff to the owner and the others to the Varal team (SUPPORT_CONTACT)', () => {
    const staff = renderEmail('staff_password_reset', variables, { supportContact: 'suporte@x' });
    expect(staff.text).toContain('responsável pela sua barraca');
    const owner = renderEmail('owner_password_reset', variables, { supportContact: 'suporte@x' });
    expect(owner.text).toContain('equipe do Varal: suporte@x');
  });
});
