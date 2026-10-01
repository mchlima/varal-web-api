import { TIME_ZONE } from '../common/time.js';
import type { EmailType } from '../generated/prisma/enums.js';
import type { EmailVariables } from './email-types.js';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface TemplateOptions {
  /** Where to ask for help (`SUPPORT_CONTACT`), printed in the footer (RN-01.21). */
  supportContact: string | undefined;
}

interface Content {
  subject: string;
  greeting: string;
  paragraphs: string[];
  button: string;
  validity: string;
  /** Who helps this recipient: the owner of the stall for staff, the Varal team for the others. */
  help: 'owner' | 'varal';
}

// Brand tokens of spec 08 (Framboesa).
const PRIMARY = '#BE185D';
const PRIMARY_INK = '#FFFFFF';
const TEXT = '#111315';
const TEXT_MUTED = '#5A6067';
const BG = '#F3F4F2';
const SURFACE = '#FFFFFF';

const formatter = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: TIME_ZONE,
});

function formatExpiry(iso: string): string {
  return formatter.format(new Date(iso)).replace(', ', ' às ');
}

function contentOf(type: EmailType, v: EmailVariables): Content {
  const org = v.organizationName ?? '';
  switch (type) {
    case 'owner_invite':
      return {
        subject: `Seu acesso ao Varal: ${org}`,
        greeting: `Olá, ${v.recipientName}!`,
        paragraphs: [
          `A conta de ${org} no Varal está pronta. Para começar, crie a sua senha de acesso.`,
        ],
        button: 'Criar minha senha',
        validity: `O link vale por 7 dias (até ${formatExpiry(v.expiresAt)}) e só pode ser usado uma vez.`,
        help: 'varal',
      };
    case 'owner_password_reset':
      return {
        subject: 'Redefinição de senha do Varal',
        greeting: `Olá, ${v.recipientName}!`,
        paragraphs: [
          `Recebemos um pedido para redefinir a senha da sua conta de ${org} no Varal.`,
          'Se não foi você, ignore este e-mail: a sua senha atual continua valendo.',
        ],
        button: 'Definir nova senha',
        validity: `O link vale por 1 hora (até ${formatExpiry(v.expiresAt)}) e só pode ser usado uma vez.`,
        help: 'varal',
      };
    case 'staff_password_reset':
      return {
        subject: `Nova senha do Varal: ${org}`,
        greeting: `Olá, ${v.recipientName}!`,
        paragraphs: [`O responsável por ${org} pediu uma nova senha para o seu acesso ao Varal.`],
        button: 'Definir nova senha',
        validity: `O link vale por 1 hora (até ${formatExpiry(v.expiresAt)}) e só pode ser usado uma vez.`,
        help: 'owner',
      };
    case 'admin_invite':
      return {
        subject: 'Convite para o admin do Varal',
        greeting: `Olá, ${v.recipientName}!`,
        paragraphs: [
          'Você foi convidado para o painel de administração do Varal. Crie a sua senha para entrar.',
        ],
        button: 'Criar minha senha',
        validity: `O link vale por 7 dias (até ${formatExpiry(v.expiresAt)}) e só pode ser usado uma vez.`,
        help: 'varal',
      };
    case 'admin_password_reset':
      return {
        subject: 'Redefinição de senha do admin do Varal',
        greeting: `Olá, ${v.recipientName}!`,
        paragraphs: [
          'Recebemos um pedido para redefinir a sua senha do admin do Varal.',
          'Se não foi você, ignore este e-mail: a sua senha atual continua valendo.',
        ],
        button: 'Definir nova senha',
        validity: `O link vale por 1 hora (até ${formatExpiry(v.expiresAt)}) e só pode ser usado uma vez.`,
        help: 'varal',
      };
  }
}

/** RN-01.21: nobody reads replies to nao-responda@, so every e-mail says so and where to get help. */
function footerOf(content: Content, options: TemplateOptions): string {
  const help =
    content.help === 'owner'
      ? 'Precisa de ajuda? Fale com o responsável pela sua barraca.'
      : options.supportContact
        ? `Precisa de ajuda? Fale com a equipe do Varal: ${options.supportContact}.`
        : 'Precisa de ajuda? Fale com a equipe do Varal pelo canal de atendimento que você já usa.';
  return `Este é um e-mail automático. Não responda: as respostas a este endereço não são lidas. ${help}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Plain text and simple HTML (pt-BR), with the brand color on the button (spec 08). */
export function renderEmail(
  type: EmailType,
  variables: EmailVariables,
  options: TemplateOptions,
): RenderedEmail {
  const content = contentOf(type, variables);
  const footer = footerOf(content, options);

  const text = [
    content.greeting,
    '',
    ...content.paragraphs.flatMap((paragraph) => [paragraph, '']),
    `${content.button}: ${variables.link}`,
    '',
    content.validity,
    '',
    '--',
    footer,
    '',
  ].join('\n');

  const paragraph = (value: string, color = TEXT, size = 16) =>
    `<p style="margin:0 0 16px;font-size:${size}px;line-height:1.5;color:${color}">${escapeHtml(value)}</p>`;
  const html = `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(content.subject)}</title></head>
<body style="margin:0;padding:24px 12px;background:${BG};font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:${SURFACE};border-radius:12px">
<tr><td style="padding:32px 28px">
<p style="margin:0 0 24px;font-size:22px;font-weight:bold;color:${PRIMARY}">Varal</p>
${paragraph(content.greeting)}
${content.paragraphs.map((value) => paragraph(value)).join('\n')}
<p style="margin:24px 0"><a href="${escapeHtml(variables.link)}" style="display:inline-block;padding:14px 24px;background:${PRIMARY};color:${PRIMARY_INK};font-size:16px;font-weight:bold;text-decoration:none;border-radius:8px">${escapeHtml(content.button)}</a></p>
${paragraph(content.validity, TEXT_MUTED, 14)}
${paragraph(`Se o botão não funcionar, copie e cole este endereço no navegador: ${variables.link}`, TEXT_MUTED, 14)}
</td></tr>
<tr><td style="padding:16px 28px 28px;border-top:1px solid #D9DCD8">
${paragraph(footer, TEXT_MUTED, 13)}
</td></tr>
</table>
</body>
</html>
`;
  return { subject: content.subject, text, html };
}
